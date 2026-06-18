//! Notification sync: persist fetched threads into SQLite and track sync state.
//!
//! SQLite is the source of truth (see `docs/design.md` §3/§5). This module upserts repos
//! and notifications, reconciles away rows that disappeared upstream (M5), and records the
//! outcome (status, error, rate-limit snapshot) in `sync_state`.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::github::{NotificationThread, RateLimit};

/// Outcome of a store + reconcile pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreOutcome {
    /// Notifications upserted from the latest fetch.
    pub stored: usize,
    /// Local notifications removed because they were no longer present upstream.
    pub removed: usize,
}

/// Upsert repos + notifications from a **complete** fetch and reconcile local state.
///
/// `threads` must be the full current set of unread notifications (GitHub only returns
/// currently-unread threads). Existing rows are updated in place; the subject-resolution
/// columns (`subject_state`, `resolved_at`, …) populated in M6 are intentionally left
/// untouched.
///
/// Reconciliation (M5): any locally-stored notification absent from this fetch was cleared
/// (marked done/read) upstream, so it is deleted — v1 keeps the inbox = currently-unread
/// only (see `docs/design.md` §"Reconcile vs. retain"). Repos left without any
/// notifications are pruned so the table doesn't accumulate orphans. Stale rows are
/// identified by the exact set of fetched thread ids rather than a timestamp watermark, so
/// reconciliation is correct even when two syncs land within the same clock tick.
pub fn store_notifications(
    conn: &mut Connection,
    threads: &[NotificationThread],
) -> rusqlite::Result<StoreOutcome> {
    let tx = conn.transaction()?;

    // Record the thread ids seen in this fetch so we can delete everything else below.
    // A connection-scoped temp table avoids SQLite's bound-variable cap on large `NOT IN`
    // lists; it is cleared (not recreated) so repeated syncs on the long-lived connection
    // stay cheap.
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS present_threads (thread_id TEXT PRIMARY KEY);
         DELETE FROM present_threads;",
    )?;

    for t in threads {
        tx.execute(
            "INSERT OR IGNORE INTO present_threads (thread_id) VALUES (?1)",
            params![t.id],
        )?;
        tx.execute(
            "INSERT INTO repos (id, full_name, owner, name, private, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               full_name = excluded.full_name,
               owner     = excluded.owner,
               name      = excluded.name,
               private   = excluded.private,
               updated_at = excluded.updated_at",
            params![
                t.repository.id,
                t.repository.full_name,
                t.repository.owner.login,
                t.repository.name,
                t.repository.private as i64,
                t.repository.updated_at,
            ],
        )?;

        tx.execute(
            "INSERT INTO notifications (
                 thread_id, repo_id, subject_type, subject_title, subject_url,
                 reason, unread, updated_at, last_read_at, thread_url, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                     strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             ON CONFLICT(thread_id) DO UPDATE SET
               repo_id       = excluded.repo_id,
               subject_type  = excluded.subject_type,
               subject_title = excluded.subject_title,
               subject_url   = excluded.subject_url,
               reason        = excluded.reason,
               unread        = excluded.unread,
               updated_at    = excluded.updated_at,
               last_read_at  = excluded.last_read_at,
               thread_url    = excluded.thread_url,
               fetched_at    = excluded.fetched_at",
            params![
                t.id,
                t.repository.id,
                t.subject.subject_type,
                t.subject.title,
                t.subject.url,
                t.reason,
                t.unread as i64,
                t.updated_at,
                t.last_read_at,
                t.url,
            ],
        )?;
    }

    // Reconcile: drop notifications no longer returned upstream, then prune repos that
    // ended up with no notifications. Notifications are deleted first to respect the
    // repos foreign key.
    let removed = tx.execute(
        "DELETE FROM notifications
         WHERE thread_id NOT IN (SELECT thread_id FROM present_threads)",
        [],
    )?;
    tx.execute(
        "DELETE FROM repos
         WHERE id NOT IN (SELECT DISTINCT repo_id FROM notifications)",
        [],
    )?;

    tx.commit()?;
    Ok(StoreOutcome {
        stored: threads.len(),
        removed,
    })
}

/// Record a successful sync: timestamp, status, and the rate-limit snapshot.
pub fn record_success(conn: &Connection, rate: &RateLimit) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sync_state SET
           last_sync_at   = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
           last_status    = 'success',
           last_error     = NULL,
           rate_remaining = ?1,
           rate_reset_at  = ?2
         WHERE id = 1",
        params![rate.remaining, rate.reset.map(|r| r.to_string())],
    )?;
    Ok(())
}

/// Record a failed sync (status + message); leaves the last successful data intact.
pub fn record_error(conn: &Connection, message: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sync_state SET last_status = 'error', last_error = ?1 WHERE id = 1",
        params![message],
    )?;
    Ok(())
}

/// Sync status surfaced to the UI.
#[derive(Debug, Serialize)]
pub struct SyncStatus {
    pub last_sync_at: Option<String>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub rate_remaining: Option<i64>,
    pub rate_reset_at: Option<String>,
    pub notification_count: i64,
}

/// Read the current sync status (from `sync_state` + a count of stored notifications).
pub fn read_status(conn: &Connection) -> rusqlite::Result<SyncStatus> {
    let row = conn.query_row(
        "SELECT last_sync_at, last_status, last_error, rate_remaining, rate_reset_at
         FROM sync_state WHERE id = 1",
        [],
        |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<i64>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        },
    )?;
    let notification_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM notifications", [], |r| r.get(0))?;

    Ok(SyncStatus {
        last_sync_at: row.0,
        last_status: row.1,
        last_error: row.2,
        rate_remaining: row.3,
        rate_reset_at: row.4,
        notification_count,
    })
}

/// Count stored notifications (helper, also used by tests).
#[cfg(test)]
pub fn count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM notifications", [], |r| r.get(0))
}

/* --------------------------------- Inbox ---------------------------------- */

/// A single notification as shown in the by-repo inbox.
#[derive(Debug, Serialize)]
pub struct NotificationView {
    pub thread_id: String,
    pub subject_type: String,
    pub subject_title: String,
    pub subject_url: Option<String>,
    pub reason: String,
    pub unread: bool,
    pub updated_at: String,
    pub thread_url: Option<String>,
    /// Resolved subject metadata (populated by M6; may be null until then).
    pub subject_number: Option<i64>,
    pub subject_state: Option<String>,
    pub subject_html_url: Option<String>,
}

/// Notifications for one repository.
#[derive(Debug, Serialize)]
pub struct RepoGroup {
    pub repo_id: i64,
    pub full_name: String,
    pub private: bool,
    pub unread_count: i64,
    pub total: i64,
    pub notifications: Vec<NotificationView>,
}

/// Read all stored notifications grouped by repository.
///
/// Repos are ordered by full name; within a repo, unread first, then most recently
/// updated. This is a pure local read (offline-first) — the source of truth is SQLite.
pub fn list_by_repo(conn: &Connection) -> rusqlite::Result<Vec<RepoGroup>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.full_name, r.private,
                n.thread_id, n.subject_type, n.subject_title, n.subject_url,
                COALESCE(n.reason, '') AS reason,
                n.unread, n.updated_at, n.thread_url,
                n.subject_number, n.subject_state, n.subject_html_url
         FROM notifications n
         JOIN repos r ON r.id = n.repo_id
         ORDER BY r.full_name ASC, n.unread DESC, n.updated_at DESC",
    )?;

    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,            // repo id
            r.get::<_, String>(1)?,         // full_name
            r.get::<_, i64>(2)? != 0,       // private
            NotificationView {
                thread_id: r.get(3)?,
                subject_type: r.get(4)?,
                subject_title: r.get(5)?,
                subject_url: r.get(6)?,
                reason: r.get(7)?,
                unread: r.get::<_, i64>(8)? != 0,
                updated_at: r.get(9)?,
                thread_url: r.get(10)?,
                subject_number: r.get(11)?,
                subject_state: r.get(12)?,
                subject_html_url: r.get(13)?,
            },
        ))
    })?;

    let mut groups: Vec<RepoGroup> = Vec::new();
    for row in rows {
        let (repo_id, full_name, private, view) = row?;
        // Rows are ordered by repo, so we only ever append to the last group.
        if groups.last().map(|g| g.repo_id) != Some(repo_id) {
            groups.push(RepoGroup {
                repo_id,
                full_name,
                private,
                unread_count: 0,
                total: 0,
                notifications: Vec::new(),
            });
        }
        let group = groups.last_mut().expect("group just ensured");
        group.total += 1;
        if view.unread {
            group.unread_count += 1;
        }
        group.notifications.push(view);
    }
    Ok(groups)
}

/// Look up a repo's full name by id (test/diagnostic helper).
#[cfg(test)]
pub fn repo_full_name(conn: &Connection, id: i64) -> rusqlite::Result<Option<String>> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT full_name FROM repos WHERE id = ?1", [id], |r| {
        r.get::<_, String>(0)
    })
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::github::{MinimalRepo, NotificationThread, RepoOwner, Subject};

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        let mut version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        let migrations = db::migrations();
        while (version as usize) < migrations.len() {
            conn.execute_batch(migrations[version as usize]).unwrap();
            version += 1;
            conn.pragma_update(None, "user_version", version).unwrap();
        }
        conn
    }

    fn thread(id: &str, repo_id: i64, repo: &str, title: &str, unread: bool) -> NotificationThread {
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
                url: Some(format!("https://api.github.com/{repo}/issues/1")),
                subject_type: "Issue".to_string(),
            },
            reason: "subscribed".to_string(),
            unread,
            updated_at: "2026-01-02T00:00:00Z".to_string(),
            last_read_at: None,
            url: format!("https://api.github.com/notifications/threads/{id}"),
        }
    }

    #[test]
    fn stores_repos_and_notifications() {
        let mut conn = mem_conn();
        let threads = vec![
            thread("1", 100, "octo/repo-a", "First", true),
            thread("2", 100, "octo/repo-a", "Second", true),
            thread("3", 200, "octo/repo-b", "Third", true),
        ];
        let n = store_notifications(&mut conn, &threads).unwrap();
        assert_eq!(n.stored, 3);
        assert_eq!(n.removed, 0);
        assert_eq!(count(&conn).unwrap(), 3);
        assert_eq!(
            repo_full_name(&conn, 100).unwrap().as_deref(),
            Some("octo/repo-a")
        );
        // Two distinct repos stored.
        let repos: i64 = conn
            .query_row("SELECT COUNT(*) FROM repos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(repos, 2);
    }

    #[test]
    fn groups_notifications_by_repo() {
        let mut conn = mem_conn();
        let threads = vec![
            thread("1", 200, "octo/zeta", "Z one", true),
            thread("2", 100, "octo/alpha", "A read", false),
            thread("3", 100, "octo/alpha", "A unread", true),
        ];
        store_notifications(&mut conn, &threads).unwrap();

        let groups = list_by_repo(&conn).unwrap();
        assert_eq!(groups.len(), 2);

        // Repos are ordered by full name: alpha before zeta.
        assert_eq!(groups[0].full_name, "octo/alpha");
        assert_eq!(groups[1].full_name, "octo/zeta");

        let alpha = &groups[0];
        assert_eq!(alpha.total, 2);
        assert_eq!(alpha.unread_count, 1);
        // Within a repo, unread sorts before read.
        assert!(alpha.notifications[0].unread);
        assert_eq!(alpha.notifications[0].subject_title, "A unread");
        assert!(!alpha.notifications[1].unread);

        assert_eq!(groups[1].total, 1);
        assert_eq!(groups[1].unread_count, 1);
    }

    #[test]
    fn null_reason_does_not_break_listing() {
        let mut conn = mem_conn();
        store_notifications(&mut conn, &[thread("1", 100, "octo/alpha", "Title", true)]).unwrap();
        // The reason column is nullable; ensure a NULL value still lists cleanly.
        conn.execute("UPDATE notifications SET reason = NULL WHERE thread_id = '1'", [])
            .unwrap();

        let groups = list_by_repo(&conn).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].notifications.len(), 1);
        assert_eq!(groups[0].notifications[0].reason, "");
    }

    #[test]
    fn upsert_is_idempotent_and_updates_mutable_fields() {
        let mut conn = mem_conn();
        store_notifications(&mut conn, &[thread("1", 100, "octo/repo-a", "Old title", true)])
            .unwrap();

        // Re-store the same thread id with a changed title + read state.
        store_notifications(
            &mut conn,
            &[thread("1", 100, "octo/repo-a", "New title", false)],
        )
        .unwrap();

        assert_eq!(count(&conn).unwrap(), 1); // no duplicate row
        let (title, unread): (String, i64) = conn
            .query_row(
                "SELECT subject_title, unread FROM notifications WHERE thread_id = '1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "New title");
        assert_eq!(unread, 0);
    }

    #[test]
    fn upsert_preserves_resolved_subject_columns() {
        let mut conn = mem_conn();
        store_notifications(&mut conn, &[thread("1", 100, "octo/repo-a", "Title", true)]).unwrap();
        // Simulate M6 resolution writing subject metadata.
        conn.execute(
            "UPDATE notifications SET subject_state = 'closed', resolved_at = '2026-01-03T00:00:00Z'
             WHERE thread_id = '1'",
            [],
        )
        .unwrap();

        // A subsequent sync must not clobber the resolved columns.
        store_notifications(&mut conn, &[thread("1", 100, "octo/repo-a", "Title v2", true)]).unwrap();
        let (state, resolved): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT subject_state, resolved_at FROM notifications WHERE thread_id = '1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(state.as_deref(), Some("closed"));
        assert_eq!(resolved.as_deref(), Some("2026-01-03T00:00:00Z"));
    }

    #[test]
    fn reconcile_removes_threads_absent_from_latest_fetch() {
        let mut conn = mem_conn();
        store_notifications(
            &mut conn,
            &[
                thread("1", 100, "octo/repo-a", "One", true),
                thread("2", 100, "octo/repo-a", "Two", true),
                thread("3", 200, "octo/repo-b", "Three", true),
            ],
        )
        .unwrap();
        assert_eq!(count(&conn).unwrap(), 3);

        // A later full sync only returns thread 1 (2 and 3 were cleared on github.com).
        let outcome =
            store_notifications(&mut conn, &[thread("1", 100, "octo/repo-a", "One", true)]).unwrap();
        assert_eq!(outcome.stored, 1);
        assert_eq!(outcome.removed, 2);
        assert_eq!(count(&conn).unwrap(), 1);

        let survives: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notifications WHERE thread_id = '1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(survives, 1);

        // repo-b only held thread 3, so it is pruned; repo-a still has thread 1.
        assert_eq!(repo_full_name(&conn, 200).unwrap(), None);
        assert_eq!(
            repo_full_name(&conn, 100).unwrap().as_deref(),
            Some("octo/repo-a")
        );
    }

    #[test]
    fn reconcile_empty_fetch_clears_inbox() {
        let mut conn = mem_conn();
        store_notifications(
            &mut conn,
            &[
                thread("1", 100, "octo/repo-a", "One", true),
                thread("2", 200, "octo/repo-b", "Two", true),
            ],
        )
        .unwrap();

        let outcome = store_notifications(&mut conn, &[]).unwrap();
        assert_eq!(outcome.stored, 0);
        assert_eq!(outcome.removed, 2);
        assert_eq!(count(&conn).unwrap(), 0);

        let repos: i64 = conn
            .query_row("SELECT COUNT(*) FROM repos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(repos, 0);
    }

    #[test]
    fn reconcile_keeps_resolved_columns_on_surviving_rows() {
        let mut conn = mem_conn();
        store_notifications(
            &mut conn,
            &[
                thread("1", 100, "octo/repo-a", "One", true),
                thread("2", 100, "octo/repo-a", "Two", true),
            ],
        )
        .unwrap();
        // Simulate M6 resolution on the thread that will survive the next sync.
        conn.execute(
            "UPDATE notifications SET subject_state = 'closed' WHERE thread_id = '1'",
            [],
        )
        .unwrap();

        // Next sync drops thread 2 but keeps thread 1 — its resolved column must persist.
        let outcome =
            store_notifications(&mut conn, &[thread("1", 100, "octo/repo-a", "One", true)]).unwrap();
        assert_eq!(outcome.removed, 1);
        let state: Option<String> = conn
            .query_row(
                "SELECT subject_state FROM notifications WHERE thread_id = '1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state.as_deref(), Some("closed"));
    }

    #[test]
    fn records_success_and_error_status() {
        let conn = mem_conn();
        let rate = RateLimit {
            remaining: Some(4999),
            reset: Some(1700000000),
            poll_interval: Some(60),
        };
        record_success(&conn, &rate).unwrap();
        let s = read_status(&conn).unwrap();
        assert_eq!(s.last_status.as_deref(), Some("success"));
        assert_eq!(s.rate_remaining, Some(4999));
        assert!(s.last_sync_at.is_some());
        assert_eq!(s.last_error, None);

        record_error(&conn, "boom").unwrap();
        let s = read_status(&conn).unwrap();
        assert_eq!(s.last_status.as_deref(), Some("error"));
        assert_eq!(s.last_error.as_deref(), Some("boom"));
    }
}
