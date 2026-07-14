//! Tauri command layer for the Dependabot module, built on the `dependabot` data layer.
//! Mirrors `coordinator.rs` for its own domain: thin `#[tauri::command]` wrappers delegate
//! to Tauri-free `*_core` functions that take `&Db`, an [`EventSink`], and the network op as
//! an injected closure, so the fetch/store and background merge-state resolution can be
//! tested without a Tauri runtime or real HTTP.
//!
//! SQLite lock discipline (same as `coordinator`): the DB lock is never held across network
//! or Keychain I/O — each pass takes it only briefly to snapshot work or record results.

use crate::db::Db;
use crate::{auth, dependabot, github, settings, sync, AppState, EventSink};
use serde::Serialize;
use tauri::{Manager, State};

/// Quota tuning for the background merge-state resolution (mirrors the notification
/// subject-resolution knob in `coordinator::tuning`). Resolution runs serially (see
/// `resolve_pending_merge_states_core`) to respect GitHub's secondary-rate-limit guidance,
/// so there is no concurrency knob.
mod tuning {
    /// Soft reserve: stop resolving before spending below this fraction of any rate bucket,
    /// leaving quota for the next fetch + the notifications module.
    pub const RATE_RESERVE_FRACTION: f64 = 0.25;
}

/// Take the DB lock and run a best-effort write, logging (rather than surfacing) a poisoned
/// lock or a write failure. Domain-local twin of `coordinator::best_effort` — kept here so
/// the Dependabot domain doesn't depend on the notifications command module.
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

/// Result of a successful Dependabot sync, returned to the caller and emitted as
/// `dependabot:done`.
#[derive(Debug, Clone, Serialize)]
pub struct DependabotSyncResult {
    count: usize,
    removed: usize,
    rate_remaining: Option<i64>,
    /// False when the enumeration didn't cover everything — a repo was skipped (e.g. a 404
    /// from a repo the token can't read PRs for) or it stopped early on the quota reserve. The
    /// frontend surfaces a gentle note so an incomplete result isn't mistaken for "no PRs".
    complete: bool,
}

/// Read all stored Dependabot PRs grouped by repository (offline-first local read).
#[tauri::command]
pub fn list_dependabot(
    state: State<'_, AppState>,
) -> Result<Vec<dependabot::DependabotRepoGroup>, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    dependabot::list_by_repo(&conn).map_err(|e| e.to_string())
}

/// Persisted Dependabot module status, surfaced to the UI on load.
#[derive(Debug, Clone, Serialize)]
pub struct DependabotStatus {
    /// ISO-8601 UTC time of the last successful sync, or null if never synced. Drives the
    /// "Synced …" label and the auto-sync staleness gate across app restarts.
    last_sync_at: Option<String>,
}

/// Read the Dependabot module's persisted status (last successful sync time).
#[tauri::command]
pub fn dependabot_status(state: State<'_, AppState>) -> Result<DependabotStatus, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    let last_sync_at = settings::get_string(&conn, settings::KEY_DEPENDABOT_LAST_SYNC)
        .map_err(|e| e.to_string())?;
    Ok(DependabotStatus { last_sync_at })
}

/// Fetch open Dependabot PRs across the notification-sourced repo list and store them locally,
/// emitting progress events.
///
/// The repo list (`dependabot_repos`) is built lazily from the notifications Helix fetches, so
/// no repo discovery happens here. Emits `dependabot:started`, `dependabot:progress`
/// ({ scanned, found }), and `dependabot:done` / `dependabot:error`. Enumeration runs without
/// holding the DB lock; storage happens in a single transaction afterwards; per-repo failures
/// update each repo's drop counter. Merge-readiness is then resolved in the background
/// (emitting `dependabot:resolved`) so the sync returns immediately.
#[tauri::command]
pub async fn sync_dependabot(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<DependabotSyncResult, String> {
    // Keep the fetch and its eventual reconciliation atomic with respect to explicit closes:
    // otherwise an already-fetched open row could be written back after discard removes it.
    let _pr_mutation_lease = state.dependabot_pr_mutation_guard.lock().await;
    // Snapshot the repo list under the lock, then release it before any network I/O.
    let repos: Vec<(String, String)> = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        dependabot::list_repos(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|r| (r.owner, r.name))
            .collect()
    };

    // No repos seen yet (e.g. notifications haven't been synced) → nothing to fetch. Report an
    // empty, complete result so the module shows its empty state without touching the network.
    if repos.is_empty() {
        return Ok(DependabotSyncResult {
            count: 0,
            removed: 0,
            rate_remaining: None,
            complete: true,
        });
    }

    let (result, token) = sync_dependabot_core(
        &state.db,
        app.clone(),
        move |token, on_progress| async move {
            github::fetch_dependabot_prs_for_repos(&token, &repos, on_progress).await
        },
    )
    .await?;

    // Resolve merge-readiness (mergeable_state) in the background, reusing the same token.
    let resolve_app = app.clone();
    tauri::async_runtime::spawn(async move {
        resolve_pending_merge_states(resolve_app, token).await;
    });

    Ok(result)
}

/// Tauri-free core of [`sync_dependabot`]: reads the token, fetches via the injected `fetch`
/// closure, stores + reconciles the results, folds the rate snapshot, and emits lifecycle
/// events through `sink`. Returns the [`DependabotSyncResult`] with the token used, so the
/// wrapper hands the same credential to the background merge-state resolver.
async fn sync_dependabot_core<S, Fetch, Fut>(
    db: &Db,
    sink: S,
    fetch: Fetch,
) -> Result<(DependabotSyncResult, String), String>
where
    S: EventSink + Clone + Send + Sync + 'static,
    Fetch: FnOnce(String, Box<dyn Fn(usize, usize) + Send>) -> Fut,
    Fut: std::future::Future<Output = Result<github::DependabotFetchOutcome, github::GitHubError>>,
{
    let token = auth::read_token(db)?
        .ok_or_else(|| "Not connected — add a GitHub token first.".to_string())?;

    sink.emit("dependabot:started", serde_json::Value::Null);

    let progress_sink = sink.clone();
    let on_progress: Box<dyn Fn(usize, usize) + Send> = Box::new(move |scanned, found| {
        progress_sink.emit(
            "dependabot:progress",
            serde_json::json!({ "scanned": scanned, "found": found }),
        );
    });
    let outcome = match fetch(token.clone(), on_progress).await {
        Ok(o) => o,
        Err(err) => {
            let err = err.to_string();
            sink.emit(
                "dependabot:error",
                serde_json::json!({ "message": err.clone() }),
            );
            return Err(err);
        }
    };

    // Store the PRs and persist the core bucket's rate snapshot.
    let store_result = (|| -> Result<dependabot::StoreOutcome, String> {
        let mut guard = db.0.lock().map_err(|e| e.to_string())?;
        let conn: &mut rusqlite::Connection = &mut guard;
        let stored = dependabot::store_prs(conn, &outcome.prs, outcome.complete)
            .map_err(|e| e.to_string())?;
        let mut rate = sync::RateTracker::default();
        rate.observe(outcome.rate.clone());
        rate.persist(conn).map_err(|e| e.to_string())?;
        Ok(stored)
    })();

    let stored = match store_result {
        Ok(s) => s,
        Err(err) => {
            sink.emit(
                "dependabot:error",
                serde_json::json!({ "message": err.clone() }),
            );
            return Err(err);
        }
    };

    // Apply per-repo outcomes to the drop counters: a successful scan resets a repo's counter;
    // an access failure (404 / non-rate 403) increments it and drops the repo (and its PRs)
    // once it's failed too many consecutive times. Best-effort — never fails the sync.
    best_effort(&db.0, "updating Dependabot repo failure counters", |conn| {
        for full_name in &outcome.ok_repos {
            dependabot::record_repo_success(conn, full_name)?;
        }
        for full_name in &outcome.failed_repos {
            if dependabot::record_repo_failure(conn, full_name)? {
                dependabot::drop_repo(conn, full_name)?;
            }
        }
        Ok::<(), rusqlite::Error>(())
    });

    // Persist the last successful sync time so the "Synced …" label and the auto-sync
    // staleness gate survive app restarts (best-effort — never fails the sync).
    best_effort(&db.0, "recording the Dependabot sync time", |conn| {
        settings::set_timestamp_now(conn, settings::KEY_DEPENDABOT_LAST_SYNC)
    });

    let result = DependabotSyncResult {
        count: stored.stored,
        removed: stored.removed,
        rate_remaining: outcome.rate.remaining,
        complete: outcome.complete,
    };
    sink.emit(
        "dependabot:done",
        serde_json::to_value(&result).unwrap_or(serde_json::Value::Null),
    );

    Ok((result, token))
}

/// Thin wrapper: build the production `resolve(pull_url)` closure and delegate to the core.
async fn resolve_pending_merge_states(app: tauri::AppHandle, token: String) {
    let state = app.state::<AppState>();
    let client = reqwest::Client::new();
    let resolve = move |url: String| {
        let client = client.clone();
        let token = token.clone();
        async move { github::resolve_subject(&client, &url, &token).await }
    };
    resolve_pending_merge_states_core(&state.db, app.clone(), resolve).await;
}

/// Tauri-free core of the background merge-state resolution: the serial, rate-reserve-budgeted
/// per-PR resolve+store loop, with the network call injected as `resolve(url)` and events sent
/// through `sink`. Mirrors `coordinator::resolve_pending_subjects_core` but for the
/// `dependabot_prs` table. Emits `dependabot:resolved` when anything changed.
async fn resolve_pending_merge_states_core<S, R, Fut>(db: &Db, sink: S, resolve: R)
where
    S: EventSink,
    R: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<github::ResolveResult, github::ResolveError>>,
{
    // Snapshot the work under the lock, then release it before any network I/O.
    let pending = {
        let Ok(conn) = db.0.lock() else {
            return;
        };
        match dependabot::prs_needing_merge_state(&conn) {
            Ok(p) => p,
            Err(_) => return,
        }
    };
    if pending.is_empty() {
        return;
    }

    const RESERVE_FRACTION: f64 = tuning::RATE_RESERVE_FRACTION;

    let mut changed = 0usize;
    // Seed the tracker with the recorded per-bucket quota so the budget check has a baseline.
    let mut rate = sync::RateTracker::default();
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
    // Already low on quota? Don't start — leave every PR for a future sync.
    if rate.below_reserve(RESERVE_FRACTION) {
        return;
    }

    // Resolve **serially** (one request at a time), per GitHub's secondary-rate-limit
    // guidance ("make requests serially, not concurrently"): a burst of concurrent PR fetches
    // is the classic secondary-limit trigger. Real network latency paces the loop; the reserve
    // check bounds primary-quota spend; and any back-off signal (a 403 / `Retry-After`) stops
    // the whole pass so we don't hammer into the limit — the rest resolves on a later sync.
    for p in &pending {
        match resolve(p.pull_url.clone()).await {
            Ok(result) => {
                rate.observe(result.rate.clone());
                match db.0.lock() {
                    Ok(conn) => match dependabot::store_merge_state(&conn, p.id, &result.subject) {
                        Ok(()) => changed += 1,
                        Err(e) => {
                            eprintln!("helix: storing merge state for PR {} failed: {e}", p.id)
                        }
                    },
                    Err(e) => eprintln!(
                        "helix: storing merge state for PR {} failed: database lock poisoned: {e}",
                        p.id
                    ),
                }
            }
            Err(err) => {
                // A failed resolution still spent quota — count it toward the reserve.
                rate.observe(err.rate.clone());
                if err.should_back_off() {
                    eprintln!(
                        "dependabot merge-state resolution backing off (rate limited): {}",
                        err.error
                    );
                    break;
                }
                eprintln!(
                    "dependabot merge-state resolution failed for PR {}: {}",
                    p.id, err.error
                );
            }
        }

        // Stop once we've crossed the reserve; the rest waits for a later sync.
        if rate.below_reserve(RESERVE_FRACTION) {
            break;
        }
    }

    best_effort(&db.0, "persisting rate limits", |conn| rate.persist(conn));

    if changed > 0 {
        sink.emit(
            "dependabot:resolved",
            serde_json::json!({ "count": changed }),
        );
    }
}

/* ------------------------- Durable merge operations ------------------------ */

/// Current queue runtime and cadence contract for the frontend. `backoff_until` is an ISO UTC
/// timestamp so it survives restarts and can be displayed without reconstructing a duration.
#[derive(Debug, Clone, Serialize)]
pub struct DependabotMergeStatus {
    pub active_count: i64,
    pub poll_interval_s: i64,
    pub min_poll_interval_s: i64,
    pub github_poll_floor_s: Option<i64>,
    pub backoff_until: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DependabotMergeProcessResult {
    pub status: DependabotMergeStatus,
    pub processed: usize,
    pub changed: bool,
}

fn merge_status(conn: &rusqlite::Connection) -> Result<DependabotMergeStatus, String> {
    let sql = format!(
        "SELECT COUNT(*) FROM dependabot_merge_operations
         WHERE state IN ({active_states})",
        active_states = dependabot::ACTIVE_STATES,
    );
    let active_count = conn
        .query_row(&sql, [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let runtime = dependabot::merge_runtime(conn).map_err(|e| e.to_string())?;
    Ok(DependabotMergeStatus {
        active_count,
        poll_interval_s: settings::get_dependabot_merge_poll_interval(conn)
            .map_err(|e| e.to_string())?,
        min_poll_interval_s: settings::MIN_DEPENDABOT_MERGE_POLL_INTERVAL_S,
        github_poll_floor_s: runtime.github_poll_floor_s,
        backoff_until: runtime.backoff_until,
        last_error: runtime.last_error,
    })
}

#[tauri::command]
pub async fn enqueue_dependabot_merge(
    pr_id: i64,
    state: State<'_, AppState>,
) -> Result<dependabot::DependabotMergeOperation, String> {
    let _mutation_lease = state.dependabot_merge_mutation_guard.lock().await;
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    dependabot::enqueue_merge_operation(&conn, pr_id).map_err(|e| {
        if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
            "This Dependabot PR is not in the local cache. Sync Dependabot and try again."
                .to_string()
        } else {
            e.to_string()
        }
    })
}

#[tauri::command]
pub async fn cancel_dependabot_merge(
    operation_id: i64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<dependabot::DependabotMergeOperation, String> {
    let _mutation_lease = state.dependabot_merge_mutation_guard.lock().await;
    let operation = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        dependabot::request_cancel(&conn, operation_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Dependabot merge operation was not found.".to_string())?
    };
    EventSink::emit(
        &app,
        "dependabot:operations-changed",
        serde_json::json!({ "operation_id": operation_id }),
    );
    Ok(operation)
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiscardDependabotPrStatus {
    Cancelling,
    Closed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DiscardDependabotPrResult {
    pub status: DiscardDependabotPrStatus,
    pub pr_id: i64,
    pub operation_id: Option<i64>,
}

async fn discard_dependabot_pr_core<S, Close, Fut>(
    db: &Db,
    sink: S,
    pr_id: i64,
    close: Close,
) -> Result<DiscardDependabotPrResult, String>
where
    S: EventSink,
    Close: FnOnce(String, i64) -> Fut,
    Fut:
        std::future::Future<Output = Result<github::ClosePullRequestResult, github::MutationError>>,
{
    let (target, cancelled_operation) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let target = dependabot::get_cached_pr(&conn, pr_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                "This Dependabot PR is not in the local cache. Sync Dependabot and try again."
                    .to_string()
            })?;
        let cancelled_operation = match dependabot::get_active_operation_for_pr(&conn, pr_id)
            .map_err(|e| e.to_string())?
        {
            Some(operation) => {
                dependabot::request_cancel(&conn, operation.id).map_err(|e| e.to_string())?
            }
            None => None,
        };
        (target, cancelled_operation)
    };

    if let Some(operation) = &cancelled_operation {
        sink.emit(
            "dependabot:operations-changed",
            serde_json::json!({ "operation_id": operation.id }),
        );
        if operation.state != "cancelled" {
            return Ok(DiscardDependabotPrResult {
                status: DiscardDependabotPrStatus::Cancelling,
                pr_id,
                operation_id: Some(operation.id),
            });
        }
    }

    let result = close(target.repo_full_name, target.number).await;
    let mut tracker = sync::RateTracker::default();
    match result {
        Ok(result) => {
            tracker.observe(result.rate);
            if result.outcome == github::ClosePullRequestOutcome::Merged {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                tracker.persist(&conn).map_err(|e| e.to_string())?;
                return Err(format!(
                    "#{} {} merged before Helix could discard it.",
                    target.number, target.title
                ));
            }
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            dependabot::remove_cached_pr(&conn, pr_id).map_err(|e| e.to_string())?;
            tracker.persist(&conn).map_err(|e| e.to_string())?;
        }
        Err(error) => {
            tracker.observe(error.rate);
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            tracker.persist(&conn).map_err(|e| e.to_string())?;
            return Err(format!(
                "Couldn't close #{} {}: {}",
                target.number, target.title, error.error
            ));
        }
    }

    sink.emit("dependabot:changed", serde_json::json!({ "pr_id": pr_id }));
    Ok(DiscardDependabotPrResult {
        status: DiscardDependabotPrStatus::Closed,
        pr_id,
        operation_id: cancelled_operation.map(|operation| operation.id),
    })
}

#[tauri::command]
pub async fn discard_dependabot_pr(
    pr_id: i64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<DiscardDependabotPrResult, String> {
    let token = auth::read_token(&state.db)?
        .ok_or_else(|| "Not connected — add a GitHub token first.".to_string())?;
    let client = reqwest::Client::new();
    let _pr_mutation_lease = state.dependabot_pr_mutation_guard.lock().await;
    let _mutation_lease = state.dependabot_merge_mutation_guard.lock().await;
    discard_dependabot_pr_core(&state.db, app, pr_id, move |repo, number| async move {
        github::close_pull_request(&client, &token, &repo, number).await
    })
    .await
}

#[tauri::command]
pub fn list_dependabot_merge_operations(
    state: State<'_, AppState>,
) -> Result<Vec<dependabot::DependabotMergeOperation>, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    dependabot::list_merge_operations(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn dependabot_merge_status(
    state: State<'_, AppState>,
) -> Result<DependabotMergeStatus, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    merge_status(&conn)
}

/// The operation-detail IPC view: `dependabot::MergeOperationDetail` (persistence) carries only
/// the operation row plus its raw narration trail. This pairs that with a user-facing
/// explanation of where the operation currently stands and what Helix (or GitHub) does next —
/// presentation concerns that belong in the coordinator, not the SQLite-only persistence layer.
/// Field names are already the shape the frontend expects (`dependabot-model.js`'s
/// `buildOperationDetailModel`): `{ operation, events, current_explanation, next_action }`.
#[derive(Debug, Clone, Serialize)]
pub struct DependabotMergeOperationDetail {
    pub operation: dependabot::DependabotMergeOperation,
    pub events: Vec<dependabot::MergeOperationEvent>,
    pub current_explanation: String,
    pub next_action: String,
}

/// Tauri-free core: reads the operation + its event trail from SQLite (never touches the
/// network) and enriches it with `phase_explanation`. `Ok(None)` when the id doesn't exist, so
/// the command wrapper can turn that into a user-facing "not found" error.
fn operation_detail_core(
    conn: &rusqlite::Connection,
    operation_id: i64,
) -> rusqlite::Result<Option<DependabotMergeOperationDetail>> {
    let Some(detail) = dependabot::get_operation_detail(conn, operation_id)? else {
        return Ok(None);
    };
    let (current_explanation, next_action) = phase_explanation(&detail.operation);
    Ok(Some(DependabotMergeOperationDetail {
        operation: detail.operation,
        events: detail.events,
        current_explanation,
        next_action,
    }))
}

/// User-facing narration of an operation's current step and what happens next — exhaustive over
/// every phase the processor can plan through (`dependabot-model.js`'s `PHASES`) plus every
/// terminal outcome. Terminal `state`s (and `cancel_requested`, which can interrupt any phase)
/// take priority over `phase`: once an operation has stopped or is stopping, its last-recorded
/// phase is just where it happened to be, not itself meaningful to narrate. An unrecognized
/// phase (e.g. a future addition this function hasn't been updated for) degrades to a generic
/// but still informative message rather than panicking or leaving the UI blank.
fn phase_explanation(operation: &dependabot::DependabotMergeOperation) -> (String, String) {
    match operation.state.as_str() {
        "merged" => {
            return (
                "The pull request has been merged.".to_string(),
                "No further action — this operation is complete.".to_string(),
            );
        }
        "cancelled" => {
            return (
                "This merge operation was cancelled.".to_string(),
                "No further action — this operation is complete. Re-enqueue the pull request if it should still be merged.".to_string(),
            );
        }
        "timed_out" => {
            return (
                "Helix stopped waiting for this pull request to become mergeable within the allotted time.".to_string(),
                "No further action from this operation — re-enqueue the pull request to try again.".to_string(),
            );
        }
        "failed" => {
            let reason = operation
                .failure_reason
                .as_deref()
                .or(operation.last_error.as_deref())
                .unwrap_or("an unspecified error");
            return (
                format!("The merge operation failed: {reason}."),
                "No further action from this operation — resolve the issue, then re-enqueue the pull request.".to_string(),
            );
        }
        "cancel_requested" => {
            return (
                "Cancellation requested; Helix will stop processing this pull request at the next safe point.".to_string(),
                "Wait for the in-flight step to finish — the operation will then move to cancelled.".to_string(),
            );
        }
        _ => {}
    }

    match dependabot::MergePhase::from_db(&operation.phase) {
        dependabot::MergePhase::Queued => (
            "Waiting for Helix to start processing this pull request.".to_string(),
            "Validate that the pull request is still open and mergeable.".to_string(),
        ),
        dependabot::MergePhase::Validating => (
            "Confirming the pull request is still open, mergeable, and matches the last observed commit.".to_string(),
            "Resolve the merge strategy for this repository and branch.".to_string(),
        ),
        dependabot::MergePhase::UpdatingBranch => (
            "Updating the pull request's branch with the latest changes from its base branch.".to_string(),
            "Wait for status checks to run against the updated branch.".to_string(),
        ),
        dependabot::MergePhase::WaitingRequirements => (
            "GitHub still reports this pull request as blocked, but no pending or failing checks are visible yet.".to_string(),
            "Wait for GitHub to publish the remaining requirement or allow the merge.".to_string(),
        ),
        dependabot::MergePhase::ApprovingWorkflows => (
            "Approving GitHub Actions workflow runs for the accepted pull request head.".to_string(),
            "Wait for GitHub to start the released workflows and publish their checks.".to_string(),
        ),
        dependabot::MergePhase::WaitingChecks => (
            "Waiting for required status checks to finish on the pull request.".to_string(),
            "Once checks succeed, continue toward merging; retry them if any fail.".to_string(),
        ),
        dependabot::MergePhase::RetryScheduled => (
            "A required check failed or hasn't started; Helix has scheduled a retry.".to_string(),
            "Re-run the failed checks once the retry delay elapses.".to_string(),
        ),
        dependabot::MergePhase::RetryingChecks => (
            "Re-running the status checks that previously failed.".to_string(),
            "Wait for the retried checks to complete.".to_string(),
        ),
        dependabot::MergePhase::EnablingAutoMerge => (
            "Enabling GitHub's native auto-merge for this pull request.".to_string(),
            "Wait for the pull request to enter (or clear) the merge queue.".to_string(),
        ),
        dependabot::MergePhase::WaitingMergeQueue => (
            "Waiting in GitHub's merge queue for this pull request.".to_string(),
            "GitHub will merge the pull request automatically once the queue processes it.".to_string(),
        ),
        dependabot::MergePhase::Merging => (
            "Merging the pull request.".to_string(),
            "No further action — Helix is completing the merge.".to_string(),
        ),
        dependabot::MergePhase::Unknown(other) => (
            format!("Processing this pull request (phase: {other})."),
            "Waiting for Helix to make further progress.".to_string(),
        ),
    }
}

/// Read one merge operation's full detail (operation + narration trail + a user-facing
/// explanation of its current phase and what happens next) for the expanded row in the UI.
#[tauri::command]
pub fn get_dependabot_merge_operation_detail(
    operation_id: i64,
    state: State<'_, AppState>,
) -> Result<DependabotMergeOperationDetail, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    operation_detail_core(&conn, operation_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Dependabot merge operation was not found.".to_string())
}

fn persist_merge_rates(conn: &rusqlite::Connection, rates: Vec<github::RateLimit>) {
    let mut tracker = sync::RateTracker::default();
    for rate in rates {
        tracker.observe(rate);
    }
    if let Err(error) = tracker.persist(conn) {
        eprintln!("helix: persisting Dependabot merge rate metadata failed: {error}");
    }
}

fn merge_rates_below_reserve(conn: &rusqlite::Connection) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs() as i64);
    sync::read_rate_buckets(conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|bucket| bucket.resource == "core" || bucket.resource == "graphql")
        .filter(|bucket| bucket.reset_at.is_none_or(|reset| reset > now))
        .any(|bucket| match (bucket.remaining, bucket.limit) {
            (Some(remaining), Some(limit)) if limit > 0 => {
                (remaining as f64) <= 0.25 * (limit as f64)
            }
            _ => false,
        })
}

fn rate_floor_and_backoff(rates: &[github::RateLimit]) -> (Option<i64>, Option<i64>) {
    let floor = rates.iter().filter_map(github::RateLimit::poll_floor).max();
    let backoff = rates.iter().filter_map(|rate| rate.retry_after).max();
    (floor, backoff)
}

/// Tauri-free queue processor. Work is snapshotted under SQLite, every network operation runs
/// with no lock held, then its result is persisted before the next (serial) call. The injected
/// function keeps all transition logic testable without HTTP.
async fn process_dependabot_merges_core<S, Process, Fut>(
    db: &Db,
    sink: S,
    process: Process,
) -> Result<DependabotMergeProcessResult, String>
where
    S: EventSink,
    Process: Fn(dependabot::MergeWork, bool) -> Fut,
    Fut: std::future::Future<Output = Result<github::MergeRemoteResult, github::MergeRemoteError>>,
{
    let heads = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        dependabot::record_merge_tick(&conn).map_err(|e| e.to_string())?;
        if dependabot::runtime_is_backing_off(&conn).map_err(|e| e.to_string())? {
            return Ok(DependabotMergeProcessResult {
                status: merge_status(&conn)?,
                processed: 0,
                changed: false,
            });
        }
        dependabot::merge_operation_heads(&conn).map_err(|e| e.to_string())?
    };

    let mut processed = 0usize;
    let mut changed = false;
    for work in heads {
        let was_cancel_requested = work.operation.state == "cancel_requested";
        {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            if merge_rates_below_reserve(&conn) {
                break;
            }
        }
        {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            if !dependabot::begin_merge_processing(&conn, work.operation.id)
                .map_err(|e| e.to_string())?
            {
                continue;
            }
        }
        let timed_out = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            dependabot::merge_processing_timed_out(&conn, work.operation.id)
                .map_err(|e| e.to_string())?
        };
        // A queue timeout may need remote disable/dequeue cleanup. Any error while confirming or
        // removing that enrollment must keep the operation active so the next same-repo FIFO item
        // cannot advance while GitHub might still merge this PR.
        let timeout_cleanup_in_flight = if timed_out {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let cached_queue_strategy = work
                .operation
                .base_ref
                .as_deref()
                .map(|base| {
                    dependabot::get_merge_policy(&conn, &work.operation.repo_full_name, base, None)
                })
                .transpose()
                .map_err(|e| e.to_string())?
                .flatten()
                .is_some_and(|policy| policy.strategy == "merge_queue");
            work.operation.strategy == "merge_queue" || cached_queue_strategy
        } else {
            false
        };
        let id = work.operation.id;
        match process(work, timed_out).await {
            Ok(result) => {
                let (floor, _) = rate_floor_and_backoff(&result.rates);
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                persist_merge_rates(&conn, result.rates);
                dependabot::clear_merge_runtime_error(&conn, floor).map_err(|e| e.to_string())?;
                let cancel_arrived_during_request = !was_cancel_requested
                    && dependabot::get_operation(&conn, id)
                        .map_err(|e| e.to_string())?
                        .is_some_and(|operation| {
                            matches!(operation.state.as_str(), "cancel_requested" | "cancelled")
                        });
                // A queue operation that has native auto-merge enabled (or a live queue entry)
                // must not be terminated locally while GitHub could still merge it: leave it in
                // `cancel_requested` so the next orchestrator pass disables auto-merge / dequeues
                // remotely under the mutation guard before the terminal cancel. A merged result
                // still wins the race (handled by the `Merged` guard below).
                let needs_remote_cancel_cleanup = dependabot::get_operation(&conn, id)
                    .map_err(|e| e.to_string())?
                    .is_some_and(|operation| {
                        operation.auto_merge_enabled || operation.merge_queue_position.is_some()
                    });
                if (was_cancel_requested || cancel_arrived_during_request)
                    && !matches!(
                        &result.outcome,
                        github::MergeRemoteOutcome::Merged { .. }
                            | github::MergeRemoteOutcome::Cancelled
                    )
                {
                    if !needs_remote_cancel_cleanup {
                        dependabot::mark_cancelled_or_timed_out(&conn, id, false)
                            .map_err(|e| e.to_string())?;
                    }
                    // When remote cleanup is still owed, deliberately leave the row in
                    // `cancel_requested` (do not run the state-mutating match below, which would
                    // resurrect it to `delegated`) so the next pass's orchestrator disables
                    // auto-merge / dequeues before the terminal cancel.
                    processed += 1;
                    changed = true;
                    continue;
                }
                match result.outcome {
                    github::MergeRemoteOutcome::Merged { head_sha } => {
                        dependabot::terminalize(
                            &conn,
                            id,
                            "merged",
                            None,
                            Some("Merged on GitHub."),
                            None,
                        )
                        .map_err(|e| e.to_string())?;
                        if let Some(head_sha) = head_sha {
                            dependabot::record_observation(
                                &conn,
                                id,
                                Some(&head_sha),
                                false,
                                "merged",
                                Some("Merged on GitHub."),
                            )
                            .map_err(|e| e.to_string())?;
                        }
                    }
                    github::MergeRemoteOutcome::Pending {
                        head_sha,
                        approved,
                        branch_update_requested,
                        reason,
                    } => {
                        dependabot::mark_merge_progress(
                            &conn,
                            id,
                            &head_sha,
                            approved,
                            branch_update_requested,
                            reason.as_deref(),
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    github::MergeRemoteOutcome::Cancelled => {
                        dependabot::mark_cancelled_or_timed_out(&conn, id, timed_out)
                            .map_err(|e| e.to_string())?;
                    }
                    github::MergeRemoteOutcome::PermanentFailure { code, reason } => {
                        dependabot::record_merge_error(&conn, id, code, &reason, true)
                            .map_err(|e| e.to_string())?;
                    }
                    // The orchestrator consumes `Prepared` internally and never hands it back to
                    // the FIFO loop; treat it defensively like `Waiting` (leave the row as-is)
                    // rather than forcing a state transition on an unexpected value.
                    github::MergeRemoteOutcome::Prepared { .. }
                    | github::MergeRemoteOutcome::Blocked { .. }
                    | github::MergeRemoteOutcome::Waiting => {}
                }
                processed += 1;
                changed = true;
            }
            Err(error) => {
                let (floor, retry_after) = rate_floor_and_backoff(&error.rates);
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                persist_merge_rates(&conn, error.rates);
                // A cancellation in flight whose remote cleanup (disable auto-merge / dequeue)
                // failed must NOT be terminalized here: doing so would abandon an operation that
                // may still be enrolled on GitHub. Instead keep it in `cancel_requested`, surface
                // the error/backoff, and let a later pass reconcile — retrying cleanup until it
                // succeeds (only then does the Ok(Cancelled) path terminalize cancelled). This
                // deliberately keeps the row the repo's FIFO head so the next same-repo PR stays
                // blocked rather than allowing two remotely active operations. Even a "permanent"
                // cleanup failure stays active for this reason; auth/rate still break globally.
                let cancel_cleanup_in_flight =
                    dependabot::merge_cancel_requested(&conn, id).map_err(|e| e.to_string())?;
                let (code, terminal) = match error.class {
                    github::MergeErrorClass::Auth => ("auth", false),
                    github::MergeErrorClass::Rate => ("rate_limited", false),
                    github::MergeErrorClass::Transient => ("transient", false),
                    github::MergeErrorClass::Permanent => ("github_permanent", true),
                };
                let terminal = terminal && !cancel_cleanup_in_flight && !timeout_cleanup_in_flight;
                dependabot::record_merge_error(&conn, id, code, &error.message, terminal)
                    .map_err(|e| e.to_string())?;
                dependabot::record_merge_runtime_error(
                    &conn,
                    &error.message,
                    floor,
                    if error.class == github::MergeErrorClass::Rate {
                        Some(retry_after.unwrap_or(60))
                    } else {
                        None
                    },
                )
                .map_err(|e| e.to_string())?;
                processed += 1;
                changed = true;
                // Auth and rate failure apply globally to the PAT/bucket; preserve all FIFO
                // heads and stop this pass rather than pointlessly trying another repository.
                if matches!(
                    error.class,
                    github::MergeErrorClass::Auth | github::MergeErrorClass::Rate
                ) {
                    break;
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    let status = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        merge_status(&conn)?
    };
    if changed {
        sink.emit(
            "dependabot:operations-changed",
            serde_json::json!({ "processed": processed }),
        );
    }
    Ok(DependabotMergeProcessResult {
        status,
        processed,
        changed,
    })
}

struct MergeTickGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for MergeTickGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

#[tauri::command]
pub async fn process_dependabot_merges(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<DependabotMergeProcessResult, String> {
    use std::sync::atomic::Ordering;
    if state
        .dependabot_merge_tick_running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        return Ok(DependabotMergeProcessResult {
            status: merge_status(&conn)?,
            processed: 0,
            changed: false,
        });
    }
    let _running = MergeTickGuard(&state.dependabot_merge_tick_running);
    // Keychain I/O happens before any DB lock and only once per processor tick.
    let token = match auth::read_token(&state.db)? {
        Some(token) => token,
        None => {
            let message = "Not connected — add a GitHub token first.";
            {
                let conn = state.db.0.lock().map_err(|e| e.to_string())?;
                dependabot::record_merge_runtime_error(&conn, message, None, None)
                    .map_err(|e| e.to_string())?;
            }
            EventSink::emit(
                &app,
                "dependabot:operations-changed",
                serde_json::json!({ "error": message }),
            );
            return Err(message.to_string());
        }
    };
    let client = reqwest::Client::new();
    let db = &state.db;
    let mutation_guard = &state.dependabot_merge_mutation_guard;
    process_dependabot_merges_core(&state.db, app, move |work, timed_out| {
        let backend = RealMergeBackend {
            client: client.clone(),
            token: token.clone(),
            mutation_guard,
            db,
            operation_id: work.operation.id,
        };
        async move { orchestrate_operation(db, &backend, work, timed_out).await }
    })
    .await
}

/* --------------------------- Durable phase orchestrator --------------------- */

/// How long a cached repo+base merge policy stays fresh before the orchestrator re-derives it
/// (requirement 2: refresh stale cache). One hour balances catching a repo that turns its merge
/// queue on/off against re-running detection on every poll.
const POLICY_MAX_AGE_S: i64 = 3600;

/// The five-minute backoff before re-running failed GitHub Actions jobs (requirement 4/5).
const CHECK_RETRY_DELAY_S: i64 = 300;

/// Headroom (minutes) a freshly scheduled retry needs inside the 90-minute deadline; below this
/// the orchestrator stops scheduling new retries and lets the timeout take over.
const RETRY_DEADLINE_CUSHION_MIN: i64 = 6;

/// Backoff before retrying strategy detection when the policy is still `Unknown` — keeps an
/// ambiguous/unreadable policy visible and retryable (requirement 2) without hammering.
const UNKNOWN_POLICY_RETRY_S: i64 = 300;

fn strategy_str(strategy: github::MergeQueueStrategy) -> &'static str {
    match strategy {
        github::MergeQueueStrategy::Direct => "direct",
        github::MergeQueueStrategy::MergeQueue => "merge_queue",
        github::MergeQueueStrategy::Unknown => "unknown",
    }
}

fn strategy_from_str(strategy: Option<&str>) -> github::MergeQueueStrategy {
    match strategy {
        Some("direct") => github::MergeQueueStrategy::Direct,
        Some("merge_queue") => github::MergeQueueStrategy::MergeQueue,
        _ => github::MergeQueueStrategy::Unknown,
    }
}

/// The network surface the durable orchestrator drives, one thin wrapper per GitHub primitive.
/// Abstracting it as a trait keeps the whole phase machine — strategy detection, direct
/// retry cycles, and the merge-queue flow — testable with an injected fake, no HTTP or Tauri
/// runtime (requirement 10). Every method returns its captured rate snapshots (both `core` and
/// `graphql` buckets) so the orchestrator can persist them (requirement 7). Cancellation and the
/// shared mutation guard are the implementation's concern, not part of the trait surface.
#[allow(async_fn_in_trait)]
trait MergeBackend {
    async fn process_operation(
        &self,
        work: &dependabot::MergeWork,
        timed_out: bool,
        strategy: github::MergeQueueStrategy,
    ) -> Result<github::MergeRemoteResult, github::MergeRemoteError>;

    async fn detect_policy(
        &self,
        repo: &str,
        base: &str,
    ) -> Result<github::MergeQueuePolicy, github::MergeRemoteError>;

    async fn ref_update_restriction(
        &self,
        repo: &str,
        base: &str,
    ) -> Result<github::RefUpdateRestrictionResult, github::MergeRemoteError>;

    async fn diagnose(
        &self,
        repo: &str,
        head: &str,
    ) -> Result<github::ExactHeadCheckDiagnosis, github::MergeRemoteError>;

    async fn compare_branch(
        &self,
        repo: &str,
        base: &str,
        head: &str,
    ) -> Result<github::BranchComparisonResult, github::MergeRemoteError>;

    async fn current_head(
        &self,
        pull_url: &str,
    ) -> Result<github::PullHeadResult, github::MergeRemoteError>;

    async fn update_branch(
        &self,
        repo: &str,
        number: i64,
        head: &str,
    ) -> Result<github::MutationResult, github::MergeRemoteError>;

    async fn rerun(
        &self,
        repo: &str,
        run_id: i64,
    ) -> Result<github::MutationResult, github::MergeRemoteError>;

    async fn approve_workflow(
        &self,
        repo: &str,
        run_id: i64,
    ) -> Result<github::MutationResult, github::MergeRemoteError>;

    async fn queue_status(
        &self,
        repo: &str,
        number: i64,
    ) -> Result<github::PrQueueStatusResult, github::MergeRemoteError>;

    async fn enable_auto_merge(
        &self,
        node_id: &str,
        head: &str,
    ) -> Result<github::MutationResult, github::MergeRemoteError>;

    async fn disable_auto_merge(
        &self,
        node_id: &str,
    ) -> Result<github::MutationResult, github::MergeRemoteError>;

    async fn enqueue(
        &self,
        node_id: &str,
        head: &str,
    ) -> Result<github::MutationResult, github::MergeRemoteError>;

    async fn dequeue(
        &self,
        node_id: &str,
    ) -> Result<github::MutationResult, github::MergeRemoteError>;
}

/// Production [`MergeBackend`] over real HTTP. Cancellation is read from SQLite for this exact
/// operation, so every guarded mutation still checks cancellation after acquiring the shared
/// mutation guard and before dispatch (a request already sent to GitHub wins the race).
struct RealMergeBackend<'a> {
    client: reqwest::Client,
    token: String,
    mutation_guard: &'a tokio::sync::Mutex<()>,
    db: &'a Db,
    operation_id: i64,
}

impl RealMergeBackend<'_> {
    fn is_cancelled(&self) -> impl Fn() -> bool + '_ {
        move || {
            let Ok(conn) = self.db.0.lock() else {
                return true;
            };
            dependabot::merge_cancel_requested(&conn, self.operation_id).unwrap_or(true)
        }
    }
}

impl MergeBackend for RealMergeBackend<'_> {
    async fn process_operation(
        &self,
        work: &dependabot::MergeWork,
        timed_out: bool,
        strategy: github::MergeQueueStrategy,
    ) -> Result<github::MergeRemoteResult, github::MergeRemoteError> {
        github::process_dependabot_merge_operation(
            &self.client,
            &self.token,
            work,
            timed_out,
            strategy,
            self.mutation_guard,
            self.is_cancelled(),
        )
        .await
    }

    async fn detect_policy(
        &self,
        repo: &str,
        base: &str,
    ) -> Result<github::MergeQueuePolicy, github::MergeRemoteError> {
        github::detect_merge_queue_policy(&self.client, &self.token, repo, base).await
    }

    async fn ref_update_restriction(
        &self,
        repo: &str,
        base: &str,
    ) -> Result<github::RefUpdateRestrictionResult, github::MergeRemoteError> {
        github::detect_ref_update_restriction(&self.client, &self.token, repo, base).await
    }

    async fn diagnose(
        &self,
        repo: &str,
        head: &str,
    ) -> Result<github::ExactHeadCheckDiagnosis, github::MergeRemoteError> {
        github::diagnose_exact_head_checks(&self.client, &self.token, repo, head).await
    }

    async fn compare_branch(
        &self,
        repo: &str,
        base: &str,
        head: &str,
    ) -> Result<github::BranchComparisonResult, github::MergeRemoteError> {
        github::compare_pull_request_branch(&self.client, &self.token, repo, base, head).await
    }

    async fn current_head(
        &self,
        pull_url: &str,
    ) -> Result<github::PullHeadResult, github::MergeRemoteError> {
        github::fetch_pull_head(&self.client, &self.token, pull_url).await
    }

    async fn update_branch(
        &self,
        repo: &str,
        number: i64,
        head: &str,
    ) -> Result<github::MutationResult, github::MergeRemoteError> {
        github::update_pull_request_branch(
            &self.client,
            &self.token,
            repo,
            number,
            head,
            self.mutation_guard,
            self.is_cancelled(),
        )
        .await
    }

    async fn rerun(
        &self,
        repo: &str,
        run_id: i64,
    ) -> Result<github::MutationResult, github::MergeRemoteError> {
        github::rerun_failed_jobs(
            &self.client,
            &self.token,
            repo,
            run_id,
            self.mutation_guard,
            self.is_cancelled(),
        )
        .await
    }

    async fn approve_workflow(
        &self,
        repo: &str,
        run_id: i64,
    ) -> Result<github::MutationResult, github::MergeRemoteError> {
        github::approve_workflow_run(
            &self.client,
            &self.token,
            repo,
            run_id,
            self.mutation_guard,
            self.is_cancelled(),
        )
        .await
    }

    async fn queue_status(
        &self,
        repo: &str,
        number: i64,
    ) -> Result<github::PrQueueStatusResult, github::MergeRemoteError> {
        github::fetch_pr_queue_status(&self.client, &self.token, repo, number).await
    }

    async fn enable_auto_merge(
        &self,
        node_id: &str,
        head: &str,
    ) -> Result<github::MutationResult, github::MergeRemoteError> {
        github::enable_pr_auto_merge(
            &self.client,
            &self.token,
            node_id,
            head,
            self.mutation_guard,
            self.is_cancelled(),
        )
        .await
    }

    async fn disable_auto_merge(
        &self,
        node_id: &str,
    ) -> Result<github::MutationResult, github::MergeRemoteError> {
        // This mutation implements cancellation itself. Reusing the operation cancellation
        // predicate would suppress the cleanup precisely when the row is `cancel_requested`.
        github::disable_pr_auto_merge(
            &self.client,
            &self.token,
            node_id,
            self.mutation_guard,
            || false,
        )
        .await
    }

    async fn enqueue(
        &self,
        node_id: &str,
        head: &str,
    ) -> Result<github::MutationResult, github::MergeRemoteError> {
        github::enqueue_pr(
            &self.client,
            &self.token,
            node_id,
            head,
            self.mutation_guard,
            self.is_cancelled(),
        )
        .await
    }

    async fn dequeue(
        &self,
        node_id: &str,
    ) -> Result<github::MutationResult, github::MergeRemoteError> {
        // Like disable-auto-merge above, deliberate remote cleanup must run after cancellation.
        github::dequeue_pr(
            &self.client,
            &self.token,
            node_id,
            self.mutation_guard,
            || false,
        )
        .await
    }
}

/// Accumulate the rate snapshots from one backend call into `rates`; on failure, prepend the
/// running total to the error's own snapshots and bail. Keeps every bucket the orchestrator
/// touched (across all its serial calls) in one place for persistence (requirement 7).
macro_rules! net {
    ($rates:expr, $call:expr) => {{
        match $call.await {
            Ok(value) => {
                $rates.extend(value.rates.iter().cloned());
                value
            }
            Err(mut error) => {
                let mut all = std::mem::take(&mut $rates);
                all.append(&mut error.rates);
                error.rates = all;
                return Err(error);
            }
        }
    }};
}

/// Take the DB lock briefly for one synchronous persistence step, mapping a poisoned lock to a
/// `MergeRemoteError` so no SQLite lock is ever held across a network call.
fn with_conn<T>(
    db: &Db,
    rates: &[github::RateLimit],
    f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
) -> Result<T, github::MergeRemoteError> {
    let conn = db.0.lock().map_err(|e| github::MergeRemoteError {
        class: github::MergeErrorClass::Transient,
        message: format!("database lock poisoned: {e}"),
        rates: rates.to_vec(),
    })?;
    f(&conn).map_err(|e| github::MergeRemoteError {
        class: github::MergeErrorClass::Transient,
        message: format!("database write failed: {e}"),
        rates: rates.to_vec(),
    })
}

/// Durable, phase-driven processor for one FIFO head. Reuses the shared exact-head validation +
/// approval processor for both strategies, resolves and caches the repo+base merge strategy,
/// runs the direct retry cycle (diagnose → schedule → rerun → wait) and the merge-queue flow
/// (auto-merge/enqueue/poll), and records a phase + narration event for every meaningful action.
/// Network calls run with no SQLite lock held; each persistence step takes the lock only briefly.
/// Returns one of the FIFO loop's terminal/active outcomes; `Prepared` is consumed internally.
async fn orchestrate_operation<B: MergeBackend>(
    db: &Db,
    backend: &B,
    work: dependabot::MergeWork,
    timed_out: bool,
) -> Result<github::MergeRemoteResult, github::MergeRemoteError> {
    use github::MergeRemoteOutcome as Outcome;
    let mut rates: Vec<github::RateLimit> = Vec::new();
    let op_id = work.operation.id;
    let repo = work.operation.repo_full_name.clone();

    // 0. Cancellation already requested before this pass: for a queue operation, reconcile the
    //    live GitHub state before cleanup. This covers a process crash between a successful queue
    //    mutation and persisting its local metadata, and lets a merge completed during the race win.
    if work.operation.state == "cancel_requested" {
        if work.operation.strategy == "merge_queue" {
            let queue = net!(rates, backend.queue_status(&repo, work.operation.number));
            if let Some(status) = queue.status {
                if status.merged || status.state.eq_ignore_ascii_case("MERGED") {
                    return Ok(github::MergeRemoteResult {
                        outcome: Outcome::Merged {
                            head_sha: Some(status.head_oid),
                        },
                        rates,
                    });
                }
                let node_id = status.node_id.as_str();
                if work.operation.auto_merge_enabled || status.auto_merge_enabled {
                    net!(rates, backend.disable_auto_merge(node_id));
                }
                if work.operation.merge_queue_position.is_some()
                    || status.merge_queue_entry.is_some()
                {
                    net!(rates, backend.dequeue(node_id));
                }
            } else if let Some(node_id) = work.operation.pull_node_id.as_deref() {
                // The PR vanished from the status query. Use durable enrollment metadata for a
                // final idempotent cleanup attempt before releasing the local FIFO head.
                if work.operation.auto_merge_enabled {
                    net!(rates, backend.disable_auto_merge(node_id));
                }
                if work.operation.merge_queue_position.is_some() {
                    net!(rates, backend.dequeue(node_id));
                }
            }
        } else if let Some(node_id) = work.operation.pull_node_id.as_deref() {
            if work.operation.auto_merge_enabled {
                net!(rates, backend.disable_auto_merge(node_id));
            }
            if work.operation.merge_queue_position.is_some() {
                net!(rates, backend.dequeue(node_id));
            }
        }
        with_conn(db, &rates, |conn| {
            dependabot::append_operation_event(
                conn,
                op_id,
                "queued",
                "lifecycle",
                "cancelled",
                "Disabled auto-merge / left the merge queue before cancelling.",
                None,
                None,
                None,
            )
        })?;
        return Ok(github::MergeRemoteResult {
            outcome: Outcome::Cancelled,
            rates,
        });
    }

    // 1. Backoff gate: a scheduled retry/poll that isn't due yet makes no network call and leaves
    //    the durable state exactly as it was (strict per-repo FIFO keeps this row the head).
    let due = with_conn(db, &rates, |conn| {
        dependabot::is_next_action_due(conn, op_id)
    })?;
    if !due {
        return Ok(github::MergeRemoteResult {
            outcome: Outcome::Waiting,
            rates,
        });
    }

    // 2. Dispatch any check retries that were scheduled for this operation and are now due (their
    //    backoff elapsed because the gate above passed). First verify the live PR head: durable
    //    retries survive restarts, but must never be replayed after Dependabot moves the branch.
    let pending_retries = with_conn(db, &rates, |conn| {
        dependabot::list_check_retries(conn, op_id)
    })?
    .into_iter()
    .filter(|retry| retry.outcome.is_none())
    .collect::<Vec<_>>();
    if !pending_retries.is_empty() {
        let live_head = net!(rates, backend.current_head(&work.operation.pull_url)).head_sha;
        let mut runnable_retries = Vec::new();
        for retry in pending_retries {
            if retry.head_sha == live_head {
                runnable_retries.push(retry);
                continue;
            }
            let retry_id = retry.id;
            let old_head = retry.head_sha.clone();
            let run_id = retry.workflow_run_id;
            with_conn(db, &rates, |conn| {
                dependabot::skip_check_retry(conn, retry_id, "stale_head")?;
                dependabot::append_operation_event(
                    conn,
                    op_id,
                    "retrying_checks",
                    "retry",
                    "stale",
                    &format!("Skipped workflow run {run_id}: its retry targeted an older PR head."),
                    Some(&format!(
                        "Retry head: {old_head}; current head: {live_head}."
                    )),
                    Some(&old_head),
                    Some(&run_id.to_string()),
                )
            })?;
        }
        if runnable_retries.is_empty() {
            with_conn(db, &rates, |conn| {
                dependabot::schedule_next_action(conn, op_id, None)
            })?;
        } else {
            with_conn(db, &rates, |conn| {
                dependabot::set_phase(
                    conn,
                    op_id,
                    dependabot::MergePhase::RetryingChecks,
                    None,
                    None,
                    None,
                )?;
                dependabot::append_operation_event(
                    conn,
                    op_id,
                    "retrying_checks",
                    "retry",
                    "start",
                    "Re-running the GitHub Actions jobs that previously failed.",
                    None,
                    None,
                    None,
                )
            })?;
            for retry in &runnable_retries {
                let result = match backend.rerun(&repo, retry.workflow_run_id).await {
                    Ok(result) => {
                        rates.extend(result.rates.iter().cloned());
                        result
                    }
                    Err(mut error) => {
                        let mut all_rates = std::mem::take(&mut rates);
                        all_rates.append(&mut error.rates);
                        if error.class == github::MergeErrorClass::Permanent {
                            let retry_id = retry.id;
                            let head = retry.head_sha.clone();
                            let run_id = retry.workflow_run_id;
                            let detail = error.message.clone();
                            with_conn(db, &all_rates, |conn| {
                                dependabot::mark_check_retry(conn, retry_id, "not_rerunnable")?;
                                dependabot::append_operation_event(
                                    conn,
                                    op_id,
                                    "retrying_checks",
                                    "retry",
                                    "failed",
                                    &format!("Workflow run {run_id} could not be re-run."),
                                    Some(&detail),
                                    Some(&head),
                                    Some(&run_id.to_string()),
                                )
                            })?;
                        }
                        error.rates = all_rates;
                        return Err(error);
                    }
                };
                let outcome = match result.outcome {
                    github::MutationOutcome::Applied => "requested",
                    github::MutationOutcome::Cancelled => "cancelled",
                };
                let head = retry.head_sha.clone();
                let run_id = retry.workflow_run_id;
                let retry_id = retry.id;
                with_conn(db, &rates, |conn| {
                    dependabot::mark_check_retry(conn, retry_id, outcome)?;
                    dependabot::append_operation_event(
                        conn,
                        op_id,
                        "retrying_checks",
                        "retry",
                        outcome,
                        &format!("Requested a re-run of workflow run {run_id}."),
                        None,
                        Some(&head),
                        Some(&run_id.to_string()),
                    )
                })?;
            }
            // Reruns dispatched: clear the backoff and wait for the fresh checks to report.
            let head = work.operation.observed_head_sha.clone().unwrap_or_default();
            with_conn(db, &rates, |conn| {
                dependabot::set_phase(
                    conn,
                    op_id,
                    dependabot::MergePhase::WaitingChecks,
                    None,
                    None,
                    None,
                )?;
                dependabot::schedule_next_action(conn, op_id, None)
            })?;
            return Ok(github::MergeRemoteResult {
                outcome: Outcome::Pending {
                    head_sha: head,
                    approved: true,
                    branch_update_requested: false,
                    reason: Some("Re-running failed checks; waiting for the results.".to_string()),
                },
                rates,
            });
        }
    }

    // 3. Resolve the strategy hint from the cache (only possible once the base ref is known).
    let (_base_ref_opt, cached_strategy) = with_conn(db, &rates, |conn| {
        let operation = dependabot::get_operation(conn, op_id)?;
        let base = operation.and_then(|operation| operation.base_ref);
        let cached = match &base {
            Some(base) => dependabot::get_merge_policy(conn, &repo, base, Some(POLICY_MAX_AGE_S))?
                .map(|policy| policy.strategy),
            None => None,
        };
        Ok((base, cached))
    })?;
    let strategy_hint = strategy_from_str(cached_strategy.as_deref());

    // 3a. Merge-queue polling fast path: once a queue operation has been validated and enrolled
    //     (its node id and accepted head are known), subsequent passes only poll/drive the queue
    //     over GraphQL — they must never re-issue the direct validation/merge REST processor.
    if strategy_hint == github::MergeQueueStrategy::MergeQueue {
        if let (Some(node_id), Some(head)) = (
            work.operation.pull_node_id.clone(),
            work.operation.observed_head_sha.clone(),
        ) {
            let outcome =
                queue_flow(db, backend, &work, &head, &node_id, timed_out, &mut rates).await?;
            return Ok(github::MergeRemoteResult { outcome, rates });
        }
    }

    with_conn(db, &rates, |conn| {
        dependabot::set_phase(
            conn,
            op_id,
            dependabot::MergePhase::Validating,
            None,
            None,
            None,
        )?;
        dependabot::append_operation_event(
            conn,
            op_id,
            "validating",
            "lifecycle",
            "start",
            "Validating the pull request at its current head.",
            None,
            None,
            None,
        )
    })?;

    // 4. Shared validation/approval (and, for a confirmed direct branch, the direct merge/update).
    let result = net!(
        rates,
        backend.process_operation(&work, timed_out, strategy_hint)
    );

    match result.outcome {
        Outcome::Merged { head_sha } => {
            with_conn(db, &rates, |conn| {
                dependabot::set_phase(
                    conn,
                    op_id,
                    dependabot::MergePhase::Merging,
                    None,
                    None,
                    None,
                )?;
                dependabot::append_operation_event(
                    conn,
                    op_id,
                    "merging",
                    "lifecycle",
                    "merged",
                    "Merged the pull request on GitHub.",
                    None,
                    head_sha.as_deref(),
                    None,
                )
            })?;
            Ok(github::MergeRemoteResult {
                outcome: Outcome::Merged { head_sha },
                rates,
            })
        }
        Outcome::Cancelled => Ok(github::MergeRemoteResult {
            outcome: Outcome::Cancelled,
            rates,
        }),
        Outcome::Waiting => Ok(github::MergeRemoteResult {
            outcome: Outcome::Waiting,
            rates,
        }),
        Outcome::PermanentFailure { code, reason } => {
            let detail = reason.clone();
            with_conn(db, &rates, |conn| {
                dependabot::append_operation_event(
                    conn,
                    op_id,
                    "validating",
                    "lifecycle",
                    "failed",
                    &format!("Stopped: {detail}"),
                    Some(&detail),
                    None,
                    None,
                )
            })?;
            Ok(github::MergeRemoteResult {
                outcome: Outcome::PermanentFailure { code, reason },
                rates,
            })
        }
        Outcome::Blocked { head_sha, base_ref } => {
            let outcome = await_checks(
                db,
                backend,
                &work,
                &head_sha,
                DirectCheckContext {
                    blocked_base_ref: Some(&base_ref),
                    pending_reason: None,
                },
                timed_out,
                &mut rates,
            )
            .await?;
            Ok(github::MergeRemoteResult { outcome, rates })
        }
        Outcome::Pending {
            head_sha,
            approved,
            branch_update_requested,
            reason,
        } => {
            if branch_update_requested {
                with_conn(db, &rates, |conn| {
                    dependabot::set_phase(
                        conn,
                        op_id,
                        dependabot::MergePhase::UpdatingBranch,
                        None,
                        None,
                        None,
                    )?;
                    dependabot::schedule_next_action(conn, op_id, None)?;
                    dependabot::append_operation_event(
                        conn,
                        op_id,
                        "updating_branch",
                        "branch",
                        "requested",
                        "Updating the branch with its base before re-checking.",
                        None,
                        Some(&head_sha),
                        None,
                    )
                })?;
                return Ok(github::MergeRemoteResult {
                    outcome: Outcome::Pending {
                        head_sha,
                        approved,
                        branch_update_requested,
                        reason,
                    },
                    rates,
                });
            }
            // Direct strategy, head accepted + approved, but not mergeable yet → diagnose checks.
            let outcome = await_checks(
                db,
                backend,
                &work,
                &head_sha,
                DirectCheckContext {
                    blocked_base_ref: None,
                    pending_reason: reason.as_deref(),
                },
                timed_out,
                &mut rates,
            )
            .await?;
            Ok(github::MergeRemoteResult { outcome, rates })
        }
        Outcome::Prepared {
            head_sha,
            base_ref,
            node_id,
            mergeable_state,
        } => {
            let approved = mergeable_state.as_deref() != Some("behind");
            {
                let base_ref = base_ref.clone();
                let node_id = node_id.clone();
                let head = head_sha.clone();
                with_conn(db, &rates, |conn| {
                    dependabot::set_phase(
                        conn,
                        op_id,
                        dependabot::MergePhase::Validating,
                        None,
                        Some(&node_id),
                        Some(&base_ref),
                    )?;
                    dependabot::append_operation_event(
                        conn,
                        op_id,
                        "validating",
                        "check",
                        "ok",
                        "Accepted the current head of the Dependabot-authored pull request.",
                        None,
                        Some(&head),
                        None,
                    )
                })?;
            }

            // Resolve strategy: cache hit, otherwise detect and cache (requirement 2).
            let strategy = match strategy_from_str(cached_strategy.as_deref()) {
                github::MergeQueueStrategy::Unknown => {
                    let policy = net!(rates, backend.detect_policy(&repo, &base_ref));
                    let resolved = policy.strategy;
                    let strategy_label = strategy_str(resolved);
                    let base_ref = base_ref.clone();
                    with_conn(db, &rates, |conn| {
                        if resolved != github::MergeQueueStrategy::Unknown {
                            dependabot::cache_merge_policy(conn, &repo, &base_ref, strategy_label)?;
                        }
                        dependabot::set_phase(
                            conn,
                            op_id,
                            dependabot::MergePhase::Validating,
                            Some(strategy_label),
                            None,
                            None,
                        )
                    })?;
                    resolved
                }
                cached => cached,
            };

            match strategy {
                github::MergeQueueStrategy::Direct => {
                    with_conn(db, &rates, |conn| {
                        dependabot::set_phase(
                            conn,
                            op_id,
                            dependabot::MergePhase::Validating,
                            Some("direct"),
                            None,
                            None,
                        )?;
                        dependabot::schedule_next_action(conn, op_id, None)?;
                        dependabot::append_operation_event(
                            conn,
                            op_id,
                            "validating",
                            "strategy",
                            "direct",
                            "Merge strategy: direct merge.",
                            None,
                            None,
                            None,
                        )
                    })?;
                    Ok(github::MergeRemoteResult {
                        outcome: Outcome::Pending {
                            head_sha,
                            approved,
                            branch_update_requested: false,
                            reason: Some("Resolved a direct-merge strategy.".to_string()),
                        },
                        rates,
                    })
                }
                github::MergeQueueStrategy::MergeQueue => {
                    with_conn(db, &rates, |conn| {
                        dependabot::set_phase(
                            conn,
                            op_id,
                            dependabot::MergePhase::Validating,
                            Some("merge_queue"),
                            None,
                            None,
                        )?;
                        dependabot::append_operation_event(
                            conn,
                            op_id,
                            "validating",
                            "strategy",
                            "merge_queue",
                            "Merge strategy: GitHub merge queue.",
                            None,
                            None,
                            None,
                        )
                    })?;
                    let outcome = queue_flow(
                        db, backend, &work, &head_sha, &node_id, timed_out, &mut rates,
                    )
                    .await?;
                    Ok(github::MergeRemoteResult { outcome, rates })
                }
                github::MergeQueueStrategy::Unknown => {
                    with_conn(db, &rates, |conn| {
                        dependabot::set_phase(
                            conn,
                            op_id,
                            dependabot::MergePhase::Validating,
                            Some("unknown"),
                            None,
                            None,
                        )?;
                        dependabot::schedule_next_action_in(conn, op_id, UNKNOWN_POLICY_RETRY_S)?;
                        dependabot::append_operation_event(
                            conn,
                            op_id,
                            "validating",
                            "strategy",
                            "pending",
                            "Could not determine the repository's merge strategy yet; will retry.",
                            None,
                            None,
                            None,
                        )
                    })?;
                    Ok(github::MergeRemoteResult {
                        outcome: Outcome::Pending {
                            head_sha,
                            approved,
                            branch_update_requested: false,
                            reason: Some(
                                "Waiting to determine the repository's merge strategy.".to_string(),
                            ),
                        },
                        rates,
                    })
                }
            }
        }
    }
}

/// Direct-strategy check handling for a validated+approved head that GitHub still reports as not
/// mergeable: any non-retryable external CI failure ends the operation as "needs attention" with
/// the failing check names; failed GitHub Actions runs are each scheduled (once per
/// run+attempt) for a five-minute rerun; otherwise Helix keeps waiting for pending checks.
/// The 90-minute deadline is evaluated before scheduling any new retry (requirement 4).
struct DirectCheckContext<'a> {
    blocked_base_ref: Option<&'a str>,
    pending_reason: Option<&'a str>,
}

async fn approve_required_workflows<B: MergeBackend>(
    db: &Db,
    backend: &B,
    work: &dependabot::MergeWork,
    head_sha: &str,
    approvals: &[github::WorkflowRunApproval],
    rates: &mut Vec<github::RateLimit>,
) -> Result<Option<github::MergeRemoteOutcome>, github::MergeRemoteError> {
    use github::MergeRemoteOutcome as Outcome;
    if approvals.is_empty() {
        return Ok(None);
    }

    let op_id = work.operation.id;
    let repo = work.operation.repo_full_name.clone();
    let live_head = net!(*rates, backend.current_head(&work.operation.pull_url)).head_sha;
    if live_head != head_sha {
        with_conn(db, rates, |conn| {
            dependabot::set_phase(
                conn,
                op_id,
                dependabot::MergePhase::Validating,
                None,
                None,
                None,
            )?;
            dependabot::schedule_next_action(conn, op_id, None)?;
            dependabot::append_operation_event(
                conn,
                op_id,
                "validating",
                "workflow_approval",
                "stale",
                "Skipped workflow approval because the pull request head changed.",
                Some(&format!(
                    "Approval head: {head_sha}; current head: {live_head}."
                )),
                Some(head_sha),
                None,
            )
        })?;
        return Ok(Some(Outcome::Waiting));
    }

    let approval_count = approvals.len();
    with_conn(db, rates, |conn| {
        dependabot::set_phase(
            conn,
            op_id,
            dependabot::MergePhase::ApprovingWorkflows,
            None,
            None,
            None,
        )?;
        dependabot::append_operation_event(
            conn,
            op_id,
            "approving_workflows",
            "workflow_approval",
            "start",
            &format!("Approving {approval_count} GitHub Actions workflow run(s)."),
            None,
            Some(head_sha),
            None,
        )
    })?;

    for approval in approvals {
        let mutation = net!(*rates, backend.approve_workflow(&repo, approval.run_id));
        if mutation.outcome == github::MutationOutcome::Cancelled {
            return Ok(Some(Outcome::Cancelled));
        }
        let name = approval
            .name
            .as_deref()
            .unwrap_or("Unnamed GitHub Actions workflow");
        with_conn(db, rates, |conn| {
            dependabot::append_operation_event(
                conn,
                op_id,
                "approving_workflows",
                "workflow_approval",
                "reconciled",
                &format!("Reconciled workflow approval for `{name}`."),
                None,
                Some(head_sha),
                Some(&approval.run_id.to_string()),
            )
        })?;
    }

    with_conn(db, rates, |conn| {
        dependabot::set_phase(
            conn,
            op_id,
            dependabot::MergePhase::WaitingChecks,
            None,
            None,
            None,
        )?;
        dependabot::schedule_next_action(conn, op_id, None)?;
        dependabot::append_operation_event(
            conn,
            op_id,
            "waiting_checks",
            "workflow_approval",
            "waiting",
            "Reconciled the workflow approvals; waiting for GitHub to start the checks.",
            None,
            Some(head_sha),
            None,
        )
    })?;
    Ok(Some(Outcome::Pending {
        head_sha: head_sha.to_string(),
        approved: true,
        branch_update_requested: false,
        reason: Some("Workflow approvals reconciled; waiting for checks to run.".to_string()),
    }))
}

async fn await_checks<B: MergeBackend>(
    db: &Db,
    backend: &B,
    work: &dependabot::MergeWork,
    head_sha: &str,
    context: DirectCheckContext<'_>,
    timed_out: bool,
    rates: &mut Vec<github::RateLimit>,
) -> Result<github::MergeRemoteOutcome, github::MergeRemoteError> {
    use github::MergeRemoteOutcome as Outcome;
    let op_id = work.operation.id;
    let repo = work.operation.repo_full_name.clone();

    let diagnosis = net!(*rates, backend.diagnose(&repo, head_sha));

    if let Some(outcome) = approve_required_workflows(
        db,
        backend,
        work,
        head_sha,
        &diagnosis.approval_required,
        rates,
    )
    .await?
    {
        return Ok(outcome);
    }

    if !diagnosis.external_failures.is_empty() {
        let names = diagnosis
            .external_failures
            .iter()
            .map(|failure| failure.name.clone())
            .collect::<Vec<_>>()
            .join(", ");
        let detail = format!("External check(s) need attention: {names}");
        let head = head_sha.to_string();
        with_conn(db, rates, |conn| {
            dependabot::append_operation_event(
                conn,
                op_id,
                "waiting_checks",
                "check",
                "failed",
                &detail,
                Some(&detail),
                Some(&head),
                None,
            )
        })?;
        return Ok(Outcome::PermanentFailure {
            code: "external_check_failed",
            reason: detail,
        });
    }

    if !diagnosis.actions_failures.is_empty() {
        let deadline_exhausted = with_conn(db, rates, |conn| {
            dependabot::merge_deadline_exhausted(conn, op_id, RETRY_DEADLINE_CUSHION_MIN)
        })?;
        if deadline_exhausted {
            let head = head_sha.to_string();
            with_conn(db, rates, |conn| {
                dependabot::append_operation_event(
                    conn,
                    op_id,
                    "waiting_checks",
                    "check",
                    "failed",
                    "A check failed with too little time left to retry before the deadline.",
                    None,
                    Some(&head),
                    None,
                )
            })?;
            return Ok(Outcome::Pending {
                head_sha: head_sha.to_string(),
                approved: true,
                branch_update_requested: false,
                reason: Some("A check failed near the deadline; letting it time out.".to_string()),
            });
        }
        let failures = diagnosis.actions_failures.clone();
        let head = head_sha.to_string();
        with_conn(db, rates, |conn| {
            for failure in &failures {
                dependabot::schedule_check_retry(
                    conn,
                    op_id,
                    &head,
                    failure.run_id,
                    failure.run_attempt,
                )?;
            }
            dependabot::set_phase(
                conn,
                op_id,
                dependabot::MergePhase::RetryScheduled,
                None,
                None,
                None,
            )?;
            dependabot::schedule_next_action_in(conn, op_id, CHECK_RETRY_DELAY_S)?;
            dependabot::append_operation_event(
                conn,
                op_id,
                "retry_scheduled",
                "retry",
                "scheduled",
                &format!(
                    "Scheduled a re-run of {} failed GitHub Actions run(s) in five minutes.",
                    failures.len()
                ),
                None,
                Some(&head),
                None,
            )
        })?;
        // A merge already dispatched to GitHub still wins, but nothing was dispatched here; the
        // deadline is re-checked by the FIFO loop before the next pass regardless of `timed_out`.
        let _ = timed_out;
        return Ok(Outcome::Pending {
            head_sha: head_sha.to_string(),
            approved: true,
            branch_update_requested: false,
            reason: Some("A required check failed; a re-run is scheduled.".to_string()),
        });
    }

    if diagnosis.pending.is_empty() {
        if let Some(base_ref) = context.blocked_base_ref {
            if base_ref.is_empty() {
                return Ok(Outcome::PermanentFailure {
                    code: "blocked_by_repository_rule",
                    reason:
                        "GitHub blocks this pull request, but did not identify its base branch."
                            .to_string(),
                });
            }
            let comparison = net!(*rates, backend.compare_branch(&repo, base_ref, head_sha));
            if comparison.behind {
                let update = net!(
                    *rates,
                    backend.update_branch(&repo, work.operation.number, head_sha)
                );
                if update.outcome == github::MutationOutcome::Cancelled {
                    return Ok(Outcome::Cancelled);
                }
                let head = head_sha.to_string();
                with_conn(db, rates, |conn| {
                    dependabot::set_phase(
                        conn,
                        op_id,
                        dependabot::MergePhase::UpdatingBranch,
                        None,
                        None,
                        None,
                    )?;
                    dependabot::schedule_next_action(conn, op_id, None)?;
                    dependabot::append_operation_event(
                        conn,
                        op_id,
                        "updating_branch",
                        "branch",
                        "requested",
                        "The branch is behind its base; requested an exact-head branch update.",
                        None,
                        Some(&head),
                        None,
                    )
                })?;
                return Ok(Outcome::Pending {
                    head_sha: head,
                    approved: false,
                    branch_update_requested: true,
                    reason: Some(
                        "Updating the stale branch and waiting for fresh checks.".to_string(),
                    ),
                });
            }
            let restriction = net!(*rates, backend.ref_update_restriction(&repo, base_ref));
            if restriction.restricted == Some(true) {
                return Ok(Outcome::PermanentFailure {
                    code: "protected_ref",
                    reason: format!(
                        "The target branch `{base_ref}` is protected against updates for the authenticated GitHub account."
                    ),
                });
            }
            let head = head_sha.to_string();
            let summary = "GitHub still blocks the merge; no pending or failing checks were found.";
            with_conn(db, rates, |conn| {
                dependabot::set_phase(
                    conn,
                    op_id,
                    dependabot::MergePhase::WaitingRequirements,
                    None,
                    None,
                    None,
                )?;
                dependabot::schedule_next_action(conn, op_id, None)?;
                dependabot::append_operation_event(
                    conn,
                    op_id,
                    "waiting_requirements",
                    "requirement",
                    "pending",
                    summary,
                    Some(
                        "The branch is current. GitHub may still be registering a required check or enforcing another repository rule.",
                    ),
                    Some(&head),
                    None,
                )
            })?;
            return Ok(Outcome::Pending {
                head_sha: head,
                approved: true,
                branch_update_requested: false,
                reason: Some(summary.to_string()),
            });
        }
        let head = head_sha.to_string();
        let summary = context
            .pending_reason
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .unwrap_or("GitHub still blocks the merge; no pending or failing checks were found.");
        with_conn(db, rates, |conn| {
            dependabot::set_phase(
                conn,
                op_id,
                dependabot::MergePhase::WaitingRequirements,
                None,
                None,
                None,
            )?;
            dependabot::schedule_next_action(conn, op_id, None)?;
            dependabot::append_operation_event(
                conn,
                op_id,
                "waiting_requirements",
                "requirement",
                "pending",
                summary,
                Some("No pending or failing checks were visible at the accepted head."),
                Some(&head),
                None,
            )
        })?;
        return Ok(Outcome::Pending {
            head_sha: head,
            approved: true,
            branch_update_requested: false,
            reason: Some(summary.to_string()),
        });
    }

    // Only pending checks remain: keep waiting, re-polling on the next FIFO pass.
    let head = head_sha.to_string();
    let pending_count = diagnosis.pending.len();
    let summary = if pending_count > 0 {
        format!("Waiting for {pending_count} status check(s) to finish.")
    } else {
        "Waiting for required status checks to finish.".to_string()
    };
    with_conn(db, rates, |conn| {
        dependabot::set_phase(
            conn,
            op_id,
            dependabot::MergePhase::WaitingChecks,
            None,
            None,
            None,
        )?;
        dependabot::schedule_next_action(conn, op_id, None)?;
        dependabot::append_operation_event(
            conn,
            op_id,
            "waiting_checks",
            "check",
            "pending",
            &summary,
            None,
            Some(&head),
            None,
        )
    })?;
    Ok(Outcome::Pending {
        head_sha: head_sha.to_string(),
        approved: true,
        branch_update_requested: false,
        reason: Some("Waiting for required status checks to finish.".to_string()),
    })
}

/// Merge-queue-strategy flow for a validated+approved head. Never issues a direct merge or REST
/// update-branch (requirement 5): it queries the PR's queue status over GraphQL and, depending on
/// what it finds, records a merged terminal, persists the live queue position while it waits,
/// idempotently enables native auto-merge while requirements are still pending, or enqueues an
/// eligible PR (at the back, `jump:false`). If the PR was previously enrolled but has since left
/// the queue without merging, its checks are diagnosed the same way as the direct flow (failed
/// Actions runs are rescheduled — re-enrollment then happens naturally on the next pass).
async fn queue_flow<B: MergeBackend>(
    db: &Db,
    backend: &B,
    work: &dependabot::MergeWork,
    head_sha: &str,
    node_id: &str,
    timed_out: bool,
    rates: &mut Vec<github::RateLimit>,
) -> Result<github::MergeRemoteOutcome, github::MergeRemoteError> {
    use github::MergeRemoteOutcome as Outcome;
    let op_id = work.operation.id;
    let repo = work.operation.repo_full_name.clone();
    let number = work.operation.number;

    let status = net!(*rates, backend.queue_status(&repo, number)).status;
    let Some(status) = status else {
        with_conn(db, rates, |conn| {
            dependabot::set_phase(
                conn,
                op_id,
                dependabot::MergePhase::WaitingMergeQueue,
                None,
                None,
                None,
            )?;
            dependabot::schedule_next_action(conn, op_id, None)?;
            dependabot::append_operation_event(
                conn,
                op_id,
                "waiting_merge_queue",
                "queue",
                "pending",
                "Waiting for GitHub to report the pull request's queue status.",
                None,
                None,
                None,
            )
        })?;
        return Ok(Outcome::Pending {
            head_sha: head_sha.to_string(),
            approved: true,
            branch_update_requested: false,
            reason: Some("Waiting for GitHub to report the queue status.".to_string()),
        });
    };

    // A merged PR wins every race — record it as the terminal outcome immediately.
    if status.merged {
        let head = status.head_oid.clone();
        with_conn(db, rates, |conn| {
            dependabot::set_phase(
                conn,
                op_id,
                dependabot::MergePhase::Merging,
                None,
                None,
                None,
            )?;
            dependabot::append_operation_event(
                conn,
                op_id,
                "merging",
                "queue",
                "merged",
                "The merge queue merged the pull request.",
                None,
                Some(&head),
                None,
            )
        })?;
        return Ok(Outcome::Merged {
            head_sha: Some(status.head_oid),
        });
    }

    // A merged PR always wins the race above, but once the operation's 90-minute deadline has
    // passed and GitHub has not merged it, Helix stops actively driving the queue and terminates
    // the operation as `timed_out` so the per-repo FIFO head is released (a perpetually pending or
    // never-satisfied requirement must not block the repository forever). Before terminalizing it
    // first undoes the remote enrollment it created — disabling native auto-merge and dequeuing
    // under the mutation guard — so a timed-out PR is never left silently enrolled on GitHub. Each
    // mutation runs with no SQLite lock held; if cleanup fails, the `net!` error bubbles up as an
    // active (non-terminal) failure, keeping this row the FIFO head for a later retry rather than
    // releasing the next same-repo item. A merge GitHub completes still wins — it was checked
    // above.
    if timed_out {
        if work.operation.auto_merge_enabled || status.auto_merge_enabled {
            net!(*rates, backend.disable_auto_merge(node_id));
        }
        if work.operation.merge_queue_position.is_some() || status.merge_queue_entry.is_some() {
            net!(*rates, backend.dequeue(node_id));
        }
        with_conn(db, rates, |conn| {
            dependabot::set_queue_metadata(conn, op_id, None, false)?;
            dependabot::append_operation_event(
                conn,
                op_id,
                "waiting_merge_queue",
                "queue",
                "timed_out",
                "The 90-minute deadline passed; disabled auto-merge and left the merge queue before timing out.",
                None,
                Some(head_sha),
                None,
            )
        })?;
        return Ok(Outcome::Cancelled);
    }
    if let Some(entry) = &status.merge_queue_entry {
        let position = entry.position;
        let head = head_sha.to_string();
        with_conn(db, rates, |conn| {
            dependabot::set_queue_metadata(conn, op_id, position, true)?;
            dependabot::set_phase(
                conn,
                op_id,
                dependabot::MergePhase::WaitingMergeQueue,
                None,
                None,
                None,
            )?;
            dependabot::schedule_next_action(conn, op_id, None)?;
            dependabot::append_operation_event(
                conn,
                op_id,
                "waiting_merge_queue",
                "queue",
                "waiting",
                &match position {
                    Some(position) => format!("Waiting in the merge queue at position {position}."),
                    None => "Waiting in the merge queue.".to_string(),
                },
                None,
                Some(&head),
                None,
            )
        })?;
        return Ok(Outcome::Pending {
            head_sha: head_sha.to_string(),
            approved: true,
            branch_update_requested: false,
            reason: Some("Waiting in GitHub's merge queue.".to_string()),
        });
    }

    // Not merged and not in the queue. A previously enrolled PR is diagnosed after queue ejection.
    // Before first enrollment, only release approval-required workflows: unrelated failing checks
    // may not be required by the merge queue and must not prevent GitHub from evaluating eligibility.
    let was_enrolled =
        work.operation.auto_merge_enabled || work.operation.merge_queue_position.is_some();
    let checks_failed = matches!(
        status.check_status.as_deref(),
        Some("FAILURE") | Some("ERROR")
    );
    if checks_failed && was_enrolled {
        with_conn(db, rates, |conn| {
            dependabot::append_operation_event(
                conn,
                op_id,
                "waiting_merge_queue",
                "queue",
                "ejected",
                "The pull request left the merge queue without merging; diagnosing its checks.",
                None,
                Some(head_sha),
                None,
            )
        })?;
        return await_checks(
            db,
            backend,
            work,
            head_sha,
            DirectCheckContext {
                blocked_base_ref: None,
                pending_reason: None,
            },
            false,
            rates,
        )
        .await;
    }
    if checks_failed {
        let diagnosis = net!(
            *rates,
            backend.diagnose(&work.operation.repo_full_name, head_sha)
        );
        if let Some(outcome) = approve_required_workflows(
            db,
            backend,
            work,
            head_sha,
            &diagnosis.approval_required,
            rates,
        )
        .await?
        {
            return Ok(outcome);
        }
    }

    // Requirements still pending (not yet approved / checks not green) → idempotently enable
    // native auto-merge so GitHub enqueues it automatically once everything is satisfied.
    let requirements_pending = status.review_decision.as_deref() != Some("APPROVED")
        || matches!(
            status.check_status.as_deref(),
            None | Some("PENDING") | Some("EXPECTED")
        );
    if requirements_pending {
        let mutation = net!(*rates, backend.enable_auto_merge(node_id, head_sha));
        if mutation.outcome == github::MutationOutcome::Cancelled {
            return Ok(Outcome::Cancelled);
        }
        let head = head_sha.to_string();
        with_conn(db, rates, |conn| {
            dependabot::set_queue_metadata(conn, op_id, None, true)?;
            dependabot::set_phase(
                conn,
                op_id,
                dependabot::MergePhase::EnablingAutoMerge,
                None,
                None,
                None,
            )?;
            dependabot::schedule_next_action(conn, op_id, None)?;
            dependabot::append_operation_event(
                conn,
                op_id,
                "enabling_auto_merge",
                "queue",
                "enabled",
                "Enabled native auto-merge; waiting for requirements to pass.",
                None,
                Some(&head),
                None,
            )
        })?;
        return Ok(Outcome::Pending {
            head_sha: head_sha.to_string(),
            approved: true,
            branch_update_requested: false,
            reason: Some("Enabled auto-merge; waiting for requirements.".to_string()),
        });
    }

    // Eligible and not queued → enqueue at the back with the accepted head OID.
    let mutation = net!(*rates, backend.enqueue(node_id, head_sha));
    if mutation.outcome == github::MutationOutcome::Cancelled {
        return Ok(Outcome::Cancelled);
    }
    let head = head_sha.to_string();
    with_conn(db, rates, |conn| {
        dependabot::set_queue_metadata(conn, op_id, None, true)?;
        dependabot::set_phase(
            conn,
            op_id,
            dependabot::MergePhase::WaitingMergeQueue,
            None,
            None,
            None,
        )?;
        dependabot::schedule_next_action(conn, op_id, None)?;
        dependabot::append_operation_event(
            conn,
            op_id,
            "waiting_merge_queue",
            "queue",
            "enqueued",
            "Enqueued the pull request in the merge queue.",
            None,
            Some(&head),
            None,
        )
    })?;
    Ok(Outcome::Pending {
        head_sha: head_sha.to_string(),
        approved: true,
        branch_update_requested: false,
        reason: Some("Enqueued in GitHub's merge queue.".to_string()),
    })
}

#[cfg(all(test, debug_assertions))]
mod tests {
    //! Orchestration tests for the Dependabot coordinator — same shape as
    //! `coordinator::tests`: in-memory SQLite + a recording `EventSink` + injected fake
    //! fetch/resolve closures, so the fetch/store and merge-state-resolution flows (incl.
    //! partial-failure and rate-reserve paths) are covered without Tauri or real HTTP.
    //! Gated on `debug_assertions` because the connected path reads the PAT from SQLite only
    //! in debug builds (release reads the Keychain).

    use super::*;
    use crate::github::{
        DependabotFetchOutcome, DependabotPr, GitHubError, RateLimit, ResolveError, ResolveResult,
        ResolvedSubject,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

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

    fn db_with_token() -> Db {
        let db = mem_db();
        auth::store_token(&db, "test-token").unwrap();
        db
    }

    fn store(db: &Db, prs: &[DependabotPr]) {
        let mut guard = db.0.lock().unwrap();
        dependabot::store_prs(&mut guard, prs, true).unwrap();
    }

    fn pr_count(db: &Db) -> i64 {
        let conn = db.0.lock().unwrap();
        dependabot::count(&conn).unwrap()
    }

    fn seed_rate(db: &Db, r: RateLimit) {
        let mut tracker = sync::RateTracker::default();
        tracker.observe(r);
        let conn = db.0.lock().unwrap();
        tracker.persist(&conn).unwrap();
    }

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

    fn pr(id: i64, repo: &str, number: i64, title: &str) -> DependabotPr {
        let (owner, name) = repo.split_once('/').unwrap();
        DependabotPr {
            id,
            number,
            title: title.to_string(),
            html_url: format!("https://github.com/{repo}/pull/{number}"),
            author: "dependabot[bot]".to_string(),
            base_ref: "main".to_string(),
            repo_full_name: repo.to_string(),
            repo_owner: owner.to_string(),
            repo_name: name.to_string(),
            pull_url: format!("https://api.github.com/repos/{repo}/pulls/{number}"),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-02T00:00:00Z".to_string(),
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

    fn ok_merge(state: &str, remaining: i64) -> ResolveResult {
        ResolveResult {
            subject: ResolvedSubject {
                mergeable_state: Some(state.to_string()),
                ..Default::default()
            },
            rate: rate("core", remaining, 5000),
        }
    }

    #[test]
    fn discard_core_closes_and_removes_a_cached_pr() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump a")]);
        let sink = RecordingSink::default();
        let result = tauri::async_runtime::block_on(discard_dependabot_pr_core(
            &db,
            sink.clone(),
            1,
            |repo, number| async move {
                assert_eq!(repo, "octo/repo-a");
                assert_eq!(number, 10);
                Ok(github::ClosePullRequestResult {
                    outcome: github::ClosePullRequestOutcome::Closed,
                    rate: rate("core", 4990, 5000),
                })
            },
        ))
        .unwrap();

        assert_eq!(result.status, DiscardDependabotPrStatus::Closed);
        assert_eq!(pr_count(&db), 0);
        assert_eq!(sink.names(), vec!["dependabot:changed"]);
    }

    #[test]
    fn discard_core_preserves_the_pr_when_close_fails_or_merge_wins() {
        for merged in [false, true] {
            let db = db_with_token();
            store(&db, &[pr(1, "octo/repo-a", 10, "Bump a")]);
            let result = tauri::async_runtime::block_on(discard_dependabot_pr_core(
                &db,
                RecordingSink::default(),
                1,
                move |_, _| async move {
                    if merged {
                        Ok(github::ClosePullRequestResult {
                            outcome: github::ClosePullRequestOutcome::Merged,
                            rate: rate("core", 4980, 5000),
                        })
                    } else {
                        Err(github::MutationError {
                            rate: rate("core", 4980, 5000),
                            error: GitHubError::Network("offline".to_string()),
                        })
                    }
                },
            ));
            assert!(result
                .unwrap_err()
                .contains(if merged { "merged" } else { "offline" }));
            assert_eq!(pr_count(&db), 1);
        }
    }

    #[test]
    fn discard_core_waits_for_active_merge_cancellation() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump a")]);
        let operation_id = {
            let conn = db.0.lock().unwrap();
            let operation = dependabot::enqueue_merge_operation(&conn, 1).unwrap();
            conn.execute(
                "UPDATE dependabot_merge_operations SET state = 'delegated' WHERE id = ?1",
                [operation.id],
            )
            .unwrap();
            operation.id
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_close = calls.clone();
        let result = tauri::async_runtime::block_on(discard_dependabot_pr_core(
            &db,
            RecordingSink::default(),
            1,
            move |_, _| {
                calls_for_close.fetch_add(1, Ordering::SeqCst);
                async {
                    Ok(github::ClosePullRequestResult {
                        outcome: github::ClosePullRequestOutcome::Closed,
                        rate: RateLimit::default(),
                    })
                }
            },
        ))
        .unwrap();

        assert_eq!(result.status, DiscardDependabotPrStatus::Cancelling);
        assert_eq!(result.operation_id, Some(operation_id));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(pr_count(&db), 1);
        let conn = db.0.lock().unwrap();
        assert_eq!(
            dependabot::get_operation(&conn, operation_id)
                .unwrap()
                .unwrap()
                .state,
            "cancel_requested"
        );
    }

    #[test]
    fn discard_core_cancels_queued_work_and_closes_immediately() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump a")]);
        let operation_id = {
            let conn = db.0.lock().unwrap();
            dependabot::enqueue_merge_operation(&conn, 1).unwrap().id
        };
        let result = tauri::async_runtime::block_on(discard_dependabot_pr_core(
            &db,
            RecordingSink::default(),
            1,
            |_, _| async {
                Ok(github::ClosePullRequestResult {
                    outcome: github::ClosePullRequestOutcome::Closed,
                    rate: RateLimit::default(),
                })
            },
        ))
        .unwrap();

        assert_eq!(result.status, DiscardDependabotPrStatus::Closed);
        assert_eq!(pr_count(&db), 0);
        let conn = db.0.lock().unwrap();
        assert_eq!(
            dependabot::get_operation(&conn, operation_id)
                .unwrap()
                .unwrap()
                .state,
            "cancelled"
        );
    }

    /* -------------------------------- sync_dependabot ------------------------- */

    #[test]
    fn sync_core_stores_prs_and_emits_lifecycle() {
        let db = db_with_token();
        let sink = RecordingSink::default();

        let (result, token) = tauri::async_runtime::block_on(sync_dependabot_core(
            &db,
            sink.clone(),
            |token, on_progress| async move {
                assert_eq!(token, "test-token");
                on_progress(1, 2);
                Ok(DependabotFetchOutcome {
                    prs: vec![
                        pr(1, "octo/repo-a", 10, "Bump a"),
                        pr(2, "octo/repo-b", 11, "Bump b"),
                    ],
                    rate: rate("core", 4990, 5000),
                    complete: true,
                    ok_repos: vec![],
                    failed_repos: vec![],
                })
            },
        ))
        .unwrap();

        assert_eq!(result.count, 2);
        assert_eq!(result.removed, 0);
        assert_eq!(result.rate_remaining, Some(4990));
        assert_eq!(token, "test-token");
        assert_eq!(pr_count(&db), 2);
        assert_eq!(
            sink.names(),
            vec![
                "dependabot:started",
                "dependabot:progress",
                "dependabot:done"
            ]
        );
        assert_eq!(
            sink.payload("dependabot:progress"),
            Some(serde_json::json!({ "scanned": 1, "found": 2 }))
        );

        // A successful sync persists the last-sync time so it survives restarts.
        let conn = db.0.lock().unwrap();
        let stamped = settings::get_string(&conn, settings::KEY_DEPENDABOT_LAST_SYNC).unwrap();
        assert!(
            stamped.is_some_and(|s| s.ends_with('Z')),
            "sync should stamp an ISO timestamp"
        );
    }

    #[test]
    fn sync_core_reconciles_removed_prs() {
        let db = db_with_token();
        store(
            &db,
            &[
                pr(1, "octo/repo-a", 10, "Bump a"),
                pr(2, "octo/repo-a", 11, "Bump b"),
            ],
        );
        let sink = RecordingSink::default();

        // Next fetch returns only #1 → #2 is reconciled away.
        let (result, _) = tauri::async_runtime::block_on(sync_dependabot_core(
            &db,
            sink.clone(),
            |_, _| async move {
                Ok(DependabotFetchOutcome {
                    prs: vec![pr(1, "octo/repo-a", 10, "Bump a")],
                    rate: rate("core", 4980, 5000),
                    complete: true,
                    ok_repos: vec![],
                    failed_repos: vec![],
                })
            },
        ))
        .unwrap();

        assert_eq!(result.count, 1);
        assert_eq!(result.removed, 1);
        assert_eq!(pr_count(&db), 1);
    }

    #[test]
    fn sync_core_without_token_errors_before_emitting() {
        let db = mem_db();
        let sink = RecordingSink::default();
        let mut called = false;

        let result =
            tauri::async_runtime::block_on(sync_dependabot_core(&db, sink.clone(), |_, _| {
                called = true;
                async move {
                    Ok(DependabotFetchOutcome {
                        prs: vec![],
                        rate: RateLimit::default(),
                        complete: true,
                        ok_repos: vec![],
                        failed_repos: vec![],
                    })
                }
            }));

        assert!(result.unwrap_err().contains("Not connected"));
        assert!(!called, "fetch must not run when no token is stored");
        assert!(sink.names().is_empty());
    }

    #[test]
    fn sync_core_fetch_error_emits_error() {
        let db = db_with_token();
        let sink = RecordingSink::default();

        let result = tauri::async_runtime::block_on(sync_dependabot_core(
            &db,
            sink.clone(),
            |_, _| async move { Err(GitHubError::Unauthorized) },
        ));

        assert!(result.unwrap_err().contains("401"));
        assert_eq!(sink.names(), vec!["dependabot:started", "dependabot:error"]);
    }

    /* --------------------------- merge-state resolution ----------------------- */

    #[test]
    fn resolve_core_resolves_all_pending_and_emits() {
        let db = db_with_token();
        store(
            &db,
            &[
                pr(1, "octo/repo-a", 10, "Bump a"),
                pr(2, "octo/repo-a", 11, "Bump b"),
            ],
        );
        let sink = RecordingSink::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        tauri::async_runtime::block_on(resolve_pending_merge_states_core(
            &db,
            sink.clone(),
            move |_url| {
                c.fetch_add(1, Ordering::SeqCst);
                async move { Ok(ok_merge("clean", 4990)) }
            },
        ));

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            sink.payload("dependabot:resolved"),
            Some(serde_json::json!({ "count": 2 }))
        );
        let conn = db.0.lock().unwrap();
        assert!(dependabot::prs_needing_merge_state(&conn)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn resolve_core_stops_once_it_crosses_the_reserve() {
        let db = db_with_token();
        let prs: Vec<_> = (0..10)
            .map(|i| pr(i, "octo/repo-a", 100 + i, "Bump"))
            .collect();
        store(&db, &prs);
        let sink = RecordingSink::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        // Resolution is serial and the reserve is checked after each request. The first
        // response already reports quota at/under the 25% reserve, so the loop stops right
        // after it — leaving the rest for a later sync.
        tauri::async_runtime::block_on(resolve_pending_merge_states_core(
            &db,
            sink.clone(),
            move |_url| {
                c.fetch_add(1, Ordering::SeqCst);
                async move { Ok(ok_merge("clean", 1000)) }
            },
        ));

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "serial resolution stops as soon as one request crosses the reserve"
        );
        assert_eq!(
            sink.payload("dependabot:resolved"),
            Some(serde_json::json!({ "count": 1 }))
        );
    }

    #[test]
    fn resolve_core_backs_off_on_a_rate_limit_403() {
        let db = db_with_token();
        let prs: Vec<_> = (0..5)
            .map(|i| pr(i, "octo/repo-a", 100 + i, "Bump"))
            .collect();
        store(&db, &prs);
        let sink = RecordingSink::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        // A 403 (secondary rate limit) on the first request must abort the whole pass rather
        // than keep firing into the limit.
        tauri::async_runtime::block_on(resolve_pending_merge_states_core(
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
        assert_eq!(sink.count("dependabot:resolved"), 0);
    }

    #[test]
    fn resolve_core_skips_entirely_when_already_below_reserve() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump a")]);
        seed_rate(&db, rate("core", 100, 5000));
        let sink = RecordingSink::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        tauri::async_runtime::block_on(resolve_pending_merge_states_core(
            &db,
            sink.clone(),
            move |_url| {
                c.fetch_add(1, Ordering::SeqCst);
                async move { Ok(ok_merge("clean", 50)) }
            },
        ));

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(sink.count("dependabot:resolved"), 0);
    }

    #[test]
    fn resolve_core_no_pending_is_a_noop() {
        let db = db_with_token();
        let sink = RecordingSink::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();

        tauri::async_runtime::block_on(resolve_pending_merge_states_core(
            &db,
            sink.clone(),
            move |_url| {
                c.fetch_add(1, Ordering::SeqCst);
                async move { Ok(ok_merge("clean", 4990)) }
            },
        ));

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(sink.count("dependabot:resolved"), 0);
    }

    #[test]
    fn resolve_core_counts_only_successes_when_some_fail() {
        let db = db_with_token();
        store(
            &db,
            &[
                pr(1, "octo/repo-a", 10, "ok"),
                pr(2, "octo/repo-a", 11, "bad"),
            ],
        );
        let sink = RecordingSink::default();

        tauri::async_runtime::block_on(resolve_pending_merge_states_core(
            &db,
            sink.clone(),
            move |url| async move {
                if url.ends_with("/11") {
                    Err(ResolveError {
                        rate: rate("core", 4980, 5000),
                        error: GitHubError::Status {
                            status: reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                            body: "boom".into(),
                        },
                    })
                } else {
                    Ok(ok_merge("clean", 4990))
                }
            },
        ));

        assert_eq!(
            sink.payload("dependabot:resolved"),
            Some(serde_json::json!({ "count": 1 }))
        );
        // The failed PR is left unresolved → still pending for a later sync.
        let conn = db.0.lock().unwrap();
        let pending = dependabot::prs_needing_merge_state(&conn).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, 2);
    }

    #[test]
    fn merge_processor_advances_one_fifo_head_per_repo_with_injected_network() {
        let db = db_with_token();
        store(
            &db,
            &[
                pr(1, "octo/repo-a", 10, "first"),
                pr(2, "octo/repo-a", 11, "second"),
                pr(3, "octo/repo-b", 12, "independent"),
            ],
        );
        {
            let conn = db.0.lock().unwrap();
            dependabot::enqueue_merge_operation(&conn, 1).unwrap();
            dependabot::enqueue_merge_operation(&conn, 2).unwrap();
            dependabot::enqueue_merge_operation(&conn, 3).unwrap();
        }
        let sink = RecordingSink::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();

        let result = tauri::async_runtime::block_on(process_dependabot_merges_core(
            &db,
            sink.clone(),
            move |work, _| {
                count.fetch_add(1, Ordering::SeqCst);
                async move {
                    Ok(github::MergeRemoteResult {
                        outcome: github::MergeRemoteOutcome::Pending {
                            head_sha: format!("sha-{}", work.operation.pr_id),
                            approved: true,
                            branch_update_requested: false,
                            reason: None,
                        },
                        rates: vec![rate("core", 4990, 5000)],
                    })
                }
            },
        ))
        .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(result.processed, 2);
        assert!(result.changed);
        let conn = db.0.lock().unwrap();
        let operations = dependabot::list_merge_operations(&conn).unwrap();
        assert_eq!(
            operations
                .iter()
                .find(|operation| operation.pr_id == 1)
                .unwrap()
                .state,
            "delegated"
        );
        assert_eq!(
            operations
                .iter()
                .find(|operation| operation.pr_id == 2)
                .unwrap()
                .state,
            "queued"
        );
        assert_eq!(sink.count("dependabot:operations-changed"), 1);
    }

    #[test]
    fn completed_native_merge_wins_a_concurrent_local_cancel() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "first")]);
        let operation_id = {
            let conn = db.0.lock().unwrap();
            dependabot::enqueue_merge_operation(&conn, 1).unwrap().id
        };

        tauri::async_runtime::block_on(process_dependabot_merges_core(
            &db,
            RecordingSink::default(),
            |_, _| async {
                let conn = db.0.lock().unwrap();
                dependabot::request_cancel(&conn, operation_id).unwrap();
                Ok(github::MergeRemoteResult {
                    outcome: github::MergeRemoteOutcome::Merged {
                        head_sha: Some("validated-head".to_string()),
                    },
                    rates: vec![rate("core", 4990, 5000)],
                })
            },
        ))
        .unwrap();

        let conn = db.0.lock().unwrap();
        assert_eq!(
            dependabot::get_operation(&conn, operation_id)
                .unwrap()
                .unwrap()
                .state,
            "merged"
        );
    }

    #[test]
    fn concurrent_cancel_discards_a_stale_pending_result() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "first")]);
        let operation_id = {
            let conn = db.0.lock().unwrap();
            dependabot::enqueue_merge_operation(&conn, 1).unwrap().id
        };

        tauri::async_runtime::block_on(process_dependabot_merges_core(
            &db,
            RecordingSink::default(),
            |_, _| async {
                let conn = db.0.lock().unwrap();
                dependabot::request_cancel(&conn, operation_id).unwrap();
                Ok(github::MergeRemoteResult {
                    outcome: github::MergeRemoteOutcome::Pending {
                        head_sha: "validated-head".to_string(),
                        approved: true,
                        branch_update_requested: false,
                        reason: None,
                    },
                    rates: vec![rate("core", 4990, 5000)],
                })
            },
        ))
        .unwrap();

        let conn = db.0.lock().unwrap();
        assert_eq!(
            dependabot::get_operation(&conn, operation_id)
                .unwrap()
                .unwrap()
                .state,
            "cancelled"
        );
    }

    #[test]
    fn merge_reserve_gates_both_core_and_graphql() {
        let db = db_with_token();
        // Both buckets healthy → the processor keeps resolving work.
        seed_rate(&db, rate("core", 4990, 5000));
        seed_rate(&db, rate("graphql", 4980, 5000));
        {
            let conn = db.0.lock().unwrap();
            assert!(!merge_rates_below_reserve(&conn));
        }
        // GraphQL alone dropping under the ~25% reserve trips the gate (not just core).
        seed_rate(&db, rate("graphql", 100, 5000));
        {
            let conn = db.0.lock().unwrap();
            assert!(
                merge_rates_below_reserve(&conn),
                "graphql under the reserve gates the processor"
            );
        }
        // Restore graphql; now core under the reserve trips it.
        seed_rate(&db, rate("graphql", 4980, 5000));
        seed_rate(&db, rate("core", 100, 5000));
        let conn = db.0.lock().unwrap();
        assert!(
            merge_rates_below_reserve(&conn),
            "core under the reserve gates the processor"
        );
    }

    #[test]
    fn merge_reserve_ignores_expired_and_unrelated_buckets() {
        let db = db_with_token();
        // Expired core/graphql buckets (reset in the past) are ignored even at 0 remaining, and a
        // non-expired but unrelated bucket (search) never gates the merge processor.
        let mut expired_core = rate("core", 0, 5000);
        expired_core.reset = Some(1);
        let mut expired_graphql = rate("graphql", 0, 5000);
        expired_graphql.reset = Some(1);
        seed_rate(&db, expired_core);
        seed_rate(&db, expired_graphql);
        seed_rate(&db, rate("search", 0, 5000));
        {
            let conn = db.0.lock().unwrap();
            assert!(!merge_rates_below_reserve(&conn));
        }
        // A fresh (non-expired) graphql bucket under the reserve does gate it.
        seed_rate(&db, rate("graphql", 100, 5000));
        let conn = db.0.lock().unwrap();
        assert!(merge_rates_below_reserve(&conn));
    }

    #[test]
    fn merge_processor_persists_auth_failure_and_keeps_fifo_slot() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "first")]);
        {
            let conn = db.0.lock().unwrap();
            dependabot::enqueue_merge_operation(&conn, 1).unwrap();
        }
        let sink = RecordingSink::default();
        let result = tauri::async_runtime::block_on(process_dependabot_merges_core(
            &db,
            sink,
            |_work, _| async move {
                Err(github::MergeRemoteError {
                    class: github::MergeErrorClass::Auth,
                    message: "Invalid or expired token — GitHub returned 401.".to_string(),
                    rates: vec![rate("core", 4990, 5000)],
                })
            },
        ))
        .unwrap();

        assert_eq!(result.processed, 1);
        assert_eq!(
            result.status.last_error.as_deref(),
            Some("Invalid or expired token — GitHub returned 401.")
        );
        let conn = db.0.lock().unwrap();
        let operation = dependabot::list_merge_operations(&conn).unwrap().remove(0);
        assert_eq!(operation.state, "validating");
        assert_eq!(
            operation.last_error.as_deref(),
            Some("Invalid or expired token — GitHub returned 401.")
        );
    }

    /* -------------------------- operation_detail_core -------------------------- */

    #[test]
    fn operation_detail_core_returns_none_for_an_unknown_id() {
        let db = mem_db();
        let conn = db.0.lock().unwrap();
        assert!(operation_detail_core(&conn, 12345).unwrap().is_none());
    }

    #[test]
    fn operation_detail_core_finds_an_existing_operation_with_its_event_in_order() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "first")]);
        let conn = db.0.lock().unwrap();
        let operation = dependabot::enqueue_merge_operation(&conn, 1).unwrap();
        dependabot::append_operation_event(
            &conn,
            operation.id,
            "validating",
            "check",
            "ok",
            "Validated head commit.",
            None,
            Some("abc123"),
            None,
        )
        .unwrap();

        let detail = operation_detail_core(&conn, operation.id).unwrap().unwrap();
        assert_eq!(detail.operation.id, operation.id);
        // Events come back oldest-first (the initial "queued" event, then the appended one).
        assert_eq!(detail.events.len(), 2);
        assert_eq!(detail.events[0].status, "queued");
        assert_eq!(detail.events[1].status, "ok");
        assert_eq!(detail.events[1].summary, "Validated head commit.");
    }

    #[test]
    fn phase_explanations_are_exhaustive_and_non_empty_for_every_planned_phase() {
        let phases = dependabot::MergePhase::KNOWN_PHASES;
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "first")]);
        let conn = db.0.lock().unwrap();
        let operation = dependabot::enqueue_merge_operation(&conn, 1).unwrap();

        for phase in phases {
            dependabot::set_phase(
                &conn,
                operation.id,
                dependabot::MergePhase::from_db(phase),
                None,
                None,
                None,
            )
            .unwrap();
            let refreshed = dependabot::get_operation(&conn, operation.id)
                .unwrap()
                .unwrap();
            let (current_explanation, next_action) = phase_explanation(&refreshed);
            assert!(
                !current_explanation.is_empty() && !next_action.is_empty(),
                "phase {phase} should have a non-empty explanation and next action"
            );
            // Every planned phase gets bespoke copy, not the generic "phase: <name>" fallback.
            assert!(
                !current_explanation.contains("phase:"),
                "phase {phase} unexpectedly hit the generic fallback: {current_explanation}"
            );
        }
    }

    #[test]
    fn frontend_phase_contract_fixture_matches_backend_emitted_phases_and_terminal_states() {
        #[derive(serde::Deserialize)]
        struct PhaseContract {
            phases: Vec<String>,
            graph_terminal_states: Vec<String>,
        }

        let contract: PhaseContract = serde_json::from_str(include_str!(
            "../../contracts/dependabot-merge-phase-contract.json"
        ))
        .unwrap();

        assert_eq!(
            contract.phases,
            dependabot::MergePhase::KNOWN_PHASES
                .iter()
                .map(|phase| phase.to_string())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            contract.graph_terminal_states,
            vec![
                "merged".to_string(),
                "cancelled".to_string(),
                "failed".to_string(),
                "timed_out".to_string(),
            ]
        );
    }

    #[test]
    fn phase_explanation_falls_back_gracefully_for_an_unrecognized_phase() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "first")]);
        let conn = db.0.lock().unwrap();
        let operation = dependabot::enqueue_merge_operation(&conn, 1).unwrap();
        dependabot::set_phase(
            &conn,
            operation.id,
            dependabot::MergePhase::Unknown("some_future_phase".to_string()),
            None,
            None,
            None,
        )
        .unwrap();
        let refreshed = dependabot::get_operation(&conn, operation.id)
            .unwrap()
            .unwrap();

        let (current_explanation, next_action) = phase_explanation(&refreshed);
        assert!(current_explanation.contains("some_future_phase"));
        assert!(!next_action.is_empty());
    }

    #[test]
    fn phase_explanation_prioritizes_terminal_state_over_a_stale_phase() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "first")]);
        let conn = db.0.lock().unwrap();
        let operation = dependabot::enqueue_merge_operation(&conn, 1).unwrap();
        dependabot::set_phase(
            &conn,
            operation.id,
            dependabot::MergePhase::WaitingChecks,
            None,
            None,
            None,
        )
        .unwrap();

        dependabot::terminalize(
            &conn,
            operation.id,
            "failed",
            Some("checks_failed"),
            Some("Required check did not pass."),
            Some("Required check did not pass."),
        )
        .unwrap();
        let refreshed = dependabot::get_operation(&conn, operation.id)
            .unwrap()
            .unwrap();
        let (current_explanation, next_action) = phase_explanation(&refreshed);
        assert!(current_explanation.contains("Required check did not pass."));
        assert!(!next_action.is_empty());
        // The stale "waiting_checks" phase must not leak into the terminal explanation.
        assert!(!current_explanation.contains("status checks"));
    }

    #[test]
    fn phase_explanation_covers_every_terminal_state_and_cancel_requested() {
        let db = db_with_token();
        store(
            &db,
            &[
                pr(1, "octo/repo-a", 10, "merged-pr"),
                pr(2, "octo/repo-a", 11, "cancelled-pr"),
                pr(3, "octo/repo-a", 12, "timed-out-pr"),
                pr(4, "octo/repo-a", 13, "cancel-requested-pr"),
            ],
        );
        let conn = db.0.lock().unwrap();

        let merged = dependabot::enqueue_merge_operation(&conn, 1).unwrap();
        dependabot::terminalize(&conn, merged.id, "merged", None, None, None).unwrap();
        let (explanation, _) = phase_explanation(
            &dependabot::get_operation(&conn, merged.id)
                .unwrap()
                .unwrap(),
        );
        assert!(explanation.contains("merged"));

        let cancelled = dependabot::enqueue_merge_operation(&conn, 2).unwrap();
        dependabot::terminalize(&conn, cancelled.id, "cancelled", None, None, None).unwrap();
        let (explanation, _) = phase_explanation(
            &dependabot::get_operation(&conn, cancelled.id)
                .unwrap()
                .unwrap(),
        );
        assert!(explanation.contains("cancelled"));

        let timed_out = dependabot::enqueue_merge_operation(&conn, 3).unwrap();
        dependabot::terminalize(&conn, timed_out.id, "timed_out", None, None, None).unwrap();
        let (explanation, _) = phase_explanation(
            &dependabot::get_operation(&conn, timed_out.id)
                .unwrap()
                .unwrap(),
        );
        assert!(explanation.contains("stopped waiting"));

        let cancel_requested = dependabot::enqueue_merge_operation(&conn, 4).unwrap();
        conn.execute(
            "UPDATE dependabot_merge_operations SET state = 'cancel_requested' WHERE id = ?1",
            [cancel_requested.id],
        )
        .unwrap();
        let (explanation, next_action) = phase_explanation(
            &dependabot::get_operation(&conn, cancel_requested.id)
                .unwrap()
                .unwrap(),
        );
        assert!(explanation.contains("Cancellation requested"));
        assert!(next_action.contains("cancelled"));
    }

    /* --------------------------- durable orchestrator ------------------------ */

    use github::{
        ActionsRunFailure, BranchComparisonResult, ExactHeadCheckDiagnosis, ExternalCheckFailure,
        MergeQueueEntryStatus, MergeQueuePolicy, MergeQueueStrategy, MergeRemoteError,
        MergeRemoteOutcome, MergeRemoteResult, MutationOutcome, MutationResult, PrQueueStatus,
        PrQueueStatusResult, PullHeadResult, RefUpdateRestrictionResult, WorkflowRunApproval,
    };
    use std::collections::VecDeque;

    fn rates_core() -> Vec<RateLimit> {
        vec![rate("core", 4990, 5000)]
    }

    fn rates_graphql() -> Vec<RateLimit> {
        vec![rate("core", 4990, 5000), rate("graphql", 4980, 5000)]
    }

    type NetResult<T> = Result<T, MergeRemoteError>;

    #[derive(Default)]
    struct Script {
        process: VecDeque<NetResult<MergeRemoteResult>>,
        policy: VecDeque<NetResult<MergeQueuePolicy>>,
        ref_restriction: VecDeque<NetResult<RefUpdateRestrictionResult>>,
        diagnose: VecDeque<NetResult<ExactHeadCheckDiagnosis>>,
        compare: VecDeque<NetResult<BranchComparisonResult>>,
        current_head: VecDeque<NetResult<PullHeadResult>>,
        update_branch: VecDeque<NetResult<MutationResult>>,
        rerun: VecDeque<NetResult<MutationResult>>,
        approve: VecDeque<NetResult<MutationResult>>,
        queue: VecDeque<NetResult<PrQueueStatusResult>>,
        enable: VecDeque<NetResult<MutationResult>>,
        disable: VecDeque<NetResult<MutationResult>>,
        enqueue: VecDeque<NetResult<MutationResult>>,
        dequeue: VecDeque<NetResult<MutationResult>>,
    }

    #[derive(Default, Clone)]
    struct Calls {
        process: usize,
        policy: usize,
        ref_restriction: usize,
        diagnose: usize,
        compare: usize,
        current_head: usize,
        update_branch: usize,
        rerun: usize,
        rerun_ids: Vec<i64>,
        approve: usize,
        approve_ids: Vec<i64>,
        queue: usize,
        enable: usize,
        disable: usize,
        enqueue: usize,
        dequeue: usize,
    }

    struct FakeBackend {
        script: Mutex<Script>,
        calls: Mutex<Calls>,
    }

    impl FakeBackend {
        fn new(script: Script) -> Self {
            Self {
                script: Mutex::new(script),
                calls: Mutex::new(Calls::default()),
            }
        }

        fn calls(&self) -> Calls {
            self.calls.lock().unwrap().clone()
        }

        fn pop<T>(deque: &mut VecDeque<NetResult<T>>, what: &str) -> NetResult<T> {
            deque
                .pop_front()
                .unwrap_or_else(|| panic!("FakeBackend: unexpected extra call to {what}"))
        }
    }

    impl MergeBackend for FakeBackend {
        async fn process_operation(
            &self,
            _work: &dependabot::MergeWork,
            _timed_out: bool,
            _strategy: MergeQueueStrategy,
        ) -> NetResult<MergeRemoteResult> {
            self.calls.lock().unwrap().process += 1;
            Self::pop(
                &mut self.script.lock().unwrap().process,
                "process_operation",
            )
        }

        async fn detect_policy(&self, _repo: &str, _base: &str) -> NetResult<MergeQueuePolicy> {
            self.calls.lock().unwrap().policy += 1;
            Self::pop(&mut self.script.lock().unwrap().policy, "detect_policy")
        }

        async fn ref_update_restriction(
            &self,
            _repo: &str,
            _base: &str,
        ) -> NetResult<RefUpdateRestrictionResult> {
            self.calls.lock().unwrap().ref_restriction += 1;
            Self::pop(
                &mut self.script.lock().unwrap().ref_restriction,
                "ref_update_restriction",
            )
        }

        async fn diagnose(&self, _repo: &str, _head: &str) -> NetResult<ExactHeadCheckDiagnosis> {
            self.calls.lock().unwrap().diagnose += 1;
            Self::pop(&mut self.script.lock().unwrap().diagnose, "diagnose")
        }

        async fn compare_branch(
            &self,
            _repo: &str,
            _base: &str,
            _head: &str,
        ) -> NetResult<BranchComparisonResult> {
            self.calls.lock().unwrap().compare += 1;
            Self::pop(&mut self.script.lock().unwrap().compare, "compare_branch")
        }

        async fn current_head(&self, _pull_url: &str) -> NetResult<PullHeadResult> {
            self.calls.lock().unwrap().current_head += 1;
            Self::pop(
                &mut self.script.lock().unwrap().current_head,
                "current_head",
            )
        }

        async fn update_branch(
            &self,
            _repo: &str,
            _number: i64,
            _head: &str,
        ) -> NetResult<MutationResult> {
            self.calls.lock().unwrap().update_branch += 1;
            Self::pop(
                &mut self.script.lock().unwrap().update_branch,
                "update_branch",
            )
        }

        async fn rerun(&self, _repo: &str, run_id: i64) -> NetResult<MutationResult> {
            {
                let mut calls = self.calls.lock().unwrap();
                calls.rerun += 1;
                calls.rerun_ids.push(run_id);
            }
            Self::pop(&mut self.script.lock().unwrap().rerun, "rerun")
        }

        async fn approve_workflow(&self, _repo: &str, run_id: i64) -> NetResult<MutationResult> {
            {
                let mut calls = self.calls.lock().unwrap();
                calls.approve += 1;
                calls.approve_ids.push(run_id);
            }
            Self::pop(&mut self.script.lock().unwrap().approve, "approve_workflow")
        }

        async fn queue_status(&self, _repo: &str, _number: i64) -> NetResult<PrQueueStatusResult> {
            self.calls.lock().unwrap().queue += 1;
            Self::pop(&mut self.script.lock().unwrap().queue, "queue_status")
        }

        async fn enable_auto_merge(
            &self,
            _node_id: &str,
            _head: &str,
        ) -> NetResult<MutationResult> {
            self.calls.lock().unwrap().enable += 1;
            Self::pop(&mut self.script.lock().unwrap().enable, "enable_auto_merge")
        }

        async fn disable_auto_merge(&self, _node_id: &str) -> NetResult<MutationResult> {
            self.calls.lock().unwrap().disable += 1;
            Self::pop(
                &mut self.script.lock().unwrap().disable,
                "disable_auto_merge",
            )
        }

        async fn enqueue(&self, _node_id: &str, _head: &str) -> NetResult<MutationResult> {
            self.calls.lock().unwrap().enqueue += 1;
            Self::pop(&mut self.script.lock().unwrap().enqueue, "enqueue")
        }

        async fn dequeue(&self, _node_id: &str) -> NetResult<MutationResult> {
            self.calls.lock().unwrap().dequeue += 1;
            Self::pop(&mut self.script.lock().unwrap().dequeue, "dequeue")
        }
    }

    fn prepared(head: &str, base: &str, node: &str, mergeable: Option<&str>) -> MergeRemoteResult {
        MergeRemoteResult {
            outcome: MergeRemoteOutcome::Prepared {
                head_sha: head.to_string(),
                base_ref: base.to_string(),
                node_id: node.to_string(),
                mergeable_state: mergeable.map(str::to_string),
            },
            rates: rates_core(),
        }
    }

    fn pending(head: &str, branch_update: bool) -> MergeRemoteResult {
        MergeRemoteResult {
            outcome: MergeRemoteOutcome::Pending {
                head_sha: head.to_string(),
                approved: true,
                branch_update_requested: branch_update,
                reason: None,
            },
            rates: rates_core(),
        }
    }

    fn pending_with_reason(head: &str, reason: &str) -> MergeRemoteResult {
        MergeRemoteResult {
            outcome: MergeRemoteOutcome::Pending {
                head_sha: head.to_string(),
                approved: true,
                branch_update_requested: false,
                reason: Some(reason.to_string()),
            },
            rates: rates_core(),
        }
    }

    fn approval(run_id: i64, name: &str) -> WorkflowRunApproval {
        WorkflowRunApproval {
            run_id,
            run_attempt: 1,
            name: Some(name.to_string()),
        }
    }

    fn blocked(head: &str, base: &str) -> MergeRemoteResult {
        MergeRemoteResult {
            outcome: MergeRemoteOutcome::Blocked {
                head_sha: head.to_string(),
                base_ref: base.to_string(),
            },
            rates: rates_core(),
        }
    }

    fn pull_head(head: &str) -> PullHeadResult {
        PullHeadResult {
            head_sha: head.to_string(),
            rates: rates_core(),
        }
    }

    fn policy(strategy: MergeQueueStrategy) -> MergeQueuePolicy {
        MergeQueuePolicy {
            strategy,
            rates: rates_core(),
        }
    }

    fn ref_restriction(restricted: Option<bool>) -> RefUpdateRestrictionResult {
        RefUpdateRestrictionResult {
            restricted,
            rates: rates_core(),
        }
    }

    fn applied() -> MutationResult {
        MutationResult {
            outcome: MutationOutcome::Applied,
            rates: rates_graphql(),
        }
    }

    fn transient_err(message: &str) -> MergeRemoteError {
        MergeRemoteError {
            class: github::MergeErrorClass::Transient,
            message: message.to_string(),
            rates: rates_graphql(),
        }
    }

    fn permanent_err(message: &str) -> MergeRemoteError {
        MergeRemoteError {
            class: github::MergeErrorClass::Permanent,
            message: message.to_string(),
            rates: rates_graphql(),
        }
    }

    fn queue_result(status: Option<PrQueueStatus>) -> PrQueueStatusResult {
        PrQueueStatusResult {
            status,
            rates: rates_graphql(),
        }
    }

    fn pr_status(head: &str) -> PrQueueStatus {
        PrQueueStatus {
            node_id: "PR_node".to_string(),
            head_oid: head.to_string(),
            state: "OPEN".to_string(),
            merged: false,
            mergeable: Some("MERGEABLE".to_string()),
            review_decision: Some("APPROVED".to_string()),
            check_status: Some("SUCCESS".to_string()),
            auto_merge_enabled: false,
            merge_queue_entry: None,
        }
    }

    fn enqueue_op(db: &Db, pr_id: i64) -> i64 {
        let conn = db.0.lock().unwrap();
        dependabot::enqueue_merge_operation(&conn, pr_id)
            .unwrap()
            .id
    }

    fn op(db: &Db, op_id: i64) -> dependabot::DependabotMergeOperation {
        let conn = db.0.lock().unwrap();
        dependabot::get_operation(&conn, op_id).unwrap().unwrap()
    }

    fn events(db: &Db, op_id: i64) -> Vec<dependabot::MergeOperationEvent> {
        let conn = db.0.lock().unwrap();
        dependabot::list_operation_events(&conn, op_id).unwrap()
    }

    fn statuses(db: &Db, op_id: i64) -> Vec<String> {
        events(db, op_id).into_iter().map(|e| e.status).collect()
    }

    fn phases(db: &Db, op_id: i64) -> Vec<String> {
        events(db, op_id).into_iter().map(|e| e.phase).collect()
    }

    fn force_due(db: &Db, op_id: i64) {
        let conn = db.0.lock().unwrap();
        dependabot::schedule_next_action(&conn, op_id, None).unwrap();
    }

    fn set_delegated_at(db: &Db, op_id: i64, sql_offset: &str) {
        let conn = db.0.lock().unwrap();
        conn.execute(
            "UPDATE dependabot_merge_operations
             SET delegated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now', ?2), state = 'delegated'
             WHERE id = ?1",
            rusqlite::params![op_id, sql_offset],
        )
        .unwrap();
    }

    /// Run one processor tick through the real FIFO loop with the orchestrator wired to a fake
    /// backend — exercises begin/timeout/rate-reserve/FIFO bookkeeping and the orchestrator's
    /// durable persistence together, no HTTP.
    fn tick(db: &Db, fake: &FakeBackend) -> DependabotMergeProcessResult {
        let sink = RecordingSink::default();
        tauri::async_runtime::block_on(process_dependabot_merges_core(
            db,
            sink,
            |work, timed_out| orchestrate_operation(db, fake, work, timed_out),
        ))
        .unwrap()
    }

    #[test]
    fn direct_strategy_detects_caches_then_merges_across_two_ticks() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([
                Ok(prepared("sha1", "main", "PR_1", Some("clean"))),
                Ok(MergeRemoteResult {
                    outcome: MergeRemoteOutcome::Merged {
                        head_sha: Some("sha1".to_string()),
                    },
                    rates: rates_core(),
                }),
            ]),
            policy: VecDeque::from([Ok(policy(MergeQueueStrategy::Direct))]),
            ..Default::default()
        });

        // Tick 1: validate + approve, detect + cache the strategy, then delegate.
        tick(&db, &fake);
        let after_one = op(&db, id);
        assert_eq!(after_one.state, "delegated");
        assert_eq!(after_one.strategy, "direct");
        assert_eq!(after_one.base_ref.as_deref(), Some("main"));
        assert_eq!(after_one.pull_node_id.as_deref(), Some("PR_1"));
        {
            let conn = db.0.lock().unwrap();
            let cached = dependabot::get_merge_policy(&conn, "octo/repo-a", "main", None)
                .unwrap()
                .unwrap();
            assert_eq!(cached.strategy, "direct");
        }

        // Tick 2: strategy is cached, so it goes straight to the direct merge.
        tick(&db, &fake);
        assert_eq!(op(&db, id).state, "merged");
        assert_eq!(fake.calls().policy, 1, "policy detected once, then cached");
        assert!(statuses(&db, id).contains(&"direct".to_string()));
        assert!(phases(&db, id).contains(&"merging".to_string()));
    }

    #[test]
    fn direct_pending_checks_wait_without_scheduling_a_retry() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(blocked("sha1", "main"))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                pending: vec![github::PendingCheck {
                    name: "build".to_string(),
                    source: github::CheckSource::Actions,
                }],
                rates: rates_core(),
                ..Default::default()
            })]),
            ..Default::default()
        });
        // Seed a cached direct policy + base ref so process is entered on the direct branch.
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }
        tick(&db, &fake);
        let after = op(&db, id);
        assert_eq!(after.phase, "waiting_checks");
        assert_eq!(after.check_retry_count, 0);
        assert_eq!(fake.calls().rerun, 0);
        assert_eq!(fake.calls().compare, 0);
        assert!(statuses(&db, id).contains(&"pending".to_string()));
    }

    #[test]
    fn direct_action_required_runs_are_approved_for_the_exact_head() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(pending("sha1", false))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                approval_required: vec![approval(100, "build"), approval(200, "dependency review")],
                rates: rates_core(),
                ..Default::default()
            })]),
            current_head: VecDeque::from([Ok(pull_head("sha1"))]),
            approve: VecDeque::from([Ok(applied()), Ok(applied())]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }

        tick(&db, &fake);

        let after = op(&db, id);
        assert_eq!(after.phase, "waiting_checks");
        assert_eq!(
            after.failure_reason.as_deref(),
            Some("Workflow approvals reconciled; waiting for checks to run.")
        );
        let calls = fake.calls();
        assert_eq!(calls.current_head, 1);
        assert_eq!(calls.approve_ids, vec![100, 200]);
        assert_eq!(calls.rerun, 0);
        let operation_events = events(&db, id);
        assert!(operation_events
            .iter()
            .any(|event| event.phase == "approving_workflows" && event.status == "start"));
        assert_eq!(
            operation_events
                .iter()
                .filter(|event| {
                    event.phase == "approving_workflows" && event.status == "reconciled"
                })
                .count(),
            2
        );
    }

    #[test]
    fn workflow_approval_skips_every_run_when_the_head_changed() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(pending("sha1", false))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                approval_required: vec![approval(100, "build"), approval(200, "lint")],
                rates: rates_core(),
                ..Default::default()
            })]),
            current_head: VecDeque::from([Ok(pull_head("sha2"))]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }

        tick(&db, &fake);

        assert_eq!(op(&db, id).phase, "validating");
        assert_eq!(fake.calls().approve, 0);
        assert!(events(&db, id)
            .iter()
            .any(|event| event.kind == "workflow_approval" && event.status == "stale"));
    }

    #[test]
    fn workflow_approval_honors_cancellation_between_runs() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(pending("sha1", false))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                approval_required: vec![approval(100, "build"), approval(200, "lint")],
                rates: rates_core(),
                ..Default::default()
            })]),
            current_head: VecDeque::from([Ok(pull_head("sha1"))]),
            approve: VecDeque::from([
                Ok(applied()),
                Ok(MutationResult {
                    outcome: MutationOutcome::Cancelled,
                    rates: rates_core(),
                }),
            ]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }

        tick(&db, &fake);

        assert_eq!(op(&db, id).state, "cancelled");
        assert_eq!(fake.calls().approve_ids, vec![100, 200]);
    }

    #[test]
    fn direct_refusal_with_no_visible_checks_preserves_github_reason() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let refusal = "Changes must be made through the merge queue.";
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(pending_with_reason("sha1", refusal))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                rates: rates_core(),
                ..Default::default()
            })]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }

        tick(&db, &fake);

        let after = op(&db, id);
        assert_eq!(after.phase, "waiting_requirements");
        assert_eq!(after.failure_reason.as_deref(), Some(refusal));
        let operation_events = events(&db, id);
        assert!(operation_events
            .iter()
            .any(|event| event.summary == refusal));
        assert!(!operation_events
            .iter()
            .any(|event| event.summary.contains("status check")));
    }

    #[test]
    fn direct_blocked_with_complete_checks_updates_a_stale_branch() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(blocked("sha1", "main"))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                rates: rates_core(),
                ..Default::default()
            })]),
            compare: VecDeque::from([Ok(BranchComparisonResult {
                behind: true,
                rates: rates_core(),
            })]),
            update_branch: VecDeque::from([Ok(MutationResult {
                outcome: MutationOutcome::Applied,
                rates: rates_core(),
            })]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }

        tick(&db, &fake);

        let after = op(&db, id);
        assert_eq!(after.state, "delegated");
        assert_eq!(after.phase, "updating_branch");
        let update_from: Option<String> =
            db.0.lock()
                .unwrap()
                .query_row(
                    "SELECT update_branch_from_sha FROM dependabot_merge_operations WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
        assert_eq!(update_from.as_deref(), Some("sha1"));
        assert_eq!(fake.calls().compare, 1);
        assert_eq!(fake.calls().update_branch, 1);
        assert!(statuses(&db, id).contains(&"requested".to_string()));
    }

    #[test]
    fn direct_blocked_with_no_visible_checks_and_current_branch_keeps_waiting() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(blocked("sha1", "main"))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                rates: rates_core(),
                ..Default::default()
            })]),
            compare: VecDeque::from([Ok(BranchComparisonResult {
                behind: false,
                rates: rates_core(),
            })]),
            ref_restriction: VecDeque::from([Ok(ref_restriction(None))]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }

        tick(&db, &fake);

        let after = op(&db, id);
        assert_eq!(after.state, "delegated");
        assert_eq!(after.phase, "waiting_requirements");
        let failure_code: Option<String> =
            db.0.lock()
                .unwrap()
                .query_row(
                    "SELECT failure_code FROM dependabot_merge_operations WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
        assert_eq!(failure_code, None);
        assert_eq!(fake.calls().compare, 1);
        assert_eq!(fake.calls().ref_restriction, 1);
        assert_eq!(fake.calls().update_branch, 0);
        assert!(statuses(&db, id).contains(&"pending".to_string()));
    }

    #[test]
    fn direct_blocked_by_protected_target_ref_terminates() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(blocked("sha1", "enterprise-3.16-release"))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                rates: rates_core(),
                ..Default::default()
            })]),
            compare: VecDeque::from([Ok(BranchComparisonResult {
                behind: false,
                rates: rates_core(),
            })]),
            ref_restriction: VecDeque::from([Ok(ref_restriction(Some(true)))]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(
                &conn,
                "octo/repo-a",
                "enterprise-3.16-release",
                "direct",
            )
            .unwrap();
            dependabot::set_phase(
                &conn,
                id,
                "queued",
                Some("direct"),
                None,
                Some("enterprise-3.16-release"),
            )
            .unwrap();
        }

        tick(&db, &fake);

        let after = op(&db, id);
        assert_eq!(after.state, "failed");
        let failure_code: Option<String> =
            db.0.lock()
                .unwrap()
                .query_row(
                    "SELECT failure_code FROM dependabot_merge_operations WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
        assert_eq!(failure_code.as_deref(), Some("protected_ref"));
        assert!(after
            .failure_reason
            .as_deref()
            .unwrap()
            .contains("enterprise-3.16-release"));
        assert_eq!(fake.calls().ref_restriction, 1);
        assert_eq!(fake.calls().update_branch, 0);
        assert!(statuses(&db, id).contains(&"failed".to_string()));
    }

    #[test]
    fn direct_external_ci_failure_terminates_as_needs_attention_with_names() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(pending("sha1", false))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                external_failures: vec![ExternalCheckFailure {
                    name: "Third-party CI".to_string(),
                    conclusion: Some("failure".to_string()),
                    details_url: None,
                }],
                rates: rates_core(),
                ..Default::default()
            })]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }
        tick(&db, &fake);
        let after = op(&db, id);
        assert_eq!(after.state, "failed");
        assert!(after
            .failure_reason
            .as_deref()
            .unwrap()
            .contains("Third-party CI"));
    }

    #[test]
    fn direct_actions_failure_schedules_then_reruns_each_unique_run() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(pending("sha1", false)), Ok(pending("sha1", false))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                actions_failures: vec![
                    ActionsRunFailure {
                        run_id: 100,
                        run_attempt: 1,
                        name: Some("ci".to_string()),
                        conclusion: Some("failure".to_string()),
                    },
                    ActionsRunFailure {
                        run_id: 200,
                        run_attempt: 1,
                        name: Some("lint".to_string()),
                        conclusion: Some("failure".to_string()),
                    },
                ],
                rates: rates_core(),
                ..Default::default()
            })]),
            current_head: VecDeque::from([Ok(pull_head("sha1"))]),
            rerun: VecDeque::from([Ok(applied()), Ok(applied())]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }

        // Tick 1: both failed runs scheduled; a five-minute backoff is set.
        tick(&db, &fake);
        let after_one = op(&db, id);
        assert_eq!(after_one.phase, "retry_scheduled");
        assert_eq!(after_one.check_retry_count, 2);
        assert!(after_one.next_action_at.is_some());

        // Not due yet → the next tick is a no-op backoff (no diagnose/rerun network).
        tick(&db, &fake);
        assert_eq!(fake.calls().rerun, 0);
        assert_eq!(op(&db, id).phase, "retry_scheduled");

        // Force the backoff due → both scheduled runs are rerun exactly once.
        force_due(&db, id);
        tick(&db, &fake);
        let calls = fake.calls();
        assert_eq!(calls.rerun, 2);
        let mut reran = calls.rerun_ids.clone();
        reran.sort_unstable();
        assert_eq!(reran, vec![100, 200]);
        assert_eq!(op(&db, id).phase, "waiting_checks");
        let conn = db.0.lock().unwrap();
        let retries = dependabot::list_check_retries(&conn, id).unwrap();
        assert!(retries
            .iter()
            .all(|r| r.outcome.as_deref() == Some("requested")));
    }

    #[test]
    fn direct_actions_failure_repeats_new_attempts_until_the_deadline() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        // Every diagnose pass reports a fresh failed attempt of the same run.
        let mut process = VecDeque::new();
        let mut diagnose = VecDeque::new();
        let mut current_head = VecDeque::new();
        let mut rerun = VecDeque::new();
        for attempt in 1..=3 {
            process.push_back(Ok(pending("sha1", false)));
            diagnose.push_back(Ok(ExactHeadCheckDiagnosis {
                actions_failures: vec![ActionsRunFailure {
                    run_id: 100,
                    run_attempt: attempt,
                    name: Some("ci".to_string()),
                    conclusion: Some("failure".to_string()),
                }],
                rates: rates_core(),
                ..Default::default()
            }));
            current_head.push_back(Ok(pull_head("sha1")));
            rerun.push_back(Ok(applied()));
        }
        let fake = FakeBackend::new(Script {
            process,
            diagnose,
            current_head,
            rerun,
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }
        // Three failure→schedule→rerun cycles, no numeric cap.
        for _ in 0..3 {
            tick(&db, &fake); // diagnose → schedule
            force_due(&db, id);
            tick(&db, &fake); // rerun
            force_due(&db, id);
        }
        assert_eq!(fake.calls().rerun, 3);
        assert_eq!(op(&db, id).check_retry_count, 3);
    }

    #[test]
    fn stale_persisted_retry_is_skipped_before_processing_the_new_head() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                "retry_scheduled",
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
            dependabot::mark_merge_progress(&conn, id, "old-head", true, false, None).unwrap();
            dependabot::schedule_check_retry(&conn, id, "old-head", 100, 1).unwrap();
            dependabot::schedule_next_action(&conn, id, None).unwrap();
        }
        let fake = FakeBackend::new(Script {
            current_head: VecDeque::from([Ok(pull_head("new-head"))]),
            process: VecDeque::from([Ok(MergeRemoteResult {
                outcome: MergeRemoteOutcome::Merged {
                    head_sha: Some("new-head".to_string()),
                },
                rates: rates_core(),
            })]),
            ..Default::default()
        });

        tick(&db, &fake);

        assert_eq!(op(&db, id).state, "merged");
        assert_eq!(fake.calls().current_head, 1);
        assert_eq!(fake.calls().rerun, 0);
        let retry = dependabot::list_check_retries(&db.0.lock().unwrap(), id)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(retry.outcome.as_deref(), Some("stale_head"));
        assert!(retry.requested_at.is_none());
        assert!(statuses(&db, id).contains(&"stale".to_string()));
    }

    #[test]
    fn non_rerunnable_workflow_failure_does_not_starve_later_repositories() {
        let db = db_with_token();
        store(
            &db,
            &[
                pr(1, "octo/repo-a", 10, "Broken retry"),
                pr(2, "octo/repo-b", 20, "Should progress"),
            ],
        );
        let blocked_id = enqueue_op(&db, 1);
        let later_id = enqueue_op(&db, 2);
        {
            let conn = db.0.lock().unwrap();
            dependabot::mark_merge_progress(&conn, blocked_id, "sha-a", true, false, None).unwrap();
            dependabot::schedule_check_retry(&conn, blocked_id, "sha-a", 100, 1).unwrap();
            dependabot::schedule_next_action(&conn, blocked_id, None).unwrap();
        }
        let fake = FakeBackend::new(Script {
            current_head: VecDeque::from([Ok(pull_head("sha-a"))]),
            rerun: VecDeque::from([Err(permanent_err(
                "GitHub returned 403 Forbidden: workflow run cannot be retried",
            ))]),
            process: VecDeque::from([Ok(MergeRemoteResult {
                outcome: MergeRemoteOutcome::Merged {
                    head_sha: Some("sha-b".to_string()),
                },
                rates: rates_core(),
            })]),
            ..Default::default()
        });

        let result = tick(&db, &fake);

        assert_eq!(result.processed, 2);
        assert_eq!(op(&db, blocked_id).state, "failed");
        assert_eq!(op(&db, later_id).state, "merged");
        let retry = dependabot::list_check_retries(&db.0.lock().unwrap(), blocked_id)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(retry.outcome.as_deref(), Some("not_rerunnable"));
        assert!(retry.requested_at.is_some());
        assert!(statuses(&db, blocked_id).contains(&"failed".to_string()));
        assert_eq!(fake.calls().process, 1);
    }

    #[test]
    fn direct_actions_failure_near_deadline_is_not_scheduled() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(pending("sha1", false))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                actions_failures: vec![ActionsRunFailure {
                    run_id: 100,
                    run_attempt: 1,
                    name: Some("ci".to_string()),
                    conclusion: Some("failure".to_string()),
                }],
                rates: rates_core(),
                ..Default::default()
            })]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }
        // Delegated 89 minutes ago: too little of the 90-minute deadline remains to retry.
        set_delegated_at(&db, id, "-89 minutes");
        tick(&db, &fake);
        assert_eq!(op(&db, id).check_retry_count, 0);
        let conn = db.0.lock().unwrap();
        assert!(dependabot::list_check_retries(&conn, id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn direct_branch_update_moves_to_updating_branch_phase() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(pending("sha1", true))]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "direct").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("direct"),
                None,
                Some("main"),
            )
            .unwrap();
        }
        tick(&db, &fake);
        assert_eq!(op(&db, id).phase, "updating_branch");
        assert_eq!(fake.calls().diagnose, 0);
    }

    #[test]
    fn unknown_policy_stays_retryable_and_never_silently_direct() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(prepared("sha1", "main", "PR_1", Some("blocked")))]),
            policy: VecDeque::from([Ok(policy(MergeQueueStrategy::Unknown))]),
            ..Default::default()
        });
        tick(&db, &fake);
        let after = op(&db, id);
        assert_eq!(after.strategy, "unknown");
        assert!(
            after.state == "delegated" && after.next_action_at.is_some(),
            "unknown policy stays active and paced for retry, not terminal"
        );
        // Nothing was cached, so it is re-derived (never assumed direct) next time.
        let conn = db.0.lock().unwrap();
        assert!(
            dependabot::get_merge_policy(&conn, "octo/repo-a", "main", None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn queue_strategy_approves_required_workflows_before_first_enqueue() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let mut status = pr_status("sha1");
        status.check_status = Some("FAILURE".to_string());
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(prepared("sha1", "main", "PR_1", Some("clean")))]),
            policy: VecDeque::from([Ok(policy(MergeQueueStrategy::MergeQueue))]),
            queue: VecDeque::from([Ok(queue_result(Some(status)))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                approval_required: vec![approval(100, "build")],
                rates: rates_core(),
                ..Default::default()
            })]),
            current_head: VecDeque::from([Ok(pull_head("sha1"))]),
            approve: VecDeque::from([Ok(applied())]),
            ..Default::default()
        });

        tick(&db, &fake);

        let after = op(&db, id);
        assert_eq!(after.strategy, "merge_queue");
        assert_eq!(after.phase, "waiting_checks");
        let calls = fake.calls();
        assert_eq!(calls.approve_ids, vec![100]);
        assert_eq!(calls.enqueue, 0);
        assert_eq!(calls.enable, 0);
    }

    #[test]
    fn queue_strategy_ignores_non_required_failures_before_first_enqueue() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let mut status = pr_status("sha1");
        status.check_status = Some("FAILURE".to_string());
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(prepared("sha1", "main", "PR_1", Some("clean")))]),
            policy: VecDeque::from([Ok(policy(MergeQueueStrategy::MergeQueue))]),
            queue: VecDeque::from([Ok(queue_result(Some(status)))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                external_failures: vec![ExternalCheckFailure {
                    name: "optional check".to_string(),
                    conclusion: Some("failure".to_string()),
                    details_url: None,
                }],
                rates: rates_core(),
                ..Default::default()
            })]),
            enqueue: VecDeque::from([Ok(applied())]),
            ..Default::default()
        });

        tick(&db, &fake);

        let after = op(&db, id);
        assert_eq!(after.state, "delegated");
        assert_eq!(after.phase, "waiting_merge_queue");
        let calls = fake.calls();
        assert_eq!(calls.diagnose, 1);
        assert_eq!(calls.enqueue, 1);
        assert_eq!(calls.enable, 0);
    }

    #[test]
    fn queue_strategy_enables_auto_merge_when_requirements_are_pending() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let mut status = pr_status("sha1");
        status.review_decision = Some("REVIEW_REQUIRED".to_string());
        status.check_status = Some("PENDING".to_string());
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(prepared("sha1", "main", "PR_1", Some("blocked")))]),
            policy: VecDeque::from([Ok(policy(MergeQueueStrategy::MergeQueue))]),
            queue: VecDeque::from([Ok(queue_result(Some(status)))]),
            enable: VecDeque::from([Ok(applied())]),
            ..Default::default()
        });
        tick(&db, &fake);
        let after = op(&db, id);
        assert_eq!(after.strategy, "merge_queue");
        assert_eq!(after.phase, "enabling_auto_merge");
        assert!(after.auto_merge_enabled);
        let calls = fake.calls();
        assert_eq!(calls.enable, 1);
        assert_eq!(calls.enqueue, 0);
    }

    #[test]
    fn queue_strategy_enqueues_an_eligible_pr_then_tracks_its_position() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let mut queued = pr_status("sha1");
        queued.merge_queue_entry = Some(MergeQueueEntryStatus {
            id: "entry".to_string(),
            position: Some(3),
            state: Some("QUEUED".to_string()),
        });
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(prepared("sha1", "main", "PR_1", Some("clean")))]),
            policy: VecDeque::from([Ok(policy(MergeQueueStrategy::MergeQueue))]),
            queue: VecDeque::from([
                Ok(queue_result(Some(pr_status("sha1")))),
                Ok(queue_result(Some(queued))),
            ]),
            enqueue: VecDeque::from([Ok(applied())]),
            ..Default::default()
        });
        // Tick 1: eligible + not queued → enqueue.
        tick(&db, &fake);
        assert_eq!(op(&db, id).phase, "waiting_merge_queue");
        assert_eq!(fake.calls().enqueue, 1);

        // Tick 2: now in the queue → its live position is persisted.
        force_due(&db, id);
        tick(&db, &fake);
        assert_eq!(op(&db, id).merge_queue_position, Some(3));
    }

    #[test]
    fn queue_strategy_records_a_merged_terminal() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        let mut merged = pr_status("sha1");
        merged.merged = true;
        merged.state = "MERGED".to_string();
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(prepared("sha1", "main", "PR_1", Some("clean")))]),
            policy: VecDeque::from([Ok(policy(MergeQueueStrategy::MergeQueue))]),
            queue: VecDeque::from([Ok(queue_result(Some(merged)))]),
            ..Default::default()
        });
        tick(&db, &fake);
        assert_eq!(op(&db, id).state, "merged");
    }

    #[test]
    fn queue_ejection_diagnoses_and_schedules_a_retry() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        // Simulate an operation already enrolled (auto-merge on) whose checks then failed.
        let mut ejected = pr_status("sha1");
        ejected.check_status = Some("FAILURE".to_string());
        ejected.review_decision = Some("APPROVED".to_string());
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(prepared("sha1", "main", "PR_1", Some("blocked")))]),
            queue: VecDeque::from([Ok(queue_result(Some(ejected)))]),
            diagnose: VecDeque::from([Ok(ExactHeadCheckDiagnosis {
                actions_failures: vec![ActionsRunFailure {
                    run_id: 55,
                    run_attempt: 1,
                    name: Some("ci".to_string()),
                    conclusion: Some("failure".to_string()),
                }],
                rates: rates_core(),
                ..Default::default()
            })]),
            ..Default::default()
        });
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "merge_queue").unwrap();
            dependabot::set_phase(
                &conn,
                id,
                dependabot::MergePhase::Queued,
                Some("merge_queue"),
                None,
                Some("main"),
            )
            .unwrap();
            dependabot::set_queue_metadata(&conn, id, None, true).unwrap();
        }
        tick(&db, &fake);
        let after = op(&db, id);
        assert_eq!(after.phase, "retry_scheduled");
        assert_eq!(after.check_retry_count, 1);
        assert_eq!(fake.calls().diagnose, 1);
    }

    #[test]
    fn queue_cancellation_disables_auto_merge_and_dequeues_before_terminal_cancel() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        {
            let conn = db.0.lock().unwrap();
            // Put the operation in a delegated, enrolled state, then request cancellation.
            dependabot::mark_merge_progress(&conn, id, "sha1", true, false, None).unwrap();
            dependabot::set_phase(
                &conn,
                id,
                "waiting_merge_queue",
                Some("merge_queue"),
                Some("PR_1"),
                Some("main"),
            )
            .unwrap();
            dependabot::set_queue_metadata(&conn, id, Some(2), true).unwrap();
            dependabot::request_cancel(&conn, id).unwrap();
        }
        let mut queued = pr_status("sha1");
        queued.auto_merge_enabled = true;
        queued.merge_queue_entry = Some(MergeQueueEntryStatus {
            id: "entry".to_string(),
            position: Some(2),
            state: Some("QUEUED".to_string()),
        });
        let fake = FakeBackend::new(Script {
            queue: VecDeque::from([Ok(queue_result(Some(queued)))]),
            disable: VecDeque::from([Ok(applied())]),
            dequeue: VecDeque::from([Ok(applied())]),
            ..Default::default()
        });
        tick(&db, &fake);
        let after = op(&db, id);
        assert_eq!(after.state, "cancelled");
        let calls = fake.calls();
        assert_eq!(calls.disable, 1, "auto-merge disabled before cancelling");
        assert_eq!(calls.dequeue, 1, "dequeued before cancelling");
        assert_eq!(
            calls.process, 0,
            "no validation/merge attempted while cancelling"
        );
    }

    #[test]
    fn queue_cancellation_reconciles_remote_enrollment_missing_from_local_metadata() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "merge_queue").unwrap();
            dependabot::mark_merge_progress(&conn, id, "sha1", true, false, None).unwrap();
            dependabot::set_phase(
                &conn,
                id,
                "waiting_merge_queue",
                Some("merge_queue"),
                Some("PR_1"),
                Some("main"),
            )
            .unwrap();
            dependabot::request_cancel(&conn, id).unwrap();
        }
        let mut queued = pr_status("sha1");
        queued.auto_merge_enabled = true;
        queued.merge_queue_entry = Some(MergeQueueEntryStatus {
            id: "entry".to_string(),
            position: Some(1),
            state: Some("QUEUED".to_string()),
        });
        let fake = FakeBackend::new(Script {
            queue: VecDeque::from([Ok(queue_result(Some(queued)))]),
            disable: VecDeque::from([Ok(applied())]),
            dequeue: VecDeque::from([Ok(applied())]),
            ..Default::default()
        });

        tick(&db, &fake);

        assert_eq!(op(&db, id).state, "cancelled");
        let calls = fake.calls();
        assert_eq!(calls.queue, 1);
        assert_eq!(calls.disable, 1);
        assert_eq!(calls.dequeue, 1);
    }

    #[test]
    fn queue_cancellation_records_a_concurrent_remote_merge() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        {
            let conn = db.0.lock().unwrap();
            dependabot::mark_merge_progress(&conn, id, "sha1", true, false, None).unwrap();
            dependabot::set_phase(
                &conn,
                id,
                "waiting_merge_queue",
                Some("merge_queue"),
                Some("PR_1"),
                Some("main"),
            )
            .unwrap();
            dependabot::request_cancel(&conn, id).unwrap();
        }
        let mut merged = pr_status("sha1");
        merged.merged = true;
        merged.state = "MERGED".to_string();
        let fake = FakeBackend::new(Script {
            queue: VecDeque::from([Ok(queue_result(Some(merged)))]),
            ..Default::default()
        });

        tick(&db, &fake);

        assert_eq!(op(&db, id).state, "merged");
        let calls = fake.calls();
        assert_eq!(calls.disable, 0);
        assert_eq!(calls.dequeue, 0);
    }

    #[test]
    fn queue_operation_honors_the_90_minute_deadline_and_releases_the_fifo_head() {
        let db = db_with_token();
        store(
            &db,
            &[
                pr(1, "octo/repo-a", 10, "Bump one"),
                pr(2, "octo/repo-a", 11, "Bump two"),
            ],
        );
        let head_id = enqueue_op(&db, 1);
        let next_id = enqueue_op(&db, 2);
        // Enroll the head in the merge queue (auto-merge on, node id + accepted head known) so it
        // takes the queue-polling fast path, then age it past the 90-minute deadline.
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "merge_queue").unwrap();
            dependabot::mark_merge_progress(&conn, head_id, "sha1", true, false, None).unwrap();
            dependabot::set_phase(
                &conn,
                head_id,
                "waiting_merge_queue",
                Some("unknown"),
                Some("PR_1"),
                Some("main"),
            )
            .unwrap();
            dependabot::set_queue_metadata(&conn, head_id, Some(2), true).unwrap();
        }
        set_delegated_at(&db, head_id, "-91 minutes");
        force_due(&db, head_id);
        // Still sitting in the queue (never merged) when the deadline elapses.
        let mut queued = pr_status("sha1");
        queued.merge_queue_entry = Some(MergeQueueEntryStatus {
            id: "entry".to_string(),
            position: Some(2),
            state: Some("QUEUED".to_string()),
        });
        let fake = FakeBackend::new(Script {
            queue: VecDeque::from([Ok(queue_result(Some(queued)))]),
            disable: VecDeque::from([Ok(applied())]),
            dequeue: VecDeque::from([Ok(applied())]),
            ..Default::default()
        });
        tick(&db, &fake);
        // The timed-out head first undoes the enrollment it created (disable auto-merge + dequeue)
        // under the mutation guard, then terminates as `timed_out`. It never re-enqueues/enables
        // (a merge GitHub completes still wins above).
        let after = op(&db, head_id);
        assert_eq!(after.state, "timed_out");
        let calls = fake.calls();
        assert_eq!(calls.enqueue, 0);
        assert_eq!(calls.enable, 0);
        assert_eq!(calls.disable, 1, "auto-merge disabled before timing out");
        assert_eq!(calls.dequeue, 1, "dequeued before timing out");
        assert!(
            statuses(&db, head_id).iter().any(|s| s == "timed_out"),
            "the timeout is narrated in the durable event log"
        );
        // The per-repo FIFO head is released so the next queued PR can proceed.
        let heads = {
            let conn = db.0.lock().unwrap();
            dependabot::merge_operation_heads(&conn).unwrap()
        };
        assert_eq!(heads.len(), 1);
        assert_eq!(
            heads[0].operation.id, next_id,
            "the next PR in the repo becomes the FIFO head after the timeout"
        );
    }

    #[test]
    fn queue_merged_wins_even_after_the_deadline() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "merge_queue").unwrap();
            dependabot::mark_merge_progress(&conn, id, "sha1", true, false, None).unwrap();
            dependabot::set_phase(
                &conn,
                id,
                "waiting_merge_queue",
                Some("merge_queue"),
                Some("PR_1"),
                Some("main"),
            )
            .unwrap();
            dependabot::set_queue_metadata(&conn, id, Some(1), true).unwrap();
        }
        set_delegated_at(&db, id, "-91 minutes");
        force_due(&db, id);
        // GitHub merged it right at the deadline: the merged result is checked before the timeout.
        let mut merged = pr_status("sha1");
        merged.merged = true;
        merged.state = "MERGED".to_string();
        let fake = FakeBackend::new(Script {
            queue: VecDeque::from([Ok(queue_result(Some(merged)))]),
            ..Default::default()
        });
        tick(&db, &fake);
        assert_eq!(
            op(&db, id).state,
            "merged",
            "a merge GitHub completed wins over the 90-minute deadline"
        );
    }

    #[test]
    fn queue_timeout_reconciles_remote_auto_merge_missing_from_local_metadata() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "merge_queue").unwrap();
            dependabot::mark_merge_progress(&conn, id, "sha1", true, false, None).unwrap();
            dependabot::set_phase(
                &conn,
                id,
                "waiting_merge_queue",
                Some("merge_queue"),
                Some("PR_1"),
                Some("main"),
            )
            .unwrap();
        }
        set_delegated_at(&db, id, "-91 minutes");
        force_due(&db, id);
        let mut status = pr_status("sha1");
        status.auto_merge_enabled = true;
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(prepared("sha1", "main", "PR_1", Some("clean")))]),
            queue: VecDeque::from([Ok(queue_result(Some(status)))]),
            disable: VecDeque::from([Ok(applied())]),
            ..Default::default()
        });

        tick(&db, &fake);

        assert_eq!(op(&db, id).state, "timed_out");
        let calls = fake.calls();
        assert_eq!(calls.queue, 1);
        assert_eq!(calls.disable, 1);
        assert_eq!(calls.dequeue, 0);
    }

    #[test]
    fn queue_timeout_cleanup_failure_keeps_the_operation_active_and_the_fifo_head() {
        let db = db_with_token();
        store(
            &db,
            &[
                pr(1, "octo/repo-a", 10, "Bump one"),
                pr(2, "octo/repo-a", 11, "Bump two"),
            ],
        );
        let head_id = enqueue_op(&db, 1);
        let next_id = enqueue_op(&db, 2);
        {
            let conn = db.0.lock().unwrap();
            dependabot::cache_merge_policy(&conn, "octo/repo-a", "main", "merge_queue").unwrap();
            dependabot::mark_merge_progress(&conn, head_id, "sha1", true, false, None).unwrap();
            dependabot::set_phase(
                &conn,
                head_id,
                "waiting_merge_queue",
                Some("merge_queue"),
                Some("PR_1"),
                Some("main"),
            )
            .unwrap();
            dependabot::set_queue_metadata(&conn, head_id, Some(2), true).unwrap();
        }
        set_delegated_at(&db, head_id, "-91 minutes");
        force_due(&db, head_id);
        let mut queued = pr_status("sha1");
        queued.merge_queue_entry = Some(MergeQueueEntryStatus {
            id: "entry".to_string(),
            position: Some(2),
            state: Some("QUEUED".to_string()),
        });
        // Even with a stale per-operation strategy, the durable queue policy must prevent a
        // nominally permanent cleanup failure from releasing the FIFO while GitHub may still have
        // the PR enrolled.
        let fake = FakeBackend::new(Script {
            queue: VecDeque::from([Ok(queue_result(Some(queued)))]),
            disable: VecDeque::from([Err(permanent_err("GitHub rejected disabling auto-merge."))]),
            ..Default::default()
        });
        tick(&db, &fake);
        // Cleanup failed → the operation is NOT terminalized: it stays active for a later retry,
        // and its per-repo FIFO head is deliberately NOT released (no dequeue was reached either).
        let after = op(&db, head_id);
        assert_ne!(
            after.state, "timed_out",
            "cleanup failure must not terminalize"
        );
        assert_eq!(
            after.state, "delegated",
            "the timed-out op stays active to retry cleanup"
        );
        assert_eq!(
            after.last_error.as_deref(),
            Some("GitHub rejected disabling auto-merge.")
        );
        let calls = fake.calls();
        assert_eq!(calls.disable, 1, "disable was attempted");
        assert_eq!(
            calls.dequeue, 0,
            "dequeue not reached after the disable error"
        );
        let heads = {
            let conn = db.0.lock().unwrap();
            dependabot::merge_operation_heads(&conn).unwrap()
        };
        assert_eq!(
            heads[0].operation.id, head_id,
            "the timed-out op remains the FIFO head; the next same-repo PR stays blocked"
        );
        assert!(
            heads.iter().all(|h| h.operation.id != next_id) || heads[0].operation.id == head_id,
            "the next PR does not become the head while cleanup is still owed"
        );
    }

    #[test]
    fn cancel_cleanup_transient_failure_retains_cancel_requested_then_succeeds() {
        let db = db_with_token();
        store(
            &db,
            &[
                pr(1, "octo/repo-a", 10, "Bump one"),
                pr(2, "octo/repo-a", 11, "Bump two"),
            ],
        );
        let id = enqueue_op(&db, 1);
        let next_id = enqueue_op(&db, 2);
        {
            let conn = db.0.lock().unwrap();
            dependabot::mark_merge_progress(&conn, id, "sha1", true, false, None).unwrap();
            dependabot::set_phase(
                &conn,
                id,
                "waiting_merge_queue",
                Some("merge_queue"),
                Some("PR_1"),
                Some("main"),
            )
            .unwrap();
            dependabot::set_queue_metadata(&conn, id, Some(2), true).unwrap();
            dependabot::request_cancel(&conn, id).unwrap();
        }
        // First pass: disable auto-merge fails transiently.
        let mut queued = pr_status("sha1");
        queued.auto_merge_enabled = true;
        queued.merge_queue_entry = Some(MergeQueueEntryStatus {
            id: "entry".to_string(),
            position: Some(2),
            state: Some("QUEUED".to_string()),
        });
        let fake = FakeBackend::new(Script {
            queue: VecDeque::from([
                Ok(queue_result(Some(queued.clone()))),
                Ok(queue_result(Some(queued))),
            ]),
            disable: VecDeque::from([
                Err(transient_err("GitHub 502 while disabling auto-merge.")),
                Ok(applied()),
            ]),
            dequeue: VecDeque::from([Ok(applied())]),
            ..Default::default()
        });
        tick(&db, &fake);
        // The cleanup error is surfaced but the operation stays in `cancel_requested` (never
        // terminalized) so a later pass can retry — and it keeps blocking the next same-repo PR.
        let after = op(&db, id);
        assert_eq!(
            after.state, "cancel_requested",
            "cleanup failure keeps it active"
        );
        assert_eq!(
            after.last_error.as_deref(),
            Some("GitHub 502 while disabling auto-merge.")
        );
        let heads = {
            let conn = db.0.lock().unwrap();
            dependabot::merge_operation_heads(&conn).unwrap()
        };
        assert_eq!(
            heads[0].operation.id, id,
            "the cancelling op stays the FIFO head; the next same-repo PR is blocked"
        );
        assert!(
            heads.iter().all(|h| h.operation.id != next_id) || heads[0].operation.id == id,
            "the next PR does not run while a remote cleanup is still owed"
        );
        assert_eq!(fake.calls().disable, 1);
        assert_eq!(fake.calls().dequeue, 0);

        // Second pass: cleanup succeeds → only now does it terminalize as cancelled.
        tick(&db, &fake);
        assert_eq!(
            op(&db, id).state,
            "cancelled",
            "terminalizes once cleanup succeeds"
        );
        let calls = fake.calls();
        assert_eq!(calls.disable, 2, "disable retried on the second pass");
        assert_eq!(calls.dequeue, 1, "dequeue ran once auto-merge was disabled");
    }

    #[test]
    fn backoff_gate_makes_no_network_call_until_due() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let id = enqueue_op(&db, 1);
        {
            let conn = db.0.lock().unwrap();
            dependabot::mark_merge_progress(&conn, id, "sha1", true, false, None).unwrap();
            dependabot::schedule_next_action_in(&conn, id, 600).unwrap();
        }
        let fake = FakeBackend::new(Script::default());
        tick(&db, &fake);
        // Nothing scripted was needed — the gate short-circuited before any backend call.
        let calls = fake.calls();
        assert_eq!(calls.process, 0);
        assert_eq!(op(&db, id).state, "delegated");
    }

    #[test]
    fn orchestrator_persists_core_and_graphql_rate_snapshots() {
        let db = db_with_token();
        store(&db, &[pr(1, "octo/repo-a", 10, "Bump")]);
        let _id = enqueue_op(&db, 1);
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([Ok(prepared("sha1", "main", "PR_1", Some("clean")))]),
            policy: VecDeque::from([Ok(policy(MergeQueueStrategy::MergeQueue))]),
            queue: VecDeque::from([Ok(queue_result(Some(pr_status("sha1"))))]),
            enqueue: VecDeque::from([Ok(applied())]),
            ..Default::default()
        });
        tick(&db, &fake);
        let conn = db.0.lock().unwrap();
        let buckets = sync::read_rate_buckets(&conn).unwrap();
        assert!(buckets.iter().any(|b| b.resource == "core"));
        assert!(
            buckets.iter().any(|b| b.resource == "graphql"),
            "graphql bucket from the queue GraphQL calls is persisted"
        );
    }

    #[test]
    fn fifo_advances_only_the_repo_head_and_independent_repos_progress() {
        let db = db_with_token();
        store(
            &db,
            &[
                pr(1, "octo/repo-a", 10, "first"),
                pr(2, "octo/repo-a", 11, "second"),
                pr(3, "octo/repo-b", 12, "other"),
            ],
        );
        let a1 = enqueue_op(&db, 1);
        let _a2 = enqueue_op(&db, 2);
        let b3 = enqueue_op(&db, 3);
        // Both repo heads validate to a cached direct strategy this tick.
        let fake = FakeBackend::new(Script {
            process: VecDeque::from([
                Ok(prepared("sha-a1", "main", "PR_a1", Some("clean"))),
                Ok(prepared("sha-b3", "main", "PR_b3", Some("clean"))),
            ]),
            policy: VecDeque::from([
                Ok(policy(MergeQueueStrategy::Direct)),
                Ok(policy(MergeQueueStrategy::Direct)),
            ]),
            ..Default::default()
        });
        tick(&db, &fake);
        // repo-a head (pr 1) advanced; repo-a second (pr 2) stayed queued; repo-b head advanced.
        assert_eq!(op(&db, a1).state, "delegated");
        assert_eq!(op(&db, b3).state, "delegated");
        let conn = db.0.lock().unwrap();
        let second = dependabot::get_operation(&conn, _a2).unwrap().unwrap();
        assert_eq!(second.state, "queued");
    }
}
