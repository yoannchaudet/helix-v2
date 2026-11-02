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

## One-time setup

### 1. Updater signing keypair (minisign)

The updater verifies every update against a public key baked into the app. Generate the
keypair once:

```sh
npm run tauri -- signer generate -w ~/.tauri/helix-v2.key
```

This writes the **private** key to `~/.tauri/helix-v2.key` and the **public** key to
`~/.tauri/helix-v2.key.pub`.

- Copy the **public** key (the contents of `~/.tauri/helix-v2.key.pub`) into
  [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) under
  `plugins.updater.pubkey`. The app embeds it to verify every update.
- Store the **private** key and its password in Azure Key Vault. **Never commit the private
  key. If you lose it, existing installs can't install future updates.**
- To rotate the key, first release an app signed with the old private key that embeds the new
  public key. Existing installations must install this bridge release before subsequent
  releases use the new private key.

### 2. Apple Developer ID certificate

In your Apple Developer account, create a **Developer ID Application** certificate, then
export it from Keychain Access as a password-protected `.p12`. Store the certificate and
password in the shared Apple signing vault. You'll also need:

- the signing identity string, for example, `Developer ID Application: Your Name (TEAMID)`
  (`security find-identity -v -p codesigning`),
- your Apple ID email, an **app-specific password** for notarization (see step 3),
  and your **Team ID** (the `TEAMID` in the identity string above).

### 3. App-specific password (for notarization)

Notarization signs in to Apple's notary service with an **app-specific password**. This
single-purpose password lets the shared workflow authenticate without your Apple Account
password or an interactive two-factor authentication prompt.

1. Sign in at <https://appleid.apple.com>.
2. Go to **Sign-In and Security → App-Specific Passwords**.
3. Click **Generate an app-specific password** (the **+**), name it `helix-notarize`, and
   confirm with your Apple Account password.
4. Copy the generated value, which looks like `abcd-efgh-ijkl-mnop`, and store it as
   `apple-notarization-password` in the shared vault. Apple shows it only once.

> This value isn't your Apple Account password. It is also separate from the `.p12` export
> password. If it leaks, revoke it from the same page and generate a replacement.

### 4. GitHub Actions environment and Azure OIDC

The reusable workflow authenticates to Azure through OpenID Connect (OIDC). It doesn't use
an Azure client secret. The protected `release` environment supplies nonsecret identifiers,
and Azure Key Vault supplies the signing credentials.

1. **Settings → Environments → New environment** → name it **`release`**.
2. Under **Deployment branches and tags**, choose **Selected branches and tags** and add a
   rule **`v*`** of type **Tag**. Optionally add a **required reviewer**.
3. Configure these `release` environment variables:

| Variable | Purpose |
| ------ | ------- |
| `AZURE_CLIENT_ID` | Entra application client ID for this repository |
| `AZURE_TENANT_ID` | Entra tenant ID |
| `AZURE_KEY_VAULT_URI` | Shared signing vault URI |
| `APPLE_ID` | Apple Account email used for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_SIGNING_IDENTITY` | Full `Developer ID Application` certificate identity |

The Entra application accepts only the
`repo:yoannchaudet/helix-v2:environment:release` OIDC subject. The shared workflow reads
these Key Vault secrets:

| Vault secret | Purpose |
| ------ | ------- |
| `apple-developer-id-certificate` | Base64-encoded Developer ID `.p12` |
| `apple-developer-id-password` | `.p12` export password |
| `apple-notarization-password` | Apple app-specific password |
| `repo-yoannchaudet-helix-v2-tauri-private-key` | Base64-encoded updater private key |
| `repo-yoannchaudet-helix-v2-tauri-private-key-password` | Updater-key password |

The release workflow pins the shared workflow to an immutable commit SHA. Review and update
that SHA explicitly when adopting a newer shared-workflow revision.

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

## Credential validation

From the shared-workflow repository, verify that Azure contains a usable Apple certificate
and matching Tauri updater key:

```powershell
./scripts/manage-vault.ps1 `
  -Action Verify `
  -Repository yoannchaudet/helix-v2 `
  -TauriProjectPath ~/personal-repos/helix-v2
```

Run `npm ci` in the Helix repository before this command. Verification signs a disposable
payload with Helix's pinned Tauri CLI; it doesn't create a release.
