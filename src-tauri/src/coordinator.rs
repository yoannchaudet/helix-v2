//! Tauri command layer for the notifications/sync domain, built on top of the `sync`
//! data layer. Keeps these command bodies — fetch+store coordination (`sync_now`),
//! background subject resolution, mark-done batching, and the inbox reads — out of `lib.rs`,
//! which is left to setup + handler registration.
//!
//! SQLite lock discipline (preserved exactly): the DB lock is never held across network or
//! Keychain I/O. Each command takes the lock only for short, local read/write passes —
//! snapshotting work or recording results — with all HTTP calls happening lock-free in
//! between.

use crate::db::Db;
use crate::sync::SyncStatus;
use crate::{auth, github, sync, AppState, EventSink};
use serde::Serialize;
use tauri::{Manager, State};

/// Concurrency and quota tuning for background GitHub work. Centralized here so the knobs
/// are easy to find and adjust without hunting through the command handlers.
mod tuning {
    /// Max concurrent `DELETE /notifications/threads/{id}` requests when marking
    /// notifications done. Mark-done is a bounded, user-initiated batch (not the automatic,
    /// potentially large background fan-out that subject resolution is), so a small pool is
    /// fine here; background subject resolution instead runs serially (see
    /// `resolve_pending_subjects_core`) to respect GitHub's secondary-rate-limit guidance.
    pub const MUTATION_POOL: usize = 8;
    /// Soft reserve for background subject resolution: stop before it eats below this fraction
    /// of any rate-limit bucket, leaving quota for the list fetch + mark-done. Checked after
    /// each (serial) resolution request; the deferred subjects resolve on a later sync.
    pub const RATE_RESERVE_FRACTION: f64 = 0.25;
    /// Per-request timeout for background subject-resolution calls. Bounds each request so a
    /// hung connection can't stall the whole pass — which the frontend now waits on before it
    /// reports the sync complete (see `subjects:resolution-done`). A timed-out request is a
    /// normal per-subject failure: it's logged and retried on a later sync.
    pub const RESOLVE_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
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
#[derive(Debug, Clone, Serialize)]
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
pub async fn sync_now(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SyncResult, String> {
    // The core returns the token it fetched with so the background resolver reuses the
    // *same* credential — matching the original (a mid-sync sign-out/token swap must not
    // make resolution run under, or silently skip because of, a different token).
    let (result, token) = sync_now_core(&state.db, app.clone(), |token, on_page| async move {
        github::fetch_all_notifications(&token, on_page).await
    })
    .await?;

    // Resolve PR/Issue subject states (the Open/Closed/Merged pills) in the background so
    // the sync returns immediately. Best-effort: the inbox is already stored and shown, and
    // a `subjects:resolved` event tells the UI to reload once states land.
    let resolve_app = app.clone();
    tauri::async_runtime::spawn(async move {
        resolve_pending_subjects(resolve_app, token).await;
    });

    Ok(result)
}

/// Tauri-free core of [`sync_now`]: reads the token, fetches via the injected `fetch`
/// closure, stores the result, and emits lifecycle events through `sink`. Kept separate
/// from the command wrapper (and from the background subject-resolution spawn) so the
/// fetch+store+emit orchestration — the retry/partial-failure/rate paths #98 cares about —
/// can be driven deterministically against a fake fetcher and a recording sink in tests.
/// Returns the [`SyncResult`] together with the token used, so the wrapper can hand the same
/// credential to the background subject resolver.
async fn sync_now_core<S, Fetch, Fut>(
    db: &Db,
    sink: S,
    fetch: Fetch,
) -> Result<(SyncResult, String), String>
where
    S: EventSink + Clone + Send + Sync + 'static,
    Fetch: FnOnce(String, Box<dyn Fn(u32, usize) + Send>) -> Fut,
    Fut: std::future::Future<Output = Result<github::FetchOutcome, github::GitHubError>>,
{
    // `read_token` locks the DB itself only for the dev path; the release path reads the
    // Keychain without holding the lock.
    let token = auth::read_token(db)?
        .ok_or_else(|| "Not connected — add a GitHub token first.".to_string())?;

    sink.emit("sync:started", serde_json::Value::Null);

    let progress_sink = sink.clone();
    let on_page: Box<dyn Fn(u32, usize) + Send> = Box::new(move |page, fetched| {
        progress_sink.emit(
            "sync:progress",
            serde_json::json!({ "page": page, "fetched": fetched }),
        );
    });
    let outcome = fetch(token.clone(), on_page).await;

    let outcome = match outcome {
        Ok(o) => o,
        Err(err) => {
            // Structured GitHubError → user-facing string at this command boundary.
            let err = err.to_string();
            best_effort(&db.0, "recording the sync error", |conn| {
                sync::record_error(conn, &err)
            });
            sink.emit("sync:error", serde_json::json!({ "message": err.clone() }));
            return Err(err);
        }
    };

    // Store the fetched threads and record success. A DB failure here must also be
    // recorded in sync_state so the UI reflects the real last outcome (not stale state).
    let store_result = (|| -> Result<sync::StoreOutcome, String> {
        let mut guard = db.0.lock().map_err(|e| e.to_string())?;
        let conn: &mut rusqlite::Connection = &mut guard;
        let stored =
            sync::store_notifications(conn, &outcome.threads).map_err(|e| e.to_string())?;
        sync::refresh_bookmark_snapshots(conn).map_err(|e| e.to_string())?;
        sync::record_success(conn, &outcome.rate).map_err(|e| e.to_string())?;
        Ok(stored)
    })();

    let stored = match store_result {
        Ok(s) => s,
        Err(err) => {
            best_effort(&db.0, "recording the sync error", |conn| {
                sync::record_error(conn, &err)
            });
            sink.emit("sync:error", serde_json::json!({ "message": err.clone() }));
            return Err(err);
        }
    };

    let result = SyncResult {
        count: stored.stored,
        removed: stored.removed,
        rate_remaining: outcome.rate.remaining,
    };
    sink.emit(
        "sync:done",
        serde_json::to_value(&result).unwrap_or(serde_json::Value::Null),
    );

    Ok((result, token))
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
    // A per-request timeout bounds each subject fetch so a hung connection can't leave the
    // pass (and therefore the sync's "resolving" phase) running forever. Falls back to the
    // default client if the builder ever fails.
    let client = reqwest::Client::builder()
        .timeout(tuning::RESOLVE_REQUEST_TIMEOUT)
        .build()
        .unwrap_or_default();
    let resolve = move |url: String| {
        let client = client.clone();
        let token = token.clone();
        async move { github::resolve_subject(&client, &url, &token).await }
    };
    resolve_pending_subjects_core(&state.db, app.clone(), resolve).await;
}

/// Tauri-free core of [`resolve_pending_subjects`]: emits a `subjects:resolution-started` /
/// `subjects:resolution-done` pair around one resolution pass (so the frontend can treat
/// resolution as the tail of the sync and only report "synced" once the pass finishes), plus
/// `subjects:resolved` when anything changed. `subjects:resolution-done` is emitted on **every**
/// pass — including the no-pending, already-below-reserve, and back-off cases — so the frontend
/// gate can never get stuck. The actual work lives in [`run_resolution_pass`].
async fn resolve_pending_subjects_core<S, R, Fut>(db: &Db, sink: S, resolve: R)
where
    S: EventSink,
    R: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<github::ResolveResult, github::ResolveError>>,
{
    sink.emit("subjects:resolution-started", serde_json::Value::Null);
    let changed = run_resolution_pass(db, &resolve).await;
    if changed > 0 {
        sink.emit("subjects:resolved", serde_json::json!({ "count": changed }));
    }
    sink.emit(
        "subjects:resolution-done",
        serde_json::json!({ "changed": changed }),
    );
}

/// One serial, rate-reserve-budgeted subject-resolution pass. Returns the number of subjects
/// whose state changed and was stored. Kept free of `AppHandle`/`github::` (the network call is
/// injected as `resolve(url)`) so tests can drive #98's rate-limit-reserve, partial-failure, and
/// secondary-rate-limit back-off paths with a fake resolver.
async fn run_resolution_pass<R, Fut>(db: &Db, resolve: &R) -> usize
where
    R: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<github::ResolveResult, github::ResolveError>>,
{
    // Snapshot the work under the lock, then release it before any network I/O.
    let pending = {
        let Ok(conn) = db.0.lock() else {
            return 0;
        };
        match sync::subjects_needing_resolution(&conn) {
            Ok(p) => p,
            Err(_) => return 0,
        }
    };
    if pending.is_empty() {
        return 0;
    }

    const RESERVE_FRACTION: f64 = tuning::RATE_RESERVE_FRACTION;

    let mut changed = 0usize;
    // The most conservative (lowest `remaining`) snapshot per rate-limit bucket seen across
    // the resolution calls, so the UI's per-bucket usage reflects what these extra requests
    // actually consumed. Seed it with what the just-completed list fetch already recorded so
    // the budget check has a baseline before the first resolution call.
    let mut rate = sync::RateTracker::default();
    {
        if let Ok(conn) = db.0.lock() {
            for b in sync::read_rate_buckets(&conn).unwrap_or_default() {
                rate.observe(github::RateLimit {
                    resource: Some(b.resource),
                    limit: b.limit,
                    remaining: b.remaining,
                    reset: b.reset_at,
                    poll_interval: None,
                    retry_after: None,
                });
            }
        }
    }
    // Already low on quota? Don't start — leave every subject for a future sync.
    if rate.below_reserve(RESERVE_FRACTION) {
        return 0;
    }

    // Resolve **serially** (one request at a time), per GitHub's secondary-rate-limit guidance
    // ("make requests serially, not concurrently"): a burst of concurrent subject fetches is
    // the classic secondary-limit trigger. Real network latency paces the loop; the reserve
    // check bounds primary-quota spend; and any back-off signal (a 403 / `Retry-After`) stops
    // the whole pass so we don't hammer into the limit — the rest resolves on a later sync.
    for p in &pending {
        match resolve(p.subject_url.clone()).await {
            Ok(result) => {
                rate.observe(result.rate.clone());
                match db.0.lock() {
                    Ok(conn) => {
                        match sync::store_resolved_subject(&conn, &p.thread_id, &result.subject) {
                            Ok(()) => changed += 1,
                            Err(e) => eprintln!(
                                "helix: storing resolved subject for {} failed: {e}",
                                p.thread_id
                            ),
                        }
                    }
                    Err(e) => eprintln!(
                        "helix: storing resolved subject for {} failed: database lock poisoned: {e}",
                        p.thread_id
                    ),
                }
            }
            Err(err) => {
                // A failed resolution still spent quota — count it toward the reserve.
                rate.observe(err.rate.clone());
                if err.should_back_off() {
                    eprintln!(
                        "subject resolution backing off (rate limited): {}",
                        err.error
                    );
                    break;
                }
                eprintln!(
                    "subject resolution failed for {}: {}",
                    p.thread_id, err.error
                );
            }
        }

        // Stop once we've crossed the reserve; the rest waits for a later sync.
        if rate.below_reserve(RESERVE_FRACTION) {
            break;
        }
    }

    // Persist the post-resolution quota so Settings shows the true per-bucket usage.
    best_effort(&db.0, "persisting rate limits", |conn| rate.persist(conn));

    changed
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

/// Read all bookmarks grouped by repository (local-only; survives done/removal).
#[tauri::command]
pub fn list_bookmarks(state: State<'_, AppState>) -> Result<Vec<sync::RepoGroup>, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    sync::list_bookmarks(&conn).map_err(|e| e.to_string())
}

/// Bookmark or un-bookmark a thread (local-only).
#[tauri::command]
pub fn set_bookmark(
    thread_id: String,
    bookmarked: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    if bookmarked {
        sync::add_bookmark(&conn, &thread_id).map_err(|e| e.to_string())
    } else {
        sync::remove_bookmark(&conn, &thread_id).map_err(|e| e.to_string())
    }
}

/// A single thread that failed to mutate, surfaced to the UI so partial failures are
/// reported without aborting the rest of the batch.
#[derive(Debug, Clone, Serialize)]
pub struct FailedThread {
    thread_id: String,
    error: String,
}

/// Outcome of a mark-as-done batch: how many threads succeeded, which failed, and the
/// post-mutation rate-limit count.
#[derive(Debug, Clone, Serialize)]
pub struct MutationResult {
    ok: usize,
    failed: Vec<FailedThread>,
    rate_remaining: Option<i64>,
}

/// Run a notification-thread mutation across `thread_ids` with bounded concurrency,
/// applying `apply_local` only to the threads whose network call succeeded.
///
/// The network op is injected as `call(token, thread_id)` (a thin wrapper around
/// `github::mark_thread_done` in production, a fake in tests) so the batching /
/// partial-failure / rate-folding orchestration can be tested without real HTTP. The DB
/// lock is never held across network I/O (mirrors `resolve_pending_subjects`): the API
/// calls run first, then a single locked pass records the local change, the most
/// conservative rate snapshot, and any per-thread failures. The frontend updates its view
/// optimistically and reloads from SQLite afterwards, so the local pass is authoritative.
async fn mutate_threads<C, Fut, F>(
    db: &Db,
    thread_ids: Vec<String>,
    call: C,
    apply_local: F,
) -> Result<MutationResult, String>
where
    C: Fn(String, String) -> Fut + Clone + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<github::RateLimit, github::MutationError>>
        + Send
        + 'static,
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

    let token = auth::read_token(db)?
        .ok_or_else(|| "Not connected — add a GitHub token first.".to_string())?;

    const POOL: usize = tuning::MUTATION_POOL;
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
            let call = call.clone();
            let token = token.clone();
            let id = id.clone();
            let task_id = id.clone();
            let handle = tauri::async_runtime::spawn(async move { call(token, task_id).await });
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

    let mut guard = db.0.lock().map_err(|e| e.to_string())?;
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
    let client = reqwest::Client::new();
    mutate_threads(
        &state.db,
        thread_ids,
        move |token, id| {
            let client = client.clone();
            async move { github::mark_thread_done(&client, &token, &id).await }
        },
        sync::mark_done_local,
    )
    .await
}

#[cfg(all(test, debug_assertions))]
mod tests {
    //! Orchestration tests for the sync coordinator. Each exercises a Tauri-free `*_core`
    //! function against an in-memory SQLite DB, a recording event sink, and an injected fake
    //! for the GitHub network call — so the fetch/store, mark-done batching, and
    //! subject-resolution flows (including partial-failure and rate-reserve paths) are
    //! covered without a Tauri runtime or real HTTP (see issue #98).
    //!
    //! Gated on `debug_assertions` (like `auth::tests`) because the "connected" path reads
    //! the PAT via `auth::read_token`, which uses the in-memory SQLite settings table only in
    //! debug builds (release reads the macOS Keychain).

    use super::*;
    use crate::db::Db;
    use crate::github::{
        FetchOutcome, GitHubError, MinimalRepo, MutationError, NotificationThread, RateLimit,
        RepoOwner, ResolveError, ResolveResult, ResolvedSubject, Subject,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// Fresh in-memory DB with the full migration set applied (mirrors `sync::tests::mem_conn`).
    fn mem_db() -> Db {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let mut version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        let migrations = crate::db::migrations();
        while (version as usize) < migrations.len() {
            conn.execute_batch(migrations[version as usize]).unwrap();
            version += 1;
            conn.pragma_update(None, "user_version", version).unwrap();
        }
        Db(Mutex::new(conn))
    }

    /// In-memory DB with a stored PAT. Tests run in a debug build, where `auth::store_token`
    /// writes the token to the SQLite settings table, so the "connected" path is exercisable.
    fn db_with_token() -> Db {
        let db = mem_db();
        auth::store_token(&db, "test-token").unwrap();
        db
    }

    fn store(db: &Db, threads: &[NotificationThread]) {
        let mut guard = db.0.lock().unwrap();
        sync::store_notifications(&mut guard, threads).unwrap();
    }

    fn notification_count(db: &Db) -> i64 {
        let conn = db.0.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM notifications", [], |r| r.get(0))
            .unwrap()
    }

    fn status(db: &Db) -> sync::SyncStatus {
        let conn = db.0.lock().unwrap();
        sync::read_status(&conn).unwrap()
    }

    /// Persist a starting rate-limit bucket so `resolve_pending_subjects_core`'s seed read
    /// (`read_rate_buckets`) has a baseline before the first resolution call.
    fn seed_rate(db: &Db, r: RateLimit) {
        let mut tracker = sync::RateTracker::default();
        tracker.observe(r);
        let conn = db.0.lock().unwrap();
        tracker.persist(&conn).unwrap();
    }

    /// Records every emitted event so tests can assert on lifecycle/progress signalling.
    #[derive(Clone, Default)]
    struct RecordingSink {
        events: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    }

    impl RecordingSink {
        fn names(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .map(|(n, _)| n.clone())
                .collect()
        }

        /// The payload of the last event with the given name.
        fn payload(&self, name: &str) -> Option<serde_json::Value> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .rev()
                .find(|(n, _)| n == name)
                .map(|(_, p)| p.clone())
        }

        fn count(&self, name: &str) -> usize {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(n, _)| n == name)
                .count()
        }
    }

    impl EventSink for RecordingSink {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.events
                .lock()
                .unwrap()
                .push((event.to_string(), payload));
        }
    }

    fn thread(id: &str, repo_id: i64, repo: &str, title: &str) -> NotificationThread {
        let (owner, name) = repo.split_once('/').unwrap();
        NotificationThread {
            id: id.to_string(),
            repository: MinimalRepo {
                id: repo_id,
                name: name.to_string(),
                full_name: repo.to_string(),
                owner: RepoOwner {
                    login: owner.to_string(),
                },
                private: false,
                updated_at: Some("2026-01-01T00:00:00Z".to_string()),
            },
            subject: Subject {
                title: title.to_string(),
                url: Some(format!("https://api.github.com/repos/{repo}/issues/{id}")),
                subject_type: "Issue".to_string(),
            },
            reason: "subscribed".to_string(),
            updated_at: "2026-01-02T00:00:00Z".to_string(),
            url: format!("https://api.github.com/notifications/threads/{id}"),
        }
    }

    fn rate(resource: &str, remaining: i64, limit: i64) -> RateLimit {
        RateLimit {
            resource: Some(resource.to_string()),
            limit: Some(limit),
            remaining: Some(remaining),
            reset: Some(9_999_999_999),
            poll_interval: None,
            retry_after: None,
        }
    }

    /* --------------------------------- sync_now ------------------------------- */

    #[test]
    fn sync_now_core_stores_threads_and_emits_lifecycle() {
        let db = db_with_token();
        let sink = RecordingSink::default();

        let (result, token) = tauri::async_runtime::block_on(sync_now_core(
            &db,
            sink.clone(),
            |token, on_page| async move {
                assert_eq!(token, "test-token");
                on_page(1, 2);
                Ok(FetchOutcome {
                    threads: vec![
                        thread("1", 100, "octo/repo-a", "First"),
                        thread("2", 100, "octo/repo-a", "Second"),
                    ],
                    rate: rate("core", 4990, 5000),
                })
            },
        ))
        .unwrap();

        assert_eq!(result.count, 2);
        assert_eq!(result.removed, 0);
        assert_eq!(result.rate_remaining, Some(4990));
        // The core hands back the same token it fetched with, for the background resolver.
        assert_eq!(token, "test-token");
        assert_eq!(notification_count(&db), 2);

        assert_eq!(
            sink.names(),
            vec!["sync:started", "sync:progress", "sync:done"]
        );
        assert_eq!(
            sink.payload("sync:progress"),
            Some(serde_json::json!({ "page": 1, "fetched": 2 }))
        );
        assert_eq!(status(&db).last_status.as_deref(), Some("success"));
    }

    #[test]
    fn sync_now_core_without_token_errors_before_emitting() {
        let db = mem_db();
        let sink = RecordingSink::default();
        let mut called = false;

        let result = tauri::async_runtime::block_on(sync_now_core(&db, sink.clone(), |_, _| {
            called = true;
            async move {
                Ok(FetchOutcome {
                    threads: vec![],
                    rate: RateLimit::default(),
                })
            }
        }));

        assert!(result.unwrap_err().contains("Not connected"));
        assert!(!called, "fetch must not run when no token is stored");
        assert!(sink.names().is_empty(), "no events before the token check");
    }

    #[test]
    fn sync_now_core_fetch_error_records_and_emits_error() {
        let db = db_with_token();
        let sink = RecordingSink::default();

        let result =
            tauri::async_runtime::block_on(sync_now_core(&db, sink.clone(), |_, _| async move {
                Err(GitHubError::Unauthorized)
            }));

        let err = result.unwrap_err();
        assert!(err.contains("401"), "surfaced error: {err}");
        assert_eq!(sink.names(), vec!["sync:started", "sync:error"]);
        // The failure is persisted so the UI reflects the real last outcome.
        let st = status(&db);
        assert_eq!(st.last_status.as_deref(), Some("error"));
        assert!(st.last_error.unwrap().contains("401"));
    }

    /* ------------------------------ mutate_threads ---------------------------- */

    #[test]
    fn mutate_threads_empty_is_noop() {
        let db = db_with_token();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        let result = tauri::async_runtime::block_on(mutate_threads(
            &db,
            vec![],
            move |_token, _id| {
                c.fetch_add(1, Ordering::SeqCst);
                async move { Ok(RateLimit::default()) }
            },
            sync::mark_done_local,
        ))
        .unwrap();

        assert_eq!(result.ok, 0);
        assert!(result.failed.is_empty());
        assert_eq!(result.rate_remaining, None);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn mutate_threads_all_succeed_and_apply_locally() {
        let db = db_with_token();
        store(
            &db,
            &[
                thread("1", 100, "octo/repo-a", "First"),
                thread("2", 100, "octo/repo-a", "Second"),
                thread("3", 100, "octo/repo-a", "Third"),
            ],
        );

        let result = tauri::async_runtime::block_on(mutate_threads(
            &db,
            vec!["1".into(), "2".into(), "3".into()],
            |token, _id| {
                assert_eq!(token, "test-token");
                async move { Ok(rate("core", 4900, 5000)) }
            },
            sync::mark_done_local,
        ))
        .unwrap();

        assert_eq!(result.ok, 3);
        assert!(result.failed.is_empty());
        assert_eq!(result.rate_remaining, Some(4900));
        assert_eq!(notification_count(&db), 0, "done threads are removed");
    }

    #[test]
    fn mutate_threads_reports_partial_failure_and_only_applies_successes() {
        let db = db_with_token();
        store(
            &db,
            &[
                thread("ok-1", 100, "octo/repo-a", "First"),
                thread("bad-2", 100, "octo/repo-a", "Second"),
                thread("ok-3", 100, "octo/repo-a", "Third"),
            ],
        );

        let result = tauri::async_runtime::block_on(mutate_threads(
            &db,
            vec!["ok-1".into(), "bad-2".into(), "ok-3".into()],
            |_token, id| async move {
                if id.starts_with("bad") {
                    Err(MutationError {
                        rate: rate("core", 4800, 5000),
                        error: GitHubError::Status {
                            status: reqwest::StatusCode::NOT_FOUND,
                            body: "gone".into(),
                        },
                    })
                } else {
                    Ok(rate("core", 4850, 5000))
                }
            },
            sync::mark_done_local,
        ))
        .unwrap();

        assert_eq!(result.ok, 2);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].thread_id, "bad-2");
        // Failed request's rate snapshot is folded in too — 4800 is the lowest seen.
        assert_eq!(result.rate_remaining, Some(4800));
        // Only the two successes were removed; the failed thread specifically remains.
        assert_eq!(notification_count(&db), 1);
        let conn = db.0.lock().unwrap();
        let remaining: String = conn
            .query_row("SELECT thread_id FROM notifications", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, "bad-2");
    }

    #[test]
    fn mutate_threads_dedupes_repeated_ids() {
        let db = db_with_token();
        store(&db, &[thread("1", 100, "octo/repo-a", "First")]);
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        let result = tauri::async_runtime::block_on(mutate_threads(
            &db,
            vec!["1".into(), "1".into(), "1".into()],
            move |_token, _id| {
                c.fetch_add(1, Ordering::SeqCst);
                async move { Ok(rate("core", 4999, 5000)) }
            },
            sync::mark_done_local,
        ))
        .unwrap();

        assert_eq!(result.ok, 1);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "duplicate id issues one call"
        );
    }

    #[test]
    fn mutate_threads_without_token_errors() {
        let db = mem_db();
        let result = tauri::async_runtime::block_on(mutate_threads(
            &db,
            vec!["1".into()],
            |_token, _id| async move { Ok(RateLimit::default()) },
            sync::mark_done_local,
        ));
        assert!(result.unwrap_err().contains("Not connected"));
    }

    /* ------------------------- resolve_pending_subjects ----------------------- */

    fn ok_subject(remaining: i64) -> ResolveResult {
        ResolveResult {
            subject: ResolvedSubject {
                state: Some("open".into()),
                html_url: Some("https://github.com/octo/repo-a/issues/1".into()),
                ..Default::default()
            },
            rate: rate("core", remaining, 5000),
        }
    }

    #[test]
    fn resolve_core_resolves_all_pending_and_emits() {
        let db = db_with_token();
        store(
            &db,
            &[
                thread("1", 100, "octo/repo-a", "First"),
                thread("2", 100, "octo/repo-a", "Second"),
            ],
        );
        let sink = RecordingSink::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        tauri::async_runtime::block_on(resolve_pending_subjects_core(
            &db,
            sink.clone(),
            move |_url| {
                c.fetch_add(1, Ordering::SeqCst);
                async move { Ok(ok_subject(4990)) }
            },
        ));

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            sink.payload("subjects:resolved"),
            Some(serde_json::json!({ "count": 2 }))
        );
        // The started/done lifecycle pair brackets the pass (the frontend gates the "synced"
        // status on `subjects:resolution-done`).
        assert_eq!(sink.count("subjects:resolution-started"), 1);
        assert_eq!(
            sink.payload("subjects:resolution-done"),
            Some(serde_json::json!({ "changed": 2 }))
        );
        // Both rows resolved, so none still need resolution.
        let conn = db.0.lock().unwrap();
        assert!(sync::subjects_needing_resolution(&conn).unwrap().is_empty());
    }

    #[test]
    fn resolve_core_emits_done_even_with_no_pending() {
        let db = db_with_token();
        let sink = RecordingSink::default();

        tauri::async_runtime::block_on(resolve_pending_subjects_core(
            &db,
            sink.clone(),
            |_url| async move { Ok(ok_subject(4990)) },
        ));

        // No work, but the lifecycle pair must still fire so the frontend gate never sticks.
        assert_eq!(sink.count("subjects:resolved"), 0);
        assert_eq!(sink.count("subjects:resolution-started"), 1);
        assert_eq!(
            sink.payload("subjects:resolution-done"),
            Some(serde_json::json!({ "changed": 0 }))
        );
    }

    #[test]
    fn resolve_core_stops_once_it_crosses_the_reserve() {
        let db = db_with_token();
        let threads: Vec<_> = (0..10)
            .map(|i| thread(&format!("{i}"), 100, "octo/repo-a", "T"))
            .collect();
        store(&db, &threads);
        let sink = RecordingSink::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        // Resolution is serial and the reserve is checked after each request. The first
        // response already reports quota at/under the 25% reserve, so the loop stops right
        // after it — leaving the remaining subjects for a later sync.
        tauri::async_runtime::block_on(resolve_pending_subjects_core(
            &db,
            sink.clone(),
            move |_url| {
                c.fetch_add(1, Ordering::SeqCst);
                async move { Ok(ok_subject(1000)) }
            },
        ));

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "serial resolution stops as soon as one request crosses the reserve"
        );
        assert_eq!(
            sink.payload("subjects:resolved"),
            Some(serde_json::json!({ "count": 1 }))
        );
    }

    #[test]
    fn resolve_core_skips_entirely_when_already_below_reserve() {
        let db = db_with_token();
        store(&db, &[thread("1", 100, "octo/repo-a", "First")]);
        // Seed a bucket already under the reserve, so resolution never starts.
        seed_rate(&db, rate("core", 100, 5000));
        let sink = RecordingSink::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        tauri::async_runtime::block_on(resolve_pending_subjects_core(
            &db,
            sink.clone(),
            move |_url| {
                c.fetch_add(1, Ordering::SeqCst);
                async move { Ok(ok_subject(50)) }
            },
        ));

        assert_eq!(calls.load(Ordering::SeqCst), 0, "no calls when already low");
        assert_eq!(sink.count("subjects:resolved"), 0);
    }

    #[test]
    fn resolve_core_no_pending_is_a_noop() {
        let db = db_with_token();
        let sink = RecordingSink::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        tauri::async_runtime::block_on(resolve_pending_subjects_core(
            &db,
            sink.clone(),
            move |_url| {
                c.fetch_add(1, Ordering::SeqCst);
                async move { Ok(ok_subject(4990)) }
            },
        ));

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(sink.count("subjects:resolved"), 0);
    }

    #[test]
    fn resolve_core_counts_only_successes_when_some_fail() {
        let db = db_with_token();
        store(
            &db,
            &[
                thread("ok-1", 100, "octo/repo-a", "First"),
                thread("bad-2", 100, "octo/repo-a", "Second"),
            ],
        );
        let sink = RecordingSink::default();

        tauri::async_runtime::block_on(resolve_pending_subjects_core(
            &db,
            sink.clone(),
            move |url| async move {
                if url.contains("bad-2") {
                    Err(ResolveError {
                        rate: rate("core", 4980, 5000),
                        error: GitHubError::Status {
                            status: reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                            body: "boom".into(),
                        },
                    })
                } else {
                    Ok(ok_subject(4990))
                }
            },
        ));

        // Only the successful subject counts toward the emitted change total.
        assert_eq!(
            sink.payload("subjects:resolved"),
            Some(serde_json::json!({ "count": 1 }))
        );
        // The failed subject is left unresolved, so it's still pending for a later sync;
        // the resolved one has dropped out.
        let conn = db.0.lock().unwrap();
        let pending = sync::subjects_needing_resolution(&conn).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].thread_id, "bad-2");
    }

    #[test]
    fn resolve_core_backs_off_on_a_rate_limit_403() {
        let db = db_with_token();
        let threads: Vec<_> = (0..5)
            .map(|i| thread(&format!("{i}"), 100, "octo/repo-a", "T"))
            .collect();
        store(&db, &threads);
        let sink = RecordingSink::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        // The first request comes back 403 (a secondary rate limit) — resolution must abort
        // the whole pass immediately rather than keep firing into the limit.
        tauri::async_runtime::block_on(resolve_pending_subjects_core(
            &db,
            sink.clone(),
            move |_url| {
                c.fetch_add(1, Ordering::SeqCst);
                async move {
                    Err(ResolveError {
                        rate: rate("core", 4990, 5000),
                        error: GitHubError::Forbidden("secondary rate limit".into()),
                    })
                }
            },
        ));

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "a 403 stops the whole resolution pass after the first request"
        );
        assert_eq!(sink.count("subjects:resolved"), 0);
    }
}
