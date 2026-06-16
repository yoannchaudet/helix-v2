//! Secret storage for the GitHub Personal Access Token.
//!
//! The PAT lives in the macOS login Keychain (via `keyring-core` + the Apple native
//! store) and is **never** written to SQLite or logged (see `docs/design.md` §8). The
//! default credential store is installed once at startup in `lib.rs`.

use keyring_core::{Entry, Error as KeyringError};

/// Keychain service identifier (matches the app bundle id for clarity in Keychain Access).
const SERVICE: &str = "com.yoannchaudet.helix";
/// Account name under which the PAT is stored.
const ACCOUNT: &str = "github-pat";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keychain error: {e}"))
}

/// Store (or replace) the PAT in the Keychain.
pub fn store_token(token: &str) -> Result<(), String> {
    entry()?
        .set_password(token)
        .map_err(|e| format!("failed to store token: {e}"))
}

/// Read the PAT from the Keychain, returning `None` when no entry exists.
pub fn read_token() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("failed to read token: {e}")),
    }
}

/// Whether a PAT is currently stored.
pub fn has_token() -> Result<bool, String> {
    Ok(read_token()?.is_some())
}

/// Remove the PAT from the Keychain. A missing entry is treated as success.
pub fn delete_token() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to delete token: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;

    static STORE_INIT: Once = Once::new();

    fn ensure_store() {
        STORE_INIT.call_once(|| {
            keyring_core::set_default_store(
                apple_native_keyring_store::keychain::Store::new()
                    .expect("init keychain store"),
            );
        });
    }

    /// Exercise the real macOS Keychain with a throwaway account so a real stored PAT is
    /// never touched. Verifies store -> read -> delete round-trips.
    #[test]
    fn keychain_round_trip() {
        ensure_store();
        let account = format!("test-{}", std::process::id());
        let entry = Entry::new(SERVICE, &account).expect("entry");

        // Clean any leftover from a previous aborted run.
        let _ = entry.delete_credential();

        entry.set_password("helix-test-secret").expect("set");
        assert_eq!(entry.get_password().expect("get"), "helix-test-secret");

        entry.delete_credential().expect("delete");
        assert!(matches!(entry.get_password(), Err(KeyringError::NoEntry)));
    }
}
