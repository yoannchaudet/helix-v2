//! SQLite storage for Helix.
//!
//! SQLite is the primary source of truth for the app (see `docs/design.md` §3). This
//! module owns the database location, connection, and a tiny versioned migration runner
//! keyed off `PRAGMA user_version` so first-run bootstrap and relaunch are idempotent.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

/// Managed connection handle. Wrapped in a `Mutex` because a rusqlite `Connection` is
/// `Send` but not `Sync`.
pub struct Db(pub Mutex<Connection>);

/// Ordered schema migrations. Index `i` is schema version `i + 1`. Never edit or reorder
/// an existing entry once shipped — only append new ones.
const MIGRATIONS: &[&str] = &[
    // v1 — initial schema (mirrors docs/design.md §3).
    r#"
    CREATE TABLE repos (
        id            INTEGER PRIMARY KEY,
        full_name     TEXT NOT NULL,
        owner         TEXT NOT NULL,
        name          TEXT NOT NULL,
        private       INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT
    );

    CREATE TABLE notifications (
        thread_id            TEXT PRIMARY KEY,
        repo_id              INTEGER NOT NULL REFERENCES repos(id),
        subject_type         TEXT NOT NULL,
        subject_title        TEXT NOT NULL,
        subject_url          TEXT,
        reason               TEXT,
        unread               INTEGER NOT NULL DEFAULT 1,
        updated_at           TEXT NOT NULL,
        last_read_at         TEXT,
        thread_url           TEXT,
        subject_number       INTEGER,
        subject_state        TEXT,
        subject_state_reason TEXT,
        subject_author       TEXT,
        subject_merged_at    TEXT,
        subject_html_url     TEXT,
        resolved_at          TEXT,
        fetched_at           TEXT NOT NULL
    );

    CREATE INDEX idx_notifications_repo ON notifications(repo_id);
    CREATE INDEX idx_notifications_unread ON notifications(unread);

    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE sync_state (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        last_sync_at    TEXT,
        last_poll_at    TEXT,
        last_status     TEXT,
        last_error      TEXT,
        rate_remaining  INTEGER,
        rate_reset_at   TEXT,
        poll_interval_s INTEGER NOT NULL DEFAULT 60
    );

    INSERT INTO sync_state (id) VALUES (1);
    "#,
];

/// Open the database at `db_path`, apply any pending migrations, and return the
/// connection. Creates the file if it does not exist.
pub fn open_and_migrate(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    run_migrations(&conn)?;
    Ok(conn)
}

/// Apply migrations newer than the current `user_version`, advancing the version after
/// each so relaunches are no-ops.
fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    let mut version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    while (version as usize) < MIGRATIONS.len() {
        conn.execute_batch(MIGRATIONS[version as usize])?;
        version += 1;
        conn.pragma_update(None, "user_version", version)?;
    }
    Ok(())
}

/// Current schema version (`PRAGMA user_version`).
pub fn schema_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

/// The ordered migration statements (exposed for tests that build an in-memory DB).
#[cfg(test)]
pub fn migrations() -> &'static [&'static str] {
    MIGRATIONS
}

/// Names of user tables, sorted, excluding SQLite internal tables.
pub fn table_names(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master \
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
         ORDER BY name",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_creates_v1_schema() {
        let dir = std::env::temp_dir().join(format!("helix-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("helix.db");
        let _ = std::fs::remove_file(&db_path);

        let conn = open_and_migrate(&db_path).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);

        let tables = table_names(&conn).unwrap();
        for expected in ["notifications", "repos", "settings", "sync_state"] {
            assert!(tables.contains(&expected.to_string()), "missing table {expected}");
        }

        // The singleton sync_state row is seeded on first run.
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);

        std::fs::remove_file(&db_path).ok();
    }

    #[test]
    fn relaunch_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("helix-test-idem-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("helix.db");
        let _ = std::fs::remove_file(&db_path);

        let first = open_and_migrate(&db_path).unwrap();
        let v1 = schema_version(&first).unwrap();
        drop(first);

        // Reopening must not re-run migrations or error.
        let second = open_and_migrate(&db_path).unwrap();
        assert_eq!(schema_version(&second).unwrap(), v1);
        assert_eq!(
            second
                .query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );

        std::fs::remove_file(&db_path).ok();
    }
}
