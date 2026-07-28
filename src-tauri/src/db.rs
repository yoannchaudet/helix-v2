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
    // v6 — flag for notifications that are new or whose `updated_at` changed since the
    // previous sync, so the UI can highlight them. Each sync recomputes it (1 for inserted
    // or changed rows, 0 for unchanged), and it persists across restarts. Cleared next sync.
    r#"
    ALTER TABLE notifications ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0;
    "#,
    // v7 — local bookmarks. A snapshot of bookmarked threads kept independent of the inbox
    // lifecycle: it survives reconciliation and mark-done, so a bookmarked thread stays
    // visible in the Bookmarks filter even after it's marked done / dropped from GitHub's
    // list. Local-only (never synced). Snapshot columns are refreshed from notifications on
    // each sync while the thread is still present; once gone, the last snapshot persists.
    r#"
    CREATE TABLE IF NOT EXISTS bookmarks (
        thread_id        TEXT PRIMARY KEY,
        repo_id          INTEGER,
        repo_full_name   TEXT NOT NULL,
        repo_private     INTEGER NOT NULL DEFAULT 0,
        subject_type     TEXT NOT NULL,
        subject_title    TEXT NOT NULL,
        subject_number   INTEGER,
        subject_state    TEXT,
        subject_html_url TEXT,
        thread_url       TEXT,
        reason           TEXT,
        updated_at       TEXT,
        bookmarked_at    TEXT NOT NULL
    );
    "#,
    // v8 — carry the resolved subject author in the bookmarks snapshot too, so the
    // Bookmarks filter can show the issue/PR author even after the thread leaves the inbox.
    // Mirrors `notifications.subject_author`; refreshed from notifications on each sync.
    r#"
    ALTER TABLE bookmarks ADD COLUMN subject_author TEXT;
    "#,
    // v9 — PR merge-readiness. GitHub's rolled-up `mergeable_state` (clean/blocked/dirty/…)
    // captured for free from the PR resolution response we already fetch. Null for non-PRs
    // and until first resolved. Snapshotted onto bookmarks too (mirrors subject_author).
    r#"
    ALTER TABLE notifications ADD COLUMN subject_mergeable_state TEXT;
    ALTER TABLE bookmarks ADD COLUMN subject_mergeable_state TEXT;
    "#,
    // v10 — the Dependabot module's local store: open Dependabot PRs (gathered by listing open
    // PRs for the notification-sourced repo list in `dependabot_repos` — no search API), cached
    // so the module reads offline-first (like notifications) and GitHub is only hit on an
    // explicit/auto sync. Self-contained (repo identity denormalized as owner/name; no FK to
    // `repos`, which is keyed on the GitHub repo id these listings don't surface here).
    // `mergeable_state`/`resolved_at` back the merge-readiness pill, resolved lazily per PR
    // (the PR list omits it) with the same smart-cache + rate-reserve discipline as
    // notification subjects. Rows no longer returned (merged/closed) are reconciled away on
    // the next complete sync.
    r#"
    CREATE TABLE IF NOT EXISTS dependabot_prs (
        id              INTEGER PRIMARY KEY,
        repo_full_name  TEXT NOT NULL,
        repo_owner      TEXT NOT NULL,
        repo_name       TEXT NOT NULL,
        number          INTEGER NOT NULL,
        title           TEXT NOT NULL,
        html_url        TEXT NOT NULL,
        author          TEXT NOT NULL,
        pull_url        TEXT NOT NULL,
        mergeable_state TEXT,
        created_at      TEXT,
        updated_at      TEXT NOT NULL,
        resolved_at     TEXT,
        fetched_at      TEXT NOT NULL
    );

    CREATE INDEX idx_dependabot_prs_repo ON dependabot_prs(repo_full_name);
    "#,
    // v11 — the Dependabot module's repo list, built lazily from the notifications Helix
    // already fetches (store_notifications inserts every seen repo here). Unlike the `repos`
    // table — which is pruned when a repo's notifications clear — this persists, so the set of
    // repos we scan for open Dependabot PRs accumulates "for free" over time. `fail_count`
    // tracks consecutive access failures (404 / non-rate 403) so a repo that becomes
    // inaccessible is dropped after a few tries.
    r#"
    CREATE TABLE IF NOT EXISTS dependabot_repos (
        repo_full_name TEXT PRIMARY KEY,
        owner          TEXT NOT NULL,
        name           TEXT NOT NULL,
        added_at       TEXT NOT NULL,
        fail_count     INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT
    );
    "#,
    // v12 — durable, locally queued Dependabot merge operations.  The PR fields are an
    // immutable enqueue-time snapshot: the processor observes live GitHub state separately,
    // but a completed operation remains an auditable record even after its cached PR is gone.
    r#"
    ALTER TABLE sync_state ADD COLUMN dependabot_merge_poll_interval_s INTEGER NOT NULL DEFAULT 60;

    CREATE TABLE IF NOT EXISTS dependabot_merge_operations (
        id                 INTEGER PRIMARY KEY,
        pr_id              INTEGER NOT NULL,
        repo_full_name     TEXT NOT NULL,
        number             INTEGER NOT NULL,
        title              TEXT NOT NULL,
        html_url           TEXT NOT NULL,
        pull_url           TEXT NOT NULL,
        author             TEXT NOT NULL,
        state              TEXT NOT NULL CHECK (state IN
                           ('queued', 'validating', 'delegated', 'cancel_requested',
                            'merged', 'cancelled', 'failed', 'timed_out')),
        observed_head_sha  TEXT,
        validated_head_sha TEXT,
        approved_head_sha  TEXT,
        merge_command_at   TEXT,
        cancel_command_at  TEXT,
        enqueued_at        TEXT NOT NULL,
        delegated_at       TEXT,
        last_checked_at    TEXT,
        last_action_at     TEXT,
        terminal_at        TEXT,
        failure_code       TEXT,
        failure_reason     TEXT,
        last_error         TEXT
    );

    -- A PR may have one active request, while terminal history is retained.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dependabot_merge_active_pr
        ON dependabot_merge_operations(pr_id)
        WHERE state IN ('queued', 'validating', 'delegated', 'cancel_requested');
    -- The oldest active operation is the sole processor head for each repository.
    CREATE INDEX IF NOT EXISTS idx_dependabot_merge_repo_fifo
        ON dependabot_merge_operations(repo_full_name, enqueued_at, id)
        WHERE state IN ('queued', 'validating', 'delegated', 'cancel_requested');
    CREATE INDEX IF NOT EXISTS idx_dependabot_merge_terminal
        ON dependabot_merge_operations(terminal_at DESC, id DESC)
        WHERE state IN ('merged', 'cancelled', 'failed', 'timed_out');

    CREATE TABLE IF NOT EXISTS dependabot_merge_runtime (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        last_tick_at         TEXT,
        last_error           TEXT,
        github_poll_floor_s  INTEGER,
        backoff_until        TEXT
    );
    INSERT OR IGNORE INTO dependabot_merge_runtime (id) VALUES (1);
    "#,
    // v13 — identify a Helix-requested update-branch commit so the subsequent authorship
    // revalidation can accept that one PAT-authored merge commit without accepting arbitrary
    // human work on the Dependabot branch.
    r#"
    ALTER TABLE dependabot_merge_operations ADD COLUMN update_branch_from_sha TEXT;
    "#,
    // v14 — Phase 2 durable processor fields plus an audit/retry/policy layer around
    // `dependabot_merge_operations`. `phase` and `strategy` are intentionally freeform TEXT
    // (no CHECK): unlike `state`, which is the small, stable lifecycle the rest of the schema
    // keys off, these describe the processor's finer-grained internal progress and resolved
    // merge approach, and are expected to grow without another migration. `pull_node_id`
    // (GraphQL node id) and `base_ref` are metadata discovered once the processor first talks
    // to GitHub about the PR, needed for GraphQL mutations (e.g. enabling native auto-merge)
    // and branch-protection/policy lookups, which are base-ref scoped. `next_action_at` lets
    // the processor pace itself (retry/backoff) without a separate timer table.
    // `check_retry_count` tracks consecutive requested check-run re-runs for the current head
    // SHA. `merge_queue_position`/`auto_merge_enabled` mirror GitHub's own native merge-queue
    // position and auto-merge flag when that strategy is in play.
    //
    // `dependabot_merge_operation_events` is an append-only narration/audit trail per
    // operation — cascade-deleted with it, so the existing terminal-retention prune in
    // `terminalize` (the newest 100 terminal rows) also prunes each pruned operation's history.
    // `dependabot_merge_check_retries` records each requested re-run of a failed workflow run
    // for a given head SHA, uniquely keyed so the same run+attempt is never double-scheduled,
    // and cascade-deleted with its operation. `dependabot_merge_policies` caches the merge
    // strategy resolved for a repo + base branch (branch protection is base-ref scoped) so it
    // isn't re-derived on every tick.
    r#"
    ALTER TABLE dependabot_merge_operations ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued';
    ALTER TABLE dependabot_merge_operations ADD COLUMN strategy TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE dependabot_merge_operations ADD COLUMN pull_node_id TEXT;
    ALTER TABLE dependabot_merge_operations ADD COLUMN base_ref TEXT;
    ALTER TABLE dependabot_merge_operations ADD COLUMN next_action_at TEXT;
    ALTER TABLE dependabot_merge_operations ADD COLUMN check_retry_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE dependabot_merge_operations ADD COLUMN merge_queue_position INTEGER;
    ALTER TABLE dependabot_merge_operations ADD COLUMN auto_merge_enabled INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE dependabot_merge_operation_events (
        id            INTEGER PRIMARY KEY,
        operation_id  INTEGER NOT NULL REFERENCES dependabot_merge_operations(id) ON DELETE CASCADE,
        phase         TEXT NOT NULL,
        kind          TEXT NOT NULL,
        status        TEXT NOT NULL,
        summary       TEXT NOT NULL,
        detail        TEXT,
        head_sha      TEXT,
        external_id   TEXT,
        created_at    TEXT NOT NULL
    );
    CREATE INDEX idx_dependabot_merge_operation_events_operation
        ON dependabot_merge_operation_events(operation_id, created_at, id);
    CREATE INDEX idx_dependabot_merge_operation_events_time
        ON dependabot_merge_operation_events(created_at DESC, id DESC);

    CREATE TABLE dependabot_merge_check_retries (
        id               INTEGER PRIMARY KEY,
        operation_id     INTEGER NOT NULL REFERENCES dependabot_merge_operations(id) ON DELETE CASCADE,
        head_sha         TEXT NOT NULL,
        workflow_run_id  INTEGER NOT NULL,
        run_attempt      INTEGER NOT NULL,
        scheduled_at     TEXT NOT NULL,
        requested_at     TEXT,
        outcome          TEXT,
        UNIQUE(operation_id, head_sha, workflow_run_id, run_attempt)
    );
    CREATE INDEX idx_dependabot_merge_check_retries_operation
        ON dependabot_merge_check_retries(operation_id, scheduled_at, id);

    CREATE TABLE dependabot_merge_policies (
        repo_full_name TEXT NOT NULL,
        base_ref       TEXT NOT NULL,
        strategy       TEXT NOT NULL,
        checked_at     TEXT NOT NULL,
        PRIMARY KEY (repo_full_name, base_ref)
    );
    "#,
    // v15 — persist the target branch returned by the Dependabot PR listing. Existing cached
    // rows remain null until the next sync; new operations snapshot this value at enqueue.
    r#"
    ALTER TABLE dependabot_prs ADD COLUMN base_ref TEXT;
    "#,
    // v16 — separate GitHub's remote notification state from Helix's local done state.
    // Notifications remain a faithful `all=true` mirror (including `unread`), while durable
    // dismissals independently control inbox visibility. Preserve every existing tombstone.
    r#"
    ALTER TABLE notifications ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE notifications ADD COLUMN subject_updated_at TEXT;

    ALTER TABLE done_tombstones RENAME TO notification_dismissals;
    ALTER TABLE notification_dismissals RENAME COLUMN updated_at TO notification_updated_at;
    ALTER TABLE notification_dismissals RENAME COLUMN done_at TO dismissed_at;
    ALTER TABLE notification_dismissals ADD COLUMN subject_updated_at TEXT;
    "#,
    // v17 — remove dead merge-operation lifecycle columns that are no longer read or written.
    // SQLite is bundled via rusqlite, so DROP COLUMN is available across supported builds.
    r#"
    ALTER TABLE dependabot_merge_operations DROP COLUMN merge_command_at;
    ALTER TABLE dependabot_merge_operations DROP COLUMN cancel_command_at;
    ALTER TABLE dependabot_merge_operations DROP COLUMN last_action_at;
    "#,
    // v18 — reserved. An earlier development build used this version for a different additive
    // migration, and local builds share one database across branches.
    r#"
    SELECT 1;
    "#,
    // v19 — persistent presentation state for collapsed Notifications repository sections.
    // Key by full name without a repos foreign key so the preference survives repo pruning.
    r#"
    CREATE TABLE IF NOT EXISTS collapsed_notification_repos (
        repo_full_name TEXT PRIMARY KEY,
        collapsed_at   TEXT NOT NULL
    );
    "#,
    // v20 — repositories explicitly tracked by SLO Dips and the GitHub Discussion categories
    // selected as their future dip sources. Categories are repository-scoped GraphQL node IDs
    // and cascade with their parent so removal is one atomic local operation.
    r#"
    CREATE TABLE IF NOT EXISTS slo_dips_repos (
        repo_id     INTEGER PRIMARY KEY,
        full_name   TEXT NOT NULL UNIQUE,
        owner       TEXT NOT NULL,
        name        TEXT NOT NULL,
        private     INTEGER NOT NULL DEFAULT 0,
        added_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slo_dips_repo_categories (
        repo_id       INTEGER NOT NULL REFERENCES slo_dips_repos(repo_id) ON DELETE CASCADE,
        category_id   TEXT NOT NULL,
        name          TEXT NOT NULL,
        emoji         TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (repo_id, category_id)
    );
    CREATE INDEX IF NOT EXISTS idx_slo_dips_categories_repo
        ON slo_dips_repo_categories(repo_id, name);
    "#,
    // v21 — resolved GitHub emoji asset for each selected Discussion category. Keep the
    // original shortcode too so the source metadata remains inspectable.
    r#"
    ALTER TABLE slo_dips_repo_categories ADD COLUMN emoji_url TEXT;
    "#,
    // v22 — match the category listing order so SQLite can satisfy the repository filter and
    // case-insensitive name/category tie-break ordering directly from the index.
    r#"
    DROP INDEX IF EXISTS idx_slo_dips_categories_repo;
    CREATE INDEX idx_slo_dips_categories_repo
        ON slo_dips_repo_categories(repo_id, name COLLATE NOCASE, category_id);
    "#,
    // v23 — collected SLO dips parsed from the bot's Discussion comments. Keyed by the GitHub
    // comment database id (stable and unique). Rows cascade with their tracked repository and
    // are pruned to a floating window by dip_date. Investigation state is derived from whether
    // a non-bot user replied to the dip comment.
    r#"
    CREATE TABLE slo_dips (
        comment_id         INTEGER PRIMARY KEY,
        repo_id            INTEGER NOT NULL REFERENCES slo_dips_repos(repo_id) ON DELETE CASCADE,
        discussion_number  INTEGER NOT NULL,
        discussion_title   TEXT NOT NULL,
        service            TEXT NOT NULL,
        comment_url        TEXT NOT NULL,
        slo_name           TEXT NOT NULL,
        slo_url            TEXT,
        dip_date           TEXT NOT NULL,
        percent            REAL NOT NULL,
        goal_percent       REAL,
        investigated       INTEGER NOT NULL DEFAULT 0,
        investigated_by    TEXT,
        investigated_at    TEXT,
        comment_created_at TEXT NOT NULL,
        fetched_at         TEXT NOT NULL
    );
    CREATE INDEX idx_slo_dips_repo_date
        ON slo_dips(repo_id, dip_date DESC);
    CREATE INDEX idx_slo_dips_date
        ON slo_dips(dip_date);
    "#,
    // v24 — local snooze overlay. A snoozed thread is hidden from the inbox until `until_at`
    // passes or genuinely new activity lands. Mirrors `notification_dismissals`: local-only
    // (never synced), no foreign key to `notifications` (rows are pruned explicitly on
    // reconcile), and the watermark columns snapshot the notification/subject generations the
    // user had already seen when they snoozed, so a read-only timestamp bump can't wake it.
    r#"
    CREATE TABLE IF NOT EXISTS notification_snoozes (
        thread_id               TEXT PRIMARY KEY,
        until_at                TEXT NOT NULL,
        snoozed_at              TEXT NOT NULL,
        notification_updated_at TEXT,
        subject_updated_at      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_notification_snoozes_until
        ON notification_snoozes(until_at);
    "#,
    // v25 — snooze is a pure deadline. Waking a snoozed thread on new activity contradicted
    // the explicit "remind me about this later" intent, so the watermark columns added in v24
    // are now dead weight and are dropped by recreating the table.
    r#"
    CREATE TABLE notification_snoozes_new (
        thread_id  TEXT PRIMARY KEY,
        until_at   TEXT NOT NULL,
        snoozed_at TEXT NOT NULL
    );

    INSERT INTO notification_snoozes_new (thread_id, until_at, snoozed_at)
        SELECT thread_id, until_at, snoozed_at FROM notification_snoozes;

    DROP INDEX IF EXISTS idx_notification_snoozes_until;
    DROP TABLE notification_snoozes;
    ALTER TABLE notification_snoozes_new RENAME TO notification_snoozes;

    CREATE INDEX idx_notification_snoozes_until
        ON notification_snoozes(until_at);
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
    use std::collections::BTreeMap;

    use super::*;

    fn table_columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let mut cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        cols.sort();
        cols
    }

    fn table_indexes(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1")
            .unwrap();
        let mut indexes: Vec<String> = stmt
            .query_map([table], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        indexes.sort();
        indexes
    }

    fn table_index_sql(conn: &Connection, table: &str) -> BTreeMap<String, String> {
        let mut stmt = conn
            .prepare(
                "SELECT name, COALESCE(sql, '') FROM sqlite_master
                 WHERE type = 'index' AND tbl_name = ?1",
            )
            .unwrap();
        let rows = stmt
            .query_map([table], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap();
        rows.collect::<Result<_, _>>().unwrap()
    }

    #[test]
    fn bootstrap_creates_v1_schema() {
        let dir = std::env::temp_dir().join(format!("helix-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("helix.db");
        let _ = std::fs::remove_file(&db_path);

        let conn = open_and_migrate(&db_path).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);

        let tables = table_names(&conn).unwrap();
        for expected in [
            "collapsed_notification_repos",
            "dependabot_prs",
            "dependabot_repos",
            "dependabot_merge_operations",
            "dependabot_merge_operation_events",
            "dependabot_merge_check_retries",
            "dependabot_merge_policies",
            "dependabot_merge_runtime",
            "notification_dismissals",
            "notifications",
            "rate_limits",
            "repos",
            "settings",
            "sync_state",
        ] {
            assert!(
                tables.contains(&expected.to_string()),
                "missing table {expected}"
            );
        }

        // The singleton sync_state row is seeded on first run.
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);

        std::fs::remove_file(&db_path).ok();
    }

    /// Exercise the real upgrade path: a populated v2 database (with the original `unread`
    /// column, its index, and a data row) migrates to the latest schema while preserving the
    /// row and restoring the remote unread signal in the current model.
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

        // Run the remaining migrations (including v3's drop and v16's remote-state restore).
        run_migrations(&conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);

        // `last_read_at` stays gone, while the remote unread signal is restored.
        let cols: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(notifications)").unwrap();
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows
        };
        assert!(cols.contains(&"unread".to_string()));
        assert!(cols.contains(&"subject_updated_at".to_string()));
        assert!(!cols.contains(&"last_read_at".to_string()));
        let title: String = conn
            .query_row(
                "SELECT subject_title FROM notifications WHERE thread_id = 't1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(title, "Hi");
        assert!(table_names(&conn)
            .unwrap()
            .contains(&"notification_dismissals".to_string()));
    }

    #[test]
    fn upgrade_from_v15_preserves_done_tombstones_as_dismissals() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for migration in &MIGRATIONS[..15] {
            conn.execute_batch(migration).unwrap();
        }
        conn.pragma_update(None, "user_version", 15).unwrap();
        conn.execute(
            "INSERT INTO done_tombstones (thread_id, updated_at, done_at)
             VALUES ('t1', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z')",
            [],
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let dismissal: (Option<String>, String, Option<String>) = conn
            .query_row(
                "SELECT notification_updated_at, dismissed_at, subject_updated_at
                 FROM notification_dismissals WHERE thread_id = 't1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            dismissal,
            (
                Some("2026-01-02T00:00:00Z".to_string()),
                "2026-01-03T00:00:00Z".to_string(),
                None,
            )
        );
        assert!(!table_names(&conn)
            .unwrap()
            .contains(&"done_tombstones".to_string()));
    }

    /// Exercise the v13 → v14 upgrade: a populated v13 database (pre-Phase-2 merge operation,
    /// no `phase`/`strategy`/event tables) migrates cleanly, backfilling the new columns with
    /// their documented defaults and adding the event/retry/policy tables with working cascade
    /// deletes.
    #[test]
    fn upgrade_from_populated_v13_adds_phase_fields_and_event_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for migration in &MIGRATIONS[..13] {
            conn.execute_batch(migration).unwrap();
        }
        conn.pragma_update(None, "user_version", 13).unwrap();

        conn.execute(
            "INSERT INTO dependabot_merge_operations
                (pr_id, repo_full_name, number, title, html_url, pull_url, author, state,
                 enqueued_at)
             VALUES (1, 'octo/repo', 10, 'Bump x', 'https://github.com/octo/repo/pull/10',
                     'https://api.github.com/repos/octo/repo/pulls/10', 'dependabot[bot]',
                     'queued', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let op_id = conn.last_insert_rowid();

        run_migrations(&conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);

        // New columns exist and back-filled defaults match the documented ones.
        let (phase, strategy, retry_count, auto_merge): (String, String, i64, bool) = conn
            .query_row(
                "SELECT phase, strategy, check_retry_count, auto_merge_enabled
                 FROM dependabot_merge_operations WHERE id = ?1",
                [op_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(phase, "queued");
        assert_eq!(strategy, "unknown");
        assert_eq!(retry_count, 0);
        assert!(!auto_merge);

        for expected in [
            "dependabot_merge_operation_events",
            "dependabot_merge_check_retries",
            "dependabot_merge_policies",
        ] {
            assert!(
                table_names(&conn).unwrap().contains(&expected.to_string()),
                "missing table {expected}"
            );
        }

        // Cascade delete: events and retries tied to the operation disappear with it.
        conn.execute(
            "INSERT INTO dependabot_merge_operation_events
                (operation_id, phase, kind, status, summary, created_at)
             VALUES (?1, 'queued', 'lifecycle', 'queued', 'Enqueued.', '2026-01-01T00:00:00Z')",
            [op_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO dependabot_merge_check_retries
                (operation_id, head_sha, workflow_run_id, run_attempt, scheduled_at)
             VALUES (?1, 'deadbeef', 1, 1, '2026-01-01T00:00:00Z')",
            [op_id],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM dependabot_merge_operations WHERE id = ?1",
            [op_id],
        )
        .unwrap();
        let remaining_events: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM dependabot_merge_operation_events",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let remaining_retries: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM dependabot_merge_check_retries",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(remaining_events, 0);
        assert_eq!(remaining_retries, 0);
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
                .query_row("SELECT COUNT(*) FROM sync_state", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );

        std::fs::remove_file(&db_path).ok();
    }

    #[test]
    fn upgrade_from_reserved_v18_creates_collapsed_notification_repos() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for migration in &MIGRATIONS[..17] {
            conn.execute_batch(migration).unwrap();
        }
        conn.pragma_update(None, "user_version", 18).unwrap();

        run_migrations(&conn).unwrap();

        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);
        assert!(table_names(&conn)
            .unwrap()
            .contains(&"collapsed_notification_repos".to_string()));
    }

    #[test]
    fn upgrade_from_early_collapse_v18_preserves_preferences() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for migration in &MIGRATIONS[..17] {
            conn.execute_batch(migration).unwrap();
        }
        conn.execute_batch(
            "CREATE TABLE collapsed_notification_repos (
                repo_full_name TEXT PRIMARY KEY,
                collapsed_at   TEXT NOT NULL
            );
            INSERT INTO collapsed_notification_repos (repo_full_name, collapsed_at)
            VALUES ('octo/repo', '2026-07-17T00:00:00Z');",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 18).unwrap();

        run_migrations(&conn).unwrap();

        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);
        assert_eq!(
            conn.query_row(
                "SELECT collapsed_at FROM collapsed_notification_repos
                 WHERE repo_full_name = 'octo/repo'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "2026-07-17T00:00:00Z"
        );
    }

    #[test]
    fn upgrade_from_populated_v14_preserves_pr_with_unknown_target_branch() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for migration in &MIGRATIONS[..14] {
            conn.execute_batch(migration).unwrap();
        }
        conn.pragma_update(None, "user_version", 14).unwrap();
        conn.execute(
            "INSERT INTO dependabot_prs
                (id, repo_full_name, repo_owner, repo_name, number, title, html_url, author,
                 pull_url, created_at, updated_at, fetched_at)
             VALUES (1, 'octo/repo', 'octo', 'repo', 10, 'Bump x',
                     'https://github.com/octo/repo/pull/10', 'dependabot[bot]',
                     'https://api.github.com/repos/octo/repo/pulls/10',
                     '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
                     '2026-01-02T00:00:00Z')",
            [],
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let (title, base_ref): (String, Option<String>) = conn
            .query_row(
                "SELECT title, base_ref FROM dependabot_prs WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Bump x");
        assert_eq!(base_ref, None);
    }

    #[test]
    fn upgrade_from_populated_v16_drops_dead_merge_operation_columns_with_schema_parity() {
        let required_indexes = [
            "idx_dependabot_merge_active_pr",
            "idx_dependabot_merge_repo_fifo",
            "idx_dependabot_merge_terminal",
        ];
        let upgraded = Connection::open_in_memory().unwrap();
        upgraded.pragma_update(None, "foreign_keys", "ON").unwrap();
        for migration in &MIGRATIONS[..16] {
            upgraded.execute_batch(migration).unwrap();
        }
        upgraded.pragma_update(None, "user_version", 16).unwrap();
        let before_index_sql = table_index_sql(&upgraded, "dependabot_merge_operations");

        upgraded
            .execute(
                "INSERT INTO dependabot_merge_operations
                    (pr_id, repo_full_name, number, title, html_url, pull_url, author, state,
                     merge_command_at, cancel_command_at, enqueued_at, delegated_at,
                     last_checked_at, last_action_at, terminal_at, failure_code, failure_reason,
                     last_error, update_branch_from_sha, phase, strategy, pull_node_id, base_ref,
                     next_action_at, check_retry_count, merge_queue_position, auto_merge_enabled)
                 VALUES
                    (1, 'octo/repo', 10, 'Bump x', 'https://github.com/octo/repo/pull/10',
                     'https://api.github.com/repos/octo/repo/pulls/10', 'dependabot[bot]',
                     'delegated', '2026-01-01T00:01:00Z', NULL, '2026-01-01T00:00:00Z',
                     '2026-01-01T00:02:00Z', '2026-01-01T00:03:00Z', '2026-01-01T00:04:00Z',
                     NULL, NULL, NULL, NULL, NULL, 'merging', 'native_squash', NULL, 'main',
                     NULL, 0, NULL, 0)",
                [],
            )
            .unwrap();
        let op_id = upgraded.last_insert_rowid();

        run_migrations(&upgraded).unwrap();
        assert_eq!(schema_version(&upgraded).unwrap(), MIGRATIONS.len() as i64);

        let upgraded_cols = table_columns(&upgraded, "dependabot_merge_operations");
        assert!(!upgraded_cols.contains(&"merge_command_at".to_string()));
        assert!(!upgraded_cols.contains(&"cancel_command_at".to_string()));
        assert!(!upgraded_cols.contains(&"last_action_at".to_string()));
        assert!(
            upgraded
                .query_row(
                    "SELECT COUNT(*) FROM dependabot_merge_operations WHERE id = ?1
                 AND pr_id = 1 AND state = 'delegated' AND phase = 'merging'
                 AND repo_full_name = 'octo/repo'",
                    [op_id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap()
                == 1
        );

        let upgraded_indexes = table_indexes(&upgraded, "dependabot_merge_operations");
        let after_index_sql = table_index_sql(&upgraded, "dependabot_merge_operations");
        for required in required_indexes {
            assert!(upgraded_indexes.contains(&required.to_string()));
            assert_eq!(
                before_index_sql.get(required),
                after_index_sql.get(required),
                "index SQL changed for {required}"
            );
        }

        let fresh = Connection::open_in_memory().unwrap();
        fresh.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_migrations(&fresh).unwrap();

        assert_eq!(
            upgraded_cols,
            table_columns(&fresh, "dependabot_merge_operations")
        );
        assert_eq!(
            upgraded_indexes,
            table_indexes(&fresh, "dependabot_merge_operations")
        );
        let fresh_index_sql = table_index_sql(&fresh, "dependabot_merge_operations");
        for required in required_indexes {
            assert_eq!(
                after_index_sql.get(required),
                fresh_index_sql.get(required),
                "upgraded and fresh index SQL differ for {required}"
            );
        }
    }

    #[test]
    fn latest_schema_persists_slo_dips_repositories_and_cascades_categories() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_migrations(&conn).unwrap();

        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);
        let tables = table_names(&conn).unwrap();
        assert!(tables.contains(&"slo_dips_repos".to_string()));
        assert!(tables.contains(&"slo_dips_repo_categories".to_string()));
        let indexes = table_index_sql(&conn, "slo_dips_repo_categories");
        assert_eq!(
            indexes
                .get("idx_slo_dips_categories_repo")
                .map(String::as_str),
            Some(
                "CREATE INDEX idx_slo_dips_categories_repo
        ON slo_dips_repo_categories(repo_id, name COLLATE NOCASE, category_id)"
            )
        );

        conn.execute(
            "INSERT INTO slo_dips_repos
                (repo_id, full_name, owner, name, private, added_at)
             VALUES (1, 'octo/repo', 'octo', 'repo', 0, '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO slo_dips_repo_categories (repo_id, category_id, name, emoji)
             VALUES (1, 'DC_1', 'SLO Dips', '📉')",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM slo_dips_repos WHERE repo_id = 1", [])
            .unwrap();
        let categories: i64 = conn
            .query_row("SELECT COUNT(*) FROM slo_dips_repo_categories", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(categories, 0);
    }

    #[test]
    fn latest_schema_persists_slo_dips_and_cascades_with_repository() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_migrations(&conn).unwrap();

        assert!(table_names(&conn)
            .unwrap()
            .contains(&"slo_dips".to_string()));
        conn.execute(
            "INSERT INTO slo_dips_repos
                (repo_id, full_name, owner, name, private, added_at)
             VALUES (1, 'octo/repo', 'octo', 'repo', 0, '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO slo_dips
                (comment_id, repo_id, discussion_number, discussion_title, service,
                 comment_url, slo_name, slo_url, dip_date, percent, goal_percent,
                 investigated, investigated_by, investigated_at, comment_created_at, fetched_at)
             VALUES (10, 1, 7585, 'SLO investigations for `dns`', 'dns',
                 'https://example/c', 'dns-x/availability/sam', 'https://dd', '2026-04-19',
                 99.967, 99.99, 1, 'octocat', '2026-04-20T00:00:00Z',
                 '2026-04-20T00:00:00Z', '2026-04-21T00:00:00Z')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM slo_dips_repos WHERE repo_id = 1", [])
            .unwrap();
        let dips: i64 = conn
            .query_row("SELECT COUNT(*) FROM slo_dips", [], |row| row.get(0))
            .unwrap();
        assert_eq!(dips, 0);
    }
}
