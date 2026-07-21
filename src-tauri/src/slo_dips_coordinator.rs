use crate::command_error::{lock_conn, CommandError, CommandResult};
use crate::db::Db;
use crate::{auth, github, slo_dips, sync, AppState};
use std::collections::BTreeSet;
use tauri::State;

const STALE_CATEGORIES_ERROR: &str = "SLO_DIPS_STALE_CATEGORIES: One or more selected Discussion categories are no longer available. Reload the categories and try again.";

/// The floating window (in days) of SLO dips we retain and display.
pub const SLO_DIPS_WINDOW_DAYS: i64 = 60;
/// Extra head-room when deciding which Discussions to fetch: a "Week of …" thread can hold
/// dips dated a few days before it was opened, so we look slightly further back than the
/// display window and let the dip-date prune trim anything that falls outside it.
const SLO_DIPS_FETCH_BUFFER_DAYS: i64 = 10;

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

/// Compute the two window boundaries as SQLite-formatted strings: the `dip_date` prune cutoff
/// (the display window) and the discussion `createdAt` fetch cutoff (window + buffer). Both come
/// from SQLite so "now" is consistent with the timestamps we store.
fn window_cutoffs(conn: &rusqlite::Connection) -> rusqlite::Result<(String, String)> {
    let dip_cutoff: String = conn.query_row(
        "SELECT date('now', ?1)",
        rusqlite::params![format!("-{SLO_DIPS_WINDOW_DAYS} days")],
        |row| row.get(0),
    )?;
    let fetch_after: String = conn.query_row(
        "SELECT strftime('%Y-%m-%dT00:00:00Z', date('now', ?1))",
        rusqlite::params![format!(
            "-{} days",
            SLO_DIPS_WINDOW_DAYS + SLO_DIPS_FETCH_BUFFER_DAYS
        )],
        |row| row.get(0),
    )?;
    Ok((dip_cutoff, fetch_after))
}

/// Turn one repository's fetched Discussions into stored dips: parse the bot's dip comments,
/// derive investigation state from replies, and keep only dips inside the display window.
fn dips_from_discussions(
    repository: &slo_dips::SloDipsRepository,
    discussions: &[github::RawDiscussion],
    dip_cutoff: &str,
) -> Vec<slo_dips::SloDip> {
    let mut dips = Vec::new();
    for discussion in discussions {
        let service = slo_dips::parse_service_from_title(&discussion.title)
            .unwrap_or_else(|| repository.name.clone());
        for comment in &discussion.comments {
            if comment
                .author_login
                .as_deref()
                .is_none_or(|login| login != slo_dips::SLO_BOT_LOGIN)
            {
                continue;
            }
            let Some(parsed) = slo_dips::parse_dip_comment(&comment.body) else {
                continue;
            };
            if parsed.dip_date.as_str() < dip_cutoff {
                continue;
            }
            let investigation = slo_dips::investigation_from_replies(
                comment
                    .replies
                    .iter()
                    .map(|reply| (reply.author_login.as_deref(), reply.created_at.as_str())),
                slo_dips::SLO_BOT_LOGIN,
            );
            dips.push(slo_dips::SloDip {
                comment_id: comment.database_id,
                repo_id: repository.id,
                repo_full_name: repository.full_name.clone(),
                discussion_number: discussion.number,
                discussion_title: discussion.title.clone(),
                service: service.clone(),
                comment_url: comment.url.clone(),
                slo_name: parsed.slo_name,
                slo_url: parsed.slo_url,
                dip_date: parsed.dip_date,
                percent: parsed.percent,
                goal_percent: parsed.goal_percent,
                investigated: investigation.investigated,
                investigated_by: investigation.by,
                investigated_at: investigation.at,
                comment_created_at: comment.created_at.clone(),
            });
        }
    }
    dips
}

type FetchResult =
    Result<(Vec<github::RawDiscussion>, Vec<github::RateLimit>), github::GitHubError>;

/// Refresh every tracked repository's dips from GitHub and reconcile them into SQLite, then
/// return the current window. The network call is injected so this is unit-testable without
/// Tauri or HTTP. On any per-repository failure we abort before touching SQLite, leaving the
/// last good local state intact (offline-first).
async fn refresh_core<Fetch, Fut>(db: &Db, fetch: Fetch) -> CommandResult<Vec<slo_dips::SloDip>>
where
    Fetch: Fn(String, String, String, Vec<String>) -> Fut,
    Fut: std::future::Future<Output = FetchResult>,
{
    let token = auth::read_token(db)?
        .ok_or_else(|| CommandError::from("Not connected — add a GitHub token first."))?;

    let (repositories, dip_cutoff) = {
        let conn = lock_conn(&db.0)?;
        let (dip_cutoff, _) = window_cutoffs(&conn)?;
        (slo_dips::list_repositories(&conn)?, dip_cutoff)
    };

    let mut all_dips = Vec::new();
    let mut fetched_repo_ids = Vec::new();
    let mut all_rates = Vec::new();
    for repository in &repositories {
        fetched_repo_ids.push(repository.id);
        let category_ids: Vec<String> = repository
            .categories
            .iter()
            .map(|category| category.id.clone())
            .collect();
        if category_ids.is_empty() {
            continue;
        }
        let (discussions, rates) = fetch(
            token.clone(),
            repository.owner.clone(),
            repository.name.clone(),
            category_ids,
        )
        .await?;
        all_rates.extend(rates);
        all_dips.extend(dips_from_discussions(repository, &discussions, &dip_cutoff));
    }

    let conn = lock_conn(&db.0)?;
    for rate in &all_rates {
        sync::upsert_rate(&conn, rate)?;
    }
    slo_dips::reconcile_dips(&conn, &fetched_repo_ids, &all_dips, &dip_cutoff)?;
    Ok(slo_dips::list_dips(&conn, &dip_cutoff)?)
}

#[tauri::command]
pub fn list_slo_dips(state: State<'_, AppState>) -> CommandResult<Vec<slo_dips::SloDip>> {
    let conn = lock_conn(&state.db.0)?;
    let (dip_cutoff, _) = window_cutoffs(&conn)?;
    Ok(slo_dips::list_dips(&conn, &dip_cutoff)?)
}

#[tauri::command]
pub async fn refresh_slo_dips(state: State<'_, AppState>) -> CommandResult<Vec<slo_dips::SloDip>> {
    let client = reqwest::Client::new();
    // Recompute the fetch cutoff at call time so a long-lived app stays current.
    let fetch_after = {
        let conn = lock_conn(&state.db.0)?;
        window_cutoffs(&conn)?.1
    };
    refresh_core(&state.db, move |token, owner, name, category_ids| {
        let client = client.clone();
        let fetch_after = fetch_after.clone();
        async move {
            github::fetch_slo_dip_discussions(
                &client,
                &token,
                &owner,
                &name,
                &category_ids,
                &fetch_after,
            )
            .await
        }
    })
    .await
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

    fn tracked_repo() -> slo_dips::SloDipsRepository {
        slo_dips::SloDipsRepository {
            id: 1,
            full_name: "github/edge-foundation".into(),
            owner: "github".into(),
            name: "edge-foundation".into(),
            private: true,
            categories: vec![slo_dips::SloDipsCategory {
                id: "DIC_1".into(),
                name: "SLO Investigations".into(),
                emoji: ":microscope:".into(),
                emoji_url: None,
            }],
        }
    }

    fn dip_discussion() -> github::RawDiscussion {
        dip_discussion_dated("2026-04-19", "2026-04-20T00:00:00Z")
    }

    fn dip_discussion_dated(dip_date: &str, created_at: &str) -> github::RawDiscussion {
        github::RawDiscussion {
            number: 7585,
            title: "SLO investigations for `dns` - Week of April 13, 2026".into(),
            comments: vec![github::RawDiscussionComment {
                database_id: 16633787,
                url: "https://github.com/github/edge-foundation/discussions/7585#c".into(),
                author_login: Some("gh-slo-bot".into()),
                created_at: created_at.into(),
                body: format!(
                    "<!-- slo-dns-dns-global-api/availability/control-plane-sam-{dip_date} -->\n### {dip_date} - [dns-global-api/availability/control-plane-sam](https://dd) - 99.967%\nwas `99.967%` on {dip_date} which is below our goal of `99.99%`."
                ),
                replies: vec![github::RawReply {
                    author_login: Some("yoannchaudet".into()),
                    created_at: "2026-05-12T00:00:00Z".into(),
                }],
            }],
        }
    }

    #[test]
    fn dips_from_discussions_parses_service_investigation_and_window() {
        let repo = tracked_repo();
        let dips = dips_from_discussions(&repo, &[dip_discussion()], "2026-01-01");
        assert_eq!(dips.len(), 1);
        let dip = &dips[0];
        assert_eq!(dip.service, "dns");
        assert_eq!(
            dip.slo_name,
            "dns-global-api/availability/control-plane-sam"
        );
        assert!((dip.percent - 99.967).abs() < 1e-9);
        assert!(dip.investigated);
        assert_eq!(dip.investigated_by.as_deref(), Some("yoannchaudet"));

        // A cutoff after the dip date drops it.
        assert!(dips_from_discussions(&repo, &[dip_discussion()], "2026-05-01").is_empty());
    }

    #[test]
    fn dips_from_discussions_ignores_non_bot_comments() {
        let repo = tracked_repo();
        let mut discussion = dip_discussion();
        // A human comment whose body happens to look like a dip must not be collected.
        discussion.comments[0].author_login = Some("yoannchaudet".into());
        assert!(dips_from_discussions(&repo, &[discussion], "2026-01-01").is_empty());
    }

    #[cfg(debug_assertions)]
    mod refresh {
        use super::*;
        use crate::db::Db;
        use std::sync::Mutex;

        fn mem_db() -> Db {
            let conn = rusqlite::Connection::open_in_memory().unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            let mut version: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            let migrations = crate::db::migrations();
            while (version as usize) < migrations.len() {
                conn.execute_batch(migrations[version as usize]).unwrap();
                version += 1;
                conn.pragma_update(None, "user_version", version).unwrap();
            }
            Db(Mutex::new(conn))
        }

        #[test]
        fn refresh_core_reconciles_fetched_dips() {
            let db = mem_db();
            auth::store_token(&db, "test-token").unwrap();
            let recent = {
                let conn = db.0.lock().unwrap();
                slo_dips::add_repository(&conn, &tracked_repo()).unwrap();
                let date: String = conn
                    .query_row("SELECT date('now','-5 days')", [], |r| r.get(0))
                    .unwrap();
                date
            };
            let discussion = dip_discussion_dated(&recent, &format!("{recent}T00:00:00Z"));

            let dips = tauri::async_runtime::block_on(refresh_core(
                &db,
                move |_token, _owner, _name, category_ids| {
                    let discussion = discussion.clone();
                    async move {
                        assert_eq!(category_ids, vec!["DIC_1".to_string()]);
                        Ok((vec![discussion], Vec::new()))
                    }
                },
            ))
            .unwrap();

            assert_eq!(dips.len(), 1);
            assert_eq!(dips[0].comment_id, 16633787);
            assert!(dips[0].investigated);

            // Reading independently returns the reconciled row.
            let conn = db.0.lock().unwrap();
            let (cutoff, _) = window_cutoffs(&conn).unwrap();
            assert_eq!(slo_dips::list_dips(&conn, &cutoff).unwrap().len(), 1);
        }

        #[test]
        fn refresh_core_requires_a_token() {
            let db = mem_db();
            let result = tauri::async_runtime::block_on(refresh_core(&db, |_, _, _, _| async {
                Ok((Vec::new(), Vec::new()))
            }));
            assert!(result.is_err());
        }
    }
}
