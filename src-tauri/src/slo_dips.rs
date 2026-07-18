use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SloDipsCategory {
    pub id: String,
    pub name: String,
    pub emoji: String,
    pub emoji_url: Option<String>,
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
        "SELECT category_id, name, emoji, emoji_url
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
                emoji_url: row.get(3)?,
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
        "INSERT INTO slo_dips_repo_categories (repo_id, category_id, name, emoji, emoji_url)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for category in categories {
        stmt.execute(params![
            repo_id,
            category.id,
            category.name,
            category.emoji,
            category.emoji_url
        ])?;
    }
    Ok(())
}

pub fn remove_repository(conn: &Connection, repo_id: i64) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM slo_dips_repos WHERE repo_id = ?1", [repo_id])? > 0)
}

/// The GitHub login of the bot that opens the weekly threads and posts the dip comments.
/// A reply authored by anyone else counts as a human investigation.
pub const SLO_BOT_LOGIN: &str = "gh-slo-bot";

/// A single SLO dip parsed from one of the bot's Discussion comments, joined with its tracked
/// repository for display. This is the row the UI reads and the reconcile path writes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SloDip {
    pub comment_id: i64,
    pub repo_id: i64,
    #[serde(default)]
    pub repo_full_name: String,
    pub discussion_number: i64,
    pub discussion_title: String,
    pub service: String,
    pub comment_url: String,
    pub slo_name: String,
    pub slo_url: Option<String>,
    pub dip_date: String,
    pub percent: f64,
    pub goal_percent: Option<f64>,
    pub investigated: bool,
    pub investigated_by: Option<String>,
    pub investigated_at: Option<String>,
    pub comment_created_at: String,
}

/// The dip-specific fields extracted from a comment body's heading. Repository/discussion
/// context and investigation state are supplied by the caller.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedDip {
    pub dip_date: String,
    pub slo_name: String,
    pub slo_url: Option<String>,
    pub percent: f64,
    pub goal_percent: Option<f64>,
}

/// Whether a dip comment has been investigated, plus the earliest human responder.
#[derive(Debug, Clone, PartialEq)]
pub struct Investigation {
    pub investigated: bool,
    pub by: Option<String>,
    pub at: Option<String>,
}

/// Pull the service name out of a weekly thread title, e.g.
/// `` SLO investigations for `dns` - Week of April 13, 2026 `` → `dns`. Returns `None` when the
/// title doesn't carry a backtick-delimited service.
pub fn parse_service_from_title(title: &str) -> Option<String> {
    let start = title.find('`')? + 1;
    let end = title[start..].find('`')? + start;
    let service = title[start..end].trim();
    (!service.is_empty()).then(|| service.to_string())
}

/// Read the leading `<!-- marker -->` from a comment body, if present.
fn comment_marker(body: &str) -> Option<&str> {
    let rest = body.trim_start().strip_prefix("<!--")?;
    let end = rest.find("-->")?;
    Some(rest[..end].trim())
}

/// True when a marker denotes a real SLO dip (as opposed to the `slo-failures-…` /
/// `slo-investigate-…` automation-failure comments we intentionally ignore).
fn is_dip_marker(marker: &str) -> bool {
    marker.starts_with("slo-")
        && !marker.starts_with("slo-failures-")
        && !marker.starts_with("slo-investigate-")
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && value.char_indices().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == '-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// Parse a dip comment. Returns `Some` only for real dips: the comment must carry a
/// `<!-- slo-… -->` marker (and not a `slo-failures-…`/`slo-investigate-…` one) AND a
/// well-formed `### {date} - [{name}]({url}) - {pct}%` heading. Returns `None` for
/// failure/investigate comments, marker-less comments, or any body that doesn't match.
pub fn parse_dip_comment(body: &str) -> Option<ParsedDip> {
    let marker = comment_marker(body)?;
    if !is_dip_marker(marker) {
        return None;
    }
    let heading = body
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("###"))?;
    parse_dip_heading(heading, body)
}

fn parse_dip_heading(heading: &str, body: &str) -> Option<ParsedDip> {
    let rest = heading.trim_start_matches('#').trim_start();
    let (date, rest) = rest.split_once(" - ")?;
    let date = date.trim();
    if !is_iso_date(date) {
        return None;
    }
    let rest = rest.trim_start().strip_prefix('[')?;
    let (slo_name, rest) = rest.split_once("](")?;
    let (slo_url, rest) = rest.split_once(')')?;
    let percent = rest
        .trim_start()
        .trim_start_matches('-')
        .trim()
        .strip_suffix('%')?
        .trim()
        .parse::<f64>()
        .ok()?;
    let slo_name = slo_name.trim();
    if slo_name.is_empty() {
        return None;
    }
    Some(ParsedDip {
        dip_date: date.to_string(),
        slo_name: slo_name.to_string(),
        slo_url: Some(slo_url.trim().to_string()).filter(|url| !url.is_empty()),
        percent,
        goal_percent: parse_goal_percent(body),
    })
}

/// Best-effort extraction of the goal threshold from the prose (``…below our goal of `99.99%```).
fn parse_goal_percent(body: &str) -> Option<f64> {
    let start = body.find("goal of")? + "goal of".len();
    let rest = body[start..].trim_start().strip_prefix('`')?;
    let end = rest.find('`')?;
    rest[..end].trim().strip_suffix('%')?.trim().parse().ok()
}

/// Derive investigation state from a dip comment's replies. A reply authored by anyone other
/// than the bot marks the dip investigated; we keep the earliest such responder.
pub fn investigation_from_replies<'a>(
    replies: impl IntoIterator<Item = (Option<&'a str>, &'a str)>,
    bot_login: &str,
) -> Investigation {
    let mut earliest: Option<(&str, &str)> = None;
    for (login, created_at) in replies {
        let Some(login) = login.map(str::trim).filter(|l| !l.is_empty()) else {
            continue;
        };
        if login == bot_login {
            continue;
        }
        if earliest.is_none_or(|(_, at)| created_at < at) {
            earliest = Some((login, created_at));
        }
    }
    match earliest {
        Some((login, at)) => Investigation {
            investigated: true,
            by: Some(login.to_string()),
            at: Some(at.to_string()),
        },
        None => Investigation {
            investigated: false,
            by: None,
            at: None,
        },
    }
}

/// Reconcile a fresh fetch into SQLite: upsert every dip we saw, drop window rows for the
/// fetched repositories that GitHub no longer returns (deleted comments), and prune everything
/// older than `cutoff` (the floating window). All in one transaction so a reader never sees a
/// half-applied refresh.
pub fn reconcile_dips(
    conn: &Connection,
    fetched_repo_ids: &[i64],
    dips: &[SloDip],
    cutoff: &str,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for dip in dips {
        tx.execute(
            "INSERT INTO slo_dips
                (comment_id, repo_id, discussion_number, discussion_title, service,
                 comment_url, slo_name, slo_url, dip_date, percent, goal_percent,
                 investigated, investigated_by, investigated_at, comment_created_at, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             ON CONFLICT(comment_id) DO UPDATE SET
                repo_id = excluded.repo_id,
                discussion_number = excluded.discussion_number,
                discussion_title = excluded.discussion_title,
                service = excluded.service,
                comment_url = excluded.comment_url,
                slo_name = excluded.slo_name,
                slo_url = excluded.slo_url,
                dip_date = excluded.dip_date,
                percent = excluded.percent,
                goal_percent = excluded.goal_percent,
                investigated = excluded.investigated,
                investigated_by = excluded.investigated_by,
                investigated_at = excluded.investigated_at,
                comment_created_at = excluded.comment_created_at,
                fetched_at = excluded.fetched_at",
            params![
                dip.comment_id,
                dip.repo_id,
                dip.discussion_number,
                dip.discussion_title,
                dip.service,
                dip.comment_url,
                dip.slo_name,
                dip.slo_url,
                dip.dip_date,
                dip.percent,
                dip.goal_percent,
                dip.investigated,
                dip.investigated_by,
                dip.investigated_at,
                dip.comment_created_at,
            ],
        )?;
    }

    let seen: BTreeSet<i64> = dips.iter().map(|dip| dip.comment_id).collect();
    for repo_id in fetched_repo_ids {
        let mut stmt =
            tx.prepare("SELECT comment_id FROM slo_dips WHERE repo_id = ?1 AND dip_date >= ?2")?;
        let stale: Vec<i64> = stmt
            .query_map(params![repo_id, cutoff], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|comment_id| !seen.contains(comment_id))
            .collect();
        drop(stmt);
        for comment_id in stale {
            tx.execute("DELETE FROM slo_dips WHERE comment_id = ?1", [comment_id])?;
        }
    }

    tx.execute("DELETE FROM slo_dips WHERE dip_date < ?1", [cutoff])?;
    tx.commit()
}

/// List every stored dip joined with its repository, newest dip first. Also prunes any rows
/// that have fallen outside the floating window since the last refresh, so a read after a long
/// idle period never surfaces stale dips.
pub fn list_dips(conn: &Connection, cutoff: &str) -> rusqlite::Result<Vec<SloDip>> {
    conn.execute("DELETE FROM slo_dips WHERE dip_date < ?1", [cutoff])?;
    let mut stmt = conn.prepare(
        "SELECT d.comment_id, d.repo_id, r.full_name, d.discussion_number, d.discussion_title,
                d.service, d.comment_url, d.slo_name, d.slo_url, d.dip_date, d.percent,
                d.goal_percent, d.investigated, d.investigated_by, d.investigated_at,
                d.comment_created_at
         FROM slo_dips d
         JOIN slo_dips_repos r ON r.repo_id = d.repo_id
         ORDER BY d.dip_date DESC, r.full_name COLLATE NOCASE ASC, d.slo_name COLLATE NOCASE ASC",
    )?;
    let dips = stmt
        .query_map([], |row| {
            Ok(SloDip {
                comment_id: row.get(0)?,
                repo_id: row.get(1)?,
                repo_full_name: row.get(2)?,
                discussion_number: row.get(3)?,
                discussion_title: row.get(4)?,
                service: row.get(5)?,
                comment_url: row.get(6)?,
                slo_name: row.get(7)?,
                slo_url: row.get(8)?,
                dip_date: row.get(9)?,
                percent: row.get(10)?,
                goal_percent: row.get(11)?,
                investigated: row.get(12)?,
                investigated_by: row.get(13)?,
                investigated_at: row.get(14)?,
                comment_created_at: row.get(15)?,
            })
        })?
        .collect();
    dips
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
                emoji_url TEXT,
                PRIMARY KEY (repo_id, category_id)
             );
             CREATE TABLE slo_dips (
                comment_id INTEGER PRIMARY KEY,
                repo_id INTEGER NOT NULL REFERENCES slo_dips_repos(repo_id) ON DELETE CASCADE,
                discussion_number INTEGER NOT NULL, discussion_title TEXT NOT NULL,
                service TEXT NOT NULL, comment_url TEXT NOT NULL, slo_name TEXT NOT NULL,
                slo_url TEXT, dip_date TEXT NOT NULL, percent REAL NOT NULL, goal_percent REAL,
                investigated INTEGER NOT NULL DEFAULT 0, investigated_by TEXT, investigated_at TEXT,
                comment_created_at TEXT NOT NULL, fetched_at TEXT NOT NULL
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
                    emoji_url: Some("https://github.githubassets.com/emoji.png".into()),
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
            emoji_url: None,
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

    const DIP_BODY: &str = "<!-- slo-dns-dns-global-api/availability/control-plane-sam-2026-04-19 -->\n### 2026-04-19 - [dns-global-api/availability/control-plane-sam](https://app.datadoghq.com/slo?slo_id=17970c80cb815c918be8a061e0a6bdf8) - 99.967%\n:wave: @yimysty, the [dns-global-api/availability/control-plane-sam](https://app.datadoghq.com/slo?slo_id=17970c80cb815c918be8a061e0a6bdf8) SLO was `99.967%` on 2026-04-19 which is below our goal of `99.99%`. Please investigate.\n<!-- slo-dns-dns-global-api/availability/control-plane-sam-2026-04-19 -->";
    const FAILURES_BODY: &str = "<!-- slo-failures-dns-2026-06-11 -->\n## ⚠️ SLO Query Failures - dns - 2026-06-11\n\nI encountered errors while trying to query 4 SLOs for dns:\n<!-- slo-failures-dns-2026-06-11 -->";
    const INVESTIGATE_BODY: &str = "<!-- slo-investigate-dns-2026-06-11 -->\n## 🔍 Investigate failures - dns - 2026-06-11\n<!-- slo-investigate-dns-2026-06-11 -->";

    #[test]
    fn parses_service_from_weekly_title() {
        assert_eq!(
            parse_service_from_title("SLO investigations for `dns` - Week of April 13, 2026")
                .as_deref(),
            Some("dns")
        );
        assert_eq!(
            parse_service_from_title(
                "SLO investigations for `legacy-dns` - Week of March 23, 2026"
            )
            .as_deref(),
            Some("legacy-dns")
        );
        assert_eq!(parse_service_from_title("no service here"), None);
    }

    #[test]
    fn parses_real_dip_comment() {
        let dip = parse_dip_comment(DIP_BODY).expect("real dip should parse");
        assert_eq!(dip.dip_date, "2026-04-19");
        assert_eq!(
            dip.slo_name,
            "dns-global-api/availability/control-plane-sam"
        );
        assert_eq!(
            dip.slo_url.as_deref(),
            Some("https://app.datadoghq.com/slo?slo_id=17970c80cb815c918be8a061e0a6bdf8")
        );
        assert!((dip.percent - 99.967).abs() < 1e-9);
        assert_eq!(dip.goal_percent, Some(99.99));
    }

    #[test]
    fn ignores_failure_and_investigate_comments() {
        assert_eq!(parse_dip_comment(FAILURES_BODY), None);
        assert_eq!(parse_dip_comment(INVESTIGATE_BODY), None);
        assert_eq!(parse_dip_comment("just a human comment, no marker"), None);
    }

    #[test]
    fn requires_the_dip_marker_even_with_a_valid_heading() {
        // A dip-shaped heading with no `<!-- slo-… -->` marker must not be collected.
        let body =
            "### 2026-04-19 - [dns/availability](https://dd) - 99.9%\nbelow our goal of `99.99%`.";
        assert_eq!(parse_dip_comment(body), None);
    }

    #[test]
    fn parses_integer_and_no_goal_headings() {
        let body = "<!-- slo-dns-x/y-2026-05-12 -->\n### 2026-05-12 - [dns-matrix/availability/internal-resolution-sam](https://dd) - 99.98%\nprose without a goal line";
        let dip = parse_dip_comment(body).unwrap();
        assert!((dip.percent - 99.98).abs() < 1e-9);
        assert_eq!(dip.goal_percent, None);
    }

    #[test]
    fn investigation_prefers_earliest_human_reply() {
        let none = investigation_from_replies(Vec::new(), SLO_BOT_LOGIN);
        assert!(!none.investigated);

        let bot_only = investigation_from_replies(
            [(Some(SLO_BOT_LOGIN), "2026-05-01T00:00:00Z")],
            SLO_BOT_LOGIN,
        );
        assert!(!bot_only.investigated);

        let humans = investigation_from_replies(
            [
                (Some("later"), "2026-05-03T00:00:00Z"),
                (Some(SLO_BOT_LOGIN), "2026-05-01T00:00:00Z"),
                (Some("earliest"), "2026-05-02T00:00:00Z"),
            ],
            SLO_BOT_LOGIN,
        );
        assert!(humans.investigated);
        assert_eq!(humans.by.as_deref(), Some("earliest"));
        assert_eq!(humans.at.as_deref(), Some("2026-05-02T00:00:00Z"));
    }

    fn seed_repo(conn: &Connection) {
        conn.execute(
            "INSERT INTO slo_dips_repos (repo_id, full_name, owner, name, private, added_at)
             VALUES (1, 'octo/repo', 'octo', 'repo', 0, '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    }

    fn dip(comment_id: i64, dip_date: &str, investigated: bool) -> SloDip {
        SloDip {
            comment_id,
            repo_id: 1,
            repo_full_name: String::new(),
            discussion_number: 7585,
            discussion_title: "SLO investigations for `dns`".into(),
            service: "dns".into(),
            comment_url: format!("https://example/c/{comment_id}"),
            slo_name: "dns/availability/sam".into(),
            slo_url: Some("https://dd".into()),
            dip_date: dip_date.into(),
            percent: 99.9,
            goal_percent: Some(99.99),
            investigated,
            investigated_by: investigated.then(|| "octocat".to_string()),
            investigated_at: investigated.then(|| "2026-04-21T00:00:00Z".to_string()),
            comment_created_at: "2026-04-20T00:00:00Z".into(),
        }
    }

    #[test]
    fn reconcile_upserts_prunes_and_drops_removed_comments() {
        let conn = database();
        seed_repo(&conn);

        // First refresh: two in-window dips.
        reconcile_dips(
            &conn,
            &[1],
            &[dip(10, "2026-04-19", false), dip(11, "2026-04-20", true)],
            "2026-03-01",
        )
        .unwrap();
        let listed = list_dips(&conn, "2026-03-01").unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].repo_full_name, "octo/repo");

        // Second refresh: comment 10 flips to investigated, comment 11 disappeared, and an old
        // dip is now outside the window.
        reconcile_dips(&conn, &[1], &[dip(10, "2026-04-19", true)], "2026-04-01").unwrap();
        let listed = list_dips(&conn, "2026-04-01").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].comment_id, 10);
        assert!(listed[0].investigated);
    }

    #[test]
    fn list_dips_prunes_stale_rows_on_read() {
        let conn = database();
        seed_repo(&conn);
        reconcile_dips(&conn, &[1], &[dip(10, "2026-01-01", false)], "2025-12-01").unwrap();
        // Later read with a window that excludes the old dip prunes it.
        assert!(list_dips(&conn, "2026-06-01").unwrap().is_empty());
    }
}
