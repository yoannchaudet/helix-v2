# Helix — Technical Design 🧬

> Status: **Draft (v1)**. This document describes the first technical design for Helix.
> Engineering principles that govern *how* we build live in [`../AGENT.md`](../AGENT.md).

## 1. Overview

Helix is a personal **macOS desktop app** for managing GitHub notifications and
automating the workflows around them. It is built on [Tauri](https://tauri.app) with a
Rust core and a vanilla HTML/CSS web UI. The local **SQLite** database is the primary
source of truth: the app is offline-first, loads instantly from local state, and
reconciles with GitHub over the network.

### Goals (v1)
- Authenticate to GitHub and store the token securely.
- Sync notifications into local SQLite and keep them reconciled.
- Display notifications grouped **by repository** in a beautiful, live view.
- Provide a **cleanup filter** that surfaces notifications safe to clear (merged/closed
  PRs, closed issues) and lets the user **bulk mark them as done**.

### Non-goals (v1)
- Cross-platform support (macOS only for now).
- Per-thread actions beyond mark-as-done (mark-read, mute, unsubscribe), search, custom
  user-defined rules, and a menu-bar/badge poller — all deferred to later milestones.
- Writing/commenting on issues or PRs.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Tauri App (macOS)                     │
│                                                              │
│  ┌──────────────────────┐        ┌────────────────────────┐ │
│  │   Web UI (webview)    │  IPC   │     Rust core          │ │
│  │  vanilla HTML/CSS/JS  │ <────> │  (Tauri commands)      │ │
│  │  - notifications view │ invoke │  - sync engine         │ │
│  │  - settings view      │ events │  - GitHub REST client  │ │
│  │  - live state/loading │        │  - SQLite (rusqlite)   │ │
│  └──────────────────────┘        │  - Keychain (keyring)  │ │
│                                   └───────────┬────────────┘ │
└───────────────────────────────────────────────┼─────────────┘
                                                 │ HTTPS (REST)
                                                 ▼
                                        api.github.com
```

- **UI layer (webview):** vanilla HTML + modern CSS, minimal JS. Renders entirely from
  data the Rust core provides. Owns loading animations, color-coded states, and live
  feedback. Never talks to GitHub directly.
- **Rust core:** exposes Tauri `#[command]` functions to the UI (e.g. `list_notifications`,
  `sync_now`, `cleanup_candidates`, `mark_done`, `get_settings`, `save_token`). Owns all
  GitHub I/O, SQLite, and Keychain access.
- **IPC:** UI → core via `invoke(command, args)`; core → UI via emitted events for
  progress/state (e.g. `sync:started`, `sync:progress`, `sync:done`, `sync:error`).

### Data flow (read path)
1. UI calls `list_notifications` → core reads SQLite → returns grouped-by-repo data.
2. UI renders immediately (works offline).

### Data flow (sync path)
1. UI calls `sync_now` (or a poll tick fires).
2. Core fetches from GitHub, upserts into SQLite, reconciles deletions.
3. Core emits progress events; UI shows live loading + updates the view.

## 3. Storage layer (SQLite)

**Location:** `~/Library/Application Support/helix/helix.db` (macOS-native app-data
directory; resolved at runtime via Tauri's app-data path API). Created on first run.

SQLite is the **primary state**. The UI always reads from SQLite. Network mutations are
applied to GitHub and then reconciled into SQLite.

### Schema (initial)

```sql
-- Repositories referenced by notifications
CREATE TABLE repos (
  id            INTEGER PRIMARY KEY,      -- GitHub repo id
  full_name     TEXT NOT NULL,            -- "owner/name"
  owner         TEXT NOT NULL,
  name          TEXT NOT NULL,
  private       INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT
);

-- One row per notification thread
CREATE TABLE notifications (
  thread_id      TEXT PRIMARY KEY,        -- GitHub notification/thread id
  repo_id        INTEGER NOT NULL REFERENCES repos(id),
  subject_type   TEXT NOT NULL,           -- PullRequest | Issue | Release | ...
  subject_title  TEXT NOT NULL,
  subject_url    TEXT,                    -- API url to resolve PR/issue
  reason         TEXT,                    -- review_requested, mention, ...
  unread         INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT NOT NULL,           -- notification updated_at
  last_read_at   TEXT,
  thread_url     TEXT,                    -- API url for the thread
  -- Resolved subject metadata (filled by cleanup resolution; nullable)
  subject_number      INTEGER,
  subject_state       TEXT,               -- open | closed | merged
  subject_state_reason TEXT,              -- completed | not_planned | null
  subject_author      TEXT,
  subject_merged_at   TEXT,
  subject_html_url    TEXT,
  resolved_at         TEXT,               -- when subject metadata was last resolved
  fetched_at          TEXT NOT NULL       -- when this row was last synced
);

CREATE INDEX idx_notifications_repo ON notifications(repo_id);
CREATE INDEX idx_notifications_unread ON notifications(unread);

-- Key/value app settings
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Sync bookkeeping (single row, id = 1)
CREATE TABLE sync_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at    TEXT,
  last_poll_at    TEXT,
  last_status     TEXT,                   -- success | error
  last_error      TEXT,
  rate_remaining  INTEGER,
  rate_reset_at   TEXT,
  poll_interval_s INTEGER NOT NULL DEFAULT 60
);
```

### Reconciliation model
- **Upsert:** each synced notification is `INSERT ... ON CONFLICT(thread_id) DO UPDATE`.
- **Deletion/reconcile:** GitHub only returns currently-unread notifications. After a
  full sync pass we mark local rows not present in the latest result as no longer unread
  (or remove them), so the local inbox matches GitHub. A `fetched_at` watermark per
  sync run identifies stale rows.
- **Optimistic local mutation:** when the user marks a thread done, we update SQLite
  immediately (UI reflects it), call the API, then confirm/rollback on the result.
- The token is **not** stored in SQLite — see §8.

## 4. GitHub integration

Native REST over HTTPS from the Rust core (no `gh` CLI dependency). A small HTTP client
(e.g. `reqwest` or `ureq` — chosen for footprint; see AGENT.md "lightweight first").

### Endpoints (v1)
| Purpose | Method & path |
| --- | --- |
| List notifications | `GET /notifications?all=false&per_page=50&page=N` |
| Resolve PR/Issue subject | `GET {subject_url}` |
| Mark a thread as done | `DELETE /notifications/threads/{thread_id}` |
| (Optional) auth check | `GET /user` |

Headers on every request:
- `Accept: application/vnd.github+json`
- `X-GitHub-Api-Version: 2026-03-10`
- `Authorization: Bearer <token>`

### Pagination
- Always follow the `Link` header (`rel="next"` / `rel="last"`).
- Fetch page 1, then remaining pages; bound concurrency to a small pool to be polite
  (the PowerShell prototype used a throttle of ~8). Fall back to sequential `next`
  walking when `last` is absent.

### Rate limiting
- After each response, persist `X-RateLimit-Remaining` and `X-RateLimit-Reset` into
  `sync_state`.
- If remaining is exhausted (or a `403/429` with `Retry-After` arrives), pause sync
  until reset and surface a 🟡 pending state in the UI. Never hard-fail the app.

### Error model
- Network/HTTP errors are caught, recorded in `sync_state.last_error`, emitted to the UI
  as a 🔴 error state, and never crash the app. The last good SQLite state stays visible.

## 5. Sync engine

A single coordinator in the Rust core:

1. **Fetch** all unread notifications (paginated, §4).
2. **Upsert** repos + notifications into SQLite (§3).
3. **Reconcile** rows missing from the latest pass.
4. **Resolve** subjects lazily — for the cleanup view we resolve PR/Issue metadata
   (state, merged_at, author, state_reason) with a bounded concurrent pool, caching
   `resolved_at` so we don't re-resolve unnecessarily.
5. **Record** `last_sync_at`, status, and rate-limit snapshot.

**Polling:** optional periodic sync on a timer. The interval is read from
`settings`/`sync_state.poll_interval_s` and is **user-configurable** in the Settings
view (never hard-coded). Manual "Sync now" is always available.

Progress is streamed to the UI via events so loading animations reflect real work.

## 6. Cleanup workflow

Ports the proven logic from `yoann-em` (`scripts/cleanup-notifications.ps1` +
`modules/CleanupNotifications.psm1`).

### Candidate rules
Starting from unread notifications whose subject is a `PullRequest` or `Issue` (with a
subject URL), resolve the subject and keep it as a cleanup candidate when:

- **Pull request:**
  - `merged_at` is set → state label **`merged`**, **OR**
  - `state == "closed"` → state label **`closed`**.
  - Open PRs are skipped.
- **Issue:**
  - `state == "closed"` → keep; classify by `state_reason`:
    - `completed` → **`completed`**
    - `not_planned` → **`not_planned`**
    - otherwise → **`closed`**.
  - Open issues are skipped.

### Optional filter
- **Dependabot-only:** restrict candidates to subjects authored by `dependabot[bot]`
  (`user.login == "dependabot[bot]"`). Off by default; toggled in the UI.

### Preview + bulk action
- Candidates are grouped by repo and previewed with their state label and author.
- The user confirms, then Helix **bulk marks** each thread done via
  `DELETE /notifications/threads/{thread_id}` (bounded concurrency).
- Each result is reconciled into SQLite (success removes/updates the row); failures are
  reported per-thread in 🔴 without aborting the rest.

## 7. UI / UX

### Views (v1)
- **Notifications by repo:** repos as sections (collapsible), each listing its
  notifications with subject type (PR/Issue), number, title, reason, and state label.
  Beautiful typography, generous spacing, scannable hierarchy.
- **Cleanup:** the filtered candidate list (§6) with the dependabot-only toggle, a
  preview grouped by repo, and a confirm → bulk mark-as-done flow with live progress.
- **Settings:** PAT entry (stored to Keychain), poll interval, dependabot-only default.

### Conventions (see AGENT.md)
- **Vanilla CSS + modern HTML**, no heavy framework.
- **Live feedback everywhere:** every async operation shows a loading animation; sync
  progress is visible; nothing happens silently.
- **Color-coded state:** 🟢 green = success, 🟡 yellow = pending/in-progress,
  🔴 red = error. Applied to sync status, rate-limit pauses, per-action results, and
  state labels.

## 8. Security

- The PAT is stored in the **macOS Keychain** via the Rust `keyring` crate — never in
  SQLite, never in plaintext on disk, never logged.
- The UI sends the token to the core once (to save); thereafter the core reads it from
  Keychain on demand. The token is not echoed back to the UI.
- **Recommended token scopes** (document for the user):
  - Classic PAT: `notifications` (read/modify the inbox). Add `repo` to resolve subjects
    in **private** repositories.
  - Fine-grained PAT alternative: read access to **Notifications**, plus
    Issues/Pull-requests read on the relevant repos for subject resolution.
- All GitHub traffic is HTTPS to `api.github.com`.

## 9. v1 milestones & open questions

### Milestones
1. **Scaffold** — Tauri app, app-data dir, SQLite bootstrap + migrations.
2. **Auth/settings** — Keychain PAT save/read, settings persistence, auth check.
3. **Sync engine** — fetch + upsert + reconcile + rate-limit handling.
4. **Notifications-by-repo view** — read from SQLite, live sync feedback.
5. **Cleanup workflow** — candidate resolution, preview, bulk mark-as-done.

### Open questions
- **Subject resolution cost:** resolving every PR/Issue is N extra calls. Do we resolve
  eagerly during sync, or lazily only when the cleanup view is opened? (Lean toward lazy
  for v1; revisit if it feels slow.)
- **Reconcile vs. retain:** when a notification is no longer unread on GitHub, do we
  delete the local row or keep it flagged read for history? (v1: keep the inbox = unread
  only; deletion is simplest.)
- **Read vs. done semantics:** v1 only does "mark done" (removes from inbox). Mark-read
  is a later milestone.
