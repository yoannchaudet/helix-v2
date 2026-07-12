use serde::ser::{Serialize, Serializer};

use crate::github::GitHubError;

/// Typed backend error for Tauri command flows.
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("{0}")]
    Message(String),
    #[error("database lock poisoned: {0}")]
    DbLockPoisoned(String),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    GitHub(#[from] GitHubError),
}

pub type CommandResult<T> = Result<T, CommandError>;

/// Lock the SQLite connection and map poisoned locks into a typed command error.
pub fn lock_conn(
    db: &std::sync::Mutex<rusqlite::Connection>,
) -> CommandResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    db.lock()
        .map_err(|error| CommandError::DbLockPoisoned(error.to_string()))
}

impl From<String> for CommandError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

impl From<&str> for CommandError {
    fn from(value: &str) -> Self {
        Self::Message(value.to_string())
    }
}

impl From<CommandError> for String {
    fn from(value: CommandError) -> Self {
        value.to_string()
    }
}

// Keep the IPC boundary shape stable: frontend still receives error strings.
impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::CommandError;
    use crate::github::GitHubError;

    #[test]
    fn serializes_as_error_string() {
        let serialized = serde_json::to_string(&CommandError::from("typed message")).unwrap();
        assert_eq!(serialized, "\"typed message\"");
    }

    #[test]
    fn serializes_non_message_variants_as_strings() {
        let poisoned = CommandError::DbLockPoisoned("mutex".to_string());
        assert_eq!(
            serde_json::to_string(&poisoned).unwrap(),
            "\"database lock poisoned: mutex\""
        );

        let github = CommandError::GitHub(GitHubError::Unauthorized);
        assert_eq!(
            serde_json::to_string(&github).unwrap(),
            "\"Invalid or expired token — GitHub returned 401.\""
        );
    }
}
