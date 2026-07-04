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

impl GitHubError {
    /// Whether this is GitHub telling us we're rate-limited: a **403 Forbidden** whose body
    /// mentions a rate limit (both the primary "API rate limit exceeded" and the secondary
    /// "exceeded a secondary rate limit" surface as 403). A non-rate 403 (scope/SAML) returns
    /// false so it isn't mistaken for throttling.
    pub fn is_rate_limited(&self) -> bool {
        matches!(self, GitHubError::Forbidden(body) if body.to_lowercase().contains("rate limit"))
    }
}

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

/// One organization the authenticated user belongs to (just the login Helix needs).
#[derive(Debug, Deserialize)]
struct OrgResponse {
    login: String,
}

/// List the organizations the authenticated user is a member of (`GET /user/orgs`,
/// Link-paginated). Used by the Dependabot module's account picker so the user can scope the
/// search to their user + selected orgs. Note: classic PATs need `read:org` for the complete
/// membership list (public-only otherwise); fine-grained tokens need org membership read.
pub async fn fetch_orgs(token: &str) -> Result<Vec<String>, GitHubError> {
    let client = reqwest::Client::new();
    let mut url = format!("{API_BASE}/user/orgs?per_page=100");
    let mut orgs: Vec<String> = Vec::new();

    loop {
        let resp = authed_get(&client, &url, token)
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

        let next = next_page_url(resp.headers());
        let page: Vec<OrgResponse> = resp.json().await.map_err(|e| GitHubError::Parse {
            what: "organizations",
            source: e.to_string(),
        })?;
        orgs.extend(page.into_iter().map(|o| o.login));

        match next {
            Some(next_url) => url = next_url,
            None => break,
        }
    }

    Ok(orgs)
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
    /// Pull requests only: GitHub's rolled-up mergeability/CI state
    /// (`clean` | `unstable` | `blocked` | `dirty` | `behind` | `draft` | `unknown`).
    /// Absent for issues. Computed lazily by GitHub, so it can be `unknown` right after a
    /// change until the next fetch settles it.
    mergeable_state: Option<String>,
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
    /// Pull requests only: GitHub's rolled-up `mergeable_state` (see `SubjectResponse`).
    /// Drives the PR merge-readiness pill; `None` for issues and other subjects.
    pub mergeable_state: Option<String>,
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
            mergeable_state: r.mergeable_state,
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

impl ResolveError {
    /// Whether this failure is GitHub telling us to slow down, so a background resolution
    /// loop should **stop the whole pass** rather than keep firing into the limit (which only
    /// prolongs it) — the remaining work is left for a later sync. True when a `Retry-After`
    /// is present (only ever set on a 429/secondary-limit 403) or the error is a **403 whose
    /// body mentions a rate limit** (primary "API rate limit exceeded" or secondary "exceeded
    /// a secondary rate limit"). A *non-rate* 403 (e.g. insufficient scope / SAML) is
    /// deliberately excluded so it's treated as an ordinary per-row failure and doesn't starve
    /// the rest of the queue by aborting every pass.
    pub fn should_back_off(&self) -> bool {
        self.rate.retry_after.is_some() || self.error.is_rate_limited()
    }
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

/* --------------------------- Dependabot enumeration ----------------------- */

/// Page size for the repo/PR listings behind the Dependabot module (the REST max).
const DEPENDABOT_PER_PAGE: u32 = 100;
/// Delay between the (core-REST) requests the Dependabot enumeration makes. Enumerating admin
/// repos and their open PRs is many small requests; pacing them serially keeps us clear of
/// GitHub's secondary rate limit (the burst guard) while staying trivially within the core
/// 5000/hr budget.
const DEPENDABOT_REQUEST_DELAY: std::time::Duration = std::time::Duration::from_millis(150);

/// One open Dependabot pull request, flattened to just the fields Helix stores. `pull_url` is
/// the PR's REST API URL (`.../pulls/{n}`), resolved later to a `mergeable_state` for the
/// merge-readiness pill (the PR *list* endpoint omits it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependabotPr {
    pub id: i64,
    pub number: i64,
    pub title: String,
    pub html_url: String,
    pub author: String,
    pub repo_full_name: String,
    pub repo_owner: String,
    pub repo_name: String,
    pub pull_url: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Result of a full Dependabot fetch: the collected PRs plus the last response's rate-limit
/// snapshot (the `core` bucket). `complete` is true when the enumeration finished normally, so
/// the caller may reconcile-delete stale local rows; it is only ever false if a future variant
/// returns partial results.
pub struct DependabotFetchOutcome {
    pub prs: Vec<DependabotPr>,
    pub rate: RateLimit,
    pub complete: bool,
}

/// A repository as returned by the repo-list endpoints, with the authenticated user's
/// permissions (present on authenticated responses). Only the fields we need are deserialized.
#[derive(Debug, Deserialize)]
struct RepoListItem {
    name: String,
    owner: RepoOwnerLogin,
    permissions: Option<RepoPermissions>,
}

#[derive(Debug, Deserialize)]
struct RepoOwnerLogin {
    login: String,
}

#[derive(Debug, Deserialize)]
struct RepoPermissions {
    #[serde(default)]
    admin: bool,
}

/// A pull request as returned by the PR *list* endpoint (no `mergeable_state`; that needs the
/// single-PR GET, done later during resolution). `url` is the PR's REST API URL.
#[derive(Debug, Deserialize)]
struct PullListItem {
    id: i64,
    number: i64,
    title: String,
    html_url: String,
    url: String,
    user: Option<SubjectUser>,
    created_at: String,
    updated_at: String,
}

/// Whether `login` is a Dependabot bot author (`dependabot[bot]`, or the legacy
/// `dependabot-preview[bot]`).
fn is_dependabot_author(login: &str) -> bool {
    matches!(login, "dependabot[bot]" | "dependabot-preview[bot]")
}

/// Soft reserve for the admin enumeration: stop before the `core` bucket dips below this
/// fraction of its limit, so scanning a very large admin scope can't exhaust the quota other
/// operations need. Stopping early yields an *incomplete* result (the caller then skips
/// reconcile-delete), so nothing is lost — the rest resolves on a later sync.
const CORE_RESERVE_FRACTION: f64 = 0.1;

/// Whether the tracked `core` quota has fallen to/below the reserve. Unknown quota (before the
/// first response populates the headers) is treated as "not low" so enumeration can start.
fn core_below_reserve(rate: &RateLimit) -> bool {
    match (rate.remaining, rate.limit) {
        (Some(remaining), Some(limit)) if limit > 0 => {
            (remaining as f64) <= CORE_RESERVE_FRACTION * (limit as f64)
        }
        _ => false,
    }
}

/// GET a single page and return `(json_body, next_page_url)`, updating `rate` and mapping the
/// usual auth/forbidden/status/parse failures to [`GitHubError`]. Shared by the repo and PR
/// list loops below.
async fn get_page<T: for<'de> serde::Deserialize<'de>>(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    what: &'static str,
    rate: &mut RateLimit,
) -> Result<(T, Option<String>), GitHubError> {
    let resp = authed_get(client, url, token)
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
    let body: T = resp.json().await.map_err(|e| GitHubError::Parse {
        what,
        source: e.to_string(),
    })?;
    Ok((body, next))
}

/// List the repositories in `owner` where the authenticated user is an **admin**, following
/// `Link` pagination. Uses `/user/repos?affiliation=owner` for the user's own account and
/// `/orgs/{owner}/repos` for an org; both include the authed user's `permissions`. Requests
/// are paced (see `DEPENDABOT_REQUEST_DELAY`).
async fn list_admin_repos(
    client: &reqwest::Client,
    token: &str,
    owner: &str,
    self_login: &str,
    rate: &mut RateLimit,
) -> Result<Vec<(String, String)>, GitHubError> {
    let mut url = if owner.eq_ignore_ascii_case(self_login) {
        format!("{API_BASE}/user/repos?affiliation=owner&per_page={DEPENDABOT_PER_PAGE}")
    } else {
        format!("{API_BASE}/orgs/{owner}/repos?per_page={DEPENDABOT_PER_PAGE}")
    };
    let mut repos = Vec::new();
    loop {
        let (page, next): (Vec<RepoListItem>, _) =
            get_page(client, &url, token, "repositories", rate).await?;
        for r in page {
            if r.permissions.map(|p| p.admin).unwrap_or(false) {
                repos.push((r.owner.login, r.name));
            }
        }
        match next {
            Some(next_url) => {
                url = next_url;
                tokio::time::sleep(DEPENDABOT_REQUEST_DELAY).await;
            }
            None => break,
        }
    }
    Ok(repos)
}

/// List the open, Dependabot-authored pull requests in one repository (paginated + paced).
async fn list_open_dependabot_prs(
    client: &reqwest::Client,
    token: &str,
    owner: &str,
    name: &str,
    rate: &mut RateLimit,
) -> Result<Vec<DependabotPr>, GitHubError> {
    let mut url =
        format!("{API_BASE}/repos/{owner}/{name}/pulls?state=open&per_page={DEPENDABOT_PER_PAGE}");
    let mut prs = Vec::new();
    loop {
        let (page, next): (Vec<PullListItem>, _) =
            get_page(client, &url, token, "pull requests", rate).await?;
        for p in page {
            let author = p.user.map(|u| u.login).unwrap_or_default();
            if !is_dependabot_author(&author) {
                continue;
            }
            prs.push(DependabotPr {
                id: p.id,
                number: p.number,
                title: p.title,
                html_url: p.html_url,
                author,
                repo_full_name: format!("{owner}/{name}"),
                repo_owner: owner.to_string(),
                repo_name: name.to_string(),
                pull_url: p.url,
                created_at: p.created_at,
                updated_at: p.updated_at,
            });
        }
        match next {
            Some(next_url) => {
                url = next_url;
                tokio::time::sleep(DEPENDABOT_REQUEST_DELAY).await;
            }
            None => break,
        }
    }
    Ok(prs)
}

/// Fetch open Dependabot PRs across the repos the user **admins** within the selected owners.
///
/// For each owner, lists its repos and keeps those with `permissions.admin`, then lists each
/// such repo's open Dependabot-authored PRs. This uses only the core REST API (no search), so
/// — paced serially (see `DEPENDABOT_REQUEST_DELAY`) — it avoids the search secondary rate
/// limit entirely. `on_progress` is invoked as repos are scanned with `(repos_scanned,
/// prs_found_so_far)`. Callers must pass a non-empty `owners`. The result is always `complete`
/// (a full enumeration), so the caller may reconcile-delete stale local rows.
pub async fn fetch_admin_dependabot_prs<F>(
    token: &str,
    owners: &[String],
    self_login: &str,
    on_progress: F,
) -> Result<DependabotFetchOutcome, GitHubError>
where
    F: Fn(usize, usize) + Send,
{
    let client = reqwest::Client::new();
    let mut rate = RateLimit::default();
    // A single problematic owner/repo (a 404, a transient 5xx, …) must not sink the whole
    // sync. We skip it, log it, and mark the result incomplete so the caller won't
    // reconcile-delete (a skipped repo's cached PRs are kept until a later clean sync). Only a
    // genuine auth failure (401) or a rate-limit is treated specially.
    let mut complete = true;

    // 1. Collect the admin repos across the selected owners (de-duplicated).
    let mut admin_repos: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for owner in owners {
        let repos = match list_admin_repos(&client, token, owner, self_login, &mut rate).await {
            Ok(repos) => repos,
            Err(GitHubError::Unauthorized) => return Err(GitHubError::Unauthorized),
            Err(e) if e.is_rate_limited() => {
                complete = false;
                break;
            }
            Err(e) => {
                eprintln!("helix: listing repos for {owner} failed, skipping: {e}");
                complete = false;
                continue;
            }
        };
        for (o, n) in repos {
            if seen.insert((o.to_lowercase(), n.to_lowercase())) {
                admin_repos.push((o, n));
            }
        }
        tokio::time::sleep(DEPENDABOT_REQUEST_DELAY).await;
    }

    // 2. List each admin repo's open Dependabot PRs. Stop early (marking the result
    //    incomplete, so the caller won't reconcile-delete) if we approach the core-quota
    //    reserve or GitHub starts rate-limiting — the rest resolves on a later sync.
    let mut prs: Vec<DependabotPr> = Vec::new();
    let mut scanned = 0usize;
    for (owner, name) in &admin_repos {
        if core_below_reserve(&rate) {
            complete = false;
            break;
        }
        match list_open_dependabot_prs(&client, token, owner, name, &mut rate).await {
            Ok(repo_prs) => prs.extend(repo_prs),
            Err(GitHubError::Unauthorized) => return Err(GitHubError::Unauthorized),
            Err(e) if e.is_rate_limited() => {
                complete = false;
                break;
            }
            // A per-repo failure (e.g. a 404 on a repo we can list but not read PRs for, or a
            // transient error) — skip this repo rather than failing the whole sync.
            Err(e) => {
                eprintln!("helix: listing PRs for {owner}/{name} failed, skipping: {e}");
                complete = false;
            }
        }
        scanned += 1;
        on_progress(scanned, prs.len());
        tokio::time::sleep(DEPENDABOT_REQUEST_DELAY).await;
    }

    Ok(DependabotFetchOutcome {
        prs,
        rate,
        complete,
    })
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
    fn resolve_error_backs_off_only_on_rate_limits() {
        let rl = |retry_after: Option<i64>, err: GitHubError| ResolveError {
            rate: RateLimit {
                retry_after,
                ..RateLimit::default()
            },
            error: err,
        };
        // Secondary/primary rate-limit 403 bodies → back off.
        assert!(rl(
            None,
            GitHubError::Forbidden("You have exceeded a secondary rate limit".into())
        )
        .should_back_off());
        assert!(rl(
            None,
            GitHubError::Forbidden("API rate limit exceeded".into())
        )
        .should_back_off());
        // Any Retry-After → back off, regardless of the error shape.
        assert!(rl(Some(60), GitHubError::Unauthorized).should_back_off());
        // A non-rate 403 (scope/SAML) must NOT abort the pass.
        assert!(!rl(
            None,
            GitHubError::Forbidden("Resource not accessible by personal access token".into())
        )
        .should_back_off());
        // Other errors don't back off.
        assert!(!rl(None, GitHubError::Network("timeout".into())).should_back_off());
    }

    #[test]
    fn is_dependabot_author_matches_bot_logins() {
        assert!(is_dependabot_author("dependabot[bot]"));
        assert!(is_dependabot_author("dependabot-preview[bot]"));
        // A human or another bot is not Dependabot.
        assert!(!is_dependabot_author("octocat"));
        assert!(!is_dependabot_author("renovate[bot]"));
        assert!(!is_dependabot_author("dependabot")); // not a bot login
    }

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
        // Issues carry no mergeable_state.
        assert_eq!(resolved.mergeable_state, None);
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

    #[test]
    fn resolves_pull_request_mergeable_state() {
        // An open PR response carries the rolled-up mergeable_state we surface as a pill.
        let body = r#"{
            "number": 12,
            "state": "open",
            "html_url": "https://github.com/o/r/pull/12",
            "user": { "login": "dev" },
            "mergeable_state": "clean"
        }"#;
        let resolved: ResolvedSubject = serde_json::from_str::<SubjectResponse>(body)
            .unwrap()
            .into();
        assert_eq!(resolved.state.as_deref(), Some("open"));
        assert_eq!(resolved.mergeable_state.as_deref(), Some("clean"));
    }
}
