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

Helix stores its GitHub PAT in the macOS **login Keychain**. By default macOS
re-prompts — *"helix wants to use your confidential information stored in
com.yoannchaudet.helix"* — on essentially every rebuild. **The fix is one
script:**

```sh
./scripts/fix-dev-keychain.sh   # paste your dev PAT once; no more prompts
```

It re-stores the PAT as an *allow-all* Keychain item (`security
add-generic-password -A`) and verifies the resulting ACL. After running it,
relaunch the app and you won't be prompted again — across all rebuilds, with or
without code signing.

> ⚠️ **Trade-off:** an allow-all item can be read by any process running as you,
> without a prompt. That's an intentional convenience for a *local, limited-scope
> dev PAT* — don't do this for a high-privilege token. The secret is still
> encrypted at rest. Re-run the script if prompts ever return — e.g. after
> signing out and back in, which deletes and recreates the item (changing the
> token in place preserves the allow-all grant).

<details>
<summary>Why signing alone can't fix this (and why we stopped relying on it)</summary>

Access to the Keychain item is gated by an ACL with **two** independent checks:

1. a **trusted-application requirement** (the app's code signature), and
2. a **partition list**.

A stable signing identity (below) satisfies (1) across rebuilds. But (2) is the
catch: for a self-signed certificate with **no Apple Team ID**, the partition
list can only pin the binary's per-build **cdhash**. Every rebuild changes the
cdhash, so the partition check fails and macOS prompts — clicking *Always Allow*
merely appends that one build's cdhash, so it can't stay stable across rebuilds
during normal iterative development. A real Team ID would yield a stable
`teamid:` partition; a self-signed dev cert cannot. The allow-all item sidesteps
the partition gate entirely, which is why it's the reliable fix.

</details>

<details>
<summary>Optional: stable dev code signature (no longer required for Keychain)</summary>

Signing each debug build with a stable identity is still available (it gives a
consistent code identity), but it is **not** needed to stop the Keychain prompts
— `fix-dev-keychain.sh` handles those. To set it up:

```sh
./scripts/setup-dev-signing.sh   # one-time: create a "Helix Dev" code-signing cert
```

`codesign` only accepts a code-signing identity created through **Keychain
Access → Certificate Assistant**, so the script walks you through that one-time
GUI step. Once the `Helix Dev` identity exists,
[`scripts/cargo-codesign.sh`](scripts/cargo-codesign.sh) — wired up as Tauri's
`build.runner` — signs every debug build with it. The scripts resolve the
identity by its SHA-1 **hash** (not by name) and don't require the cert to be
Gatekeeper-trusted, so a duplicate or untrusted `Helix Dev` cert won't break
signing. The wrapper is a no-op when the identity is absent, so this is optional
and CI/other contributors are unaffected.

</details>

## Project conventions

Engineering principles (lightweight-first, offline-first, API discipline, color-coded
live feedback) live in [`AGENT.md`](AGENT.md). The incremental path to v1 is tracked in
[`docs/milestones.md`](docs/milestones.md).
