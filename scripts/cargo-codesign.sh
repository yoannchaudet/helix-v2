#!/usr/bin/env bash
#
# Tauri `build.runner` wrapper for local macOS development.
#
# It code-signs the freshly built *debug* binary with a stable, self-signed identity
# before the app is launched, giving every build a consistent code identity.
#
# NOTE: this signing does NOT, on its own, stop the macOS Keychain from re-prompting
# for the stored PAT. The Keychain item is also gated by a *partition list*, which for
# a self-signed cert with no Apple Team ID can only pin each build's (changing) cdhash —
# so prompts persist across rebuilds regardless of how stable the signature is. To stop
# the prompts, run `scripts/fix-dev-keychain.sh` (re-stores the PAT as an allow-all
# item). This signing wrapper is therefore optional.
#
# `tauri dev` invokes this as `… run <flags> -- <app-args>`, where `cargo run` builds
# *and* executes in one step. To sign in between, we intercept `run`: build, sign,
# then exec the binary ourselves. `tauri build` (release) and any other subcommand are
# passed straight through to cargo.
#
# Create the signing identity once with `scripts/setup-dev-signing.sh`. If the
# identity is missing (CI, other contributors, or before setup), signing is skipped
# and the build/run behaves exactly like a plain `cargo` invocation.
#
# Wired up via `build.runner` in `src-tauri/tauri.conf.json`.

set -uo pipefail

IDENTITY="${HELIX_DEV_SIGN_IDENTITY:-Helix Dev}"

# Resolve the debug binary from this script's location so it works regardless of the
# working directory Tauri invokes us from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../src-tauri/target/debug/helix"

# Resolve the signing identity to a single, stable SHA-1 hash.
#
# Two deliberate choices here, both about producing a *stable, deterministic code
# signature* across rebuilds (which gives the app a consistent code identity; note this
# alone does NOT keep the Keychain grant stable — see the header note and
# scripts/fix-dev-keychain.sh):
#
#   * We intentionally do NOT use `find-identity -v` (valid-only). A self-signed local
#     dev cert is untrusted by Gatekeeper (CSSMERR_TP_NOT_TRUSTED) and so is filtered out
#     by `-v`, yet it still produces a perfectly stable code signature. Trust only matters
#     for *verification*/Gatekeeper, not for *applying* a signature, which is all we need.
#   * We sign by SHA-1 hash, not by name. If two certs share the name (easy to end up with
#     by re-running setup), `codesign --sign "<name>"` fails with "ambiguous". Picking the
#     first hash from a sorted, de-duplicated list keeps the chosen identity deterministic.
resolve_identity_hash() {
  security find-identity -p codesigning 2>/dev/null \
    | grep -F "\"$IDENTITY\"" \
    | grep -oE '[0-9A-F]{40}' \
    | LC_ALL=C sort -u \
    | head -n1
}

# Code-sign the dev binary with the resolved identity. A no-op when no matching identity
# exists, so the workflow stays optional and never blocks a build.
sign_dev_binary() {
  [ -x "$BIN" ] || return 0
  local hash
  hash="$(resolve_identity_hash)"
  [ -n "$hash" ] || return 0
  codesign --force --sign "$hash" "$BIN" >/dev/null 2>&1 \
    || echo "helix: codesign with '$IDENTITY' ($hash) failed; Keychain prompts may persist" >&2
}

# `tauri dev` path: turn `run <flags> -- <app-args>` into `build <flags>`, sign, exec.
if [ "${1:-}" = "run" ]; then
  shift
  build_args=()
  app_args=()
  seen_sep=0
  for arg in "$@"; do
    if [ "$seen_sep" -eq 0 ] && [ "$arg" = "--" ]; then
      seen_sep=1
      continue
    fi
    if [ "$seen_sep" -eq 0 ]; then
      build_args+=("$arg")
    else
      app_args+=("$arg")
    fi
  done

  cargo build "${build_args[@]}"
  status=$?
  [ "$status" -eq 0 ] || exit "$status"

  # Release builds are signed by `tauri build`'s bundle config, not here.
  case " ${build_args[*]} " in
    *" --release "*) ;;
    *) sign_dev_binary ;;
  esac

  exec "$BIN" "${app_args[@]}"
fi

# Everything else (e.g. `tauri build` -> `build --release …`, `metadata`) passes
# through. Sign after a successful *debug* `build` so manual `cargo build` is covered.
cargo "$@"
status=$?
if [ "$status" -eq 0 ] && [[ " $* " == *" build "* ]] && [[ " $* " != *" --release "* ]]; then
  sign_dev_binary
fi
exit "$status"
