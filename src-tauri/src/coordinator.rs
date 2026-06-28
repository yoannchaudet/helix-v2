//! Tauri command layer for the notifications/sync domain, built on top of the `sync`
//! data layer. Keeps these command bodies — fetch+store coordination (`sync_now`),
//! background subject resolution, mark-done batching, and the inbox reads — out of `lib.rs`,
//! which is left to setup + handler registration.
//!
//! SQLite lock discipline (preserved exactly): the DB lock is never held across network or
//! Keychain I/O. Each command takes the lock only for short, local read/write passes —
//! snapshotting work or recording results — with all HTTP calls happening lock-free in
//! between.

use crate::sync::SyncStatus;
use crate::{auth, github, sync, AppState};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

/// Concurrency and quota tuning for background GitHub work. Centralized here so the knobs
/// are easy to find and adjust without hunting through the command handlers.
mod tuning {
    /// Max concurrent requests when resolving notification subjects in the background.
    pub const SUBJECT_RESOLUTION_POOL: usize = 8;
    /// Max concurrent `DELETE /notifications/threads/{id}` requests when marking
    /// notifications done.
    pub const MUTATION_POOL: usize = 8;
    /// Soft reserve for background subject resolution: stop before it eats below this
    /// fraction of any rate-limit bucket, leaving quota for the list fetch + mark-done.
    /// The check runs after each batch of up to `SUBJECT_RESOLUTION_POOL` concurrent
    /// requests, so a single batch can dip up to that many requests past the line before
    /// we stop (immaterial against the thousands-wide core budget; not a hard floor).
    pub const RATE_RESERVE_FRACTION: f64 = 0.25;
}

/// Take the DB lock and run a best-effort write, logging (rather than surfacing) either a
/// poisoned lock or a write failure. These writes are optional — the app keeps working
/// without them — but a silent failure would hide real problems (a corrupt or locked DB), so
/// we make them observable instead of dropping them with `let _ = …`.
fn best_effort<E: std::fmt::Display>(
    db: &std::sync::Mutex<rusqlite::Connection>,
    what: &str,
    write: impl FnOnce(&rusqlite::Connection) -> Result<(), E>,
) {
    match db.lock() {
        Ok(conn) => {
            if let Err(e) = write(&conn) {
                eprintln!("helix: {what} failed: {e}");
            }
        }
        Err(e) => eprintln!("helix: {what} failed: database lock poisoned: {e}"),
    }
}

/// Result of a successful sync, returned to the caller and emitted as `sync:done`.
#[derive(Clone, Serialize)]
pub struct SyncResult {
    count: usize,
    removed: usize,
    rate_remaining: Option<i64>,
}

/// Fetch notifications from GitHub and store them locally, emitting progress events.
///
/// Emits `sync:started`, `sync:progress` ({ page, fetched }), and `sync:done` /
/// `sync:error`. The network fetch runs without holding the DB lock; storage happens in a
/// single transaction afterwards.
#[tauri::command]
pub async fn sync_now(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<SyncResult, String> {
    // `read_token` locks the DB itself only for the dev path; the release path reads the
    // Keychain without holding the lock.
    let token = auth::read_token(&state.db)?
        .ok_or_else(|| "Not connected — add a GitHub token first.".to_string())?;

    let _ = app.emit("sync:started", ());

    let progress_app = app.clone();
    let outcome = github::fetch_all_notifications(&token, move |page, fetched| {
        let _ = progress_app.emit(
            "sync:progress",
            serde_json::json!({ "page": page, "fetched": fetched }),
        );
    })
    .await;

    let outcome = match outcome {
        Ok(o) => o,
        Err(err) => {
            // Structured GitHubError → user-facing string at this command boundary.
            let err = err.to_string();
            best_effort(&state.db.0, "recording the sync error", |conn| {
                sync::record_error(conn, &err)
            });
            let _ = app.emit("sync:error", serde_json::json!({ "message": err.clone() }));
            return Err(err);
        }
    };

    // Store the fetched threads and record success. A DB failure here must also be
    // recorded in sync_state so the UI reflects the real last outcome (not stale state).
    let store_result = (|| -> Result<sync::StoreOutcome, String> {
        let mut guard = state.db.0.lock().map_err(|e| e.to_string())?;
        let conn: &mut rusqlite::Connection = &mut guard;
        let stored =
            sync::store_notifications(conn, &outcome.threads).map_err(|e| e.to_string())?;
        sync::record_success(conn, &outcome.rate).map_err(|e| e.to_string())?;
        Ok(stored)
    })();

    let stored = match store_result {
        Ok(s) => s,
        Err(err) => {
            best_effort(&state.db.0, "recording the sync error", |conn| {
                sync::record_error(conn, &err)
            });
            let _ = app.emit("sync:error", serde_json::json!({ "message": err.clone() }));
            return Err(err);
        }
    };

    let result = SyncResult {
        count: stored.stored,
        removed: stored.removed,
        rate_remaining: outcome.rate.remaining,
    };
    let _ = app.emit("sync:done", &result);

    // Resolve PR/Issue subject states (the Open/Closed/Merged pills) in the background so
    // the sync returns immediately. Best-effort: the inbox is already stored and shown, and
    // a `subjects:resolved` event tells the UI to reload once states land.
    let resolve_app = app.clone();
    let resolve_token = token.clone();
    tauri::async_runtime::spawn(async move {
        resolve_pending_subjects(resolve_app, resolve_token).await;
    });

    Ok(result)
}

/// Resolve outstanding subjects (state, number, author, **web `html_url`**, …) so the UI can
/// show Open/Closed/Merged pills and open the notification in a browser. Applies to any
/// subject with a `subject.url` (PRs, issues, discussions, releases, …), not just PR/Issue.
///
/// Smart caching (`subjects_needing_resolution`) keeps this cheap after the first sync. To
/// avoid this *optional* work starving the quota that core operations (list fetch, mark-done)
/// need, it stops after a batch once spending has reached a ~25% reserve on any rate-limit
/// bucket (a soft floor — see `RESERVE_FRACTION`); the deferred (oldest) subjects resolve on
/// a later sync once quota recovers. Per-subject failures are logged and retried later; the
/// DB lock is never held across network I/O. Emits `subjects:resolved` when anything changed.
async fn resolve_pending_subjects(app: tauri::AppHandle, token: String) {
    let state = app.state::<AppState>();

    // Snapshot the work under the lock, then release it before any network I/O.
    let pending = {
        let Ok(conn) = state.db.0.lock() else {
            return;
        };
        match sync::subjects_needing_resolution(&conn) {
            Ok(p) => p,
            Err(_) => return,
        }
    };
    if pending.is_empty() {
        return;
    }

    const POOL: usize = tuning::SUBJECT_RESOLUTION_POOL;
    const RESERVE_FRACTION: f64 = tuning::RATE_RESERVE_FRACTION;

    let client = reqwest::Client::new();
    let mut changed = 0usize;
    // The most conservative (lowest `remaining`) snapshot per rate-limit bucket seen across
    // the resolution calls, so the UI's per-bucket usage reflects what these extra requests
    // actually consumed. Seed it with what the just-completed list fetch already recorded so
    // the budget check has a baseline before the first resolution call.
    let mut rate = sync::RateTracker::default();
    {
        if let Ok(conn) = state.db.0.lock() {
            for b in sync::read_rate_buckets(&conn).unwrap_or_default() {
                rate.observe(github::RateLimit {
                    resource: Some(b.resource),
                    limit: b.limit,
                    remaining: b.remaining,
                    reset: b.reset_at,
                    poll_interval: None,
                });
            }
        }
    }
    // Already low on quota? Don't start — leave every subject for a future sync.
    if rate.below_reserve(RESERVE_FRACTION) {
        return;
    }

    for batch in pending.chunks(POOL) {
        let mut handles = Vec::with_capacity(batch.len());
        for p in batch {
            let client = client.clone();
            let token = token.clone();
            let url = p.subject_url.clone();
            let thread_id = p.thread_id.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                let res = github::resolve_subject(&client, &url, &token).await;
                (thread_id, res)
            }));
        }
        for h in handles {
            let Ok((thread_id, res)) = h.await else {
                continue;
            };
            match res {
                Ok(result) => {
                    rate.observe(result.rate.clone());
                    match state.db.0.lock() {
                        Ok(conn) => {
                            match sync::store_resolved_subject(&conn, &thread_id, &result.subject) {
                                Ok(()) => changed += 1,
                                Err(e) => eprintln!(
                                    "helix: storing resolved subject for {thread_id} failed: {e}"
                                ),
                            }
                        }
                        Err(e) => eprintln!(
                            "helix: storing resolved subject for {thread_id} failed: database lock poisoned: {e}"
                        ),
                    }
                }
                Err(err) => {
                    // A failed resolution still spent quota — count it toward the reserve.
                    rate.observe(err.rate.clone());
                    eprintln!("subject resolution failed for {thread_id}: {}", err.error);
                }
            }
        }

        // Stop once this batch pushed us into the reserve; the rest waits for a later sync.
        if rate.below_reserve(RESERVE_FRACTION) {
            break;
        }
    }

    // Persist the post-resolution quota so Settings shows the true per-bucket usage.
    best_effort(&state.db.0, "persisting rate limits", |conn| rate.persist(conn));

    if changed > 0 {
        let _ = app.emit("subjects:resolved", serde_json::json!({ "count": changed }));
    }
}

/// Read the current sync status (last sync, status/error, rate limit, stored count).
#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    sync::read_status(&conn).map_err(|e| e.to_string())
}

/// Read all stored notifications grouped by repository (offline-first local read).
#[tauri::command]
pub fn list_inbox(state: State<'_, AppState>) -> Result<Vec<sync::RepoGroup>, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    sync::list_by_repo(&conn).map_err(|e| e.to_string())
}

/// A single thread that failed to mutate, surfaced to the UI so partial failures are
/// reported without aborting the rest of the batch.
#[derive(Clone, Serialize)]
pub struct FailedThread {
    thread_id: String,
    error: String,
}

/// Outcome of a mark-as-done batch: how many threads succeeded, which failed, and the
/// post-mutation rate-limit count.
#[derive(Clone, Serialize)]
pub struct MutationResult {
    ok: usize,
    failed: Vec<FailedThread>,
    rate_remaining: Option<i64>,
}

/// A boxed future returned by a thread mutation call (e.g. done), so `mutate_threads` can
/// be generic over the GitHub mutation endpoints. Both the success and failure variants
/// carry a rate-limit snapshot so quota can be folded in either case.
type ThreadMutationFuture = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<github::RateLimit, github::MutationError>> + Send>,
>;

/// A thread-mutation entry point: takes a client, token, and thread id and returns the
/// boxed future above. Implemented by a thin wrapper around `github::mark_thread_done`.
type ThreadMutation = fn(reqwest::Client, String, String) -> ThreadMutationFuture;

/// Run a notification-thread mutation across `thread_ids` with bounded concurrency,
/// applying `apply_local` only to the threads whose network call succeeded.
///
/// The DB lock is never held across network I/O (mirrors `resolve_pending_subjects`): the
/// API calls run first, then a single locked pass records the local change, the most
/// conservative rate snapshot, and any per-thread failures. The frontend updates its view
/// optimistically and reloads from SQLite afterwards, so the local pass is authoritative.
async fn mutate_threads<F>(
    state: State<'_, AppState>,
    thread_ids: Vec<String>,
    call: ThreadMutation,
    apply_local: F,
) -> Result<MutationResult, String>
where
    F: FnOnce(&mut rusqlite::Connection, &[String]) -> rusqlite::Result<usize>,
{
    if thread_ids.is_empty() {
        return Ok(MutationResult {
            ok: 0,
            failed: Vec::new(),
            rate_remaining: None,
        });
    }

    // Dedupe up front: a repeated id would issue a second DELETE that can fail (the thread
    // is already gone), which would otherwise be reported as a misleading partial failure.
    let thread_ids: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        thread_ids
            .into_iter()
            .filter(|id| seen.insert(id.clone()))
            .collect()
    };

    let token = auth::read_token(&state.db)?
        .ok_or_else(|| "Not connected — add a GitHub token first.".to_string())?;

    const POOL: usize = tuning::MUTATION_POOL;
    let client = reqwest::Client::new();
    let mut succeeded: Vec<String> = Vec::new();
    let mut failed: Vec<FailedThread> = Vec::new();
    // Lowest `remaining` per bucket seen across the batch — the truest "after these calls"
    // quota for each API bucket the mutations touched.
    let mut rate = sync::RateTracker::default();

    for batch in thread_ids.chunks(POOL) {
        // Keep each thread id alongside its task handle so a join failure (panic/cancel)
        // can still be reported as a failure for that specific thread rather than silently
        // dropped (which would skew the ok/failed counts shown to the user).
        let mut handles = Vec::with_capacity(batch.len());
        for id in batch {
            let client = client.clone();
            let token = token.clone();
            let id = id.clone();
            let task_id = id.clone();
            let handle = tauri::async_runtime::spawn(async move {
                call(client, token, task_id).await
            });
            handles.push((id, handle));
        }
        for (id, handle) in handles {
            let res = match handle.await {
                Ok(res) => res,
                Err(join_err) => {
                    failed.push(FailedThread {
                        thread_id: id,
                        error: format!("task failed: {join_err}"),
                    });
                    continue;
                }
            };
            match res {
                Ok(r) => {
                    rate.observe(r);
                    succeeded.push(id);
                }
                Err(err) => {
                    // A failed request still consumes quota, so fold its rate snapshot too.
                    rate.observe(err.rate);
                    failed.push(FailedThread {
                        thread_id: id,
                        error: err.error.to_string(),
                    });
                }
            }
        }
    }

    let mut guard = state.db.0.lock().map_err(|e| e.to_string())?;
    let conn: &mut rusqlite::Connection = &mut guard;
    if !succeeded.is_empty() {
        apply_local(conn, &succeeded).map_err(|e| e.to_string())?;
    }
    let rate_remaining = rate.lowest_remaining();
    // The lock is already held here, so log inline rather than re-locking via `best_effort`.
    if let Err(e) = rate.persist(conn) {
        eprintln!("helix: persisting rate limits failed: {e}");
    }

    Ok(MutationResult {
        ok: succeeded.len(),
        failed,
        rate_remaining,
    })
}

/// Mark one or more notification threads as **done** on GitHub and locally.
///
/// Done threads are removed from the inbox entirely. Per-thread failures are reported
/// without aborting the batch.
#[tauri::command]
pub async fn mark_threads_done(
    thread_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<MutationResult, String> {
    mutate_threads(
        state,
        thread_ids,
        |client, token, id| {
            Box::pin(async move { github::mark_thread_done(&client, &token, &id).await })
        },
        sync::mark_done_local,
    )
    .await
}
