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

# Match by name against ALL code-signing identities, not just `-v` (valid/trusted) ones.
# A self-signed dev cert is untrusted by Gatekeeper (CSSMERR_TP_NOT_TRUSTED) and so is
# hidden by `-v`, yet it still signs fine (scripts/cargo-codesign.sh signs by hash). If we
# checked `-v` here, this script would wrongly report the identity as missing and prompt
# you to create another one — which is exactly how duplicate "Helix Dev" certs accumulate.
hashes="$(security find-identity -p codesigning 2>/dev/null \
  | grep -F "\"$IDENTITY\"" | grep -oE '[0-9A-F]{40}' | sort -u || true)"
count="$(printf '%s' "$hashes" | grep -c . || true)"

if [ "$count" -gt 1 ]; then
  echo "⚠️  Found $count code-signing identities named '$IDENTITY':"
  printf '%s\n' "$hashes" | sed 's/^/      /'
  cat <<EOF
Duplicates are harmless — cargo-codesign.sh signs by a single deterministic hash — but you
can remove the extras in Keychain Access (delete all but one "Helix Dev" certificate) to
keep things tidy. Signing will keep working either way.
EOF
  exit 0
fi

if [ "$count" -eq 1 ]; then
  echo "✅ Code-signing identity '$IDENTITY' exists. Nothing to do."
  echo "   (It may show as untrusted/Gatekeeper-unverified — that's expected and fine for"
  echo "    local dev signing, which only needs a stable signature, not Gatekeeper trust.)"
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
