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

/// A structured error from a GitHub API call. It converts to the user-facing string only at
/// the command boundary (via `Display` / `From<GitHubError> for String`); internally, callers
/// can branch on the kind — e.g. an invalid token vs a transient network failure vs being
/// rate-limited — which a bare `String` can't express.
#[derive(Debug)]
pub enum GitHubError {
    /// Transport-level failure before any HTTP response (offline, DNS, TLS, timeout).
    Network(String),
    /// 401 — the token is missing, invalid, or expired.
    Unauthorized,
    /// 403 — rate limit hit or the token lacks a required scope. Carries GitHub's body.
    Forbidden(String),
    /// Any other non-success HTTP status, with the (trimmed) response body.
    Status {
        status: reqwest::StatusCode,
        body: String,
    },
    /// A response arrived but couldn't be parsed; `what` names the payload (e.g. "subject").
    Parse { what: &'static str, source: String },
}

impl std::fmt::Display for GitHubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitHubError::Network(e) => write!(f, "network error: {e}"),
            GitHubError::Unauthorized => {
                write!(f, "Invalid or expired token — GitHub returned 401.")
            }
            GitHubError::Forbidden(body) => write!(
                f,
                "GitHub returned 403 Forbidden (rate limit or insufficient scope): {body}"
            ),
            GitHubError::Status { status, body } => write!(f, "GitHub returned {status}: {body}"),
            GitHubError::Parse { what, source } => write!(f, "failed to parse {what}: {source}"),
        }
    }
}

impl std::error::Error for GitHubError {}

impl From<GitHubError> for String {
    fn from(e: GitHubError) -> Self {
        e.to_string()
    }
}

/// Verify a PAT by fetching the authenticated user (`GET /user`).
///
/// Returns the user on success, or a structured [`GitHubError`] (invalid token, network
/// failure, unexpected status).
pub async fn fetch_user(token: &str) -> Result<GitHubUser, GitHubError> {
    let client = reqwest::Client::new();
    let resp = authed_get(&client, &format!("{API_BASE}/user"), token)
        .send()
        .await
        .map_err(|e| GitHubError::Network(e.to_string()))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(GitHubError::Unauthorized);
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        let body = resp.text().await.unwrap_or_default();
        return Err(GitHubError::Forbidden(body.trim().to_string()));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(GitHubError::Status {
            status,
            body: body.trim().to_string(),
        });
    }

    let user: UserResponse = resp.json().await.map_err(|e| GitHubError::Parse {
        what: "GitHub response",
        source: e.to_string(),
    })?;

    Ok(GitHubUser {
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
    })
}

/* ------------------------------ Notifications ------------------------------ */

/// A notification thread (subset of the `Thread` schema Helix stores).
///
/// Helix deliberately ignores read/unread state: a thread stays in the inbox until it's
/// marked **done** (removed from GitHub's list), so the `unread`/`last_read_at` fields the
/// API returns are not deserialized.
#[derive(Debug, Deserialize)]
pub struct NotificationThread {
    pub id: String,
    pub repository: MinimalRepo,
    pub subject: Subject,
    pub reason: String,
    pub updated_at: String,
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
    /// API URL to the subject — issues, PRs, discussions, releases, commits, … — which we
    /// resolve to get the web `html_url` (and, for PR/Issue/Discussion, a state). Null for
    /// subject types GitHub doesn't expose this way (e.g. CheckSuite), and occasionally for
    /// discussions (older / comment-less) — callers must handle `None`.
    pub url: Option<String>,
    #[serde(rename = "type")]
    pub subject_type: String,
}

/// Raw subject metadata as returned by the issue/PR REST endpoints (`subject.url`).
/// Only the fields Helix needs are deserialized; everything else is ignored.
#[derive(Debug, Deserialize)]
struct SubjectResponse {
    number: Option<i64>,
    /// `open` | `closed`.
    state: Option<String>,
    /// Issues only: `completed` | `not_planned` | null.
    state_reason: Option<String>,
    /// Pull requests only: set once merged.
    merged_at: Option<String>,
    html_url: Option<String>,
    user: Option<SubjectUser>,
}

#[derive(Debug, Deserialize)]
struct SubjectUser {
    login: String,
}

/// Resolved PR/Issue subject metadata used for the state pill (and the future
/// cleanup filter). `state` is the **effective** label stored in `subject_state`:
/// `merged` (when `merged_at` is set), otherwise the API `state` (`open`/`closed`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResolvedSubject {
    pub number: Option<i64>,
    pub state: Option<String>,
    pub state_reason: Option<String>,
    pub merged_at: Option<String>,
    pub html_url: Option<String>,
    pub author: Option<String>,
}

impl From<SubjectResponse> for ResolvedSubject {
    fn from(r: SubjectResponse) -> Self {
        // A merged PR reports `state == "closed"`; surface it as the distinct `merged`
        // label the UI colours differently.
        let state = if r.merged_at.is_some() {
            Some("merged".to_string())
        } else {
            r.state
        };
        ResolvedSubject {
            number: r.number,
            state,
            state_reason: r.state_reason,
            merged_at: r.merged_at,
            html_url: r.html_url,
            author: r.user.map(|u| u.login),
        }
    }
}

/// Outcome of resolving a single subject: the metadata plus the rate-limit snapshot read
/// from that response's headers (so the caller can keep the displayed quota accurate after
/// these extra calls — see `sync::upsert_rate` / `sync::RateTracker`).
pub struct ResolveResult {
    pub subject: ResolvedSubject,
    pub rate: RateLimit,
}

/// Resolve a notification's subject by fetching `subject.url`. Works for any subject that
/// has one — issues, PRs, discussions, releases, commits — yielding a web `html_url` (and,
/// for PR/Issue/Discussion, a state).
///
/// A 404 means the subject is currently unreadable (deleted, or private without the right
/// token scope); we return an empty [`ResolvedSubject`] and the caller still stamps
/// `resolved_at`, so it won't be re-fetched on every sync. It isn't permanently skipped,
/// though: `sync::subjects_needing_resolution` retries rows that resolved to nothing about
/// once an hour, so access granted later (e.g. a broader token) eventually resolves. Other
/// non-success statuses are surfaced as [`ResolveError`] (carrying the rate snapshot) and
/// left unresolved for the next sync. The response's rate-limit headers are captured in
/// every case except a transport error before any response.
pub async fn resolve_subject(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<ResolveResult, ResolveError> {
    let resp = authed_get(client, url, token)
        .send()
        .await
        .map_err(|e| ResolveError {
            // A transport error before any response carries no rate snapshot.
            rate: RateLimit::default(),
            error: GitHubError::Network(e.to_string()),
        })?;

    let status = resp.status();
    let mut rate = RateLimit::default();
    rate.update_from(resp.headers());

    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(ResolveResult {
            subject: ResolvedSubject::default(),
            rate,
        });
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        let body = resp.text().await.unwrap_or_default();
        return Err(ResolveError {
            rate,
            error: GitHubError::Forbidden(body.trim().to_string()),
        });
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // A failed (non-404) request still consumed quota — carry its rate snapshot so the
        // caller's budget accounting stays accurate.
        return Err(ResolveError {
            rate,
            error: GitHubError::Status {
                status,
                body: body.trim().to_string(),
            },
        });
    }

    match resp.json::<SubjectResponse>().await {
        Ok(raw) => Ok(ResolveResult {
            subject: raw.into(),
            rate,
        }),
        Err(e) => Err(ResolveError {
            rate,
            error: GitHubError::Parse {
                what: "subject",
                source: e.to_string(),
            },
        }),
    }
}

/// Failure from resolving a subject that still carries the rate-limit snapshot. A failed
/// request (other than a transport error before any response) consumes quota too, so the
/// caller folds this `rate` into its budget accounting.
pub struct ResolveError {
    pub rate: RateLimit,
    pub error: GitHubError,
}

/* -------------------------------- Mutations ------------------------------- */

/// Failure from a thread mutation that still carries the rate-limit snapshot. A failed
/// request consumes quota too, so the caller folds this `rate` into the displayed remaining
/// count to keep it accurate even when some/all mutations fail.
pub struct MutationError {
    pub rate: RateLimit,
    pub error: GitHubError,
}

/// Mark a notification thread as **done** (`DELETE /notifications/threads/{thread_id}`).
///
/// GitHub answers `204 No Content` on success; the thread is removed from the inbox
/// entirely. The response's rate-limit snapshot is returned on success and carried in
/// [`MutationError`] on failure (failed requests still consume quota). A transport error
/// before any response carries a default (empty) snapshot.
pub async fn mark_thread_done(
    client: &reqwest::Client,
    token: &str,
    thread_id: &str,
) -> Result<RateLimit, MutationError> {
    let url = format!("{API_BASE}/notifications/threads/{thread_id}");
    let resp = authed(client.delete(&url), token)
        .send()
        .await
        .map_err(|e| MutationError {
            rate: RateLimit::default(),
            error: GitHubError::Network(e.to_string()),
        })?;

    let status = resp.status();
    let mut rate = RateLimit::default();
    rate.update_from(resp.headers());

    if status.is_success() {
        return Ok(rate);
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(MutationError {
            rate,
            error: GitHubError::Unauthorized,
        });
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        let body = resp.text().await.unwrap_or_default();
        return Err(MutationError {
            rate,
            error: GitHubError::Forbidden(body.trim().to_string()),
        });
    }
    let body = resp.text().await.unwrap_or_default();
    Err(MutationError {
        rate,
        error: GitHubError::Status {
            status,
            body: body.trim().to_string(),
        },
    })
}

/// Rate-limit snapshot read from response headers.
///
/// GitHub partitions rate limits into independent **buckets** (REST `core`, `search`,
/// `graphql`, …). Every response reports which bucket it counted against via
/// `X-RateLimit-Resource`, along with that bucket's `limit`/`remaining`/`reset`. Capturing
/// the resource lets the UI show one usage bar per bucket Helix actually touches, and the
/// `limit` gives the bar its denominator.
#[derive(Debug, Default, Clone, Serialize)]
pub struct RateLimit {
    /// Which bucket this snapshot is for (`X-RateLimit-Resource`, e.g. `core`).
    pub resource: Option<String>,
    /// Total requests allowed in the current window (`X-RateLimit-Limit`).
    pub limit: Option<i64>,
    /// Remaining requests in the current window (`X-RateLimit-Remaining`).
    pub remaining: Option<i64>,
    /// Window reset time as epoch seconds (`X-RateLimit-Reset`).
    pub reset: Option<i64>,
    /// Minimum seconds between polls requested by GitHub (`X-Poll-Interval`).
    pub poll_interval: Option<i64>,
    /// Seconds GitHub asked us to wait before retrying (`Retry-After`), sent on a 403/429
    /// secondary rate-limit. Parsed as delta-seconds (GitHub's form for rate limits).
    pub retry_after: Option<i64>,
}

impl RateLimit {
    fn update_from(&mut self, headers: &HeaderMap) {
        if let Some(v) = header_string(headers, "x-ratelimit-resource") {
            self.resource = Some(v);
        }
        if let Some(v) = header_i64(headers, "x-ratelimit-limit") {
            self.limit = Some(v);
        }
        if let Some(v) = header_i64(headers, "x-ratelimit-remaining") {
            self.remaining = Some(v);
        }
        if let Some(v) = header_i64(headers, "x-ratelimit-reset") {
            self.reset = Some(v);
        }
        if let Some(v) = header_i64(headers, "x-poll-interval") {
            self.poll_interval = Some(v);
        }
        if let Some(v) = header_i64(headers, "retry-after") {
            self.retry_after = Some(v);
        }
    }

    /// The cadence floor GitHub is asking us to honor before the next poll: the larger of
    /// `X-Poll-Interval` (steady-state) and `Retry-After` (backoff after a rejection), or
    /// `None` when GitHub requested neither.
    pub fn poll_floor(&self) -> Option<i64> {
        match (self.poll_interval, self.retry_after) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        }
    }
}

/// Result of a full notifications fetch.
pub struct FetchOutcome {
    pub threads: Vec<NotificationThread>,
    pub rate: RateLimit,
}

/// Fetch **all** notifications (read and unread alike), following `Link` pagination.
///
/// Uses `all=true`: Helix shows every notification GitHub still lists and only removes one
/// when it's marked **done**, so read state never affects what's displayed. `on_page` is
/// invoked after each page with `(page_number, total_fetched_so_far)` so the caller can
/// surface live progress. Rate-limit headers from the last response are returned in
/// [`FetchOutcome::rate`].
pub async fn fetch_all_notifications<F>(
    token: &str,
    on_page: F,
) -> Result<FetchOutcome, GitHubError>
where
    F: Fn(u32, usize) + Send,
{
    let client = reqwest::Client::new();
    let mut url = format!("{API_BASE}/notifications?all=true&per_page={NOTIFICATIONS_PER_PAGE}");
    let mut threads: Vec<NotificationThread> = Vec::new();
    let mut rate = RateLimit::default();
    let mut page: u32 = 0;

    loop {
        page += 1;
        let resp = authed_get(&client, &url, token)
            .send()
            .await
            .map_err(|e| GitHubError::Network(e.to_string()))?;

        let status = resp.status();
        rate.update_from(resp.headers());

        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(GitHubError::Unauthorized);
        }
        if status == reqwest::StatusCode::FORBIDDEN {
            let body = resp.text().await.unwrap_or_default();
            return Err(GitHubError::Forbidden(body.trim().to_string()));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(GitHubError::Status {
                status,
                body: body.trim().to_string(),
            });
        }

        let next = next_page_url(resp.headers());
        let page_threads: Vec<NotificationThread> =
            resp.json().await.map_err(|e| GitHubError::Parse {
                what: "notifications",
                source: e.to_string(),
            })?;
        threads.extend(page_threads);
        on_page(page, threads.len());

        match next {
            Some(next_url) => url = next_url,
            None => break,
        }
    }

    Ok(FetchOutcome { threads, rate })
}

/// Apply the standard GitHub headers (auth, accept, pinned API version, user-agent) to a
/// request builder. Shared by every verb so the discipline in `AGENT.md` is applied once.
fn authed(builder: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    builder
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .header("User-Agent", USER_AGENT)
}

/// Build an authenticated GET request with the standard GitHub headers.
fn authed_get(client: &reqwest::Client, url: &str, token: &str) -> reqwest::RequestBuilder {
    authed(client.get(url), token)
}

/// Parse an integer response header.
fn header_i64(headers: &HeaderMap, name: &str) -> Option<i64> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

/// Read a string response header (trimmed, non-empty).
fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    let v = headers.get(name)?.to_str().ok()?.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
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
    fn github_error_display_matches_user_facing_messages() {
        assert_eq!(
            GitHubError::Network("connection refused".into()).to_string(),
            "network error: connection refused"
        );
        assert_eq!(
            GitHubError::Unauthorized.to_string(),
            "Invalid or expired token — GitHub returned 401."
        );
        assert_eq!(
            GitHubError::Forbidden("rate limit exceeded".into()).to_string(),
            "GitHub returned 403 Forbidden (rate limit or insufficient scope): rate limit exceeded"
        );
        assert_eq!(
            GitHubError::Status {
                status: reqwest::StatusCode::NOT_FOUND,
                body: "missing".into(),
            }
            .to_string(),
            "GitHub returned 404 Not Found: missing"
        );
        assert_eq!(
            GitHubError::Parse {
                what: "subject",
                source: "expected value".into(),
            }
            .to_string(),
            "failed to parse subject: expected value"
        );
    }

    #[test]
    fn github_error_flattens_to_string_at_the_boundary() {
        // The IPC boundary returns `String`; `?`/`.into()` go through Display.
        let s: String = GitHubError::Unauthorized.into();
        assert_eq!(s, "Invalid or expired token — GitHub returned 401.");
    }

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
            HeaderValue::from_static("<https://api.github.com/notifications?page=1>; rel=\"prev\""),
        );
        assert_eq!(next_page_url(&h), None);
        assert_eq!(next_page_url(&HeaderMap::new()), None);
    }

    #[test]
    fn reads_rate_limit_headers() {
        let mut h = HeaderMap::new();
        h.insert("x-ratelimit-resource", HeaderValue::from_static("core"));
        h.insert("x-ratelimit-limit", HeaderValue::from_static("5000"));
        h.insert("x-ratelimit-remaining", HeaderValue::from_static("4998"));
        h.insert("x-ratelimit-reset", HeaderValue::from_static("1700000000"));
        h.insert("x-poll-interval", HeaderValue::from_static("60"));
        h.insert("retry-after", HeaderValue::from_static("45"));
        let mut rate = RateLimit::default();
        rate.update_from(&h);
        assert_eq!(rate.resource.as_deref(), Some("core"));
        assert_eq!(rate.limit, Some(5000));
        assert_eq!(rate.remaining, Some(4998));
        assert_eq!(rate.reset, Some(1700000000));
        assert_eq!(rate.poll_interval, Some(60));
        assert_eq!(rate.retry_after, Some(45));
    }

    #[test]
    fn poll_floor_is_the_max_of_poll_interval_and_retry_after() {
        let floor = |p, r| {
            RateLimit {
                poll_interval: p,
                retry_after: r,
                ..RateLimit::default()
            }
            .poll_floor()
        };
        assert_eq!(floor(Some(60), Some(120)), Some(120));
        assert_eq!(floor(Some(60), None), Some(60));
        assert_eq!(floor(None, Some(90)), Some(90));
        assert_eq!(floor(None, None), None);
    }

    #[test]
    fn resolves_open_issue() {
        let body = r#"{
            "number": 42,
            "state": "open",
            "state_reason": null,
            "html_url": "https://github.com/o/r/issues/42",
            "user": { "login": "octocat" }
        }"#;
        let raw: SubjectResponse = serde_json::from_str(body).unwrap();
        let resolved: ResolvedSubject = raw.into();
        assert_eq!(resolved.number, Some(42));
        assert_eq!(resolved.state.as_deref(), Some("open"));
        assert_eq!(resolved.state_reason, None);
        assert_eq!(resolved.author.as_deref(), Some("octocat"));
    }

    #[test]
    fn resolves_closed_not_planned_issue() {
        let body = r#"{
            "number": 7,
            "state": "closed",
            "state_reason": "not_planned",
            "user": { "login": "hubot" }
        }"#;
        let resolved: ResolvedSubject = serde_json::from_str::<SubjectResponse>(body)
            .unwrap()
            .into();
        assert_eq!(resolved.state.as_deref(), Some("closed"));
        assert_eq!(resolved.state_reason.as_deref(), Some("not_planned"));
    }

    #[test]
    fn merged_pr_reports_merged_state() {
        // GitHub reports a merged PR as state "closed"; we surface the distinct "merged".
        let body = r#"{
            "number": 99,
            "state": "closed",
            "merged_at": "2026-01-02T03:04:05Z",
            "user": { "login": "dev" }
        }"#;
        let resolved: ResolvedSubject = serde_json::from_str::<SubjectResponse>(body)
            .unwrap()
            .into();
        assert_eq!(resolved.state.as_deref(), Some("merged"));
        assert_eq!(resolved.merged_at.as_deref(), Some("2026-01-02T03:04:05Z"));
    }
}
