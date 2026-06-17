#!/usr/bin/env bash
#
# One-time setup so local dev builds are signed with a stable identity, which keeps
# the macOS Keychain "Always Allow" grant for Helix's stored PAT valid across
# rebuilds (see scripts/cargo-codesign.sh and the README "Local development" notes).
#
# Why a GUI step: macOS `codesign` only accepts a code-signing identity created
# through Keychain Access → Certificate Assistant. Self-signed certs minted with
# openssl/`security` from a script are rejected ("no identity found") even after
# adding trustRoot, so the certificate itself must be created interactively. This
# script detects whether that identity already exists, and if not, walks you through
# creating it (and can open Certificate Assistant for you).
#
# Safe to re-run: it exits immediately once a valid identity is present.

set -euo pipefail

IDENTITY="${HELIX_DEV_SIGN_IDENTITY:-Helix Dev}"

if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "✅ Code-signing identity '$IDENTITY' already exists and is valid. Nothing to do."
  exit 0
fi

cat <<EOF
No valid code-signing identity named '$IDENTITY' was found.

Create one (one-time, ~30 seconds) via Keychain Access → Certificate Assistant:

  1. Keychain Access menu ▸ Certificate Assistant ▸ Create a Certificate…
  2. Name:             $IDENTITY
  3. Identity Type:    Self Signed Root
  4. Certificate Type: Code Signing
  5. Click Create, then Done (keep it in your "login" keychain).

EOF

if [ -t 0 ]; then
  read -r -p "Open Certificate Assistant now? [Y/n] " ans
  case "${ans:-Y}" in
    [Nn]*) ;;
    *) open -a "Certificate Assistant" 2>/dev/null || \
         echo "Could not auto-open it; open Keychain Access and use the menu above." ;;
  esac
fi

cat <<EOF

After creating '$IDENTITY', re-run this script to confirm, then start the app:

  ./scripts/setup-dev-signing.sh   # should report the identity is valid
  npm run tauri dev

On the first build macOS will prompt once or twice — click Always Allow each time:
  • "codesign wants to use the '$IDENTITY' key"
  • "Helix wants to use your confidential information" (the stored PAT)

Subsequent rebuilds will not prompt.
EOF
exit 1
