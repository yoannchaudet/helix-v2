//! Minimal GitHub REST client.
//!
//! Covers the calls Helix needs so far: verifying a PAT (`GET /user`) and listing
//! notifications (`GET /notifications`, paginated). All calls go to `api.github.com`
//! over HTTPS and follow the API discipline in `AGENT.md`: explicit headers, the pinned
//! API version, pagination via `Link`, rate-limit awareness, and actionable errors.

use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://api.github.com";
/// Pinned REST API version (see docs.github.com/en/rest).
pub const API_VERSION: &str = "2026-03-10";
/// GitHub requires a User-Agent on every request.
const USER_AGENT: &str = "Helix";
/// Notifications page size (the endpoint caps `per_page` at 50).
const NOTIFICATIONS_PER_PAGE: u32 = 50;

/// The authenticated GitHub user, as surfaced to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct GitHubUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct UserResponse {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

/// Verify a PAT by fetching the authenticated user (`GET /user`).
///
/// Returns the user on success, or a human-readable error (invalid token, network
/// failure, unexpected status).
pub async fn fetch_user(token: &str) -> Result<GitHubUser, String> {
    let client = reqwest::Client::new();
    let resp = authed_get(&client, &format!("{API_BASE}/user"), token)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Invalid token — GitHub returned 401 Unauthorized.".to_string());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub returned {status}: {}", body.trim()));
    }

    let user: UserResponse = resp
        .json()
        .await
        .map_err(|e| format!("failed to parse GitHub response: {e}"))?;

    Ok(GitHubUser {
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
    })
}

/* ------------------------------ Notifications ------------------------------ */

/// A notification thread (subset of the `Thread` schema Helix stores).
#[derive(Debug, Deserialize)]
pub struct NotificationThread {
    pub id: String,
    pub repository: MinimalRepo,
    pub subject: Subject,
    pub reason: String,
    pub unread: bool,
    pub updated_at: String,
    pub last_read_at: Option<String>,
    /// API URL of the notification thread.
    pub url: String,
}

#[derive(Debug, Deserialize)]
pub struct MinimalRepo {
    pub id: i64,
    pub name: String,
    pub full_name: String,
    pub owner: RepoOwner,
    pub private: bool,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RepoOwner {
    pub login: String,
}

#[derive(Debug, Deserialize)]
pub struct Subject {
    pub title: String,
    /// API URL to the PR/issue (null for some subject types, e.g. discussions).
    pub url: Option<String>,
    #[serde(rename = "type")]
    pub subject_type: String,
}

/// Rate-limit snapshot read from response headers.
#[derive(Debug, Default, Clone, Serialize)]
pub struct RateLimit {
    /// Remaining requests in the current window (`X-RateLimit-Remaining`).
    pub remaining: Option<i64>,
    /// Window reset time as epoch seconds (`X-RateLimit-Reset`).
    pub reset: Option<i64>,
    /// Minimum seconds between polls requested by GitHub (`X-Poll-Interval`).
    pub poll_interval: Option<i64>,
}

impl RateLimit {
    fn update_from(&mut self, headers: &HeaderMap) {
        if let Some(v) = header_i64(headers, "x-ratelimit-remaining") {
            self.remaining = Some(v);
        }
        if let Some(v) = header_i64(headers, "x-ratelimit-reset") {
            self.reset = Some(v);
        }
        if let Some(v) = header_i64(headers, "x-poll-interval") {
            self.poll_interval = Some(v);
        }
    }
}

/// Result of a full notifications fetch.
pub struct FetchOutcome {
    pub threads: Vec<NotificationThread>,
    pub rate: RateLimit,
}

/// Fetch **all** unread notifications, following `Link` pagination.
///
/// `on_page` is invoked after each page with `(page_number, total_fetched_so_far)` so the
/// caller can surface live progress. Rate-limit headers from the last response are
/// returned in [`FetchOutcome::rate`].
pub async fn fetch_all_notifications<F>(token: &str, on_page: F) -> Result<FetchOutcome, String>
where
    F: Fn(u32, usize) + Send,
{
    let client = reqwest::Client::new();
    let mut url = format!("{API_BASE}/notifications?all=false&per_page={NOTIFICATIONS_PER_PAGE}");
    let mut threads: Vec<NotificationThread> = Vec::new();
    let mut rate = RateLimit::default();
    let mut page: u32 = 0;

    loop {
        page += 1;
        let resp = authed_get(&client, &url, token)
            .send()
            .await
            .map_err(|e| format!("network error: {e}"))?;

        let status = resp.status();
        rate.update_from(resp.headers());

        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Invalid or expired token — GitHub returned 401.".to_string());
        }
        if status == reqwest::StatusCode::FORBIDDEN {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "GitHub returned 403 Forbidden (rate limit or insufficient scope): {}",
                body.trim()
            ));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub returned {status}: {}", body.trim()));
        }

        let next = next_page_url(resp.headers());
        let page_threads: Vec<NotificationThread> = resp
            .json()
            .await
            .map_err(|e| format!("failed to parse notifications: {e}"))?;
        threads.extend(page_threads);
        on_page(page, threads.len());

        match next {
            Some(next_url) => url = next_url,
            None => break,
        }
    }

    Ok(FetchOutcome { threads, rate })
}

/// Build an authenticated GET request with the standard GitHub headers.
fn authed_get(client: &reqwest::Client, url: &str, token: &str) -> reqwest::RequestBuilder {
    client
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .header("User-Agent", USER_AGENT)
}

/// Parse an integer response header.
fn header_i64(headers: &HeaderMap, name: &str) -> Option<i64> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

/// Extract the `rel="next"` URL from a `Link` header, if present.
fn next_page_url(headers: &HeaderMap) -> Option<String> {
    let link = headers.get("link")?.to_str().ok()?;
    for part in link.split(',') {
        let mut segments = part.split(';');
        let url_seg = segments.next()?.trim();
        let is_next = segments.any(|s| s.trim() == r#"rel="next""#);
        if is_next {
            let url = url_seg.trim_start_matches('<').trim_end_matches('>');
            return Some(url.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};

    #[test]
    fn parses_next_link() {
        let mut h = HeaderMap::new();
        h.insert(
            "link",
            HeaderValue::from_static(
                "<https://api.github.com/notifications?page=2>; rel=\"next\", \
                 <https://api.github.com/notifications?page=5>; rel=\"last\"",
            ),
        );
        assert_eq!(
            next_page_url(&h).as_deref(),
            Some("https://api.github.com/notifications?page=2")
        );
    }

    #[test]
    fn no_next_link_on_last_page() {
        let mut h = HeaderMap::new();
        h.insert(
            "link",
            HeaderValue::from_static(
                "<https://api.github.com/notifications?page=1>; rel=\"prev\"",
            ),
        );
        assert_eq!(next_page_url(&h), None);
        assert_eq!(next_page_url(&HeaderMap::new()), None);
    }

    #[test]
    fn reads_rate_limit_headers() {
        let mut h = HeaderMap::new();
        h.insert("x-ratelimit-remaining", HeaderValue::from_static("4998"));
        h.insert("x-ratelimit-reset", HeaderValue::from_static("1700000000"));
        h.insert("x-poll-interval", HeaderValue::from_static("60"));
        let mut rate = RateLimit::default();
        rate.update_from(&h);
        assert_eq!(rate.remaining, Some(4998));
        assert_eq!(rate.reset, Some(1700000000));
        assert_eq!(rate.poll_interval, Some(60));
    }
}
