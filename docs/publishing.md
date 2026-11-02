# Publishing Helix 🚀

How we build, sign, and ship Helix, and how in-app auto-update works.

> Engineering principles live in [`../AGENT.md`](../AGENT.md); the technical design lives in
> [`design.md`](design.md).

## Overview

- Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml),
  either dispatched at a **version tag** (`v*`) by the auto-tag workflow or triggered by a
  manually pushed version tag.
- Each release is a **universal** (Intel + Apple Silicon) macOS app, **code-signed** with an
  Apple *Developer ID Application* certificate and **notarized**, so it installs with no
  Gatekeeper warnings.
- Artifacts are published to a **GitHub Release**: the `.dmg` (manual install) plus the
  updater bundle (`Helix.app.tar.gz`, its `.sig`, and `latest.json`).
- The app auto-updates from those release assets using the Tauri updater plugin (see
  [App-side wiring](#app-side-wiring)).

## Signing configuration

The
[Apple signing workflows repository](https://github.com/yoannchaudet/apple-signing-workflows)
owns the reusable workflow and all signing operations. Use its documentation instead of
maintaining signing procedures here:

- Follow the
  [operator quick start](https://github.com/yoannchaudet/apple-signing-workflows#operator-quick-start)
  to provision Azure, register a caller, hydrate credentials, and verify them.
- Follow
  [caller registration](https://github.com/yoannchaudet/apple-signing-workflows/blob/main/docs/azure-setup.md#register-a-caller)
  to configure GitHub OpenID Connect (OIDC) and the protected `release` environment.
- Follow
  [credential hydration and verification](https://github.com/yoannchaudet/apple-signing-workflows/blob/main/docs/credentials.md#hydration)
  to load credentials or confirm Helix can use them. Use `yoannchaudet/helix-v2` as the
  repository and the Helix repository root as the Tauri project path.
- Follow
  [credential rotation](https://github.com/yoannchaudet/apple-signing-workflows/blob/main/docs/credentials.md#rotation)
  to replace or roll back vault values.
- Read the
  [updater-key warning](https://github.com/yoannchaudet/apple-signing-workflows/blob/main/docs/credentials.md#updater-key-warning)
  before replacing a Tauri updater key.
- Follow the
  [backup and incident guidance](https://github.com/yoannchaudet/apple-signing-workflows/blob/main/docs/security.md#backups-and-incidents)
  for offline backups and credential exposure.

Helix keeps only its caller-specific configuration:

- [`.github/workflows/release.yml`](../.github/workflows/release.yml) pins the reusable
  workflow to an immutable commit SHA.
- The protected `release` environment permits `v*` tags and contains the Azure and Apple
  identifiers required by the shared workflow.
- [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) contains the updater public
  key under `plugins.updater.pubkey`.
- The Entra federated credential uses the exact
  `repo:yoannchaudet/helix-v2:environment:release` subject.

## Cutting a release

1. **Bump the version** with the helper script (from the repo root):
   ```sh
   pwsh ./scripts/bump-version.ps1            # patch bump (default), e.g. 0.2.0 -> 0.2.1
   pwsh ./scripts/bump-version.ps1 -Type minor  # 0.2.0 -> 0.3.0
   pwsh ./scripts/bump-version.ps1 -Type major  # 0.2.0 -> 1.0.0
   ```
   It refuses to run on a dirty tree, syncs `main`, creates a `bump-v<X.Y.Z>` branch, edits
   the three version-tracking files, commits, pushes, and opens a PR. Requires **PowerShell
   7.3+** (it relies on native-command error propagation) and the GitHub CLI (`gh`).

   The three files it edits (do it by hand if you prefer):
   - [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) → `"version"` — the
     **authoritative** app version (drives the bundle name and the updater version).
   - [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml) → `version` — keep it in sync.
   - [`src-tauri/Cargo.lock`](../src-tauri/Cargo.lock) — the `helix` package `version` line
     (the script edits it directly; a `cargo build` **from `src-tauri/`** also refreshes it
     without touching dependency versions).

2. **Merge the bump PR** to `main`. Everything after this is automatic:
   - The [auto-tag workflow](../.github/workflows/auto-tag.yml) detects the merged `bump-v*`
     branch, creates the `v<X.Y.Z>` tag, and pushes it.
   - Because GitHub suppresses workflow events caused by tag pushes made with `GITHUB_TOKEN`,
     the auto-tag workflow explicitly dispatches the
     [release workflow](../.github/workflows/release.yml) at the new tag. It builds, signs,
     notarizes, and creates a **draft** GitHub Release with the `.dmg` + updater assets and an
     **auto-generated changelog**. (If you added a required reviewer to the `release`
     environment, the run waits for your approval before it starts.)

3. **Review the draft release** and **publish** it. The changelog is pre-populated from merged
   PRs (categorized by label — see [`.github/release.yml`](../.github/release.yml)). Edit it
   if you like, then publish.

> The in-app updater only sees **published, non-draft, non-prerelease** releases (the
> endpoint resolves `releases/latest`), so nothing updates until you publish. To abort a
> release, delete the draft Release, then delete the tag locally and remotely:
> `git tag -d v0.2.0 && git push origin --delete v0.2.0`.
>
> **Manual fallback** — if you need to tag by hand (e.g. the auto-tag workflow failed):
> ```sh
> git checkout main && git pull
> git tag v0.2.0
> git push origin v0.2.0
> ```
> A tag pushed with your credentials triggers the release workflow directly. If the auto-tag
> workflow pushed the tag but failed while dispatching the release, keep the existing tag and
> dispatch the release at that ref:
> ```sh
> gh workflow run release.yml --ref v0.2.0
> ```

## How auto-update reaches users

- The app polls
  `https://github.com/yoannchaudet/helix-v2/releases/latest/download/latest.json`.
- `latest.json` (generated by `tauri-action`) lists the new version and the signed
  `Helix.app.tar.gz` URL per arch.
- If `latest.json`'s version is newer, the app downloads the bundle, verifies its minisign
  signature against the embedded public key, swaps in the new `.app`, and relaunches.
- The **first** install is always by `.dmg`; every version after it can auto-update.

## App-side wiring

Implemented in [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) and
[`src/main.js`](../src/main.js):

- The `tauri-plugin-updater` plugin is registered **only in release macOS builds**, so dev
  builds never self-update.
- Rust commands `check_for_update` / `install_update` drive the updater and emit
  `update:progress` / `update:installed`; `updater_enabled` / `app_version` feed the UI.
- The UI auto-checks on launch (release only) and shows an update banner; Settings →
  **Updates** has the version and a **Check for updates** button. Dev builds show
  "Updates are disabled in dev builds".
