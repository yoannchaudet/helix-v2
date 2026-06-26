#!/usr/bin/env bash
#
# Stop macOS from re-prompting for Keychain access on every local dev run.
#
# Why this exists (and why signing alone can't fix it):
#
#   Helix stores its PAT in the login Keychain. Access to that item is gated by an
#   ACL with TWO independent checks:
#     1. a trusted-application requirement (the app's code signature), and
#     2. a "partition list".
#
#   Stable signing (scripts/setup-dev-signing.sh + cargo-codesign.sh) satisfies (1)
#   across rebuilds. But (2) is the catch: for a self-signed cert with NO Apple Team
#   ID, the partition list can only pin the binary's per-build *cdhash*. Every
#   rebuild changes the cdhash, so the partition check fails and macOS prompts —
#   "Always Allow" merely appends that one build's cdhash, so it cannot stay stable
#   across rebuilds during normal iterative development. (A real Team ID would yield a
#   stable `teamid:` partition; a self-signed dev cert cannot.)
#
#   This script sidesteps the partition gate entirely by re-storing the PAT as an
#   "allow all applications" item (`security add-generic-password -A`), which has no
#   app restriction and no partition list. After running it, Helix reads the PAT
#   silently across all rebuilds — no signing required.
#
# SECURITY TRADE-OFF (read this):
#   `-A` lets ANY process running as you read this token without warning. That's an
#   intentional convenience for a *local, limited-scope dev PAT*. Do NOT use this for
#   a high-privilege token. The secret is still encrypted at rest in the Keychain.
#
# Usage:
#   ./scripts/fix-dev-keychain.sh          # paste your dev PAT when prompted
#
# Safe to re-run. Re-run it if prompts ever return (e.g. after recreating the item).

set -euo pipefail

SERVICE="${HELIX_KEYCHAIN_SERVICE:-com.yoannchaudet.helix}"
ACCOUNT="${HELIX_KEYCHAIN_ACCOUNT:-github-pat}"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

echo "This re-stores Helix's dev PAT as an 'allow all applications' Keychain item so"
echo "macOS stops prompting on every rebuild."
echo
echo "  Service : $SERVICE"
echo "  Account : $ACCOUNT"
echo "  Keychain: $LOGIN_KEYCHAIN"
echo
echo "⚠️  Trade-off: any process running as you will be able to read this token"
echo "    without a prompt. Only do this for a limited-scope local dev PAT."
echo

# Read the PAT without echoing it. We ask you to paste rather than recovering the
# existing secret, because recovering it would itself trigger the very prompt we are
# trying to eliminate.
printf 'Paste your GitHub PAT (input hidden), then press Enter: '
read -rs TOKEN
echo
if [ -z "${TOKEN:-}" ]; then
  echo "✗ No token entered. Aborting; nothing was changed." >&2
  exit 1
fi

# Delete any existing item so we start from a clean ACL (an item recreated by the
# app would carry cdhash partition pins; deleting + re-adding with -A clears them).
# Distinguish "not found" (fine) from a real failure (locked keychain, ACL denial,
# etc.) — if delete fails for a real reason, the subsequent `-U` would update data
# without necessarily resetting the ACL, so we stop rather than silently proceed.
del_out="$(security delete-generic-password -s "$SERVICE" -a "$ACCOUNT" "$LOGIN_KEYCHAIN" 2>&1)" && del_rc=0 || del_rc=$?
if [ "$del_rc" -eq 0 ]; then
  echo "• Removed the previous item."
elif printf '%s' "$del_out" | grep -qiE "could not be found|SecKeychainSearchCopyNext|errSecItemNotFound|The specified item could not"; then
  echo "• No previous item to remove."
else
  echo "✗ Could not remove the existing item (and it isn't 'not found'):" >&2
  printf '    %s\n' "$del_out" >&2
  echo "  Aborting so we don't leave a half-updated ACL. Nothing was added." >&2
  exit 1
fi

# Re-add as allow-all. -A = accessible by all applications without warning;
# -U = update if it somehow still exists.
#
# Note: the token is passed via `-w "$TOKEN"`, so it is briefly visible in this
# process's arguments to other processes running as you. Given the accepted end state
# (-A lets any such process read the item from the Keychain anyway), this does not
# widen the threat model. `security` has no stdin password input, and bare `-w`
# (interactive) conflicts with the positional keychain argument, so this is the
# pragmatic choice.
security add-generic-password \
  -U -A \
  -s "$SERVICE" \
  -a "$ACCOUNT" \
  -w "$TOKEN" \
  -l "Helix dev PAT" \
  "$LOGIN_KEYCHAIN"
unset TOKEN
echo "• Stored the PAT with an allow-all ACL."

# Verify the resulting ACL is what we expect: the decrypt entry must have no app
# restriction ("applications: <null>" = allow all), which is what makes reads
# prompt-free, AND the partition list must carry no per-build `cdhash:` pins (the pins
# are exactly what re-prompt on every rebuild). A benign `apple-tool:` partition is
# expected on items created by `security` and does NOT cause prompts.
#
# Note: we avoid `awk '... exit'` here on purpose. Exiting awk early closes the pipe,
# the upstream `security`/`printf` gets SIGPIPE, and with `set -o pipefail` that would
# make these checks spuriously fail. We read the (small) item block fully instead.
echo
echo "Verifying ACL..."
# Anchor the block on the account attribute: in `dump-keychain` output `acct` precedes
# both `svce` and the `access:` entries, so starting here captures the service line and
# the full ACL for THIS item. (Anchoring on the service string instead would miss `acct`,
# which is printed earlier.)
acl="$(security dump-keychain -a "$LOGIN_KEYCHAIN" 2>/dev/null \
  | awk -v a="\"acct\"<blob>=\"$ACCOUNT\"" '
      index($0,a) && !started { started=1 }
      started && stop { next }
      started { print; if (/^keychain:/) stop=1 }
    ')" || true

# Guard against inspecting the wrong item: the captured block must also carry our
# service. If it doesn't (no item, or an account collision under a different service),
# fail safe to a warning rather than a false ✅.
if [ -z "$acl" ] || ! printf '%s\n' "$acl" | grep -qiF "$SERVICE"; then
  echo "⚠️  Could not locate the '$SERVICE' / '$ACCOUNT' item's ACL to verify it." >&2
  echo "    Re-inspect with: security dump-keychain -a \"$LOGIN_KEYCHAIN\"" >&2
  exit 1
fi

# The decrypt authorization block should list "applications: <null>" (allow all).
decrypt_open="$(printf '%s\n' "$acl" | awk '
  /authorizations.*decrypt/ { f=1; next }
  /^ *entry [0-9]+:/         { f=0 }
  f && /applications: <null>/ { print "yes" }
')"

# The partition_id block should contain no per-build cdhash pins (a benign
# `apple-tool:` partition is fine and expected on `security`-created items).
partition_pinned="$(printf '%s\n' "$acl" | awk '
  /authorizations.*partition_id/ { g=1; next }
  /^ *entry [0-9]+:/             { g=0 }
  g && /cdhash:/                 { print "yes" }
')"

if [ -n "$decrypt_open" ] && [ -z "$partition_pinned" ]; then
  echo "✅ Done. The item is allow-all (any app may read it) with no per-build cdhash pins."
  echo "   Relaunch the app (npm run tauri dev) — you should not be prompted again."
else
  echo "⚠️  The ACL doesn't look fully open (decrypt_open='${decrypt_open:-no}'," >&2
  echo "    partition_pinned='${partition_pinned:-no}'). macOS prompts may persist." >&2
  echo "    Inspect with: security dump-keychain -a \"$LOGIN_KEYCHAIN\"" >&2
  exit 1
fi
