# Helix — Technical Design 🧬

> Status: **Implemented (v1 / MVP)** — a living document kept in sync with the shipped
> app. It describes Helix's technical design; see [§9](#9-status--deferred-work) for what
> is done versus deferred.
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
  user-defined rules, and a menu-bar/badge poller — all deferred (see §9).
- Writing/commenting on issues or PRs.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Tauri App (macOS)                      │
│                                                             │
│  ┌──────────────────────┐        ┌────────────────────────┐ │
│  │   Web UI (webview)   │  IPC   │       Rust core        │ │
│  │ vanilla HTML/CSS/JS  │ <────> │    (Tauri commands)    │ │
│  │  - notifications view│ invoke │  - sync engine         │ │
│  │  - settings view     │ events │  - GitHub REST client  │ │
│  │  - live state/loading│        │  - SQLite (rusqlite)   │ │
│  └──────────────────────┘        │  - Keychain (keyring)  │ │
│                                  └────────────┬───────────┘ │
└───────────────────────────────────────────────┼─────────────┘
                                                │ HTTPS (REST)
                                                ▼
                                         api.github.com
```

- **UI layer (webview):** vanilla HTML + modern CSS, minimal JS. Renders entirely from
  data the Rust core provides. Owns loading animations, color-coded states, and live
  feedback. Never talks to GitHub directly.
- **Rust core:** exposes Tauri `#[command]` functions to the UI (e.g. `list_inbox`,
  `sync_now`, `sync_status`, `mark_threads_done`, `sign_in` / `sign_out`, `auth_status`,
  `get_settings` / `save_settings`, `open_url`). Owns all GitHub I/O, SQLite, and Keychain
  access.
- **IPC:** UI → core via `invoke(command, args)`; core → UI via emitted events. The core
  emits `sync:started` / `sync:progress` / `sync:done` / `sync:error` around a sync and
  `subjects:resolved` when background subject resolution updates rows; the UI currently
  reacts to `sync:progress` (live progress) and `subjects:resolved` (re-render), and reads
  sync status via `sync_status`.

### Current architecture (as built)

The shape above still holds; a few specifics have settled since the original draft:

- **Frontend is decomposed into ES modules** under `src/js/` (`api`, `dom`, `format`,
  `inbox-model`, `inbox-view`, `inbox`, `account`, `sync`, `settings`, `storage`,
  `updates`, `menu`, `shortcuts`, `sidebar-resize`, `state`, `constants`, `ui`).
  `src/main.js` is a thin orchestrator that wires each module's `init()` on
  `DOMContentLoaded`. To avoid circular imports, a module that must call into another
  exposes a `configureX({ onEvent })` hook set by `main.js` rather than importing it.
- **Polling is frontend-driven:** `sync.js` runs a 1-second tick (`setInterval`) that
  calls `sync_now` once the configured interval has elapsed; `main.js` starts/stops this
  loop via `startPolling()` / `stopPolling()` on auth-state changes. There is no Rust-side
  timer.
- **CSS is token-driven:** colors plus shared non-color primitives (spacing, radii,
  durations, control sizing, z-index) live as custom properties in `src/styles.css`, with
  a light/dark theme resolved from the user's appearance choice.
- **Token storage is build-mode based** (see [§8](#8-security)): release builds use the
  macOS Keychain, debug builds store the PAT unencrypted in SQLite.

### Data flow (read path)
1. UI calls `list_inbox` → core reads SQLite → returns grouped-by-repo data.
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
  updated_at     TEXT NOT NULL,           -- notification updated_at
  thread_url     TEXT,                    -- API url for the thread
  -- Resolved subject metadata (filled by cleanup resolution; nullable)
  subject_number      INTEGER,
  subject_state       TEXT,               -- open | closed | merged
  subject_state_reason TEXT,              -- completed | not_planned | null
  subject_author      TEXT,
  subject_merged_at   TEXT,
  subject_html_url    TEXT,
  resolved_at         TEXT,               -- when subject metadata was last resolved
  is_new              INTEGER NOT NULL DEFAULT 0, -- new/changed in the last sync; clears next sync
  fetched_at          TEXT NOT NULL       -- when this row was last synced
);

CREATE INDEX idx_notifications_repo ON notifications(repo_id);

-- Key/value app settings
--   github_login : cached GitHub login for offline display
--   window_width/height : last window size, restored on launch
--   theme : appearance preference — system (default) | light | dark
--   dev_github_pat : debug-build only, unencrypted PAT (see auth.rs)
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
  poll_interval_s INTEGER NOT NULL DEFAULT 60,  -- user's configured interval
  github_poll_interval_s INTEGER                -- GitHub's requested floor (X-Poll-Interval / Retry-After)
);

-- Per-bucket GitHub rate-limit snapshots (one row per resource: core, graphql, search, …),
-- surfaced as usage bars in Settings. Captured from `X-RateLimit-*` response headers.
CREATE TABLE rate_limits (
  resource    TEXT PRIMARY KEY,           -- e.g. "core", "search"
  lim         INTEGER,
  remaining   INTEGER,
  reset_at    INTEGER,                    -- epoch seconds
  updated_at  TEXT NOT NULL
);

-- Durable local record of threads the user marked done. GitHub's `DELETE` only removes a
-- thread from the *unread* list; `all=true` keeps returning done threads as "read", so we
-- remember "done" locally and suppress those threads until they genuinely re-surface.
CREATE TABLE done_tombstones (
  thread_id   TEXT PRIMARY KEY,
  updated_at  TEXT,                       -- thread updated_at at mark-done time
  done_at     TEXT NOT NULL               -- re-surface watermark (see reconciliation)
);

CREATE TABLE bookmarks (                  -- local-only; snapshot survives done/removal
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
```

> **Bookmarks** are a local, never-synced overlay: bookmarking snapshots the thread's
> notification data so a "Bookmarks" filter shows it even after it's marked done or drops off
> GitHub's list. Snapshots refresh from the inbox on each sync while the thread is present.
> Done-ness is derived on read (absent from `notifications` → done), so a done bookmark simply
> hides its mark-as-done button (its absence implies the thread is already done).

> Read state is intentionally **not** modeled: the original `unread` / `last_read_at`
> columns were dropped once Helix switched to showing every notification until it is marked
> *done*.

### Reconciliation model
- **Upsert:** each synced notification is `INSERT ... ON CONFLICT(thread_id) DO UPDATE`.
- **Deletion/reconcile:** Helix fetches `all=true` (read and unread alike). After a full
  sync pass we delete local rows whose threads GitHub no longer lists (the set of fetched
  thread ids, a temp table, identifies the stale rows). Locally-done threads are a
  deliberate exception — GitHub keeps returning them, but tombstones keep them out (below).
  Read state is not modeled: a notification is shown until it is marked **done** (the only
  thing that removes it), here or elsewhere.
- **Done threads & durable tombstones:** marking a thread done (`DELETE`) only removes it
  from GitHub's *unread* list — `all=true` keeps returning it as "read". So Helix records a
  durable row in `done_tombstones` and suppresses that thread on subsequent syncs until it
  genuinely re-surfaces, i.e. its fetched `updated_at` is newer than the tombstone watermark
  `max(updated_at, done_at)`. A tombstone is reaped once GitHub stops listing the thread.
- **Optimistic local mutation:** when the user marks a thread done, the UI updates
  immediately; the core calls the API for each thread (bounded concurrency), then deletes
  the local rows for the threads that succeeded (writing a tombstone) and reports per-thread
  failures.
- The token is **not** stored in SQLite for release builds — see §8.

## 4. GitHub integration

Native REST over HTTPS from the Rust core (no `gh` CLI dependency). A small HTTP client
(e.g. `reqwest` or `ureq` — chosen for footprint; see AGENT.md "lightweight first").

### Endpoints (v1)
| Purpose | Method & path |
| --- | --- |
| List notifications | `GET /notifications?all=true&per_page=50&page=N` |
| Resolve a subject (any type with a URL) | `GET {subject_url}` |
| Mark a thread as done | `DELETE /notifications/threads/{thread_id}` |
| (Optional) auth check | `GET /user` |

Headers on every request:
- `Accept: application/vnd.github+json`
- `X-GitHub-Api-Version: 2026-03-10`
- `Authorization: Bearer <token>`

### Pagination
- Fetch notifications by following the `Link` header's `rel="next"` URL in a loop,
  page by page, until there is no `next` — a simple sequential walk (no concurrent
  page fan-out). Live progress is emitted per page so the UI can show real work.

### Rate limiting
- After each response, persist the `X-RateLimit-*` headers. The single most-recent
  `remaining`/`reset` also lives in `sync_state`, and a **per-bucket** snapshot (core,
  graphql, search, …) is kept in `rate_limits` and shown as usage bars in Settings.
- **Honor GitHub's requested poll cadence**: a successful sync records `X-Poll-Interval`
  (and any `Retry-After`, whichever is larger) in `sync_state.github_poll_interval_s`, and
  the frontend floors its automatic poll interval by it — so the effective cadence is
  `max(user interval, app minimum, GitHub's requested floor)`.
- Background subject resolution backs off when a bucket drops below a reserve (~25%
  remaining), so resolution never starves foreground syncs.
- A full automatic pause-until-reset / `Retry-After` backoff after a rate-limit *rejection*
  is still deferred; such a rejection is handled like any other failed request — see the
  error model below.

### Error model
- Network/HTTP errors are caught, recorded in `sync_state.last_error`, emitted to the UI
  as a 🔴 error state, and never crash the app. The last good SQLite state stays visible.

## 5. Sync engine

A single coordinator in the Rust core:

1. **Fetch** all notifications, read and unread (`all=true`, paginated, §4).
2. **Upsert** repos + notifications into SQLite (§3).
3. **Reconcile** rows missing from the latest pass (and honor done tombstones, §3).
4. **Resolve** subjects in the background — for **any** subject that carries a URL we fetch
   its `html_url` (so discussions, releases, etc. become clickable), and for
   PR/Issue/Discussion we also capture state/`merged_at`/`state_reason`/author. A bounded
   concurrent pool does this, caching `resolved_at` so we don't re-resolve unnecessarily,
   and it backs off once a rate-limit bucket drops below a reserve (~25% remaining).
5. **Record** `last_sync_at`, status, and the rate-limit snapshots.

**Polling:** the UI drives periodic syncs — a 1-second tick calls `sync_now` whenever the
configured interval has elapsed. The interval is read from `sync_state.poll_interval_s` and
is **user-configurable** in Settings (never hard-coded). Manual "Sync now" is always
available.

Progress is streamed to the UI via events so loading animations reflect real work.

## 6. Cleanup workflow

Ports the candidate logic from `yoann-em`
(`scripts/cleanup-notifications.ps1` + `modules/CleanupNotifications.psm1`), surfaced as a
**sidebar filter** ("Cleanup") rather than a separate preview pane.

### Candidate rules
A notification is a cleanup candidate when its resolved subject is a closed PR/issue:

- **Pull request:** `subject_state` is `merged` (set when `merged_at` is present) or
  `closed`. Open PRs are skipped.
- **Issue:** `subject_state` is `closed`. Open issues are skipped.

Only a **current** resolution counts: a candidate is excluded while it looks stale
(`updated_at > resolved_at`) — e.g. a reopened issue — until background re-resolution
catches up, so the filter never offers a stale "safe to clear" item. (The `subject_state_reason`
column — `completed` / `not_planned` — is still resolved and stored, but the UI shows a
single merged/closed/open state pill and does not classify issues further.)

### Surfacing + bulk action
- Selecting the **Cleanup** filter shows the candidates grouped by repo (same by-repo list
  as every other filter), with a live count in the sidebar.
- The user clears them via the toolbar **••• → "Mark all as done"** over the visible
  (filtered) set, with an in-menu confirmation, or one at a time from a row's context menu.
- Each thread is marked done via `DELETE /notifications/threads/{thread_id}` (bounded
  concurrency); successes are removed locally and tombstoned (§3); failures are reported
  per-thread in 🔴 without aborting the rest.

## 7. UI / UX

### Shell — native macOS layout
A vibrant **sidebar + content** layout that fills the window edge-to-edge (no centered
column, no marketing hero):
- **Sidebar** (`NSVisualEffect` *Sidebar* vibrancy via the `window-vibrancy` crate):
  cross-cutting smart filters (**All**, **Mentions**, **Team mentions**, **Review
  requests**, **Assigned**, **Cleanup**) with live counts, a **Repositories** list of
  selectable sources, and a **Settings** entry (`⌘,`) pinned to the bottom. Selection is
  single-active (a smart filter *or* a repository), Mail-style.
- **Content pane:** an opaque pane with a **unified toolbar** fused into the overlay title
  bar (`titleBarStyle: "Overlay"`, `hiddenTitle: true`, transparent window +
  `macOSPrivateApi`). The toolbar shows the active source title (left) and sync
  status + refresh (right), and stays pinned while the list scrolls.
- Accent (purple) is applied **sparingly** — selection tint, counts — not as
  large filled buttons (system control styling otherwise).

### Views (v1)
- **Notifications:** a full-width, dense list with **sticky, Mail-style repo section
  headers** (repo name, private badge, notification count), each listing its notifications with
  subject type (PR/Issue), number, title, reason, and state label. Hairline row separators.
  Once a row's subject is resolved, clicking (or pressing Enter on) it opens the subject in
  the browser; a right-click context menu offers **Copy URL** and **Mark as done**.
- **Cleanup:** the **Cleanup** sidebar filter (§6) reuses the same by-repo list, narrowed to
  candidates; clearing them is the toolbar ••• "Mark all as done" flow with live progress.
- **Settings:** an in-app pane (reached from the sidebar or `⌘,`) for PAT entry, the poll
  interval, **appearance (System / Light / Dark)**, **per-bucket API rate-limit usage
  bars**, account info, and local-storage details (DB path, schema version).

#### Theming
- The webview palette is driven entirely by CSS custom properties on `:root`, with
  `*-rgb` channel triplets feeding the alpha-composited tints; a `:root[data-theme="dark"]`
  block overrides them with a Dracula-inspired palette tuned for WCAG AA contrast.
- The **System / Light / Dark** choice persists as the `theme` setting. `main.js` resolves
  the effective theme (following `prefers-color-scheme` live in System mode) and sets
  `data-theme` on the root; an inline `<head>` script mirrors the pref via `localStorage`
  to paint the correct theme before first frame (no flash).
- The native macOS window chrome (title bar + vibrancy) is matched to the preference via
  `Window::set_theme` — applied at launch in `setup()` and by a dedicated `set_theme`
  command on each change (kept separate from `save_settings` so an unrelated invalid field
  can't block a theme change). `system` leaves the window following the OS appearance.

### Conventions (see AGENT.md)
- **Vanilla CSS + modern HTML**, no heavy framework. System font stack only.
- **Live feedback everywhere:** every async operation shows a loading animation; sync
  progress is visible; nothing happens silently.
- **Color-coded state:** 🟢 green = success, 🟡 yellow = pending/in-progress,
  🔴 red = error. Applied to sync status, rate-limit pauses, per-action results, and
  state labels.

## 8. Security

- **Release builds** store the PAT in the **macOS Keychain** (via the `keyring-core` +
  `apple-native-keyring-store` crates) — never in SQLite, never in plaintext on disk, never
  logged.
- **Debug builds** (`tauri dev` / `cargo`) instead store the PAT **unencrypted** in the
  SQLite `settings` table (the Keychain re-prompts on every rebuild for a self-signed
  binary, which is unworkable in dev). The Settings UI warns while this is active. The
  backend selects the store at compile time via `cfg!(debug_assertions)` (see `auth.rs`).
- The UI sends the token to the core once (to save); thereafter the core reads it from
  the active store on demand. The token is not echoed back to the UI, and never returned
  by `get_settings`.
- **Recommended token scopes** (document for the user):
  - Classic PAT: `notifications` (read/modify the inbox). Add `repo` to resolve subjects
    in **private** repositories.
  - Fine-grained PAT alternative: read access to **Notifications**, plus
    Issues/Pull-requests read on the relevant repos for subject resolution.
- All GitHub traffic is HTTPS to `api.github.com`.

## 9. Status & deferred work

### Status
The v1/MVP scope is implemented: Keychain/SQLite auth + settings, the paginated
fetch → upsert → reconcile sync engine (with durable done tombstones and per-bucket
rate-limit handling), the by-repo notifications view, background subject resolution, the
**Cleanup** filter, and mark-as-done (single + bulk).

### Deferred (post-v1)
Per-thread mark-as-read, mute, unsubscribe; search; user-defined custom filter rules; a
menu-bar/badge background poller; and cross-platform support.

### Resolved decisions
- **Reconcile vs. retain:** Helix fetches `all=true` and does not model read state — a
  notification is shown until it is marked **done**. Because GitHub keeps done threads in the
  `all=true` response, "done" is tracked locally via durable tombstones (§3).
- **Subject resolution cost:** resolution runs in the background after a sync (not eagerly
  inline), bounded by a concurrent pool and a rate-limit reserve, so it never blocks the
  inbox or starves foreground syncs.
