use crate::command_error::{lock_conn, CommandError, CommandResult};
use crate::db::Db;
use crate::{auth, github, slo_dips, sync, AppState};
use std::collections::BTreeSet;
use tauri::State;

const STALE_CATEGORIES_ERROR: &str = "SLO_DIPS_STALE_CATEGORIES: One or more selected Discussion categories are no longer available. Reload the categories and try again.";

pub fn parse_repository_input(input: &str) -> CommandResult<(String, String)> {
    let input = input.trim();
    let mut parts = input.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner.is_empty()
        || name.is_empty()
        || parts.next().is_some()
        || !owner
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == '.'
        })
    {
        return Err(CommandError::from(
            "Enter a repository as org/repo-name (for example, github/docs).",
        ));
    }
    Ok((owner.to_string(), name.to_string()))
}

async fn inspect_core<Fetch, Fut>(
    db: &Db,
    repository: String,
    fetch: Fetch,
) -> CommandResult<github::RepositoryInspection>
where
    Fetch: FnOnce(String, String, String) -> Fut,
    Fut: std::future::Future<Output = Result<github::RepositoryInspection, github::GitHubError>>,
{
    let (owner, name) = parse_repository_input(&repository)?;
    let token = auth::read_token(db)?
        .ok_or_else(|| CommandError::from("Not connected — add a GitHub token first."))?;
    let inspection = fetch(token, owner, name).await?;
    persist_rates(db, &inspection.rates)?;
    Ok(inspection)
}

fn persist_rates(db: &Db, rates: &[github::RateLimit]) -> CommandResult<()> {
    let conn = lock_conn(&db.0)?;
    for rate in rates {
        sync::upsert_rate(&conn, rate)?;
    }
    Ok(())
}

fn selected_categories(
    inspection: &github::RepositoryInspection,
    selected_ids: Vec<String>,
) -> CommandResult<Vec<slo_dips::SloDipsCategory>> {
    let selected_ids: BTreeSet<_> = selected_ids.into_iter().collect();
    if selected_ids.is_empty() {
        return Err(CommandError::from(
            "Select at least one GitHub Discussion category.",
        ));
    }
    let categories: Vec<_> = inspection
        .categories
        .iter()
        .filter(|category| selected_ids.contains(&category.id))
        .map(|category| slo_dips::SloDipsCategory {
            id: category.id.clone(),
            name: category.name.clone(),
            emoji: category.emoji.clone(),
            emoji_url: category.emoji_url.clone(),
        })
        .collect();
    if categories.len() != selected_ids.len() {
        return Err(CommandError::from(STALE_CATEGORIES_ERROR));
    }
    Ok(categories)
}

#[tauri::command]
pub fn list_slo_dips_repos(
    state: State<'_, AppState>,
) -> CommandResult<Vec<slo_dips::SloDipsRepository>> {
    let conn = lock_conn(&state.db.0)?;
    Ok(slo_dips::list_repositories(&conn)?)
}

#[tauri::command]
pub async fn inspect_slo_dips_repo(
    repository: String,
    state: State<'_, AppState>,
) -> CommandResult<github::RepositoryInspection> {
    let client = reqwest::Client::new();
    inspect_core(
        &state.db,
        repository,
        move |token, owner, name| async move {
            github::inspect_repository(&client, &token, &owner, &name).await
        },
    )
    .await
}

#[tauri::command]
pub async fn add_slo_dips_repo(
    repository: String,
    category_ids: Vec<String>,
    state: State<'_, AppState>,
) -> CommandResult<slo_dips::SloDipsRepository> {
    let client = reqwest::Client::new();
    let inspection = inspect_core(
        &state.db,
        repository,
        move |token, owner, name| async move {
            github::inspect_repository(&client, &token, &owner, &name).await
        },
    )
    .await?;
    if inspection.categories.is_empty() {
        return Err(CommandError::from(
            "This repository has no GitHub Discussion categories. Enable Discussions and add a category first.",
        ));
    }
    let categories = selected_categories(&inspection, category_ids)?;
    let repository = slo_dips::SloDipsRepository {
        id: inspection.repository.id,
        full_name: inspection.repository.full_name,
        owner: inspection.repository.owner,
        name: inspection.repository.name,
        private: inspection.repository.private,
        categories,
    };
    let conn = lock_conn(&state.db.0)?;
    Ok(slo_dips::add_repository(&conn, &repository)?)
}

#[tauri::command]
pub async fn update_slo_dips_repo_categories(
    repo_id: i64,
    category_ids: Vec<String>,
    state: State<'_, AppState>,
) -> CommandResult<slo_dips::SloDipsRepository> {
    let stored = {
        let conn = lock_conn(&state.db.0)?;
        slo_dips::get_repository(&conn, repo_id)?
            .ok_or_else(|| CommandError::from("SLO Dips repository not found."))?
    };
    let token = auth::read_token(&state.db)?
        .ok_or_else(|| CommandError::from("Not connected — add a GitHub token first."))?;
    let client = reqwest::Client::new();
    let inspection =
        github::inspect_repository(&client, &token, &stored.owner, &stored.name).await?;
    persist_rates(&state.db, &inspection.rates)?;
    let categories = selected_categories(&inspection, category_ids)?;
    let conn = lock_conn(&state.db.0)?;
    Ok(slo_dips::replace_categories(&conn, repo_id, &categories)?)
}

#[tauri::command]
pub fn remove_slo_dips_repo(repo_id: i64, state: State<'_, AppState>) -> CommandResult<()> {
    let conn = lock_conn(&state.db.0)?;
    if !slo_dips::remove_repository(&conn, repo_id)? {
        return Err(CommandError::from("SLO Dips repository not found."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_input_requires_exact_github_shape() {
        assert_eq!(
            parse_repository_input(" github/docs ").unwrap(),
            ("github".into(), "docs".into())
        );
        for invalid in [
            "",
            "github",
            "/docs",
            "github/",
            "a/b/c",
            "https://github.com/a/b",
        ] {
            assert!(parse_repository_input(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn category_selection_rejects_empty_and_stale_ids() {
        let inspection = github::RepositoryInspection {
            repository: github::RepositoryMetadata {
                id: 1,
                full_name: "a/b".into(),
                owner: "a".into(),
                name: "b".into(),
                private: false,
            },
            categories: vec![github::DiscussionCategory {
                id: "one".into(),
                name: "One".into(),
                emoji: String::new(),
                emoji_url: None,
                description: None,
                is_answerable: false,
            }],
            rates: Vec::new(),
        };
        assert!(selected_categories(&inspection, Vec::new()).is_err());
        assert!(selected_categories(&inspection, vec!["missing".into()]).is_err());
        assert_eq!(
            selected_categories(&inspection, vec!["one".into()])
                .unwrap()
                .len(),
            1
        );
    }
}
