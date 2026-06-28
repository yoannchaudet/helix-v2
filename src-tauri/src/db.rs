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
    // v2 — per-bucket rate-limit snapshots. GitHub partitions limits into independent
    // buckets (core/search/graphql/…); each response reports its bucket via
    // `X-RateLimit-Resource`. One row per bucket Helix has touched lets the UI draw a
    // usage bar (remaining vs. `lim`) and a reset countdown per API, instead of a single
    // opaque number. Additive: existing `sync_state.rate_*` columns are left untouched.
    r#"
    CREATE TABLE IF NOT EXISTS rate_limits (
        resource    TEXT PRIMARY KEY,
        lim         INTEGER,
        remaining   INTEGER,
        reset_at    INTEGER,
        updated_at  TEXT NOT NULL
    );
    "#,
    // v3 — drop read-status tracking. Helix shows every notification GitHub lists and only
    // removes one when it's marked *done*, so read/unread state is no longer modeled. The
    // index on `unread` must go before the column can be dropped.
    r#"
    DROP INDEX IF EXISTS idx_notifications_unread;
    ALTER TABLE notifications DROP COLUMN unread;
    ALTER TABLE notifications DROP COLUMN last_read_at;
    "#,
    // v4 — durable local record of threads the user marked done. GitHub's `DELETE`
    // ("done") only removes a thread from the *unread* list; `all=true` (which we fetch)
    // keeps returning done threads as "read", so we must remember "done" locally.
    // store_notifications consults this table to keep such threads out of the inbox until the
    // thread genuinely re-surfaces with newer activity or GitHub stops listing it. `done_at`
    // is the mark-done time, used as the re-surface watermark (see store_notifications).
    r#"
    CREATE TABLE IF NOT EXISTS done_tombstones (
        thread_id   TEXT PRIMARY KEY,
        updated_at  TEXT,
        done_at     TEXT NOT NULL
    );
    "#,
    // v5 — GitHub's requested poll-cadence floor, captured per successful sync so the
    // frontend can honor it on top of the user's interval. Holds the max of `X-Poll-Interval`
    // and any `Retry-After` seen on the recorded response. NULL means GitHub asked for nothing.
    r#"
    ALTER TABLE sync_state ADD COLUMN github_poll_interval_s INTEGER;
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
        // Run each migration and its version bump atomically. If any statement fails, the
        // transaction rolls back and `user_version` is left unchanged, so the next launch
        // cleanly retries the whole migration instead of starting from a half-applied state
        // (which could otherwise brick startup — e.g. a column dropped but the bump missed).
        let next = version + 1;
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATIONS[version as usize])?;
        tx.pragma_update(None, "user_version", next)?;
        tx.commit()?;
        version = next;
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
        for expected in ["done_tombstones", "notifications", "rate_limits", "repos", "settings", "sync_state"] {
            assert!(tables.contains(&expected.to_string()), "missing table {expected}");
        }

        // The singleton sync_state row is seeded on first run.
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);

        std::fs::remove_file(&db_path).ok();
    }

    /// Exercise the real upgrade path: a populated v2 database (with the dropped `unread`
    /// column, its index, and a data row) migrates to the latest schema, dropping the
    /// read-status columns while preserving the row, and adding `done_tombstones`.
    #[test]
    fn upgrade_from_populated_v2_drops_read_columns_and_keeps_data() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        // Apply only v1 + v2 and stamp the DB as version 2.
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.execute_batch(MIGRATIONS[1]).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();

        // Seed a repo + a notification carrying the soon-to-be-dropped read columns.
        conn.execute(
            "INSERT INTO repos (id, full_name, owner, name) VALUES (1, 'o/r', 'o', 'r')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notifications
               (thread_id, repo_id, subject_type, subject_title, reason, unread,
                updated_at, last_read_at, fetched_at)
             VALUES ('t1', 1, 'Issue', 'Hi', 'subscribed', 1, '2026-01-01T00:00:00Z',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();

        // Run the remaining migrations (v3 drop-columns, v4 tombstones).
        run_migrations(&conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);

        // The read-status columns are gone; the data row survives.
        let cols: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(notifications)").unwrap();
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows
        };
        assert!(!cols.contains(&"unread".to_string()));
        assert!(!cols.contains(&"last_read_at".to_string()));
        let title: String = conn
            .query_row(
                "SELECT subject_title FROM notifications WHERE thread_id = 't1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(title, "Hi");
        assert!(table_names(&conn).unwrap().contains(&"done_tombstones".to_string()));
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
