//! Notification sync: persist fetched threads into SQLite and track sync state.
//!
//! SQLite is the source of truth (see `docs/design.md` §3/§5). This module upserts repos
//! and notifications and records the outcome (status, error, rate-limit snapshot) in
//! `sync_state`. Reconciliation of threads that disappeared upstream is a later milestone
//! (M5); here we only fetch + store.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::github::{NotificationThread, RateLimit};

/// Upsert repos + notifications from a fetch into SQLite in a single transaction.
///
/// Existing rows are updated in place; the subject-resolution columns
/// (`subject_state`, `resolved_at`, …) populated in M6 are intentionally left untouched.
/// Returns the number of threads stored.
pub fn store_notifications(
    conn: &mut Connection,
    threads: &[NotificationThread],
) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    for t in threads {
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
    tx.commit()?;
    Ok(threads.len())
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
        assert_eq!(n, 3);
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
