//! Helix application core.
//!
//! On startup we resolve the app-data directory and bootstrap the SQLite database
//! (creating it and applying migrations on first run). Release builds also install the
//! macOS Keychain credential store for the PAT; debug builds store the PAT unencrypted in
//! SQLite instead (see `auth.rs`). The frontend drives auth/settings and storage status
//! through the commands below, always with live, color-coded feedback (see `AGENT.md`).

mod auth;
mod db;
mod github;
mod settings;
mod sync;

use db::Db;
use github::GitHubUser;
use serde::Serialize;
use sync::SyncStatus;
use tauri::{Emitter, Manager, State};

/// Application-wide state managed by Tauri.
struct AppState {
    /// Absolute path to `helix.db`, surfaced to the UI for transparency.
    db_path: String,
    db: Db,
    /// Last window size persisted to SQLite, cached to skip redundant writes while a
    /// resize drag emits a stream of events.
    last_window_size: std::sync::Mutex<Option<(u32, u32)>>,
}

/// Snapshot of the local storage, returned to the frontend.
#[derive(Serialize)]
struct DbStatus {
    path: String,
    schema_version: i64,
    tables: Vec<String>,
}

/// Authentication state, derived from the Keychain + cached login (offline-friendly).
#[derive(Serialize)]
struct AuthStatus {
    authenticated: bool,
    login: Option<String>,
    /// True when the PAT is stored unencrypted in SQLite (debug builds) rather than the
    /// Keychain — the frontend shows a warning when set.
    unencrypted_storage: bool,
}

/// User-facing settings.
#[derive(Serialize)]
struct Settings {
    poll_interval_s: i64,
    github_login: Option<String>,
    /// Appearance preference: `system`, `light`, or `dark`.
    theme: String,
}

/// Map an appearance preference to a window theme. `system` (and any unknown value)
/// returns `None`, which makes the window follow the OS appearance.
fn theme_for_pref(pref: &str) -> Option<tauri::Theme> {
    match pref {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    }
}

/// Apply an appearance preference to the native window chrome (title bar + vibrancy),
/// so the OS-drawn surfaces match the in-app theme. Best-effort: a failure here must
/// never block a settings save.
fn apply_window_theme(window: &tauri::WebviewWindow, pref: &str) {
    let _ = window.set_theme(theme_for_pref(pref));
}

/// Report the local database path, schema version, and tables.
#[tauri::command]
fn db_status(state: State<'_, AppState>) -> Result<DbStatus, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    let schema_version = db::schema_version(&conn).map_err(|e| e.to_string())?;
    let tables = db::table_names(&conn).map_err(|e| e.to_string())?;
    Ok(DbStatus {
        path: state.db_path.clone(),
        schema_version,
        tables,
    })
}

/// Current auth state: whether a token is stored plus the cached login. Does not hit the
/// network, so it works offline and loads fast.
#[tauri::command]
fn auth_status(state: State<'_, AppState>) -> Result<AuthStatus, String> {
    // `has_token` may hit the Keychain (release), so don't hold the DB lock across it.
    let authenticated = auth::has_token(&state.db)?;
    let login = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        settings::get_string(&conn, settings::KEY_GITHUB_LOGIN).map_err(|e| e.to_string())?
    };
    Ok(AuthStatus {
        authenticated,
        login,
        unencrypted_storage: auth::storage_is_unencrypted(),
    })
}

/// Verify a PAT against GitHub, and on success store it and cache the login. Invalid tokens
/// are rejected and nothing is stored.
#[tauri::command]
async fn sign_in(token: String, state: State<'_, AppState>) -> Result<GitHubUser, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Please enter a Personal Access Token.".to_string());
    }

    // Verify before persisting anything (network call, no locks held).
    let user = github::fetch_user(&token).await?;

    // Store the token first (may be Keychain I/O in release — `store_token` locks the DB
    // itself only for the dev/SQLite path, so we never hold the lock across Keychain I/O).
    auth::store_token(&state.db, &token)?;
    {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        settings::set_string(&conn, settings::KEY_GITHUB_LOGIN, &user.login)
            .map_err(|e| e.to_string())?;
        // New credentials may have broader scope — re-resolve all subjects on next sync.
        let _ = sync::reset_resolution(&conn);
    }
    Ok(user)
}

/// Remove the stored token and cached login.
#[tauri::command]
fn sign_out(state: State<'_, AppState>) -> Result<(), String> {
    // `delete_token` does its Keychain work without the DB lock (release).
    auth::delete_token(&state.db)?;
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    settings::delete_key(&conn, settings::KEY_GITHUB_LOGIN).map_err(|e| e.to_string())?;
    Ok(())
}

/// Read user-facing settings.
#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    Ok(Settings {
        poll_interval_s: settings::get_poll_interval(&conn).map_err(|e| e.to_string())?,
        github_login: settings::get_string(&conn, settings::KEY_GITHUB_LOGIN)
            .map_err(|e| e.to_string())?,
        theme: settings::get_theme(&conn).map_err(|e| e.to_string())?,
    })
}

/// Persist user-facing settings. Rejects a polling interval below the minimum.
#[tauri::command]
fn save_settings(
    poll_interval_s: i64,
    state: State<'_, AppState>,
) -> Result<Settings, String> {
    if poll_interval_s < settings::MIN_POLL_INTERVAL_S {
        return Err(format!(
            "Polling interval must be at least {} seconds.",
            settings::MIN_POLL_INTERVAL_S
        ));
    }
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    settings::set_poll_interval(&conn, poll_interval_s).map_err(|e| e.to_string())?;
    Ok(Settings {
        poll_interval_s,
        github_login: settings::get_string(&conn, settings::KEY_GITHUB_LOGIN)
            .map_err(|e| e.to_string())?,
        theme: settings::get_theme(&conn).map_err(|e| e.to_string())?,
    })
}

/// Persist the appearance preference and apply it to the native window chrome. Kept
/// separate from `save_settings` so an unrelated invalid field (e.g. a mid-edit poll
/// interval) can never block a theme change.
#[tauri::command]
fn set_theme(
    theme: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !settings::is_valid_theme(&theme) {
        return Err(format!("Unknown theme: {theme}"));
    }
    {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        settings::set_string(&conn, settings::KEY_THEME, &theme).map_err(|e| e.to_string())?;
    }
    apply_window_theme(&window, &theme);
    Ok(())
}

/// Result of a successful sync, returned to the caller and emitted as `sync:done`.
#[derive(Clone, Serialize)]
struct SyncResult {
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
async fn sync_now(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<SyncResult, String> {
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
            if let Ok(conn) = state.db.0.lock() {
                let _ = sync::record_error(&conn, &err);
            }
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
            if let Ok(conn) = state.db.0.lock() {
                let _ = sync::record_error(&conn, &err);
            }
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

    const POOL: usize = 8;
    // Background subject resolution is *optional* quota: stop before it eats into the
    // reserve other operations (the notifications list fetch, mark-done) need. We aim to
    // keep at least this fraction of each bucket's allowance.
    //
    // This is a *soft* reserve: the check runs after each batch of up to POOL concurrent
    // requests, so a single batch can dip up to POOL requests past the line before we stop
    // (immaterial against the thousands-wide core budget; not a hard floor). Deferred
    // subjects stay pending (newest-first), so a later sync — once the window resets and
    // quota is plentiful again — finishes them.
    const RESERVE_FRACTION: f64 = 0.25;

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
                    if let Ok(conn) = state.db.0.lock() {
                        if sync::store_resolved_subject(&conn, &thread_id, &result.subject).is_ok()
                        {
                            changed += 1;
                        }
                    }
                }
                Err(err) => {
                    // A failed resolution still spent quota — count it toward the reserve.
                    rate.observe(err.rate.clone());
                    eprintln!("subject resolution failed for {thread_id}: {}", err.message);
                }
            }
        }

        // Stop once this batch pushed us into the reserve; the rest waits for a later sync.
        if rate.below_reserve(RESERVE_FRACTION) {
            break;
        }
    }

    // Persist the post-resolution quota so Settings shows the true per-bucket usage.
    if let Ok(conn) = state.db.0.lock() {
        let _ = rate.persist(&conn);
    }

    if changed > 0 {
        let _ = app.emit("subjects:resolved", serde_json::json!({ "count": changed }));
    }
}

/// Read the current sync status (last sync, status/error, rate limit, stored count).
#[tauri::command]
fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    sync::read_status(&conn).map_err(|e| e.to_string())
}

/// Read all stored notifications grouped by repository (offline-first local read).
#[tauri::command]
fn list_inbox(state: State<'_, AppState>) -> Result<Vec<sync::RepoGroup>, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    sync::list_by_repo(&conn).map_err(|e| e.to_string())
}

/// A single thread that failed to mutate, surfaced to the UI so partial failures are
/// reported without aborting the rest of the batch.
#[derive(Clone, Serialize)]
struct FailedThread {
    thread_id: String,
    error: String,
}

/// Outcome of a mark-as-done batch: how many threads succeeded, which failed, and the
/// post-mutation rate-limit count.
#[derive(Clone, Serialize)]
struct MutationResult {
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

    const POOL: usize = 8;
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
                        error: err.message,
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
    let _ = rate.persist(conn);

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
async fn mark_threads_done(
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

/// Reveal the main window. The window starts hidden (see `tauri.conf.json`) so the
/// frontend can paint its shell before we show it, avoiding a white flash on launch.
/// Driven from Rust because Tauri v2's `withGlobalTauri` does not expose the `window`
/// API to the frontend.
#[tauri::command]
fn show_main_window(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// Reveal a path in Finder, selecting it in its containing folder (macOS `open -R`).
/// Args are passed directly to `open` (no shell), so the path needs no escaping.
#[cfg(target_os = "macos")]
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    // `open` parses leading-dash arguments as flags even without a shell, so reject
    // anything that isn't a plain, non-empty path to avoid option injection.
    let path = path.trim();
    if path.is_empty() || path.starts_with('-') {
        return Err("invalid path to reveal".to_string());
    }
    let status = std::process::Command::new("open")
        .args(["-R", path])
        .status()
        .map_err(|e| format!("failed to reveal in Finder: {e}"))?;
    if !status.success() {
        return Err(format!("could not reveal the path in Finder ({status})"));
    }
    Ok(())
}

/// Non-macOS fallback: Reveal in Finder is a macOS-only affordance.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn reveal_in_finder(_path: String) -> Result<(), String> {
    Err("Reveal in Finder is only supported on macOS.".to_string())
}

/// Open an `http(s)` URL in the user's default browser.
///
/// The URL is passed directly to `open` (no shell), so it needs no escaping, but we
/// still restrict it to `http`/`https` so a crafted value can't make `open` launch an
/// arbitrary URL handler (e.g. a custom app scheme) or be parsed as a flag.
#[cfg(target_os = "macos")]
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Err("invalid URL to open".to_string());
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs can be opened".to_string());
    }
    // A well-formed URL has no whitespace or control characters; reject them defensively
    // so nothing surprising is ever handed to `open`.
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("URL contains invalid characters".to_string());
    }
    let status = std::process::Command::new("open")
        .arg(url)
        .status()
        .map_err(|e| format!("failed to open URL: {e}"))?;
    if !status.success() {
        return Err(format!("could not open the URL ({status})"));
    }
    Ok(())
}

/// Non-macOS fallback for [`open_url`].
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn open_url(_url: String) -> Result<(), String> {
    Err("Opening URLs is only supported on macOS.".to_string())
}

/// Whether in-app auto-update is available in this build. Release macOS builds ship the
/// updater plugin; debug builds — and non-macOS — do not, so the frontend hides the update
/// UI and never calls the (absent) updater commands.
#[tauri::command]
fn updater_enabled() -> bool {
    !cfg!(debug_assertions) && cfg!(target_os = "macos")
}

/// The running app version (from `tauri.conf.json`), shown in Settings.
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Metadata about an available update, surfaced to the UI.
#[derive(Serialize, Clone)]
struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

/// Download progress, emitted on the `update:progress` event while an update installs.
#[derive(Serialize, Clone)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Check the configured release endpoint for a newer version. Returns `None` when the app
/// is up to date. Release macOS builds only: the updater plugin isn't initialized in debug
/// (so this errors there) and the UI gates calls behind `updater_enabled`.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(Some(UpdateInfo {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
        })),
        None => Ok(None),
    }
}

/// Download and install the available update — emitting `update:progress` as bytes arrive
/// and `update:installed` when done — then relaunch into the new version. Release macOS
/// builds only.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("No update available.".to_string());
    };
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit("update:progress", UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("update:installed", ());
    // Relaunch into the freshly installed bundle. `restart` diverges (never returns).
    app.restart();
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn check_for_update(_app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    Err("Updates are only supported on macOS.".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn install_update(_app: tauri::AppHandle) -> Result<(), String> {
    Err("Updates are only supported on macOS.".to_string())
}

/// Persist the current window size (logical px) to SQLite so the next launch restores
/// it. Skips minimized/maximized/fullscreen states and redundant writes (the cache in
/// `AppState`) so a resize drag doesn't hammer the database.
fn persist_window_size(window: &tauri::Window) {
    if window.is_minimized().unwrap_or(false)
        || window.is_maximized().unwrap_or(false)
        || window.is_fullscreen().unwrap_or(false)
    {
        return;
    }
    let Ok(physical) = window.inner_size() else {
        return;
    };
    let logical = physical.to_logical::<f64>(window.scale_factor().unwrap_or(1.0));
    let (w, h) = (logical.width.round() as u32, logical.height.round() as u32);
    if w == 0 || h == 0 {
        return;
    }

    let state = window.state::<AppState>();
    // Skip if unchanged from the last *persisted* size (a resize drag emits a stream
    // of events).
    {
        let last = match state.last_window_size.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if *last == Some((w, h)) {
            return;
        }
    }
    // Persist, and only advance the cache on a successful write — otherwise a failed
    // write would be permanently skipped on subsequent same-size events.
    let lock = state.db.0.lock();
    if let Ok(conn) = lock {
        if settings::set_window_size(&conn, w, h).is_ok() {
            if let Ok(mut last) = state.last_window_size.lock() {
                *last = Some((w, h));
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the macOS login-Keychain credential store for keyring-core. Only release
    // builds use the Keychain; debug builds store the PAT unencrypted in SQLite (see
    // `auth.rs`) and never touch keyring, so we skip the store there entirely.
    #[cfg(not(debug_assertions))]
    keyring_core::set_default_store(
        apple_native_keyring_store::keychain::Store::new()
            .expect("failed to initialize the macOS Keychain store"),
    );

    // Auto-update is release-only: a dev build must never try to self-update (it would hit
    // the production endpoint and replace the running binary). The updater plugin is
    // macOS-only (see Cargo.toml); we drive it from Rust (see `check_for_update` /
    // `install_update`) and relaunch with the core `AppHandle::restart`.
    let builder = tauri::Builder::default();
    #[cfg(all(not(debug_assertions), target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .on_window_event(|window, event| {
            // Persist the window size to SQLite so the next launch reopens at the same
            // size (macOS/Tauri don't restore it automatically). Resize fires
            // repeatedly while dragging; `persist_window_size` skips redundant writes.
            if let tauri::WindowEvent::Resized(_) = event {
                persist_window_size(window);
            }
        })
        .setup(|app| {
            // Resolve `~/Library/Application Support/helix/` on macOS (see design.md §3).
            let data_dir = app.path().data_dir()?.join("helix");
            std::fs::create_dir_all(&data_dir)?;

            let db_path = data_dir.join("helix.db");
            let conn = db::open_and_migrate(&db_path)?;

            // Release builds: scrub any plaintext dev PAT a prior debug run may have left in
            // this shared DB, so a release build never carries an unencrypted token. No-op
            // in debug (must not touch the Keychain).
            let _ = auth::purge_inactive_token(&conn);

            // Restore the last window size (logical px) before the window is shown, so
            // there's no visible resize jump. Read it before `conn` is moved into state.
            let saved_size = settings::get_window_size(&conn).ok().flatten();
            // Appearance preference, read before `conn` moves into state, to set the
            // native window theme at launch (matching the webview's no-FOUC resolution).
            let saved_theme = settings::get_theme(&conn)
                .unwrap_or_else(|_| settings::DEFAULT_THEME.to_string());

            app.manage(AppState {
                db_path: db_path.to_string_lossy().into_owned(),
                db: Db(std::sync::Mutex::new(conn)),
                last_window_size: std::sync::Mutex::new(saved_size),
            });

            if let (Some((w, h)), Some(win)) = (saved_size, app.get_webview_window("main")) {
                let _ = win.set_size(tauri::LogicalSize::new(w as f64, h as f64));
            }

            // Native macOS translucency: an NSVisualEffect "Sidebar" material sits behind
            // the (transparent) webview, so the vibrant sidebar shows through while the
            // content pane paints an opaque background over it. Best-effort: a failure
            // here must never block launch (the app simply renders flat).
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("main") {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                let _ = apply_vibrancy(&win, NSVisualEffectMaterial::Sidebar, None, None);
            }

            // Match the native window chrome (title bar + vibrancy) to the saved
            // appearance preference. `system` leaves it following the OS.
            if let Some(win) = app.get_webview_window("main") {
                apply_window_theme(&win, &saved_theme);
            }

            // Safety net: the main window starts hidden and is normally revealed by
            // the frontend (`show_main_window`) once the DOM is ready. If the frontend
            // fails to load, show it anyway after a short delay so the app is never
            // stuck as an invisible dock icon.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(win) = handle.get_webview_window("main") {
                    // Default to *not* visible on error so we err toward showing the
                    // window rather than leaving it stuck hidden.
                    if !win.is_visible().unwrap_or(false) {
                        let _ = win.show();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_status,
            auth_status,
            sign_in,
            sign_out,
            get_settings,
            save_settings,
            set_theme,
            sync_now,
            sync_status,
            list_inbox,
            mark_threads_done,
            show_main_window,
            reveal_in_finder,
            open_url,
            updater_enabled,
            app_version,
            check_for_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
