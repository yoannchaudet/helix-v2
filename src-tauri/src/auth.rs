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

use crate::db::Db;
use crate::settings;

/// Whether the PAT is stored unencrypted (dev/SQLite) rather than in the Keychain.
///
/// Surfaced to the frontend so the Settings page can warn the user. Compile-time constant:
/// `true` in debug builds, `false` in release.
pub fn storage_is_unencrypted() -> bool {
    cfg!(debug_assertions)
}

// The token functions take the `Db` mutex (not a held `&Connection`) so that the *release*
// path can do its Keychain I/O **without** holding the SQLite lock — keeping a potentially
// slow OS call off the critical section that other DB-backed commands contend for. Only the
// dev/SQLite path acquires the lock, and only briefly.

/// Store (or replace) the PAT.
pub fn store_token(db: &Db, token: &str) -> Result<(), String> {
    if storage_is_unencrypted() {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        settings::set_string(&conn, settings::KEY_DEV_GITHUB_PAT, token)
            .map_err(|e| format!("failed to store token: {e}"))
    } else {
        keychain::store(token)
    }
}

/// Read the PAT, returning `None` when none is stored.
pub fn read_token(db: &Db) -> Result<Option<String>, String> {
    if storage_is_unencrypted() {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        settings::get_string(&conn, settings::KEY_DEV_GITHUB_PAT)
            .map_err(|e| format!("failed to read token: {e}"))
    } else {
        keychain::read()
    }
}

/// Whether a PAT is currently stored.
pub fn has_token(db: &Db) -> Result<bool, String> {
    Ok(read_token(db)?.is_some())
}

/// Remove the stored PAT. A missing entry is treated as success.
pub fn delete_token(db: &Db) -> Result<(), String> {
    if storage_is_unencrypted() {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        settings::delete_key(&conn, settings::KEY_DEV_GITHUB_PAT)
            .map_err(|e| format!("failed to delete token: {e}"))
    } else {
        // Keychain I/O first, with no lock held; then a brief lock only to scrub any
        // plaintext dev token a prior debug run may have left in the shared SQLite DB.
        keychain::delete()?;
        if let Ok(conn) = db.0.lock() {
            let _ = settings::delete_key(&conn, settings::KEY_DEV_GITHUB_PAT);
        }
        Ok(())
    }
}

/// Remove a token left behind by the *inactive* backend. Run once at startup, when only a
/// raw `Connection` is available (before it is wrapped in [`Db`]).
///
/// In release builds this deletes any plaintext dev PAT that a previous **debug** run on
/// this machine may have written to the shared SQLite database, so a release build never
/// silently carries an unencrypted token. In debug builds it is a deliberate no-op: we must
/// not touch the Keychain (that would reintroduce the very prompt this design avoids), and
/// a stale Keychain item is harmless — the SQLite backend is authoritative in dev.
pub fn purge_inactive_token(conn: &Connection) -> Result<(), String> {
    if !storage_is_unencrypted() {
        settings::delete_key(conn, settings::KEY_DEV_GITHUB_PAT)
            .map_err(|e| format!("failed to purge stale dev token: {e}"))?;
    }
    Ok(())
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

// These tests cover the dev/SQLite backend, which is only compiled in debug builds. Gating
// the whole module on `debug_assertions` (rather than skipping at runtime) means they are
// always meaningful when present and never silently pass under `cargo test --release`.
#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use crate::db;

    fn mem_db() -> Db {
        let conn = Connection::open_in_memory().unwrap();
        for m in db::migrations() {
            conn.execute_batch(m).unwrap();
        }
        Db(std::sync::Mutex::new(conn))
    }

    /// The dev/SQLite backend round-trips store -> read -> has -> delete.
    #[test]
    fn sqlite_backend_round_trip() {
        let db = mem_db();

        assert!(!has_token(&db).unwrap());
        assert_eq!(read_token(&db).unwrap(), None);

        store_token(&db, "ghp_dev_secret").unwrap();
        assert!(has_token(&db).unwrap());
        assert_eq!(read_token(&db).unwrap().as_deref(), Some("ghp_dev_secret"));

        // The PAT lives under its own key, distinct from user-facing settings.
        assert_eq!(
            settings::get_string(&db.0.lock().unwrap(), settings::KEY_DEV_GITHUB_PAT)
                .unwrap()
                .as_deref(),
            Some("ghp_dev_secret")
        );

        delete_token(&db).unwrap();
        assert!(!has_token(&db).unwrap());
        assert_eq!(read_token(&db).unwrap(), None);
    }

    /// `purge_inactive_token` is a no-op in debug builds — the dev/SQLite token must survive
    /// (only release builds purge it). The release-side deletion can't run under a debug
    /// `cargo test`, but the function is a thin `delete_key`, so a debug no-op assertion
    /// plus review covers it.
    #[test]
    fn purge_is_noop_in_debug() {
        let db = mem_db();
        store_token(&db, "ghp_dev_secret").unwrap();
        purge_inactive_token(&db.0.lock().unwrap()).unwrap();
        // The dev token must still be there in debug builds.
        assert_eq!(read_token(&db).unwrap().as_deref(), Some("ghp_dev_secret"));
    }
}
