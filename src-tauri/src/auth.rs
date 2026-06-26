//! Secret storage for the GitHub Personal Access Token.
//!
//! The storage backend is chosen at **compile time**:
//!
//! * **Release builds** keep the PAT in the macOS login Keychain (via `keyring-core` +
//!   the Apple native store), never writing it to SQLite — the secure default.
//! * **Debug builds** (`cargo` / `tauri dev`, i.e. `cfg!(debug_assertions)`) store the
//!   PAT **unencrypted** in the SQLite `settings` table instead. This deliberately trades
//!   security for developer sanity: the Keychain re-prompts on every rebuild (its ACL
//!   partition list pins per-build code hashes for a no-Team-ID self-signed binary), which
//!   is unworkable during iterative development. The Settings UI shows a prominent warning
//!   whenever this unencrypted path is active (see `storage_is_unencrypted`).
//!
//! The PAT is never written to SQLite in release, never logged, and never returned by
//! `get_settings` (it lives under its own key — see `settings::KEY_DEV_GITHUB_PAT`).

use rusqlite::Connection;

use crate::settings;

/// Whether the PAT is stored unencrypted (dev/SQLite) rather than in the Keychain.
///
/// Surfaced to the frontend so the Settings page can warn the user. Compile-time constant:
/// `true` in debug builds, `false` in release.
pub fn storage_is_unencrypted() -> bool {
    cfg!(debug_assertions)
}

/// Store (or replace) the PAT.
pub fn store_token(conn: &Connection, token: &str) -> Result<(), String> {
    if storage_is_unencrypted() {
        settings::set_string(conn, settings::KEY_DEV_GITHUB_PAT, token)
            .map_err(|e| format!("failed to store token: {e}"))
    } else {
        keychain::store(token)
    }
}

/// Read the PAT, returning `None` when none is stored.
pub fn read_token(conn: &Connection) -> Result<Option<String>, String> {
    if storage_is_unencrypted() {
        settings::get_string(conn, settings::KEY_DEV_GITHUB_PAT)
            .map_err(|e| format!("failed to read token: {e}"))
    } else {
        keychain::read()
    }
}

/// Whether a PAT is currently stored.
pub fn has_token(conn: &Connection) -> Result<bool, String> {
    Ok(read_token(conn)?.is_some())
}

/// Remove the stored PAT. A missing entry is treated as success.
pub fn delete_token(conn: &Connection) -> Result<(), String> {
    if storage_is_unencrypted() {
        settings::delete_key(conn, settings::KEY_DEV_GITHUB_PAT)
            .map_err(|e| format!("failed to delete token: {e}"))
    } else {
        keychain::delete()
    }
}

/// macOS Keychain backend (used by release builds).
mod keychain {
    use keyring_core::{Entry, Error as KeyringError};

    /// Keychain service identifier (matches the app bundle id for clarity in Keychain Access).
    const SERVICE: &str = "com.yoannchaudet.helix";
    /// Account name under which the PAT is stored.
    const ACCOUNT: &str = "github-pat";

    fn entry() -> Result<Entry, String> {
        Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keychain error: {e}"))
    }

    pub fn store(token: &str) -> Result<(), String> {
        entry()?
            .set_password(token)
            .map_err(|e| format!("failed to store token: {e}"))
    }

    pub fn read() -> Result<Option<String>, String> {
        match entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => Err(format!("failed to read token: {e}")),
        }
    }

    pub fn delete() -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(format!("failed to delete token: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for m in db::migrations() {
            conn.execute_batch(m).unwrap();
        }
        conn
    }

    /// The dev/SQLite backend round-trips store -> read -> has -> delete. This is the path
    /// exercised by `cargo test` (a debug build), so it covers the default test behavior.
    #[test]
    fn sqlite_backend_round_trip() {
        // Only meaningful when the dev backend is active (debug builds).
        if !storage_is_unencrypted() {
            return;
        }
        let conn = mem_conn();

        assert!(!has_token(&conn).unwrap());
        assert_eq!(read_token(&conn).unwrap(), None);

        store_token(&conn, "ghp_dev_secret").unwrap();
        assert!(has_token(&conn).unwrap());
        assert_eq!(read_token(&conn).unwrap().as_deref(), Some("ghp_dev_secret"));

        // The PAT lives under its own key, distinct from user-facing settings.
        assert_eq!(
            settings::get_string(&conn, settings::KEY_DEV_GITHUB_PAT)
                .unwrap()
                .as_deref(),
            Some("ghp_dev_secret")
        );

        delete_token(&conn).unwrap();
        assert!(!has_token(&conn).unwrap());
        assert_eq!(read_token(&conn).unwrap(), None);
    }
}
