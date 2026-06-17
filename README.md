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

### Avoiding repeated Keychain prompts (macOS)

Helix stores its GitHub PAT in the macOS login Keychain, and the Keychain ties its
"Always Allow" grant to the app's code signature. Every `cargo` rebuild produces a
binary with a new (ad-hoc) signature, so by default macOS re-prompts to let Helix read
the PAT on **every** compile.

To stop this, sign each dev build with a stable identity:

```sh
./scripts/setup-dev-signing.sh   # one-time: create a "Helix Dev" code-signing cert
```

`codesign` only accepts a code-signing identity created through **Keychain Access →
Certificate Assistant**, so the script walks you through that one-time GUI step (it can
open Certificate Assistant for you). Once the `Helix Dev` identity exists,
[`scripts/cargo-codesign.sh`](scripts/cargo-codesign.sh) — wired up as Tauri's
`build.runner` — code-signs every debug build with it automatically. The first build
prompts once or twice (click **Always Allow**); after that, rebuilds are silent. The
wrapper is a no-op when the identity is absent, so this setup is optional and CI/other
contributors are unaffected.

## Project conventions

Engineering principles (lightweight-first, offline-first, API discipline, color-coded
live feedback) live in [`AGENT.md`](AGENT.md). The incremental path to v1 is tracked in
[`docs/milestones.md`](docs/milestones.md).
