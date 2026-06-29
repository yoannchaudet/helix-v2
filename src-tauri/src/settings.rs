//! Application settings persisted in SQLite.
//!
//! Non-secret preferences live here. The PAT is **not** a setting in the usual sense:
//! release builds keep it in the Keychain, while debug builds store it unencrypted under
//! `KEY_DEV_GITHUB_PAT` (see `auth.rs`). Either way it is never returned by `get_settings`.
//! Simple key/value pairs go in the `settings` table; the polling cadence lives in
//! `sync_state.poll_interval_s` (per the schema in `docs/design.md` §3).

use rusqlite::{Connection, OptionalExtension};

/// Settings keys.
pub const KEY_GITHUB_LOGIN: &str = "github_login";
pub const KEY_WINDOW_WIDTH: &str = "window_width";
pub const KEY_WINDOW_HEIGHT: &str = "window_height";
/// Appearance preference: `system` (default), `light`, or `dark`.
pub const KEY_THEME: &str = "theme";
/// Dev-only: the PAT stored *unencrypted* in SQLite for debug builds (see `auth.rs`).
/// Release builds keep the PAT in the Keychain and never use this key.
pub const KEY_DEV_GITHUB_PAT: &str = "dev_github_pat";

/// Lower bound for the polling interval, to avoid hammering the API.
pub const MIN_POLL_INTERVAL_S: i64 = 10;

/// Default appearance preference when none is stored.
pub const DEFAULT_THEME: &str = "system";

/// The accepted appearance preferences.
pub const THEMES: [&str; 3] = ["system", "light", "dark"];

/// Whether `value` is a recognized appearance preference.
pub fn is_valid_theme(value: &str) -> bool {
    THEMES.contains(&value)
}

/// Current appearance preference, defaulting to `system` when unset or invalid.
pub fn get_theme(conn: &Connection) -> rusqlite::Result<String> {
    Ok(get_string(conn, KEY_THEME)?
        .filter(|v| is_valid_theme(v))
        .unwrap_or_else(|| DEFAULT_THEME.to_string()))
}

/// Read a string setting, or `None` if unset.
pub fn get_string(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .optional()
}

/// Insert or update a string setting.
pub fn set_string(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )?;
    Ok(())
}

/// Delete a setting if present.
pub fn delete_key(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
}

/// Current polling interval (seconds) from `sync_state`.
pub fn get_poll_interval(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT poll_interval_s FROM sync_state WHERE id = 1",
        [],
        |row| row.get(0),
    )
}

/// Update the polling interval (seconds) in `sync_state`.
pub fn set_poll_interval(conn: &Connection, seconds: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sync_state SET poll_interval_s = ?1 WHERE id = 1",
        [seconds],
    )?;
    Ok(())
}

/// Read the persisted window size (logical pixels), or `None` if either dimension is
/// unset or unparseable. Used to restore the window to its last size on launch.
pub fn get_window_size(conn: &Connection) -> rusqlite::Result<Option<(u32, u32)>> {
    let width = get_string(conn, KEY_WINDOW_WIDTH)?.and_then(|v| v.parse::<u32>().ok());
    let height = get_string(conn, KEY_WINDOW_HEIGHT)?.and_then(|v| v.parse::<u32>().ok());
    Ok(match (width, height) {
        (Some(w), Some(h)) => Some((w, h)),
        _ => None,
    })
}

/// Persist the window size (logical pixels) so the next launch reopens at the same size.
pub fn set_window_size(conn: &Connection, width: u32, height: u32) -> rusqlite::Result<()> {
    set_string(conn, KEY_WINDOW_WIDTH, &width.to_string())?;
    set_string(conn, KEY_WINDOW_HEIGHT, &height.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn mem_conn() -> Connection {
        // Reuse the real migrations against an in-memory database.
        let conn = Connection::open_in_memory().unwrap();
        // open_and_migrate works on a path; replicate its migration step here.
        let mut version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        let migrations = db::migrations();
        while (version as usize) < migrations.len() {
            conn.execute_batch(migrations[version as usize]).unwrap();
            version += 1;
            conn.pragma_update(None, "user_version", version).unwrap();
        }
        conn
    }

    #[test]
    fn string_round_trip_and_delete() {
        let conn = mem_conn();
        assert_eq!(get_string(&conn, KEY_GITHUB_LOGIN).unwrap(), None);
        set_string(&conn, KEY_GITHUB_LOGIN, "octocat").unwrap();
        assert_eq!(
            get_string(&conn, KEY_GITHUB_LOGIN).unwrap(),
            Some("octocat".to_string())
        );
        // Upsert overwrites.
        set_string(&conn, KEY_GITHUB_LOGIN, "monalisa").unwrap();
        assert_eq!(
            get_string(&conn, KEY_GITHUB_LOGIN).unwrap(),
            Some("monalisa".to_string())
        );
        delete_key(&conn, KEY_GITHUB_LOGIN).unwrap();
        assert_eq!(get_string(&conn, KEY_GITHUB_LOGIN).unwrap(), None);
    }

    #[test]
    fn poll_interval_defaults_and_updates() {
        let conn = mem_conn();
        assert_eq!(get_poll_interval(&conn).unwrap(), 60); // seeded default
        set_poll_interval(&conn, 120).unwrap();
        assert_eq!(get_poll_interval(&conn).unwrap(), 120);
    }

    #[test]
    fn window_size_round_trip() {
        let conn = mem_conn();
        // Unset until both dimensions are stored.
        assert_eq!(get_window_size(&conn).unwrap(), None);
        set_window_size(&conn, 1024, 768).unwrap();
        assert_eq!(get_window_size(&conn).unwrap(), Some((1024, 768)));
        // Overwrites on subsequent saves.
        set_window_size(&conn, 800, 600).unwrap();
        assert_eq!(get_window_size(&conn).unwrap(), Some((800, 600)));

        // A non-numeric stored value is treated as unset.
        set_string(&conn, KEY_WINDOW_WIDTH, "garbage").unwrap();
        assert_eq!(get_window_size(&conn).unwrap(), None);
    }

    #[test]
    fn theme_defaults_validates_and_round_trips() {
        let conn = mem_conn();
        // Defaults to `system` when unset.
        assert_eq!(get_theme(&conn).unwrap(), "system");

        // Round-trips each valid value.
        for theme in THEMES {
            assert!(is_valid_theme(theme));
            set_string(&conn, KEY_THEME, theme).unwrap();
            assert_eq!(get_theme(&conn).unwrap(), theme);
        }

        // An unrecognized stored value falls back to the default rather than leaking through.
        assert!(!is_valid_theme("solarized"));
        set_string(&conn, KEY_THEME, "solarized").unwrap();
        assert_eq!(get_theme(&conn).unwrap(), "system");
    }
}
