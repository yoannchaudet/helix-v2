# Helix 🧬

A personal, opinionated tool for managing GitHub notifications and automating the workflows around them.

> **Status:** A working MVP. A macOS desktop app built with [Tauri](https://tauri.app)
> (Rust core + vanilla HTML/CSS UI). Local SQLite is the source of truth, so the app works
> offline and loads fast. See [`docs/design.md`](docs/design.md) for the technical design
> and [`AGENT.md`](AGENT.md) for the engineering principles.

## Why Helix?

GitHub notifications are a firehose. Helix is a personal system for taming that firehose:
triaging what matters, ignoring what doesn't, and automating the repetitive actions that
follow. The name is a nod to the DNA emoji 🧬 — it's the encoded "DNA" of how I manage my
GitHub day.

## An opinionated notification model

Helix is deliberately opinionated about how notifications work — it does **not**
mirror GitHub's model:

- **No concept of "read."** A notification is either in your inbox or it's gone.
  There is no read/unread state to track or manage.
- **Nothing disappears on its own.** Notifications never auto-expire or silently
  vanish; they stay until you act on them.
- **Acknowledge explicitly.** The only way a notification leaves your inbox is by
  marking it **done** — one at a time or in bulk. That's the single, deliberate
  gesture that clears it.

## Vision

- **Triage** — cut through notification noise and surface what actually needs attention.
- **Automate** — turn repetitive notification-driven chores into hands-off workflows.
- **Personalize** — encode my own rules and habits, not a one-size-fits-all inbox.

## Features

- **Offline-first inbox** grouped **by repository**, served from local SQLite and
  reconciled with GitHub on each sync.
- **Smart filters** in the sidebar — All, Mentions, Team mentions, Review requests,
  Assigned, and **Cleanup** (notifications safe to clear: merged/closed PRs and closed
  issues) — each with live counts.
- **Open in the browser** — once a notification's subject is resolved, click (or press
  Enter on) the row to open it; right-click to copy the URL.
- **Mark as done** — clear a single notification from its context menu, or bulk-clear the
  visible/filtered set from the toolbar, with optimistic local updates and per-thread
  failure reporting.
- **API rate-limit visibility** — per-bucket usage bars in Settings.
- **Light & dark themes** — a Dracula-inspired dark mode; choose System (default),
  Light, or Dark in Settings. System follows your macOS appearance live, and the
  native window chrome switches with it.
- **Live, color-coded feedback** — every sync and action shows progress; 🟢 success,
  🟡 pending, 🔴 error.

## Tech stack

- **[Tauri](https://tauri.app)** — Rust core + webview UI, packaged as a native macOS app.
- **Vanilla HTML/CSS/JS** — no heavy frontend framework.
- **SQLite** — primary local state at `~/Library/Application Support/helix/helix.db`
  (created and migrated on first run).

## Development

Requires [Node.js](https://nodejs.org) and a [Rust](https://rustup.rs) toolchain.

```sh
npm install        # install the Tauri CLI
npm run tauri dev  # run the app in development
npm run tauri build  # produce a release bundle
```

Run the Rust tests (e.g. the SQLite bootstrap) with:

```sh
cd src-tauri && cargo test
```

Run the frontend unit tests (the pure logic in `src/js/` — filtering, cleanup
candidacy, sorting, time formatting) with Node's built-in test runner (no extra
dependencies):

```sh
npm test
```

### Token storage (macOS)

Where Helix keeps your GitHub PAT depends on the build:

- **Release builds** store it in the macOS **login Keychain** — encrypted at
  rest, the secure default.
- **Debug builds** (`tauri dev` / `cargo`) store it **unencrypted** in the app's
  local SQLite database instead, and the Settings page shows a warning while this
  is active.

This split is deliberate. The Keychain ties its "always allow" grant to the
binary's code signature *and* an ACL partition list that, for a self-signed
binary with no Apple Team ID, can only pin the per-build code hash — so it
re-prompts on essentially every rebuild, which is unworkable during development.
Rather than fight that, debug builds skip the Keychain entirely.

> ⚠️ Because the dev token is stored unencrypted, use a **low-privilege PAT**
> locally and never ship a debug build. There is nothing to set up — it just
> works, with no prompts.

## Project conventions

Engineering principles (lightweight-first, offline-first, API discipline, color-coded
live feedback) live in [`AGENT.md`](AGENT.md). The technical design lives in
[`docs/design.md`](docs/design.md).
