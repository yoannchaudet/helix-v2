use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SloDipsCategory {
    pub id: String,
    pub name: String,
    pub emoji: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SloDipsRepository {
    pub id: i64,
    pub full_name: String,
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub categories: Vec<SloDipsCategory>,
}

pub fn list_repositories(conn: &Connection) -> rusqlite::Result<Vec<SloDipsRepository>> {
    let mut stmt = conn.prepare(
        "SELECT repo_id, full_name, owner, name, private
         FROM slo_dips_repos
         ORDER BY full_name COLLATE NOCASE ASC",
    )?;
    let repositories = stmt
        .query_map([], |row| {
            Ok(SloDipsRepository {
                id: row.get(0)?,
                full_name: row.get(1)?,
                owner: row.get(2)?,
                name: row.get(3)?,
                private: row.get(4)?,
                categories: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    repositories
        .into_iter()
        .map(|mut repository| {
            repository.categories = list_categories(conn, repository.id)?;
            Ok(repository)
        })
        .collect()
}

pub fn get_repository(
    conn: &Connection,
    repo_id: i64,
) -> rusqlite::Result<Option<SloDipsRepository>> {
    let mut repository = conn
        .query_row(
            "SELECT repo_id, full_name, owner, name, private
             FROM slo_dips_repos WHERE repo_id = ?1",
            [repo_id],
            |row| {
                Ok(SloDipsRepository {
                    id: row.get(0)?,
                    full_name: row.get(1)?,
                    owner: row.get(2)?,
                    name: row.get(3)?,
                    private: row.get(4)?,
                    categories: Vec::new(),
                })
            },
        )
        .optional()?;
    if let Some(repository) = repository.as_mut() {
        repository.categories = list_categories(conn, repository.id)?;
    }
    Ok(repository)
}

fn list_categories(conn: &Connection, repo_id: i64) -> rusqlite::Result<Vec<SloDipsCategory>> {
    let mut stmt = conn.prepare(
        "SELECT category_id, name, emoji
         FROM slo_dips_repo_categories
         WHERE repo_id = ?1
         ORDER BY name COLLATE NOCASE ASC, category_id ASC",
    )?;
    let categories = stmt
        .query_map([repo_id], |row| {
            Ok(SloDipsCategory {
                id: row.get(0)?,
                name: row.get(1)?,
                emoji: row.get(2)?,
            })
        })?
        .collect();
    categories
}

pub fn add_repository(
    conn: &Connection,
    repository: &SloDipsRepository,
) -> rusqlite::Result<SloDipsRepository> {
    let tx = conn.unchecked_transaction()?;
    let exists = tx
        .query_row(
            "SELECT 1 FROM slo_dips_repos WHERE repo_id = ?1 OR full_name = ?2",
            params![repository.id, repository.full_name],
            |_| Ok(()),
        )
        .optional()?
        .is_some();

    if !exists {
        tx.execute(
            "INSERT INTO slo_dips_repos
                (repo_id, full_name, owner, name, private, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%SZ','now'))",
            params![
                repository.id,
                repository.full_name,
                repository.owner,
                repository.name,
                repository.private
            ],
        )?;
        insert_categories(&tx, repository.id, &repository.categories)?;
    }
    tx.commit()?;

    get_repository(conn, repository.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn replace_categories(
    conn: &Connection,
    repo_id: i64,
    categories: &[SloDipsCategory],
) -> rusqlite::Result<SloDipsRepository> {
    let tx = conn.unchecked_transaction()?;
    let exists = tx
        .query_row(
            "SELECT 1 FROM slo_dips_repos WHERE repo_id = ?1",
            [repo_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    tx.execute(
        "DELETE FROM slo_dips_repo_categories WHERE repo_id = ?1",
        [repo_id],
    )?;
    insert_categories(&tx, repo_id, categories)?;
    tx.commit()?;
    get_repository(conn, repo_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

fn insert_categories(
    conn: &Connection,
    repo_id: i64,
    categories: &[SloDipsCategory],
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        "INSERT INTO slo_dips_repo_categories (repo_id, category_id, name, emoji)
         VALUES (?1, ?2, ?3, ?4)",
    )?;
    for category in categories {
        stmt.execute(params![repo_id, category.id, category.name, category.emoji])?;
    }
    Ok(())
}

pub fn remove_repository(conn: &Connection, repo_id: i64) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM slo_dips_repos WHERE repo_id = ?1", [repo_id])? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch(
            "CREATE TABLE slo_dips_repos (
                repo_id INTEGER PRIMARY KEY, full_name TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
                name TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL
             );
             CREATE TABLE slo_dips_repo_categories (
                repo_id INTEGER NOT NULL REFERENCES slo_dips_repos(repo_id) ON DELETE CASCADE,
                category_id TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (repo_id, category_id)
             );",
        )
        .unwrap();
        conn
    }

    fn repository(categories: &[(&str, &str)]) -> SloDipsRepository {
        SloDipsRepository {
            id: 42,
            full_name: "octo/repo".into(),
            owner: "octo".into(),
            name: "repo".into(),
            private: true,
            categories: categories
                .iter()
                .map(|(id, name)| SloDipsCategory {
                    id: (*id).into(),
                    name: (*name).into(),
                    emoji: "📈".into(),
                })
                .collect(),
        }
    }

    #[test]
    fn add_list_replace_and_remove_are_atomic() {
        let conn = database();
        let added =
            add_repository(&conn, &repository(&[("a", "Incidents"), ("b", "SLO")])).unwrap();
        assert_eq!(added.categories.len(), 2);
        assert!(added.private);

        let replacement = vec![SloDipsCategory {
            id: "c".into(),
            name: "Reliability".into(),
            emoji: "🛡️".into(),
        }];
        let updated = replace_categories(&conn, 42, &replacement).unwrap();
        assert_eq!(updated.categories, replacement);

        assert!(remove_repository(&conn, 42).unwrap());
        assert!(list_repositories(&conn).unwrap().is_empty());
        let categories: i64 = conn
            .query_row("SELECT COUNT(*) FROM slo_dips_repo_categories", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(categories, 0);
    }

    #[test]
    fn duplicate_add_preserves_original_categories() {
        let conn = database();
        add_repository(&conn, &repository(&[("a", "Original")])).unwrap();
        let duplicate = add_repository(&conn, &repository(&[("b", "Replacement")])).unwrap();
        assert_eq!(duplicate.categories[0].name, "Original");
    }
}
