# Helix 🧬

A personal tool for managing GitHub notifications and automating the workflows around them.

> **Status:** Early development. A macOS desktop app built with [Tauri](https://tauri.app)
> (Rust core + vanilla HTML/CSS UI). Local SQLite is the source of truth, so the app works
> offline and loads fast. See [`docs/design.md`](docs/design.md) and
> [`docs/milestones.md`](docs/milestones.md).

## Why Helix?

GitHub notifications are a firehose. Helix is a personal system for taming that firehose:
triaging what matters, ignoring what doesn't, and automating the repetitive actions that
follow. The name is a nod to the DNA emoji 🧬 — it's the encoded "DNA" of how I manage my
GitHub day.

## Vision

- **Triage** — cut through notification noise and surface what actually needs attention.
- **Automate** — turn repetitive notification-driven chores into hands-off workflows.
- **Personalize** — encode my own rules and habits, not a one-size-fits-all inbox.

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

## Project conventions

Engineering principles (lightweight-first, offline-first, API discipline, color-coded
live feedback) live in [`AGENT.md`](AGENT.md). The incremental path to v1 is tracked in
[`docs/milestones.md`](docs/milestones.md).
