# Publishing Helix 🚀

How we build, sign, and ship Helix, and how in-app auto-update works.

> Engineering principles live in [`../AGENT.md`](../AGENT.md); the technical design lives in
> [`design.md`](design.md).

## Overview

- Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml),
  triggered by pushing a **version tag** (`v*`).
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
npm run tauri -- signer generate -w ~/.tauri/helix.key
```

This writes the **private** key to `~/.tauri/helix.key` and prints/​writes the **public** key
to `~/.tauri/helix.key.pub`.

- Copy the **public** key (the contents of `~/.tauri/helix.key.pub`) into
  [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) under
  `plugins.updater.pubkey` (it's committed there — replace it whenever you regenerate the
  keypair). The app embeds it to verify every update.
- The **private** key is a CI secret (below). **Never commit it. If you lose it, existing
  installs can never be updated again** — back it up (e.g. a password manager).

### 2. Apple Developer ID certificate

In your Apple Developer account, create a **Developer ID Application** certificate, then
export it from Keychain Access as a `.p12` (with a password). You'll need:

- the `.p12` file (base64-encode it for the secret: `base64 -i cert.p12 | pbcopy`),
- the certificate password,
- the signing identity string, e.g. `Developer ID Application: Your Name (TEAMID)`
  (`security find-identity -v -p codesigning`),
- your Apple ID email, an **app-specific password** for notarization (see step 3 below),
  and your **Team ID** (the `TEAMID` in the identity string above).

### 3. App-specific password (for notarization)

Notarization signs in to Apple's notary service with your Apple ID via an **app-specific
password** — a single-purpose password Apple issues so a tool can authenticate without your
real password (and without triggering a 2FA prompt on every run). It becomes the
`APPLE_PASSWORD` secret.

1. Sign in at <https://appleid.apple.com>.
2. Go to **Sign-In and Security → App-Specific Passwords**.
3. Click **Generate an app-specific password** (the **+**), give it a name (e.g.
   `helix-notarize`), and confirm with your Apple ID password.
4. Copy the generated value — it looks like `abcd-efgh-ijkl-mnop`. **Store it now**, Apple
   only shows it once. This is the `APPLE_PASSWORD` secret.

> It is **not** your Apple ID login password, and it's separate from the certificate's
> `.p12` export password (`APPLE_CERTIFICATE_PASSWORD`). If it ever leaks, revoke it from the
> same page and generate a new one.

### 4. GitHub Actions secrets (a protected `release` environment)

The signing/notarization secrets are sensitive, so keep them out of routine CI: store them
in a **GitHub Environment** named `release` (not repository secrets), readable only by the
release workflow.

1. **Settings → Environments → New environment** → name it **`release`**.
2. Under **Deployment branches and tags**, choose **Selected branches and tags** and add a
   rule **`v*`** of type **Tag** — so the environment (and its secrets) is only usable on a
   version tag. Optionally add a **required reviewer** to approve each release.
3. Add these as **environment secrets** of `release` (Environment → *Add secret*):

| Secret | Purpose |
| ------ | ------- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/helix.key` (the minisign private key) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for that key (empty if you set none) |
| `APPLE_CERTIFICATE` | base64 of the `.p12` Developer ID cert |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |

The release workflow declares `environment: release`, so it can read these; CI builds with
`--no-bundle` and never needs the signing key. (If you previously added these as
*repository* secrets, delete those copies so they're only in the `release` environment.)

## Cutting a release

1. **Bump the version** to the new `X.Y.Z` in three files:
   - [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) → `"version"` — the
     **authoritative** app version (drives the bundle name and the updater version).
   - [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml) → `version` — keep it in sync.
   - [`src-tauri/Cargo.lock`](../src-tauri/Cargo.lock) — it records the `helix` package
     version, so refresh it by running `cargo build` (or `cargo update -p helix`) and commit
     the change.

   The git tag must equal this version with a leading `v` (config `0.2.0` → tag `v0.2.0`).
2. Commit and merge to `main`.
3. **Tag and push** — this is what kicks off the release (replace `0.2.0`):
   ```sh
   git checkout main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. The **Release** workflow builds, signs, notarizes, and creates a **draft** GitHub
   Release with the `.dmg` + updater assets. (If you added a required reviewer to the
   `release` environment, the run waits for your approval before it starts.)
5. **Review the draft**, edit the notes, then **publish** it.

> Don't create the release/tag from the GitHub UI — push the git tag; the workflow creates
> the draft Release itself. The in-app updater only sees **published, non-draft,
> non-prerelease** releases (the endpoint resolves `releases/latest`), so nothing updates
> until you publish. To abort, delete the draft and the tag: `git push origin :v0.2.0`.

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

## Local validation

You can produce signed-by-updater (but not Apple-notarized) artifacts locally.
`TAURI_SIGNING_PRIVATE_KEY` accepts either the key's **path** (handy locally, shown here)
or its **contents** (the form used for the CI secret):

```sh
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/helix.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri -- build
```

This yields the `.dmg`, `Helix.app.tar.gz`, and `.sig` under
`src-tauri/target/release/bundle/`.
