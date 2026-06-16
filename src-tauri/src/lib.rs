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
    let store_result = (|| -> Result<usize, String> {
        let mut guard = state.db.0.lock().map_err(|e| e.to_string())?;
        let conn: &mut rusqlite::Connection = &mut guard;
        let n = sync::store_notifications(conn, &outcome.threads).map_err(|e| e.to_string())?;
        sync::record_success(conn, &outcome.rate).map_err(|e| e.to_string())?;
        Ok(n)
    })();

    let count = match store_result {
        Ok(n) => n,
        Err(err) => {
            if let Ok(conn) = state.db.0.lock() {
                let _ = sync::record_error(&conn, &err);
            }
            let _ = app.emit("sync:error", serde_json::json!({ "message": err.clone() }));
            return Err(err);
        }
    };

    let result = SyncResult {
        count,
        rate_remaining: outcome.rate.remaining,
    };
    let _ = app.emit("sync:done", &result);
    Ok(result)
}

/// Read the current sync status (last sync, status/error, rate limit, stored count).
#[tauri::command]
fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    sync::read_status(&conn).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the macOS login-Keychain credential store for keyring-core.
    keyring_core::set_default_store(
        apple_native_keyring_store::keychain::Store::new()
            .expect("failed to initialize the macOS Keychain store"),
    );

    tauri::Builder::default()
        .setup(|app| {
            // Resolve `~/Library/Application Support/helix/` on macOS (see design.md §3).
            let data_dir = app.path().data_dir()?.join("helix");
            std::fs::create_dir_all(&data_dir)?;

            let db_path = data_dir.join("helix.db");
            let conn = db::open_and_migrate(&db_path)?;

            app.manage(AppState {
                db_path: db_path.to_string_lossy().into_owned(),
                db: Db(std::sync::Mutex::new(conn)),
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
            sync_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
