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
}
