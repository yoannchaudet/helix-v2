//! Helix application core.
//!
//! On startup we resolve the macOS app-data directory, ensure it exists, and bootstrap
//! the SQLite database (creating it and applying migrations on first run). The frontend
//! reads storage status via the `db_status` command so it can show live, color-coded
//! feedback (see `AGENT.md`).

mod db;

use db::Db;
use serde::Serialize;
use tauri::{Manager, State};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .invoke_handler(tauri::generate_handler![db_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
