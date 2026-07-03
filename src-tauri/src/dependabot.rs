//! Dependabot module data layer: persist the open Dependabot PRs fetched from the Search
//! API and read them back grouped by repository.
//!
//! Mirrors `sync.rs` for its own domain (see `docs/design.md` — SQLite is the source of
//! truth). `store_prs` upserts the current search results and reconciles away rows that
//! disappeared upstream (a PR that merged/closed no longer matches `is:open`, so it's
//! deleted). The module reads offline-first via `list_by_repo`; GitHub is only contacted on
//! a sync. Merge-readiness (`mergeable_state`) is resolved lazily per PR — the Search API
//! omits it — with the same smart-cache (`prs_needing_merge_state`) + rate-reserve discipline
//! used for notification subjects.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::github::{DependabotPr, ResolvedSubject};

/// Outcome of a store + reconcile pass (mirrors `sync::StoreOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreOutcome {
    /// PRs upserted from the latest search.
    pub stored: usize,
    /// Local PRs removed because they were no longer returned (merged/closed/inaccessible).
    pub removed: usize,
}

/// Upsert the Dependabot PRs from a search and (optionally) reconcile local state.
///
/// Existing rows are updated in place, but the resolution columns (`mergeable_state`,
/// `resolved_at`) are intentionally left untouched — they are populated separately by
/// `store_merge_state`. When `reconcile` is true (the search returned the **complete** result
/// set), any locally-stored PR absent from `prs` was merged/closed (or became inaccessible)
/// and is deleted, so the module never shows a stale PR. When false (the search was
/// incomplete/capped — see `DependabotSearchOutcome::complete`), removals are **skipped** so
/// we never drop a PR that simply fell outside a partial result window. Stale rows are
/// identified by the exact set of fetched ids (not a timestamp watermark) so reconciliation
/// is correct even for two syncs in one tick.
pub fn store_prs(
    conn: &mut Connection,
    prs: &[DependabotPr],
    reconcile: bool,
) -> rusqlite::Result<StoreOutcome> {
    let tx = conn.transaction()?;

    // Connection-scoped temp table of the ids seen this fetch, so we can delete everything
    // else without hitting SQLite's bound-variable cap on a large `NOT IN` list. Cleared
    // (not recreated) so repeated syncs on the long-lived connection stay cheap.
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS present_dependabot_prs (id INTEGER PRIMARY KEY);
         DELETE FROM present_dependabot_prs;",
    )?;

    let mut stored = 0usize;
    for pr in prs {
        tx.execute(
            "INSERT INTO dependabot_prs
               (id, repo_full_name, repo_owner, repo_name, number, title, html_url, author,
                pull_url, created_at, updated_at, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                     strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             ON CONFLICT(id) DO UPDATE SET
               repo_full_name = excluded.repo_full_name,
               repo_owner     = excluded.repo_owner,
               repo_name      = excluded.repo_name,
               number         = excluded.number,
               title          = excluded.title,
               html_url       = excluded.html_url,
               author         = excluded.author,
               pull_url       = excluded.pull_url,
               created_at     = excluded.created_at,
               updated_at     = excluded.updated_at,
               fetched_at     = excluded.fetched_at",
            params![
                pr.id,
                pr.repo_full_name,
                pr.repo_owner,
                pr.repo_name,
                pr.number,
                pr.title,
                pr.html_url,
                pr.author,
                pr.pull_url,
                pr.created_at,
                pr.updated_at,
            ],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO present_dependabot_prs (id) VALUES (?1)",
            params![pr.id],
        )?;
        stored += 1;
    }

    // Reconcile: delete any local PR not present in this search — but only for a complete
    // search, so an incomplete/capped result never drops PRs outside its window.
    let removed = if reconcile {
        tx.execute(
            "DELETE FROM dependabot_prs
             WHERE id NOT IN (SELECT id FROM present_dependabot_prs)",
            [],
        )?
    } else {
        0
    };

    tx.commit()?;
    Ok(StoreOutcome { stored, removed })
}

/// A single Dependabot PR as shown in the by-repo list.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DependabotPrView {
    pub id: i64,
    pub number: i64,
    pub title: String,
    pub html_url: String,
    pub author: String,
    pub updated_at: String,
    /// GitHub's rolled-up `mergeable_state` (clean/blocked/dirty/…), driving the
    /// merge-readiness pill. Null until first resolved (the Search API omits it).
    pub mergeable_state: Option<String>,
}

/// Dependabot PRs for one repository.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DependabotRepoGroup {
    pub full_name: String,
    pub total: i64,
    pub prs: Vec<DependabotPrView>,
}

/// Read all stored Dependabot PRs grouped by repository (offline-first local read).
///
/// Repos are ordered by full name; within a repo, most recently updated first.
pub fn list_by_repo(conn: &Connection) -> rusqlite::Result<Vec<DependabotRepoGroup>> {
    let mut stmt = conn.prepare(
        "SELECT repo_full_name, id, number, title, html_url, author, updated_at, mergeable_state
         FROM dependabot_prs
         ORDER BY repo_full_name ASC, updated_at DESC, id ASC",
    )?;

    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?, // repo_full_name
            DependabotPrView {
                id: r.get(1)?,
                number: r.get(2)?,
                title: r.get(3)?,
                html_url: r.get(4)?,
                author: r.get(5)?,
                updated_at: r.get(6)?,
                mergeable_state: r.get(7)?,
            },
        ))
    })?;

    let mut groups: Vec<DependabotRepoGroup> = Vec::new();
    for row in rows {
        let (full_name, view) = row?;
        // Rows are ordered by repo, so we only ever append to the last group.
        if groups.last().map(|g| g.full_name.as_str()) != Some(full_name.as_str()) {
            groups.push(DependabotRepoGroup {
                full_name,
                total: 0,
                prs: Vec::new(),
            });
        }
        let group = groups.last_mut().expect("group just ensured");
        group.total += 1;
        group.prs.push(view);
    }
    Ok(groups)
}

/// A PR whose merge-readiness still needs resolving. `pull_url` is the PR's REST API URL,
/// fetched (via `github::resolve_subject`) for its `mergeable_state`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPr {
    pub id: i64,
    pub pull_url: String,
}

/// Find PRs whose `mergeable_state` should be (re)resolved. A row qualifies when it has
/// never been resolved (`resolved_at IS NULL`), changed upstream since (`updated_at >
/// resolved_at`), or resolved to GitHub's lazy `unknown` and was last attempted over a minute
/// ago (GitHub computes mergeability lazily, so the first fetch after a push is often
/// `unknown`; re-fetching nudges it, and the one-minute floor bounds the cost). A row that
/// resolved to `NULL` — the PR was inaccessible (e.g. a 404) — is deliberately NOT retried on
/// that timer; it re-resolves only when its `updated_at` advances, so an unreadable PR isn't
/// re-fetched every minute forever. Ordered newest-first.
pub fn prs_needing_merge_state(conn: &Connection) -> rusqlite::Result<Vec<PendingPr>> {
    let mut stmt = conn.prepare(
        "SELECT id, pull_url
         FROM dependabot_prs
         WHERE resolved_at IS NULL
            OR updated_at > resolved_at
            OR (mergeable_state = 'unknown'
                AND resolved_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minute'))
         ORDER BY updated_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PendingPr {
            id: r.get(0)?,
            pull_url: r.get(1)?,
        })
    })?;
    rows.collect()
}

/// Persist a PR's resolved `mergeable_state` and stamp `resolved_at` so the smart cache can
/// skip the row until its `updated_at` changes again. Only the merge state is stored — the
/// other resolved fields (number, author, html_url) already come from the search result.
pub fn store_merge_state(
    conn: &Connection,
    id: i64,
    subject: &ResolvedSubject,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_prs SET
           mergeable_state = ?2,
           resolved_at     = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?1",
        params![id, subject.mergeable_state],
    )?;
    Ok(())
}

/// Count stored Dependabot PRs (helper, also used by tests).
#[cfg(test)]
pub fn count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM dependabot_prs", [], |r| r.get(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::ResolvedSubject;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        let mut version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        let migrations = crate::db::migrations();
        while (version as usize) < migrations.len() {
            conn.execute_batch(migrations[version as usize]).unwrap();
            version += 1;
            conn.pragma_update(None, "user_version", version).unwrap();
        }
        conn
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

    #[test]
    fn stores_and_lists_prs_grouped_by_repo() {
        let mut conn = mem_conn();
        let out = store_prs(
            &mut conn,
            &[
                pr(1, "octo/repo-a", 10, "Bump a"),
                pr(2, "octo/repo-a", 11, "Bump b"),
                pr(3, "octo/repo-b", 12, "Bump c"),
            ],
            true,
        )
        .unwrap();
        assert_eq!(out.stored, 3);
        assert_eq!(out.removed, 0);
        assert_eq!(count(&conn).unwrap(), 3);

        let groups = list_by_repo(&conn).unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].full_name, "octo/repo-a");
        assert_eq!(groups[0].total, 2);
        assert_eq!(groups[1].full_name, "octo/repo-b");
        assert_eq!(groups[1].total, 1);
        // No merge state resolved yet.
        assert_eq!(groups[0].prs[0].mergeable_state, None);
    }

    #[test]
    fn reconciles_away_prs_no_longer_returned() {
        let mut conn = mem_conn();
        store_prs(
            &mut conn,
            &[
                pr(1, "octo/repo-a", 10, "Bump a"),
                pr(2, "octo/repo-a", 11, "Bump b"),
            ],
            true,
        )
        .unwrap();

        // Second (complete) search returns only #1 (say #2 was merged) plus a new #3.
        let out = store_prs(
            &mut conn,
            &[
                pr(1, "octo/repo-a", 10, "Bump a"),
                pr(3, "octo/repo-b", 12, "Bump c"),
            ],
            true,
        )
        .unwrap();
        assert_eq!(out.stored, 2);
        assert_eq!(out.removed, 1);
        assert_eq!(count(&conn).unwrap(), 2);

        let ids: Vec<i64> = list_by_repo(&conn)
            .unwrap()
            .into_iter()
            .flat_map(|g| g.prs.into_iter().map(|p| p.id))
            .collect();
        assert_eq!(ids, vec![1, 3]);
    }

    #[test]
    fn incomplete_search_upserts_without_reconciling() {
        let mut conn = mem_conn();
        store_prs(
            &mut conn,
            &[
                pr(1, "octo/repo-a", 10, "Bump a"),
                pr(2, "octo/repo-a", 11, "Bump b"),
            ],
            true,
        )
        .unwrap();

        // An incomplete (capped/timed-out) search returns only #1 — #2 must NOT be dropped,
        // since it may simply have fallen outside the partial window.
        let out = store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "Bump a")], false).unwrap();
        assert_eq!(out.stored, 1);
        assert_eq!(out.removed, 0);
        assert_eq!(
            count(&conn).unwrap(),
            2,
            "no rows dropped from an incomplete search"
        );
    }

    #[test]
    fn upsert_updates_existing_row_in_place() {
        let mut conn = mem_conn();
        store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "Old title")], true).unwrap();
        let mut updated = pr(1, "octo/repo-a", 10, "New title");
        updated.updated_at = "2026-02-01T00:00:00Z".to_string();
        store_prs(&mut conn, &[updated], true).unwrap();

        assert_eq!(count(&conn).unwrap(), 1);
        let groups = list_by_repo(&conn).unwrap();
        assert_eq!(groups[0].prs[0].title, "New title");
    }

    #[test]
    fn newly_stored_prs_need_merge_state_then_are_cached() {
        let mut conn = mem_conn();
        store_prs(
            &mut conn,
            &[
                pr(1, "octo/repo-a", 10, "Bump a"),
                pr(2, "octo/repo-a", 11, "Bump b"),
            ],
            true,
        )
        .unwrap();

        // Both are unresolved → both pending.
        let pending = prs_needing_merge_state(&conn).unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(
            pending[0].pull_url,
            "https://api.github.com/repos/octo/repo-a/pulls/11"
        );

        // Resolve one to a real state → it drops out; the other remains pending.
        store_merge_state(
            &conn,
            1,
            &ResolvedSubject {
                mergeable_state: Some("clean".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        let pending = prs_needing_merge_state(&conn).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, 2);

        // The stored state surfaces in the view.
        let groups = list_by_repo(&conn).unwrap();
        let resolved = groups[0].prs.iter().find(|p| p.id == 1).unwrap();
        assert_eq!(resolved.mergeable_state.as_deref(), Some("clean"));
    }

    #[test]
    fn unknown_merge_state_stays_pending_for_retry() {
        let mut conn = mem_conn();
        store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "Bump a")], true).unwrap();
        store_merge_state(
            &conn,
            1,
            &ResolvedSubject {
                mergeable_state: Some("unknown".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        // Put resolved_at AFTER updated_at (so the "changed upstream" clause is false) but far
        // enough in the past that the one-minute retry floor for `unknown` has elapsed — so we
        // isolate the timer clause.
        conn.execute(
            "UPDATE dependabot_prs
             SET updated_at = '2000-01-01T00:00:00Z', resolved_at = '2000-01-02T00:00:00Z'
             WHERE id = 1",
            [],
        )
        .unwrap();

        assert_eq!(
            prs_needing_merge_state(&conn).unwrap().len(),
            1,
            "an unknown state is retried after a minute"
        );
    }

    #[test]
    fn null_merge_state_is_not_retried_on_the_timer() {
        let mut conn = mem_conn();
        store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "Bump a")], true).unwrap();
        // Resolving to nothing (an inaccessible PR / 404 → mergeable_state = None) stamps
        // resolved_at but must NOT be re-fetched on the one-minute timer (only when updated_at
        // advances). Same backdating as above, so the only difference is the NULL state.
        store_merge_state(&conn, 1, &ResolvedSubject::default()).unwrap();
        conn.execute(
            "UPDATE dependabot_prs
             SET updated_at = '2000-01-01T00:00:00Z', resolved_at = '2000-01-02T00:00:00Z'
             WHERE id = 1",
            [],
        )
        .unwrap();

        assert!(
            prs_needing_merge_state(&conn).unwrap().is_empty(),
            "a NULL merge state is not retried on the one-minute timer"
        );
    }
}
