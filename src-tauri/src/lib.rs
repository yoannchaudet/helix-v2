//! Helix application core.
//!
//! On startup we install the macOS Keychain credential store, resolve the app-data
//! directory, and bootstrap the SQLite database (creating it and applying migrations on
//! first run). The frontend drives auth/settings and storage status through the commands
//! below, always with live, color-coded feedback (see `AGENT.md`).

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
}

/// User-facing settings.
#[derive(Serialize)]
struct Settings {
    poll_interval_s: i64,
    dependabot_only: bool,
    github_login: Option<String>,
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

/// Current auth state: a token in the Keychain plus the cached login. Does not hit the
/// network, so it works offline and loads fast.
#[tauri::command]
fn auth_status(state: State<'_, AppState>) -> Result<AuthStatus, String> {
    let has_token = auth::has_token()?;
    let login = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        settings::get_string(&conn, settings::KEY_GITHUB_LOGIN).map_err(|e| e.to_string())?
    };
    Ok(AuthStatus {
        authenticated: has_token,
        login,
    })
}

/// Verify a PAT against GitHub, and on success store it in the Keychain and cache the
/// login. Invalid tokens are rejected and nothing is stored.
#[tauri::command]
async fn sign_in(token: String, state: State<'_, AppState>) -> Result<GitHubUser, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Please enter a Personal Access Token.".to_string());
    }

    // Verify before persisting anything (network call, no locks held).
    let user = github::fetch_user(&token).await?;

    auth::store_token(&token)?;
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
    auth::delete_token()?;
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
        dependabot_only: settings::get_bool(&conn, settings::KEY_DEPENDABOT_ONLY, false)
            .map_err(|e| e.to_string())?,
        github_login: settings::get_string(&conn, settings::KEY_GITHUB_LOGIN)
            .map_err(|e| e.to_string())?,
    })
}

/// Persist user-facing settings. Rejects a polling interval below the minimum.
#[tauri::command]
fn save_settings(
    poll_interval_s: i64,
    dependabot_only: bool,
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
    settings::set_bool(&conn, settings::KEY_DEPENDABOT_ONLY, dependabot_only)
        .map_err(|e| e.to_string())?;
    Ok(Settings {
        poll_interval_s,
        dependabot_only,
        github_login: settings::get_string(&conn, settings::KEY_GITHUB_LOGIN)
            .map_err(|e| e.to_string())?,
    })
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
    let token = auth::read_token()?
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

/// Resolve outstanding PR/Issue subjects (state, number, author, …) so the UI can show
/// Open/Closed/Merged pills. Smart caching (`subjects_needing_resolution`) keeps this cheap
/// after the first sync. Per-subject failures are logged and retried on a future sync; the
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
    let client = reqwest::Client::new();
    let mut changed = 0usize;
    // The most conservative (lowest `remaining`) rate snapshot seen across the resolution
    // calls, so the UI's quota reflects what these extra requests actually consumed.
    let mut rate: Option<github::RateLimit> = None;

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
                    // Track the lowest remaining (most recent within the window).
                    if let Some(remaining) = result.rate.remaining {
                        if rate
                            .as_ref()
                            .and_then(|r| r.remaining)
                            .is_none_or(|cur| remaining < cur)
                        {
                            rate = Some(result.rate.clone());
                        }
                    }
                    if let Ok(conn) = state.db.0.lock() {
                        if sync::store_resolved_subject(&conn, &thread_id, &result.subject).is_ok()
                        {
                            changed += 1;
                        }
                    }
                }
                Err(err) => eprintln!("subject resolution failed for {thread_id}: {err}"),
            }
        }
    }

    // Persist the post-resolution quota so Settings shows the true remaining count.
    if let Some(rate) = &rate {
        if let Ok(conn) = state.db.0.lock() {
            let _ = sync::record_rate(&conn, rate);
        }
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
    // Install the macOS login-Keychain credential store for keyring-core.
    keyring_core::set_default_store(
        apple_native_keyring_store::keychain::Store::new()
            .expect("failed to initialize the macOS Keychain store"),
    );

    tauri::Builder::default()
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

            // Restore the last window size (logical px) before the window is shown, so
            // there's no visible resize jump. Read it before `conn` is moved into state.
            let saved_size = settings::get_window_size(&conn).ok().flatten();

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
            sync_now,
            sync_status,
            list_inbox,
            show_main_window,
            reveal_in_finder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
