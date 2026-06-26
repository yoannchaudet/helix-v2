# Helix — Milestones to v1 🧬

> Status: **Draft**. An incremental path to v1. Each milestone is small, builds on the
> previous one, and is independently demoable. Numbering matches
> [`design.md`](design.md) §9. See [`../AGENT.md`](../AGENT.md) for the principles that
> govern *how* each step is built (offline-first SQLite, API discipline, vanilla UI,
> color-coded live feedback).

v1 is complete when **M1–M7** are done.

---

## M1 — Scaffold & SQLite bootstrap
**Objective:** A Tauri app that launches and prepares its local storage.
**Deliverables:**
- Tauri (Rust core + vanilla HTML/CSS/JS webview) project that builds and runs on macOS.
- App-data directory resolved at runtime to `~/Library/Application Support/helix/`.
- SQLite database `helix.db` created on first run with the v1 schema applied via a
  simple, versioned migration runner (see design.md §3).
**Done when:** `helix` launches, shows a window, and creates
`~/Library/Application Support/helix/helix.db` with all tables. Relaunch is idempotent
(no duplicate/migration errors).

## M2 — Auth & settings
**Objective:** Securely authenticate and persist preferences.
**Deliverables:**
- Settings view; PAT stored in the macOS Keychain (release) or unencrypted in SQLite
  (debug builds — see `auth.rs`).
- Settings (poll interval, dependabot-only default) persisted in SQLite.
- Auth check against `GET /user`.
**Done when:** Entering a PAT shows the authenticated login; the token survives relaunch
(via Keychain in release builds; via SQLite in debug builds).

## M3 — Fetch & store notifications
**Objective:** Pull the notification inbox into local state.
**Deliverables:**
- Paginated `GET /notifications?all=true` (follow `Link` headers).
- Upsert repos + notifications into SQLite; record rate-limit snapshot in `sync_state`.
- "Sync now" command with live progress events.
**Done when:** "Sync now" populates the DB; an offline relaunch shows the same data.

## M4 — Notifications-by-repo view
**Objective:** A beautiful, readable inbox grouped by repository.
**Deliverables:**
- Read from SQLite, grouped by repo (collapsible sections).
- Subject type, number, title, reason, state label; color-coded states.
- Live sync feedback / loading animation.
**Done when:** A grouped, well-typeset list renders from local state and a sync shows
live progress.

## M5 — Reconciliation
**Objective:** Keep local state consistent with GitHub.
**Deliverables:**
- After a full sync pass, reconcile rows no longer present (marked done) using the
  `fetched_at` watermark (design.md §3).
**Done when:** Clearing a notification on github.com makes it disappear from Helix after
the next sync.

## M6 — Cleanup candidates
**Objective:** Surface notifications safe to clear.
**Deliverables:**
- Resolve PR/Issue subjects with bounded concurrency (cache `resolved_at`).
- Apply filter rules: merged/closed PRs, closed issues classified by `state_reason`
  (design.md §6).
- Dependabot-only toggle; grouped preview.
**Done when:** The cleanup view lists the correct candidates, grouped by repo, matching
the `yoann-em` logic.

## M7 — Bulk mark-as-done
**Objective:** Clear the surfaced notifications in one action.
**Deliverables:**
- Confirm → bulk `DELETE /notifications/threads/{id}` (bounded concurrency).
- Optimistic local update + reconcile; per-thread result reporting.
**Done when:** Bulk clearing works end-to-end; failures are surfaced in red without
aborting the rest of the batch.

## M7.1 — Per-thread & per-view mark-as-done
**Objective:** Let the user clear notifications directly from the inbox, not just via the
cleanup view.
**Deliverables:**
- `DELETE /notifications/threads/{id}` with bounded concurrency and per-thread failure
  reporting (`mark_threads_done`).
- Right-click context menu on a notification (Mark as done) and a toolbar ••• menu that
  marks the currently visible/filtered set as done (confirm first).
**Done when:** Marking done removes a notification (locally + on GitHub) for both a single
thread and the filtered set, failures surface in red without aborting the batch, and a
later sync does not resurrect a done item.

---

### Deferred (post-v1)
Per-thread mark-as-read, mute, unsubscribe; search; user-defined custom filter rules;
background polling with a menu-bar badge; and cross-platform support.
