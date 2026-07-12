//! Dependabot module data layer: persist the open Dependabot PRs and read them back grouped
//! by repository.
//!
//! Mirrors `sync.rs` for its own domain (see `docs/design.md` — SQLite is the source of
//! truth). The repo list (`dependabot_repos`) is fed from the notifications Helix fetches
//! (`sync::store_resolved_subject` records a repo once it has a Dependabot-authored
//! notification); `github::fetch_dependabot_prs_for_repos` then lists each repo's open
//! Dependabot PRs — no search API. `store_prs` upserts the current results and, when the fetch
//! was complete, reconciles away rows that disappeared upstream (a PR that merged/closed no
//! longer appears, so it's deleted). The module reads offline-first via `list_by_repo`; GitHub
//! is only contacted on a sync. Merge-readiness (`mergeable_state`) is resolved lazily per PR —
//! the PR list omits it — with the same smart-cache (`prs_needing_merge_state`) + rate-reserve
//! discipline used for notification subjects.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::github::{DependabotPr, ResolvedSubject};

/// Outcome of a store + reconcile pass (mirrors `sync::StoreOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreOutcome {
    /// PRs upserted from the latest fetch.
    pub stored: usize,
    /// Local PRs removed because they were no longer returned (merged/closed/inaccessible).
    pub removed: usize,
}

/// Upsert the Dependabot PRs from a fetch and (optionally) reconcile local state.
///
/// Existing rows are updated in place, but the resolution columns (`mergeable_state`,
/// `resolved_at`) are intentionally left untouched — they are populated separately by
/// `store_merge_state`. When `reconcile` is true (the fetch returned the **complete** result
/// set — see `DependabotFetchOutcome::complete`), any locally-stored PR absent from `prs` was
/// merged/closed (or became inaccessible) and is deleted, so the module never shows a stale
/// PR. When false (the enumeration stopped early on the quota reserve), removals are
/// **skipped** so we never drop a PR outside the partial window. Stale rows are identified by
/// the exact set of fetched ids (not a timestamp watermark) so reconciliation is correct even
/// for two syncs in one tick.
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

    // Reconcile: delete any local PR not present in this fetch — but only for a complete
    // fetch, so an incomplete/capped result never drops PRs outside its window.
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
    /// merge-readiness pill. Null until first resolved (the PR list endpoint omits it).
    pub mergeable_state: Option<String>,
    /// The locally queued merge request, if this PR has one. This is intentionally a compact
    /// summary so the offline PR list does not need a second IPC request to paint queue state.
    pub active_merge_operation: Option<ActiveMergeOperationSummary>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ActiveMergeOperationSummary {
    pub id: i64,
    pub state: String,
    pub queue_position: Option<i64>,
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
        "SELECT p.repo_full_name, p.id, p.number, p.title, p.html_url, p.author, p.updated_at,
                p.mergeable_state, o.id, o.state
         FROM dependabot_prs p
         LEFT JOIN dependabot_merge_operations o ON o.pr_id = p.id
             AND o.state IN ('queued', 'validating', 'delegated', 'cancel_requested')
         ORDER BY p.repo_full_name ASC, p.updated_at DESC, p.id ASC",
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
                active_merge_operation: match (
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                ) {
                    (Some(id), Some(state)) => Some(ActiveMergeOperationSummary {
                        id,
                        state,
                        queue_position: None,
                    }),
                    _ => None,
                },
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
    let positions = active_queue_positions(conn)?;
    for group in &mut groups {
        for pr in &mut group.prs {
            if let Some(summary) = &mut pr.active_merge_operation {
                summary.queue_position = positions.get(&summary.id).copied();
            }
        }
    }
    Ok(groups)
}

const ACTIVE_STATES: &str = "'queued', 'validating', 'delegated', 'cancel_requested'";

/// Durable operation returned by the merge-operation IPC. Snapshot fields never change after
/// enqueue; live GitHub observations are represented by the SHA and lifecycle fields.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DependabotMergeOperation {
    pub id: i64,
    pub pr_id: i64,
    pub repo_full_name: String,
    pub number: i64,
    pub title: String,
    pub html_url: String,
    pub pull_url: String,
    pub author: String,
    pub state: String,
    pub observed_head_sha: Option<String>,
    pub validated_head_sha: Option<String>,
    pub approved_head_sha: Option<String>,
    pub queue_position: Option<i64>,
    pub failure_reason: Option<String>,
    pub last_error: Option<String>,
    pub enqueued_at: String,
    pub delegated_at: Option<String>,
    pub terminal_at: Option<String>,
    /// Fine-grained progress within `state` (e.g. `"validating_commits"`, `"awaiting_checks"`,
    /// `"merging"`). Freeform — unlike `state`, it carries no CHECK constraint, so the
    /// processor's internal state machine can grow without another migration.
    pub phase: String,
    /// The merge approach resolved for this operation (e.g. `"native_squash"`,
    /// `"auto_merge"`), cached from `dependabot_merge_policies` once known.
    pub strategy: String,
    /// The PR's GraphQL node id, needed for GraphQL mutations (e.g. enabling native
    /// auto-merge). `None` until the processor first resolves it.
    pub pull_node_id: Option<String>,
    /// The PR's base branch. Branch-protection / merge-policy lookups are base-ref scoped.
    pub base_ref: Option<String>,
    /// When the processor should next revisit this operation (a scheduled retry/backoff).
    /// `None` means there is nothing pacing it away — see `is_next_action_due`.
    pub next_action_at: Option<String>,
    /// Consecutive check-run re-runs requested for the current head SHA.
    pub check_retry_count: i64,
    /// GitHub's native merge-queue position, when the repo uses a merge queue for this PR.
    pub merge_queue_position: Option<i64>,
    /// Whether Helix has enabled GitHub's native auto-merge for this PR.
    pub auto_merge_enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct DependabotMergeRuntime {
    pub last_tick_at: Option<String>,
    pub last_error: Option<String>,
    pub github_poll_floor_s: Option<i64>,
    pub backoff_until: Option<String>,
}

/// A compact active operation used by the processor. Kept separate from the IPC shape so it can
/// carry command/check timing fields without exposing implementation-only details.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeWork {
    pub operation: DependabotMergeOperation,
    pub update_branch_from_sha: Option<String>,
    pub last_checked_at: Option<String>,
    pub failure_code: Option<String>,
}

fn operation_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DependabotMergeOperation> {
    Ok(DependabotMergeOperation {
        id: r.get(0)?,
        pr_id: r.get(1)?,
        repo_full_name: r.get(2)?,
        number: r.get(3)?,
        title: r.get(4)?,
        html_url: r.get(5)?,
        pull_url: r.get(6)?,
        author: r.get(7)?,
        state: r.get(8)?,
        observed_head_sha: r.get(9)?,
        validated_head_sha: r.get(10)?,
        approved_head_sha: r.get(11)?,
        queue_position: None,
        failure_reason: r.get(12)?,
        last_error: r.get(13)?,
        enqueued_at: r.get(14)?,
        delegated_at: r.get(15)?,
        terminal_at: r.get(16)?,
        phase: r.get(17)?,
        strategy: r.get(18)?,
        pull_node_id: r.get(19)?,
        base_ref: r.get(20)?,
        next_action_at: r.get(21)?,
        check_retry_count: r.get(22)?,
        merge_queue_position: r.get(23)?,
        auto_merge_enabled: r.get(24)?,
    })
}

const OPERATION_COLUMNS: &str = "id, pr_id, repo_full_name, number, title, html_url, pull_url,
    author, state, observed_head_sha, validated_head_sha, approved_head_sha, failure_reason,
    last_error, enqueued_at, delegated_at, terminal_at, phase, strategy, pull_node_id, base_ref,
    next_action_at, check_retry_count, merge_queue_position, auto_merge_enabled";

fn active_queue_positions(
    conn: &Connection,
) -> rusqlite::Result<std::collections::HashMap<i64, i64>> {
    let mut stmt = conn.prepare(
        "SELECT o.id,
                (SELECT COUNT(*) FROM dependabot_merge_operations earlier
                 WHERE earlier.repo_full_name = o.repo_full_name
                   AND earlier.state IN ('queued', 'validating', 'delegated', 'cancel_requested')
                   AND (earlier.enqueued_at < o.enqueued_at
                        OR (earlier.enqueued_at = o.enqueued_at AND earlier.id <= o.id)))
         FROM dependabot_merge_operations o
         WHERE o.state IN ('queued', 'validating', 'delegated', 'cancel_requested')",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Enqueue a cached Dependabot PR. The active-per-PR index makes this idempotent even when two
/// IPC calls race; returning the existing active row is more useful than surfacing a constraint.
pub fn enqueue_merge_operation(
    conn: &Connection,
    pr_id: i64,
) -> rusqlite::Result<DependabotMergeOperation> {
    let cached: Option<(String, i64, String, String, String, String)> = conn
        .query_row(
            "SELECT repo_full_name, number, title, html_url, pull_url, author
             FROM dependabot_prs WHERE id = ?1",
            [pr_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()?;
    let Some((repo, number, title, html_url, pull_url, author)) = cached else {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    };
    if let Some(existing) = get_active_operation_for_pr(conn, pr_id)? {
        return Ok(existing);
    }
    // The insert and its initial queued event are written in one transaction, so a crash or a
    // racing reader never observes an operation without the audit trail's opening entry.
    let tx = conn.unchecked_transaction()?;
    let inserted = tx.execute(
        "INSERT INTO dependabot_merge_operations
             (pr_id, repo_full_name, number, title, html_url, pull_url, author, state, enqueued_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', strftime('%Y-%m-%dT%H:%M:%SZ','now'))",
        params![pr_id, repo, number, title, html_url, pull_url, author],
    );
    if let Err(error) = inserted {
        drop(tx);
        // The partial unique index is the final arbiter if a second process races this enqueue.
        // Return its active row rather than exposing an implementation-detail constraint error.
        if let Some(existing) = get_active_operation_for_pr(conn, pr_id)? {
            return Ok(existing);
        }
        return Err(error);
    }
    let id = tx.last_insert_rowid();
    append_operation_event(
        &tx,
        id,
        "queued",
        "lifecycle",
        "queued",
        "Enqueued for automatic merge.",
        None,
        None,
        None,
    )?;
    tx.commit()?;
    operation_with_queue_position(conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn get_operation(
    conn: &Connection,
    id: i64,
) -> rusqlite::Result<Option<DependabotMergeOperation>> {
    let sql = format!("SELECT {OPERATION_COLUMNS} FROM dependabot_merge_operations WHERE id = ?1");
    conn.query_row(&sql, [id], operation_from_row).optional()
}

fn operation_with_queue_position(
    conn: &Connection,
    id: i64,
) -> rusqlite::Result<Option<DependabotMergeOperation>> {
    let mut operation = get_operation(conn, id)?;
    if let Some(operation) = &mut operation {
        operation.queue_position = active_queue_positions(conn)?.get(&id).copied();
    }
    Ok(operation)
}

fn get_active_operation_for_pr(
    conn: &Connection,
    pr_id: i64,
) -> rusqlite::Result<Option<DependabotMergeOperation>> {
    let sql = format!(
        "SELECT {OPERATION_COLUMNS} FROM dependabot_merge_operations
         WHERE pr_id = ?1 AND state IN ({ACTIVE_STATES}) ORDER BY id DESC LIMIT 1"
    );
    conn.query_row(&sql, [pr_id], operation_from_row).optional()
}

/// Active rows are first (repo FIFO), followed by the most recent terminal rows. Terminal
/// retention is enforced whenever a row becomes terminal.
pub fn list_merge_operations(conn: &Connection) -> rusqlite::Result<Vec<DependabotMergeOperation>> {
    let sql = format!(
        "SELECT {OPERATION_COLUMNS} FROM dependabot_merge_operations
         ORDER BY CASE WHEN state IN ({ACTIVE_STATES}) THEN 0 ELSE 1 END,
                  CASE WHEN state IN ({ACTIVE_STATES}) THEN enqueued_at END ASC,
                  CASE WHEN state IN ({ACTIVE_STATES}) THEN id END ASC,
                  terminal_at DESC, id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut operations: Vec<_> = stmt
        .query_map([], operation_from_row)?
        .collect::<Result<_, _>>()?;
    let positions = active_queue_positions(conn)?;
    for operation in &mut operations {
        operation.queue_position = positions.get(&operation.id).copied();
    }
    Ok(operations)
}

/// The oldest active request for each repository is the only row that may make progress in a
/// tick. A retry/backoff remains the head and intentionally blocks later requests in that repo.
pub fn merge_operation_heads(conn: &Connection) -> rusqlite::Result<Vec<MergeWork>> {
    let sql = format!(
        "SELECT {OPERATION_COLUMNS}, update_branch_from_sha, last_checked_at, failure_code
         FROM dependabot_merge_operations o
         WHERE o.state IN ({ACTIVE_STATES})
           AND NOT EXISTS (
               SELECT 1 FROM dependabot_merge_operations earlier
               WHERE earlier.repo_full_name = o.repo_full_name
                 AND earlier.state IN ({ACTIVE_STATES})
                 AND (earlier.enqueued_at < o.enqueued_at
                      OR (earlier.enqueued_at = o.enqueued_at AND earlier.id < o.id)))
         ORDER BY o.repo_full_name, o.enqueued_at, o.id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        let operation = operation_from_row(r)?;
        Ok(MergeWork {
            operation,
            update_branch_from_sha: r.get(25)?,
            last_checked_at: r.get(26)?,
            failure_code: r.get(27)?,
        })
    })?;
    rows.collect()
}

pub fn request_cancel(
    conn: &Connection,
    id: i64,
) -> rusqlite::Result<Option<DependabotMergeOperation>> {
    let Some(operation) = get_operation(conn, id)? else {
        return Ok(None);
    };
    match operation.state.as_str() {
        "queued" => terminalize(
            conn,
            id,
            "cancelled",
            None,
            Some("Cancelled before validation."),
            None,
        )?,
        "validating" | "delegated" => {
            let updated = conn.execute(
                "UPDATE dependabot_merge_operations
                 SET state = 'cancel_requested',
                     failure_reason = 'Stopping before the next GitHub mutation.',
                     last_action_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                 WHERE id = ?1 AND state IN ('validating', 'delegated')",
                [id],
            )?;
            if updated > 0 {
                append_operation_event(
                    conn,
                    id,
                    "cancel_requested",
                    "lifecycle",
                    "cancel_requested",
                    "Cancellation requested; stopping before the next GitHub mutation.",
                    None,
                    None,
                    None,
                )?;
            }
        }
        "cancel_requested" => {}
        _ => {}
    }
    operation_with_queue_position(conn, id)
}

pub fn merge_runtime(conn: &Connection) -> rusqlite::Result<DependabotMergeRuntime> {
    conn.query_row(
        "SELECT last_tick_at, last_error, github_poll_floor_s, backoff_until
         FROM dependabot_merge_runtime WHERE id = 1",
        [],
        |r| {
            Ok(DependabotMergeRuntime {
                last_tick_at: r.get(0)?,
                last_error: r.get(1)?,
                github_poll_floor_s: r.get(2)?,
                backoff_until: r.get(3)?,
            })
        },
    )
}

pub fn record_merge_tick(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_merge_runtime
         SET last_tick_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1",
        [],
    )?;
    Ok(())
}

pub fn runtime_is_backing_off(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT backoff_until IS NOT NULL
             AND backoff_until > strftime('%Y-%m-%dT%H:%M:%SZ','now')
         FROM dependabot_merge_runtime WHERE id = 1",
        [],
        |r| r.get(0),
    )
}

pub fn record_merge_runtime_error(
    conn: &Connection,
    error: &str,
    poll_floor_s: Option<i64>,
    backoff_s: Option<i64>,
) -> rusqlite::Result<()> {
    let floor = poll_floor_s.filter(|v| *v > 0);
    let backoff = backoff_s.filter(|v| *v > 0);
    conn.execute(
        "UPDATE dependabot_merge_runtime
         SET last_error = ?1,
             github_poll_floor_s = ?2,
             backoff_until = CASE WHEN ?3 IS NULL THEN backoff_until
                 ELSE strftime('%Y-%m-%dT%H:%M:%SZ','now', '+' || ?3 || ' seconds') END
         WHERE id = 1",
        params![error, floor, backoff],
    )?;
    Ok(())
}

pub fn clear_merge_runtime_error(
    conn: &Connection,
    poll_floor_s: Option<i64>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_merge_runtime
         SET last_error = NULL, github_poll_floor_s = ?1,
             backoff_until = CASE WHEN backoff_until <= strftime('%Y-%m-%dT%H:%M:%SZ','now')
                                  THEN NULL ELSE backoff_until END
         WHERE id = 1",
        [poll_floor_s],
    )?;
    Ok(())
}

pub fn record_observation(
    conn: &Connection,
    id: i64,
    head_sha: Option<&str>,
    validated: bool,
    approved: bool,
    state: &str,
    reason: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_merge_operations
         SET state = ?2, observed_head_sha = ?3,
             validated_head_sha = CASE WHEN ?4 THEN ?3 ELSE validated_head_sha END,
             approved_head_sha = CASE WHEN ?5 THEN ?3 ELSE approved_head_sha END,
             last_checked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             failure_reason = ?6, last_error = NULL
         WHERE id = ?1",
        params![id, state, head_sha, validated, approved, reason],
    )?;
    Ok(())
}

pub fn begin_merge_processing(conn: &Connection, id: i64) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "UPDATE dependabot_merge_operations
         SET state = CASE WHEN state = 'queued' THEN 'validating' ELSE state END,
             delegated_at = COALESCE(delegated_at, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         WHERE id = ?1
           AND state IN ('queued', 'validating', 'delegated', 'cancel_requested')",
        [id],
    )? > 0)
}

pub fn merge_cancel_requested(conn: &Connection, id: i64) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT state IN ('cancel_requested', 'cancelled')
             FROM dependabot_merge_operations WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap_or(true))
}

pub fn mark_merge_progress(
    conn: &Connection,
    id: i64,
    head_sha: &str,
    approved: bool,
    branch_update_requested: bool,
    reason: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_merge_operations
         SET state = 'delegated', observed_head_sha = ?2, validated_head_sha = ?2,
             approved_head_sha = CASE WHEN ?3 THEN ?2 ELSE approved_head_sha END,
             delegated_at = COALESCE(delegated_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
             last_checked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             last_action_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             update_branch_from_sha = CASE WHEN ?4 THEN ?2 ELSE NULL END,
             failure_code = NULL, failure_reason = ?5, last_error = NULL
         WHERE id = ?1",
        params![id, head_sha, approved, branch_update_requested, reason],
    )?;
    Ok(())
}

pub fn mark_cancelled_or_timed_out(
    conn: &Connection,
    id: i64,
    timed_out: bool,
) -> rusqlite::Result<()> {
    if timed_out {
        terminalize(
            conn,
            id,
            "timed_out",
            Some("timeout"),
            Some("Helix merge operation timed out after 90 minutes."),
            None,
        )?;
    } else {
        terminalize(conn, id, "cancelled", None, Some("Cancelled."), None)?;
    }
    Ok(())
}

pub fn terminalize(
    conn: &Connection,
    id: i64,
    state: &str,
    failure_code: Option<&str>,
    failure_reason: Option<&str>,
    last_error: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_merge_operations
         SET state = ?2, failure_code = ?3, failure_reason = ?4, last_error = ?5,
             terminal_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             last_checked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?1",
        params![id, state, failure_code, failure_reason, last_error],
    )?;
    // Recorded via the idempotent append below, so a repeated terminalize call for the same
    // state/reason (e.g. a duplicate timeout sweep) narrates once rather than spamming the
    // audit trail.
    append_operation_event(
        conn,
        id,
        state,
        "lifecycle",
        state,
        &terminal_event_summary(state, failure_reason),
        failure_reason,
        None,
        None,
    )?;
    // Keep all active rows plus only the newest 100 terminal rows.
    conn.execute(
        "DELETE FROM dependabot_merge_operations
         WHERE state IN ('merged', 'cancelled', 'failed', 'timed_out')
           AND id NOT IN (
               SELECT id FROM dependabot_merge_operations
               WHERE state IN ('merged', 'cancelled', 'failed', 'timed_out')
               ORDER BY terminal_at DESC, id DESC LIMIT 100
           )",
        [],
    )?;
    Ok(())
}

/// Human-readable narration for a terminal-state event (see `terminalize`).
fn terminal_event_summary(state: &str, failure_reason: Option<&str>) -> String {
    match state {
        "merged" => "Merged.".to_string(),
        "cancelled" => "Cancelled.".to_string(),
        "timed_out" => "Timed out.".to_string(),
        "failed" => failure_reason
            .map(|reason| format!("Failed: {reason}"))
            .unwrap_or_else(|| "Failed.".to_string()),
        other => format!("Reached terminal state {other}."),
    }
}

pub fn record_merge_error(
    conn: &Connection,
    id: i64,
    code: &str,
    reason: &str,
    terminal: bool,
) -> rusqlite::Result<()> {
    if terminal {
        return terminalize(conn, id, "failed", Some(code), Some(reason), Some(reason));
    }
    conn.execute(
        "UPDATE dependabot_merge_operations
         SET failure_code = ?2, failure_reason = ?3, last_error = ?3,
             last_checked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?1",
        params![id, code, reason],
    )?;
    Ok(())
}

pub fn merge_processing_timed_out(conn: &Connection, id: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT state IN ('validating', 'delegated') AND delegated_at <=
                strftime('%Y-%m-%dT%H:%M:%SZ','now','-90 minutes')
         FROM dependabot_merge_operations WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
}

/// Whether so little of the 90-minute processing deadline remains that a fresh retry scheduled
/// for a few minutes out could never fire before the operation times out. `cushion_minutes` is
/// the headroom a newly scheduled action needs; the deadline is treated as exhausted once
/// `delegated_at` is older than `90 - cushion_minutes`. Used by the orchestrator to satisfy
/// "evaluate the 90-minute deadline before scheduling/dispatch" without scheduling work that
/// the timeout would immediately supersede.
pub fn merge_deadline_exhausted(
    conn: &Connection,
    id: i64,
    cushion_minutes: i64,
) -> rusqlite::Result<bool> {
    let window = format!("-{} minutes", (90 - cushion_minutes).max(0));
    conn.query_row(
        "SELECT delegated_at IS NOT NULL
             AND delegated_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now', ?2)
         FROM dependabot_merge_operations WHERE id = ?1",
        params![id, window],
        |r| r.get(0),
    )
}

// ---------------------------------------------------------------------------------------------
// Phase 2 durable persistence: per-operation narration events, check-run retry scheduling, and
// a cached merge policy per repo + base branch. These are additive to the `state` machine above
// — `phase`/`strategy` on `DependabotMergeOperation` are freeform progress/approach markers the
// orchestrator narrates through the functions below; nothing here changes `state` semantics.
// ---------------------------------------------------------------------------------------------

/// One entry in an operation's append-only narration/audit trail.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MergeOperationEvent {
    pub id: i64,
    pub operation_id: i64,
    pub phase: String,
    pub kind: String,
    pub status: String,
    pub summary: String,
    pub detail: Option<String>,
    pub head_sha: Option<String>,
    pub external_id: Option<String>,
    pub created_at: String,
}

fn merge_operation_event_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MergeOperationEvent> {
    Ok(MergeOperationEvent {
        id: r.get(0)?,
        operation_id: r.get(1)?,
        phase: r.get(2)?,
        kind: r.get(3)?,
        status: r.get(4)?,
        summary: r.get(5)?,
        detail: r.get(6)?,
        head_sha: r.get(7)?,
        external_id: r.get(8)?,
        created_at: r.get(9)?,
    })
}

const EVENT_COLUMNS: &str =
    "id, operation_id, phase, kind, status, summary, detail, head_sha, external_id, created_at";

/// Append a narration event for an operation, unless it would be an exact repeat of the most
/// recent event recorded for that operation (same `phase`/`kind`/`status`/`summary`/`detail`/
/// `head_sha`/`external_id`). The orchestrator narrates progress on every tick, so without this
/// the audit trail would otherwise grow unboundedly for a long-running or slow-to-progress
/// operation without conveying any new information.
#[allow(clippy::too_many_arguments)]
pub fn append_operation_event(
    conn: &Connection,
    operation_id: i64,
    phase: &str,
    kind: &str,
    status: &str,
    summary: &str,
    detail: Option<&str>,
    head_sha: Option<&str>,
    external_id: Option<&str>,
) -> rusqlite::Result<()> {
    let duplicate: bool = conn
        .query_row(
            "SELECT phase = ?2 AND kind = ?3 AND status = ?4 AND summary = ?5
                    AND detail IS ?6 AND head_sha IS ?7 AND external_id IS ?8
             FROM dependabot_merge_operation_events
             WHERE operation_id = ?1
             ORDER BY id DESC LIMIT 1",
            params![
                operation_id,
                phase,
                kind,
                status,
                summary,
                detail,
                head_sha,
                external_id
            ],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false);
    if duplicate {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO dependabot_merge_operation_events
             (operation_id, phase, kind, status, summary, detail, head_sha, external_id,
              created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%Y-%m-%dT%H:%M:%SZ','now'))",
        params![
            operation_id,
            phase,
            kind,
            status,
            summary,
            detail,
            head_sha,
            external_id
        ],
    )?;
    Ok(())
}

/// All events for an operation, oldest first.
pub fn list_operation_events(
    conn: &Connection,
    operation_id: i64,
) -> rusqlite::Result<Vec<MergeOperationEvent>> {
    let sql =
        format!("SELECT {EVENT_COLUMNS} FROM dependabot_merge_operation_events WHERE operation_id = ?1 ORDER BY id ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([operation_id], merge_operation_event_from_row)?;
    rows.collect()
}

/// An operation plus its full narration trail, for the operation-detail IPC view.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MergeOperationDetail {
    pub operation: DependabotMergeOperation,
    pub events: Vec<MergeOperationEvent>,
}

/// Fetch one operation (with queue position filled in) plus its event history.
pub fn get_operation_detail(
    conn: &Connection,
    id: i64,
) -> rusqlite::Result<Option<MergeOperationDetail>> {
    let Some(operation) = operation_with_queue_position(conn, id)? else {
        return Ok(None);
    };
    let events = list_operation_events(conn, id)?;
    Ok(Some(MergeOperationDetail { operation, events }))
}

/// Update the operation's fine-grained `phase` and, when given, its resolved `strategy` and
/// GitHub identity metadata (`pull_node_id`, `base_ref`) discovered along the way. `None` for
/// `strategy`/`pull_node_id`/`base_ref` leaves the existing value untouched, so callers can
/// narrate incremental progress without re-supplying metadata they haven't (re)resolved.
pub fn set_phase(
    conn: &Connection,
    id: i64,
    phase: &str,
    strategy: Option<&str>,
    pull_node_id: Option<&str>,
    base_ref: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_merge_operations
         SET phase = ?2,
             strategy = COALESCE(?3, strategy),
             pull_node_id = COALESCE(?4, pull_node_id),
             base_ref = COALESCE(?5, base_ref)
         WHERE id = ?1",
        params![id, phase, strategy, pull_node_id, base_ref],
    )?;
    Ok(())
}

/// Persist GitHub's native merge-queue position (`None` clears it, e.g. the PR left the queue)
/// and whether native auto-merge has been enabled for this PR.
pub fn set_queue_metadata(
    conn: &Connection,
    id: i64,
    merge_queue_position: Option<i64>,
    auto_merge_enabled: bool,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_merge_operations
         SET merge_queue_position = ?2, auto_merge_enabled = ?3
         WHERE id = ?1",
        params![id, merge_queue_position, auto_merge_enabled],
    )?;
    Ok(())
}

/// Schedule (or, with `None`, clear) when the processor should next revisit this operation —
/// e.g. a backoff after a transient failure or a check-run poll delay.
pub fn schedule_next_action(
    conn: &Connection,
    id: i64,
    next_action_at: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_merge_operations SET next_action_at = ?2 WHERE id = ?1",
        params![id, next_action_at],
    )?;
    Ok(())
}

/// Schedule the operation's next action `delay_seconds` from now, computed in SQLite so it
/// shares the same clock as [`is_next_action_due`]. Used for paced retries/backoffs (e.g. the
/// five-minute Actions re-run delay) without threading a formatted timestamp through Rust.
pub fn schedule_next_action_in(
    conn: &Connection,
    id: i64,
    delay_seconds: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_merge_operations
         SET next_action_at = strftime('%Y-%m-%dT%H:%M:%SZ','now', '+' || ?2 || ' seconds')
         WHERE id = ?1",
        params![id, delay_seconds],
    )?;
    Ok(())
}

/// Whether this operation's scheduled next action is due. An unscheduled operation
/// (`next_action_at IS NULL`) counts as due — there is nothing pacing the processor away from
/// it — otherwise it becomes due once the timestamp has passed.
pub fn is_next_action_due(conn: &Connection, id: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT next_action_at IS NULL OR next_action_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')
         FROM dependabot_merge_operations WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
}

/// A scheduled re-run of a failed workflow run for a given head SHA.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MergeCheckRetry {
    pub id: i64,
    pub operation_id: i64,
    pub head_sha: String,
    pub workflow_run_id: i64,
    pub run_attempt: i64,
    pub scheduled_at: String,
    pub requested_at: Option<String>,
    pub outcome: Option<String>,
}

fn check_retry_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MergeCheckRetry> {
    Ok(MergeCheckRetry {
        id: r.get(0)?,
        operation_id: r.get(1)?,
        head_sha: r.get(2)?,
        workflow_run_id: r.get(3)?,
        run_attempt: r.get(4)?,
        scheduled_at: r.get(5)?,
        requested_at: r.get(6)?,
        outcome: r.get(7)?,
    })
}

const CHECK_RETRY_COLUMNS: &str = "id, operation_id, head_sha, workflow_run_id, run_attempt,
    scheduled_at, requested_at, outcome";

/// Schedule a re-run for a failed workflow run on the operation's current head SHA. Idempotent
/// on `(operation_id, head_sha, workflow_run_id, run_attempt)`: a repeated call for the same
/// failed run returns the already-scheduled row rather than inserting a duplicate. The first
/// time a given run is scheduled, the operation's `check_retry_count` is also incremented, so a
/// retry budget can be enforced from the operation row alone.
pub fn schedule_check_retry(
    conn: &Connection,
    operation_id: i64,
    head_sha: &str,
    workflow_run_id: i64,
    run_attempt: i64,
) -> rusqlite::Result<MergeCheckRetry> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO dependabot_merge_check_retries
             (operation_id, head_sha, workflow_run_id, run_attempt, scheduled_at)
         VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%SZ','now'))",
        params![operation_id, head_sha, workflow_run_id, run_attempt],
    )?;
    if inserted > 0 {
        conn.execute(
            "UPDATE dependabot_merge_operations
             SET check_retry_count = check_retry_count + 1 WHERE id = ?1",
            [operation_id],
        )?;
    }
    let sql = format!(
        "SELECT {CHECK_RETRY_COLUMNS} FROM dependabot_merge_check_retries
         WHERE operation_id = ?1 AND head_sha = ?2 AND workflow_run_id = ?3 AND run_attempt = ?4"
    );
    conn.query_row(
        &sql,
        params![operation_id, head_sha, workflow_run_id, run_attempt],
        check_retry_from_row,
    )
}

/// Retries scheduled for an operation, most recently scheduled first.
pub fn list_check_retries(
    conn: &Connection,
    operation_id: i64,
) -> rusqlite::Result<Vec<MergeCheckRetry>> {
    let sql = format!(
        "SELECT {CHECK_RETRY_COLUMNS} FROM dependabot_merge_check_retries
         WHERE operation_id = ?1 ORDER BY id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([operation_id], check_retry_from_row)?;
    rows.collect()
}

/// Mark a scheduled retry as dispatched to GitHub (or record its terminal outcome), stamping
/// `requested_at` the first time this is called for the row (subsequent calls, e.g. to update
/// the outcome once known, leave the original dispatch time untouched).
pub fn mark_check_retry(conn: &Connection, id: i64, outcome: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_merge_check_retries
         SET requested_at = COALESCE(requested_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
             outcome = ?2
         WHERE id = ?1",
        params![id, outcome],
    )?;
    Ok(())
}

/// The merge strategy resolved for a repo + base branch (branch protection is base-ref scoped).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MergePolicy {
    pub repo_full_name: String,
    pub base_ref: String,
    pub strategy: String,
    pub checked_at: String,
}

/// Cache the resolved merge strategy for a repo + base branch (upsert).
pub fn cache_merge_policy(
    conn: &Connection,
    repo_full_name: &str,
    base_ref: &str,
    strategy: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO dependabot_merge_policies (repo_full_name, base_ref, strategy, checked_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(repo_full_name, base_ref) DO UPDATE SET
             strategy = excluded.strategy, checked_at = excluded.checked_at",
        params![repo_full_name, base_ref, strategy],
    )?;
    Ok(())
}

/// Look up the cached policy for a repo + base branch. When `max_age_s` is given, a cached row
/// older than that many seconds is treated as absent (stale) so the caller re-derives it;
/// `None` accepts any cached row regardless of age.
pub fn get_merge_policy(
    conn: &Connection,
    repo_full_name: &str,
    base_ref: &str,
    max_age_s: Option<i64>,
) -> rusqlite::Result<Option<MergePolicy>> {
    conn.query_row(
        "SELECT repo_full_name, base_ref, strategy, checked_at
         FROM dependabot_merge_policies
         WHERE repo_full_name = ?1 AND base_ref = ?2
           AND (?3 IS NULL
                OR checked_at > strftime('%Y-%m-%dT%H:%M:%SZ','now', '-' || ?3 || ' seconds'))",
        params![repo_full_name, base_ref, max_age_s],
        |r| {
            Ok(MergePolicy {
                repo_full_name: r.get(0)?,
                base_ref: r.get(1)?,
                strategy: r.get(2)?,
                checked_at: r.get(3)?,
            })
        },
    )
    .optional()
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
/// other resolved fields (number, author, html_url) already come from the PR list result.
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

/// Consecutive access failures (404 / non-rate 403) after which a repo is dropped from the
/// list — it has become inaccessible (renamed, deleted, or access revoked), so we stop
/// scanning it. Reset to 0 on any successful fetch.
pub const REPO_DROP_THRESHOLD: i64 = 3;

/// A repository to scan for open Dependabot PRs (from `dependabot_repos`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependabotRepo {
    pub full_name: String,
    pub owner: String,
    pub name: String,
}

/// Record a repository seen in a notification fetch, so the Dependabot module can scan it for
/// open Dependabot PRs. Idempotent (`INSERT OR IGNORE`) — an existing row (and its
/// `fail_count`) is left untouched. Called from `sync::store_notifications`.
pub fn observe_repo(
    conn: &Connection,
    full_name: &str,
    owner: &str,
    name: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO dependabot_repos (repo_full_name, owner, name, added_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ','now'))",
        params![full_name, owner, name],
    )?;
    Ok(())
}

/// The repositories to scan, ordered by full name for a stable pass.
pub fn list_repos(conn: &Connection) -> rusqlite::Result<Vec<DependabotRepo>> {
    let mut stmt = conn.prepare(
        "SELECT repo_full_name, owner, name FROM dependabot_repos ORDER BY repo_full_name ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(DependabotRepo {
            full_name: r.get(0)?,
            owner: r.get(1)?,
            name: r.get(2)?,
        })
    })?;
    rows.collect()
}

/// Mark a repo's scan as successful: reset its failure counter and stamp `last_synced_at`.
pub fn record_repo_success(conn: &Connection, full_name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dependabot_repos
         SET fail_count = 0, last_synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE repo_full_name = ?1",
        params![full_name],
    )?;
    Ok(())
}

/// Record an access failure for a repo and report whether it has now failed enough consecutive
/// times to be dropped (see `REPO_DROP_THRESHOLD`).
pub fn record_repo_failure(conn: &Connection, full_name: &str) -> rusqlite::Result<bool> {
    conn.execute(
        "UPDATE dependabot_repos SET fail_count = fail_count + 1 WHERE repo_full_name = ?1",
        params![full_name],
    )?;
    let count: i64 = conn
        .query_row(
            "SELECT fail_count FROM dependabot_repos WHERE repo_full_name = ?1",
            params![full_name],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    Ok(count >= REPO_DROP_THRESHOLD)
}

/// Drop a repo from the scan list and delete its cached PRs (it's become inaccessible).
pub fn drop_repo(conn: &Connection, full_name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM dependabot_prs WHERE repo_full_name = ?1",
        params![full_name],
    )?;
    conn.execute(
        "DELETE FROM dependabot_repos WHERE repo_full_name = ?1",
        params![full_name],
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
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
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

        // Second (complete) fetch returns only #1 (say #2 was merged) plus a new #3.
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
    fn observe_repo_is_idempotent_and_list_repos_is_sorted() {
        let conn = mem_conn();
        observe_repo(&conn, "octo/repo-b", "octo", "repo-b").unwrap();
        observe_repo(&conn, "octo/repo-a", "octo", "repo-a").unwrap();
        // A second observe of an existing repo is a no-op (doesn't reset state).
        record_repo_failure(&conn, "octo/repo-a").unwrap();
        observe_repo(&conn, "octo/repo-a", "octo", "repo-a").unwrap();

        let repos: Vec<String> = list_repos(&conn)
            .unwrap()
            .into_iter()
            .map(|r| r.full_name)
            .collect();
        assert_eq!(repos, vec!["octo/repo-a", "octo/repo-b"]);
        // The failure count survived the re-observe.
        let fc: i64 = conn
            .query_row(
                "SELECT fail_count FROM dependabot_repos WHERE repo_full_name = 'octo/repo-a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fc, 1);
    }

    #[test]
    fn repo_failures_drop_at_threshold_and_success_resets() {
        let conn = mem_conn();
        observe_repo(&conn, "octo/repo-a", "octo", "repo-a").unwrap();

        // Below the threshold → not dropped.
        for _ in 0..(REPO_DROP_THRESHOLD - 1) {
            assert!(!record_repo_failure(&conn, "octo/repo-a").unwrap());
        }
        // A success resets the counter, so it takes the full threshold again to drop.
        record_repo_success(&conn, "octo/repo-a").unwrap();
        for _ in 0..(REPO_DROP_THRESHOLD - 1) {
            assert!(!record_repo_failure(&conn, "octo/repo-a").unwrap());
        }
        // The threshold-th consecutive failure signals a drop.
        assert!(record_repo_failure(&conn, "octo/repo-a").unwrap());
    }

    #[test]
    fn drop_repo_removes_the_repo_and_its_prs() {
        let mut conn = mem_conn();
        observe_repo(&conn, "octo/repo-a", "octo", "repo-a").unwrap();
        observe_repo(&conn, "octo/repo-b", "octo", "repo-b").unwrap();
        store_prs(
            &mut conn,
            &[
                pr(1, "octo/repo-a", 10, "Bump a"),
                pr(2, "octo/repo-b", 11, "Bump b"),
            ],
            true,
        )
        .unwrap();

        drop_repo(&conn, "octo/repo-a").unwrap();

        let repos: Vec<String> = list_repos(&conn)
            .unwrap()
            .into_iter()
            .map(|r| r.full_name)
            .collect();
        assert_eq!(repos, vec!["octo/repo-b"]);
        // repo-a's PR is gone; repo-b's remains.
        let ids: Vec<i64> = list_by_repo(&conn)
            .unwrap()
            .into_iter()
            .flat_map(|g| g.prs.into_iter().map(|p| p.id))
            .collect();
        assert_eq!(ids, vec![2]);
    }

    #[test]
    fn incomplete_fetch_upserts_without_reconciling() {
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

        // An incomplete (capped/timed-out) fetch returns only #1 — #2 must NOT be dropped,
        // since it may simply have fallen outside the partial window.
        let out = store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "Bump a")], false).unwrap();
        assert_eq!(out.stored, 1);
        assert_eq!(out.removed, 0);
        assert_eq!(
            count(&conn).unwrap(),
            2,
            "no rows dropped from an incomplete fetch"
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

    #[test]
    fn merge_operations_are_idempotent_fifo_and_surface_on_prs() {
        let mut conn = mem_conn();
        store_prs(
            &mut conn,
            &[
                pr(1, "octo/repo-a", 10, "First"),
                pr(2, "octo/repo-a", 11, "Second"),
                pr(3, "octo/repo-b", 12, "Independent"),
            ],
            true,
        )
        .unwrap();

        let first = enqueue_merge_operation(&conn, 1).unwrap();
        let first_again = enqueue_merge_operation(&conn, 1).unwrap();
        let second = enqueue_merge_operation(&conn, 2).unwrap();
        let other_repo = enqueue_merge_operation(&conn, 3).unwrap();
        assert_eq!(first.id, first_again.id, "active enqueue is idempotent");

        let heads = merge_operation_heads(&conn).unwrap();
        assert_eq!(heads.len(), 2, "one FIFO head per repository");
        assert!(heads.iter().any(|head| head.operation.id == first.id));
        assert!(heads.iter().any(|head| head.operation.id == other_repo.id));

        let operations = list_merge_operations(&conn).unwrap();
        assert_eq!(
            operations
                .iter()
                .find(|operation| operation.id == first.id)
                .unwrap()
                .queue_position,
            Some(1)
        );
        assert_eq!(
            operations
                .iter()
                .find(|operation| operation.id == second.id)
                .unwrap()
                .queue_position,
            Some(2)
        );
        let groups = list_by_repo(&conn).unwrap();
        let first_view = groups[0].prs.iter().find(|view| view.id == 1).unwrap();
        assert_eq!(
            first_view
                .active_merge_operation
                .as_ref()
                .map(|operation| operation.id),
            Some(first.id)
        );
    }

    #[test]
    fn queued_cancel_is_local_and_terminal_history_is_bounded() {
        let mut conn = mem_conn();
        let prs: Vec<_> = (1..=102)
            .map(|id| pr(id, "octo/repo-a", id, &format!("Bump {id}")))
            .collect();
        store_prs(&mut conn, &prs, true).unwrap();
        for id in 1..=102 {
            let operation = enqueue_merge_operation(&conn, id).unwrap();
            request_cancel(&conn, operation.id).unwrap();
        }
        let terminal: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM dependabot_merge_operations
                 WHERE state IN ('merged', 'cancelled', 'failed', 'timed_out')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(terminal, 100);
        assert_eq!(merge_operation_heads(&conn).unwrap().len(), 0);
    }

    #[test]
    fn active_native_merge_cancellation_releases_fifo_after_processor_ack() {
        let mut conn = mem_conn();
        store_prs(
            &mut conn,
            &[
                pr(1, "octo/repo-a", 10, "First"),
                pr(2, "octo/repo-a", 11, "Second"),
            ],
            true,
        )
        .unwrap();
        let first = enqueue_merge_operation(&conn, 1).unwrap();
        let second = enqueue_merge_operation(&conn, 2).unwrap();
        mark_merge_progress(&conn, first.id, "head-sha", true, false, None).unwrap();

        let cancelling = request_cancel(&conn, first.id).unwrap().unwrap();
        assert_eq!(cancelling.state, "cancel_requested");
        assert!(cancelling.terminal_at.is_none());
        mark_cancelled_or_timed_out(&conn, first.id, false).unwrap();
        assert_eq!(
            merge_operation_heads(&conn)
                .unwrap()
                .first()
                .map(|head| head.operation.id),
            Some(second.id)
        );
    }

    #[test]
    fn validation_phase_is_covered_by_the_operation_timeout() {
        let mut conn = mem_conn();
        store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "First")], true).unwrap();
        let operation = enqueue_merge_operation(&conn, 1).unwrap();
        assert!(begin_merge_processing(&conn, operation.id).unwrap());
        conn.execute(
            "UPDATE dependabot_merge_operations
             SET delegated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-91 minutes')
             WHERE id = ?1",
            [operation.id],
        )
        .unwrap();
        assert!(merge_processing_timed_out(&conn, operation.id).unwrap());
    }

    #[test]
    fn enqueue_sets_phase2_defaults_and_writes_the_initial_queued_event() {
        let mut conn = mem_conn();
        store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "First")], true).unwrap();
        let operation = enqueue_merge_operation(&conn, 1).unwrap();

        assert_eq!(operation.phase, "queued");
        assert_eq!(operation.strategy, "unknown");
        assert_eq!(operation.check_retry_count, 0);
        assert!(!operation.auto_merge_enabled);
        assert_eq!(operation.merge_queue_position, None);
        assert_eq!(operation.pull_node_id, None);
        assert_eq!(operation.base_ref, None);
        assert_eq!(operation.next_action_at, None);

        let events = list_operation_events(&conn, operation.id).unwrap();
        assert_eq!(events.len(), 1, "enqueue writes exactly one opening event");
        assert_eq!(events[0].kind, "lifecycle");
        assert_eq!(events[0].status, "queued");
        assert_eq!(events[0].phase, "queued");

        let detail = get_operation_detail(&conn, operation.id).unwrap().unwrap();
        assert_eq!(detail.operation.id, operation.id);
        assert_eq!(detail.events.len(), 1);
    }

    #[test]
    fn append_operation_event_is_idempotent_and_preserves_order() {
        let mut conn = mem_conn();
        store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "First")], true).unwrap();
        let operation = enqueue_merge_operation(&conn, 1).unwrap();

        // A repeat of the exact same event (e.g. re-narrating unchanged progress on the next
        // poll tick) is a no-op.
        append_operation_event(
            &conn,
            operation.id,
            "validating",
            "progress",
            "checking",
            "Validating PR authorship.",
            None,
            Some("sha1"),
            None,
        )
        .unwrap();
        append_operation_event(
            &conn,
            operation.id,
            "validating",
            "progress",
            "checking",
            "Validating PR authorship.",
            None,
            Some("sha1"),
            None,
        )
        .unwrap();
        // A genuinely new event (different head sha) is appended.
        append_operation_event(
            &conn,
            operation.id,
            "validating",
            "progress",
            "checking",
            "Validating PR authorship.",
            None,
            Some("sha2"),
            None,
        )
        .unwrap();

        let events = list_operation_events(&conn, operation.id).unwrap();
        // Initial "queued" event + one deduped "checking" event + the sha2 change = 3.
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].status, "queued");
        assert_eq!(events[1].head_sha.as_deref(), Some("sha1"));
        assert_eq!(events[2].head_sha.as_deref(), Some("sha2"));
        // Ascending by id / created_at.
        assert!(events[0].id < events[1].id && events[1].id < events[2].id);
    }

    #[test]
    fn terminalize_is_idempotent_and_events_cascade_with_terminal_retention() {
        let mut conn = mem_conn();
        let prs: Vec<_> = (1..=101)
            .map(|id| pr(id, "octo/repo-a", id, &format!("Bump {id}")))
            .collect();
        store_prs(&mut conn, &prs, true).unwrap();

        let first = enqueue_merge_operation(&conn, 1).unwrap();
        // Calling terminalize twice for the same operation/state must not duplicate the event.
        terminalize(&conn, first.id, "failed", Some("code"), Some("boom"), None).unwrap();
        terminalize(&conn, first.id, "failed", Some("code"), Some("boom"), None).unwrap();
        let events = list_operation_events(&conn, first.id).unwrap();
        assert_eq!(
            events.iter().filter(|e| e.status == "failed").count(),
            1,
            "repeated terminalize narrates once"
        );

        // Push 100 more terminal operations so `first` (the oldest terminal row) is pruned by
        // the existing latest-100 retention.
        for id in 2..=101 {
            let operation = enqueue_merge_operation(&conn, id).unwrap();
            terminalize(&conn, operation.id, "cancelled", None, None, None).unwrap();
        }

        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM dependabot_merge_operations WHERE id = ?1",
                [first.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0, "oldest terminal row is pruned past the cap");

        // Its events are cascade-deleted along with it.
        let orphaned_events: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM dependabot_merge_operation_events WHERE operation_id = ?1",
                [first.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphaned_events, 0);
    }

    #[test]
    fn cancel_request_appends_a_single_event_even_if_called_twice() {
        let mut conn = mem_conn();
        store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "First")], true).unwrap();
        let operation = enqueue_merge_operation(&conn, 1).unwrap();
        mark_merge_progress(&conn, operation.id, "sha", true, false, None).unwrap();

        request_cancel(&conn, operation.id).unwrap();
        request_cancel(&conn, operation.id).unwrap();

        let events = list_operation_events(&conn, operation.id).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| e.status == "cancel_requested")
                .count(),
            1
        );
    }

    #[test]
    fn schedule_check_retry_is_unique_and_increments_operation_retry_count() {
        let mut conn = mem_conn();
        store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "First")], true).unwrap();
        let operation = enqueue_merge_operation(&conn, 1).unwrap();

        let first = schedule_check_retry(&conn, operation.id, "sha1", 100, 1).unwrap();
        let again = schedule_check_retry(&conn, operation.id, "sha1", 100, 1).unwrap();
        assert_eq!(
            first.id, again.id,
            "same run+attempt is not double-scheduled"
        );

        let second = schedule_check_retry(&conn, operation.id, "sha1", 100, 2).unwrap();
        assert_ne!(first.id, second.id, "a new attempt is a distinct retry");

        let retries = list_check_retries(&conn, operation.id).unwrap();
        assert_eq!(retries.len(), 2);

        // check_retry_count only increments on genuinely new schedules (2, not 3).
        let retry_count: i64 = conn
            .query_row(
                "SELECT check_retry_count FROM dependabot_merge_operations WHERE id = ?1",
                [operation.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(retry_count, 2);

        mark_check_retry(&conn, first.id, "requested").unwrap();
        let marked = list_check_retries(&conn, operation.id)
            .unwrap()
            .into_iter()
            .find(|r| r.id == first.id)
            .unwrap();
        assert_eq!(marked.outcome.as_deref(), Some("requested"));
        assert!(marked.requested_at.is_some());

        // Marking again with a different outcome updates the outcome but not requested_at.
        mark_check_retry(&conn, first.id, "succeeded").unwrap();
        let remarked = list_check_retries(&conn, operation.id)
            .unwrap()
            .into_iter()
            .find(|r| r.id == first.id)
            .unwrap();
        assert_eq!(remarked.outcome.as_deref(), Some("succeeded"));
        assert_eq!(remarked.requested_at, marked.requested_at);
    }

    #[test]
    fn merge_policy_cache_respects_freshness_window() {
        let conn = mem_conn();
        cache_merge_policy(&conn, "octo/repo-a", "main", "native_squash").unwrap();

        let fresh = get_merge_policy(&conn, "octo/repo-a", "main", Some(3600))
            .unwrap()
            .unwrap();
        assert_eq!(fresh.strategy, "native_squash");
        // No bound at all also returns the cached row.
        assert!(get_merge_policy(&conn, "octo/repo-a", "main", None)
            .unwrap()
            .is_some());
        // A different base ref is a cache miss.
        assert!(
            get_merge_policy(&conn, "octo/repo-a", "develop", Some(3600))
                .unwrap()
                .is_none()
        );

        // Backdate checked_at to simulate a stale cache entry.
        conn.execute(
            "UPDATE dependabot_merge_policies
             SET checked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 hours')
             WHERE repo_full_name = 'octo/repo-a' AND base_ref = 'main'",
            [],
        )
        .unwrap();
        assert!(get_merge_policy(&conn, "octo/repo-a", "main", Some(3600))
            .unwrap()
            .is_none());
        // Re-caching (upsert) refreshes checked_at, making it fresh again.
        cache_merge_policy(&conn, "octo/repo-a", "main", "auto_merge").unwrap();
        let refreshed = get_merge_policy(&conn, "octo/repo-a", "main", Some(3600))
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.strategy, "auto_merge");
    }

    #[test]
    fn set_phase_updates_phase_and_optional_metadata_without_clobbering() {
        let mut conn = mem_conn();
        store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "First")], true).unwrap();
        let operation = enqueue_merge_operation(&conn, 1).unwrap();

        set_phase(
            &conn,
            operation.id,
            "validating_commits",
            Some("native_squash"),
            Some("PR_kwABC"),
            Some("main"),
        )
        .unwrap();
        let updated = get_operation(&conn, operation.id).unwrap().unwrap();
        assert_eq!(updated.phase, "validating_commits");
        assert_eq!(updated.strategy, "native_squash");
        assert_eq!(updated.pull_node_id.as_deref(), Some("PR_kwABC"));
        assert_eq!(updated.base_ref.as_deref(), Some("main"));

        // Advancing the phase alone (all metadata `None`) leaves previously discovered
        // metadata untouched.
        set_phase(&conn, operation.id, "awaiting_checks", None, None, None).unwrap();
        let advanced = get_operation(&conn, operation.id).unwrap().unwrap();
        assert_eq!(advanced.phase, "awaiting_checks");
        assert_eq!(advanced.strategy, "native_squash");
        assert_eq!(advanced.pull_node_id.as_deref(), Some("PR_kwABC"));
        assert_eq!(advanced.base_ref.as_deref(), Some("main"));
    }

    #[test]
    fn queue_metadata_and_next_action_due_semantics() {
        let mut conn = mem_conn();
        store_prs(&mut conn, &[pr(1, "octo/repo-a", 10, "First")], true).unwrap();
        let operation = enqueue_merge_operation(&conn, 1).unwrap();

        set_queue_metadata(&conn, operation.id, Some(3), true).unwrap();
        let updated = get_operation(&conn, operation.id).unwrap().unwrap();
        assert_eq!(updated.merge_queue_position, Some(3));
        assert!(updated.auto_merge_enabled);

        // Clearing the queue position (e.g. the PR left the native merge queue).
        set_queue_metadata(&conn, operation.id, None, true).unwrap();
        let cleared = get_operation(&conn, operation.id).unwrap().unwrap();
        assert_eq!(cleared.merge_queue_position, None);

        // No schedule yet ⇒ due (nothing pacing the processor away from it).
        assert!(is_next_action_due(&conn, operation.id).unwrap());

        schedule_next_action(&conn, operation.id, Some("2999-01-01T00:00:00Z")).unwrap();
        assert!(!is_next_action_due(&conn, operation.id).unwrap());

        schedule_next_action(&conn, operation.id, Some("2000-01-01T00:00:00Z")).unwrap();
        assert!(is_next_action_due(&conn, operation.id).unwrap());

        // Clearing the schedule returns to "due".
        schedule_next_action(&conn, operation.id, None).unwrap();
        assert!(is_next_action_due(&conn, operation.id).unwrap());
    }
}
