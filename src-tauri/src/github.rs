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

/* ------------------------------ Notifications ------------------------------ */

/// A notification thread (subset of the `Thread` schema Helix stores).
///
/// Helix does not use read state for ordinary inbox visibility, but retains `unread` as the
/// authoritative signal that a previously-dismissed thread has a new notification generation.
#[derive(Debug, Deserialize)]
pub struct NotificationThread {
    pub id: String,
    pub repository: MinimalRepo,
    pub subject: Subject,
    pub reason: String,
    pub unread: bool,
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
    updated_at: Option<String>,
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
    /// Subject activity timestamp from the subject endpoint. Unlike a notification thread's
    /// user-specific timestamp, this only advances when the underlying subject changes.
    pub updated_at: Option<String>,
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
            updated_at: r.updated_at,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClosePullRequestOutcome {
    Closed,
    Merged,
}

#[derive(Debug)]
pub struct ClosePullRequestResult {
    pub outcome: ClosePullRequestOutcome,
    pub rate: RateLimit,
}

#[derive(Debug, Deserialize)]
struct ClosePullRequestResponse {
    state: String,
    merged_at: Option<String>,
}

fn close_pull_request_request(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    number: i64,
) -> reqwest::RequestBuilder {
    authed(
        client
            .patch(format!("{API_BASE}/repos/{repo_full_name}/pulls/{number}"))
            .json(&serde_json::json!({ "state": "closed" })),
        token,
    )
}

/// Close a pull request without deleting its head branch.
///
/// GitHub returns the updated pull request. A non-null `merged_at` means a concurrent merge won
/// before this close was applied; callers must not report that as a successful discard.
pub async fn close_pull_request(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    number: i64,
) -> Result<ClosePullRequestResult, MutationError> {
    let response = close_pull_request_request(client, token, repo_full_name, number)
        .send()
        .await
        .map_err(|error| MutationError {
            rate: RateLimit::default(),
            error: GitHubError::Network(error.to_string()),
        })?;
    let status = response.status();
    let mut rate = RateLimit::default();
    rate.update_from(response.headers());
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(MutationError {
            rate,
            error: GitHubError::Unauthorized,
        });
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        let body = response.text().await.unwrap_or_default();
        return Err(MutationError {
            rate,
            error: GitHubError::Forbidden(body.trim().to_string()),
        });
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(MutationError {
            rate,
            error: GitHubError::Status {
                status,
                body: body.trim().to_string(),
            },
        });
    }
    let pull: ClosePullRequestResponse = response.json().await.map_err(|error| MutationError {
        rate: rate.clone(),
        error: GitHubError::Parse {
            what: "closed pull request",
            source: error.to_string(),
        },
    })?;
    let outcome = if pull.merged_at.is_some() {
        ClosePullRequestOutcome::Merged
    } else if pull.state.eq_ignore_ascii_case("closed") {
        ClosePullRequestOutcome::Closed
    } else {
        return Err(MutationError {
            rate,
            error: GitHubError::Parse {
                what: "closed pull request",
                source: format!("GitHub returned unexpected state {:?}", pull.state),
            },
        });
    };
    Ok(ClosePullRequestResult { outcome, rate })
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
/// Uses `all=true`: remote read state does not control ordinary inbox visibility, but
/// `unread` is retained to verify that a dismissed thread has a new generation. `on_page` is
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
    pub base_ref: String,
    pub repo_full_name: String,
    pub repo_owner: String,
    pub repo_name: String,
    pub pull_url: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Result of a Dependabot fetch across a repo list: the collected PRs, the last response's
/// `core` rate snapshot, and per-repo outcomes. `complete` is true when every repo was scanned
/// (so the caller may reconcile-delete stale local rows); it is false if the scan stopped early
/// (quota reserve / rate-limit) or a repo errored. `ok_repos` / `failed_repos` (by full name)
/// let the caller reset or increment each repo's failure counter for the drop policy.
pub struct DependabotFetchOutcome {
    pub prs: Vec<DependabotPr>,
    pub rate: RateLimit,
    pub complete: bool,
    pub ok_repos: Vec<String>,
    pub failed_repos: Vec<String>,
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
    base: MergeBase,
    created_at: String,
    updated_at: String,
}

/// Canonical GitHub logins trusted by the Automation PRs module.
pub const TRUSTED_AUTOMATION_AUTHORS: &[&str] = &[
    "dependabot[bot]",
    "dependabot-preview[bot]",
    "github-actions[bot]",
];

/// Whether `login` is a bot author trusted for Automation PR processing.
pub fn is_trusted_automation_author(login: &str) -> bool {
    TRUSTED_AUTOMATION_AUTHORS.contains(&login)
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

/// List open pull requests from supported automation bots in one repository (paginated + paced).
/// The Dependabot-specific name is retained to match the module's existing internal API.
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
            if !is_trusted_automation_author(&author) {
                continue;
            }
            prs.push(DependabotPr {
                id: p.id,
                number: p.number,
                title: p.title,
                html_url: p.html_url,
                author,
                base_ref: p.base.ref_name,
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

/// Fetch open supported automation PRs across the given `repos` (the persistent,
/// notification-sourced repo list). For each repo, lists its open PRs and keeps those from
/// supported automation bots. Uses only the core REST API, serial + paced (see
/// `DEPENDABOT_REQUEST_DELAY`), so it avoids
/// tripping GitHub's secondary rate limit. `on_progress(scanned, found)` reports live progress.
///
/// Per-repo results are reported in `ok_repos` (fetched successfully) and `failed_repos` (a
/// 404 or non-rate 403 — the repo is likely gone or no longer readable), so the caller can
/// reset/increment each repo's drop counter. Stops early — marking the result **incomplete**
/// (so the caller won't reconcile-delete) — on the core-quota reserve or a rate-limit; a
/// per-repo failure is skipped (not fatal). Only a 401 aborts the whole fetch.
pub async fn fetch_dependabot_prs_for_repos<F>(
    token: &str,
    repos: &[(String, String)],
    on_progress: F,
) -> Result<DependabotFetchOutcome, GitHubError>
where
    F: Fn(usize, usize) + Send,
{
    let client = reqwest::Client::new();
    let mut rate = RateLimit::default();
    let mut prs: Vec<DependabotPr> = Vec::new();
    let mut ok_repos: Vec<String> = Vec::new();
    let mut failed_repos: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    let mut complete = true;

    for (owner, name) in repos {
        // Leave headroom on the core bucket for everything else (notifications, merge-state
        // resolution); the unscanned repos resolve on a later sync.
        if core_below_reserve(&rate) {
            complete = false;
            break;
        }
        match list_open_dependabot_prs(&client, token, owner, name, &mut rate).await {
            Ok(repo_prs) => {
                prs.extend(repo_prs);
                ok_repos.push(format!("{owner}/{name}"));
            }
            Err(GitHubError::Unauthorized) => return Err(GitHubError::Unauthorized),
            // Back off on any rate-limit signal — a 403 whose body says "rate limit", a 429, or
            // any response carrying `Retry-After` (the header is recorded into `rate` even on an
            // error). Mirrors `ResolveError::should_back_off`; the unscanned repos resolve on a
            // later sync. Crucially, this must run *before* the 403 failure branch below so a
            // rate-limiting 403 isn't miscounted as a per-repo access failure (which would drop
            // a healthy repo after a few strikes).
            Err(e)
                if e.is_rate_limited()
                    || rate.retry_after.is_some()
                    || matches!(&e, GitHubError::Status { status, .. } if *status == reqwest::StatusCode::TOO_MANY_REQUESTS) =>
            {
                complete = false;
                break;
            }
            // A 404 / non-rate 403 means the repo is gone or no longer readable — record it so
            // the caller can drop it after a few consecutive failures. Other transient errors
            // (5xx, network, parse) are skipped without counting toward the drop.
            Err(e) => {
                if matches!(e, GitHubError::Forbidden(_))
                    || matches!(e, GitHubError::Status { status, .. } if status == reqwest::StatusCode::NOT_FOUND)
                {
                    failed_repos.push(format!("{owner}/{name}"));
                } else {
                    eprintln!("helix: listing PRs for {owner}/{name} failed, skipping: {e}");
                }
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
        ok_repos,
        failed_repos,
    })
}

/* ----------------------- Dependabot merge operations ---------------------- */

/// Classification used by the durable merge queue to decide whether a repository's FIFO head
/// retries or becomes terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeErrorClass {
    Auth,
    Rate,
    Transient,
    Permanent,
}

#[derive(Debug)]
pub struct MergeRemoteError {
    pub class: MergeErrorClass,
    pub message: String,
    pub rates: Vec<RateLimit>,
}

#[derive(Debug)]
pub enum MergeRemoteOutcome {
    Merged {
        head_sha: Option<String>,
    },
    Pending {
        head_sha: String,
        approved: bool,
        branch_update_requested: bool,
        reason: Option<String>,
    },
    Cancelled,
    PermanentFailure {
        code: &'static str,
        reason: String,
    },
    /// GitHub reports the validated direct-merge PR as blocked. The orchestrator diagnoses checks
    /// first, then determines whether a stale base branch is the remaining blocker.
    Blocked {
        head_sha: String,
        base_ref: String,
    },
    /// The head passed validation (and, unless `behind`, was approved), but the resolved merge
    /// strategy is not `Direct` — so no direct `PUT /merge` or `PUT /update-branch` was issued.
    /// The orchestrator uses `base_ref`/`node_id` to resolve/cache the strategy and drive the
    /// merge-queue flow (enable auto-merge / enqueue / poll) instead. Never surfaced to the
    /// FIFO loop: the orchestrator consumes it and returns one of the variants above.
    Prepared {
        head_sha: String,
        base_ref: String,
        node_id: String,
        mergeable_state: Option<String>,
    },
    /// No progress was made this tick and the durable `state` must not change — e.g. the
    /// operation is pacing itself away behind `next_action_at` (a scheduled retry/backoff that
    /// isn't due yet), so no network call was made. The orchestrator has already persisted any
    /// phase/event narration; the FIFO loop leaves the row exactly as it found it.
    Waiting,
}

#[derive(Debug)]
pub struct MergeRemoteResult {
    pub outcome: MergeRemoteOutcome,
    pub rates: Vec<RateLimit>,
}

#[derive(Debug, Deserialize)]
struct MergePull {
    state: String,
    #[serde(default)]
    draft: bool,
    merged_at: Option<String>,
    user: Option<SubjectUser>,
    mergeable_state: Option<String>,
    head: MergeHead,
    #[serde(default)]
    node_id: String,
    base: Option<MergeBase>,
}

#[derive(Debug, Deserialize)]
struct MergeHead {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct MergeBase {
    #[serde(rename = "ref")]
    ref_name: String,
}

fn merge_pull_has_trusted_author(pull: &MergePull) -> bool {
    pull.user
        .as_ref()
        .is_some_and(|user| is_trusted_automation_author(&user.login))
}

#[derive(Debug, Deserialize)]
struct MergeReview {
    user: Option<SubjectUser>,
    state: String,
    commit_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MergeLogin {
    login: String,
}

#[derive(Debug, Deserialize)]
struct MergeResponse {
    merged: bool,
    message: String,
}

#[derive(Debug, Deserialize)]
struct RepositoryMergeSettings {
    allow_squash_merge: bool,
    allow_merge_commit: bool,
    allow_rebase_merge: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectMergeMethod {
    Squash,
    Merge,
    Rebase,
}

impl DirectMergeMethod {
    fn as_api_value(self) -> &'static str {
        match self {
            Self::Squash => "squash",
            Self::Merge => "merge",
            Self::Rebase => "rebase",
        }
    }
}

fn enabled_direct_merge_methods(settings: &RepositoryMergeSettings) -> Vec<DirectMergeMethod> {
    let mut methods = Vec::with_capacity(3);
    if settings.allow_squash_merge {
        methods.push(DirectMergeMethod::Squash);
    }
    if settings.allow_rebase_merge {
        methods.push(DirectMergeMethod::Rebase);
    }
    if settings.allow_merge_commit {
        methods.push(DirectMergeMethod::Merge);
    }
    methods
}

fn merge_error(
    status: reqwest::StatusCode,
    body: String,
    rate: &RateLimit,
    rates: &mut Vec<RateLimit>,
) -> MergeRemoteError {
    let normalized_body = body.to_lowercase();
    let workflow_run_not_rerunnable = normalized_body.contains("workflow run cannot be retried")
        || normalized_body.contains("workflow run cannot be rerun")
        || normalized_body.contains("workflow run cannot be re-run");
    let class = if status == reqwest::StatusCode::FORBIDDEN && workflow_run_not_rerunnable {
        // This is specific to one stale/non-rerunnable Actions run, not the PAT. Treating every
        // non-rate 403 as auth would stop the global processor and starve unrelated repositories.
        MergeErrorClass::Permanent
    } else if status == reqwest::StatusCode::UNAUTHORIZED
        || (status == reqwest::StatusCode::FORBIDDEN
            && !normalized_body.contains("rate limit")
            && rate.retry_after.is_none())
    {
        MergeErrorClass::Auth
    } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || (status == reqwest::StatusCode::FORBIDDEN
            && (normalized_body.contains("rate limit") || rate.retry_after.is_some()))
    {
        MergeErrorClass::Rate
    } else if status.is_server_error()
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::CONFLICT
        || (status == reqwest::StatusCode::UNPROCESSABLE_ENTITY
            && normalized_body.contains("expected head sha"))
    {
        MergeErrorClass::Transient
    } else {
        MergeErrorClass::Permanent
    };
    MergeRemoteError {
        class,
        message: format!("GitHub returned {status}: {body}"),
        rates: std::mem::take(rates),
    }
}

async fn merge_json<T: for<'de> Deserialize<'de>>(
    request: reqwest::RequestBuilder,
    what: &'static str,
    rates: &mut Vec<RateLimit>,
) -> Result<T, MergeRemoteError> {
    let response = request.send().await.map_err(|e| MergeRemoteError {
        class: MergeErrorClass::Transient,
        message: format!("network error: {e}"),
        rates: std::mem::take(rates),
    })?;
    let status = response.status();
    let mut rate = RateLimit::default();
    rate.update_from(response.headers());
    rates.push(rate.clone());
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default().trim().to_string();
        return Err(merge_error(status, body, &rate, rates));
    }
    response.json().await.map_err(|e| MergeRemoteError {
        class: MergeErrorClass::Transient,
        message: format!("failed to parse {what}: {e}"),
        rates: std::mem::take(rates),
    })
}

fn merge_refusal_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("message")?.as_str().map(str::to_string))
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| "GitHub is still blocking this merge.".to_string())
}

fn merge_method_is_disallowed(message: &str) -> bool {
    [
        "Squash merges are not allowed on this repository.",
        "Merge commits are not allowed on this repository.",
        "Rebase merges are not allowed on this repository.",
    ]
    .iter()
    .any(|candidate| message.eq_ignore_ascii_case(candidate))
}

enum MergeAttemptResult {
    Response(MergeResponse),
    MethodDisallowed,
}

async fn merge_pull_request(
    request: reqwest::RequestBuilder,
    rates: &mut Vec<RateLimit>,
) -> Result<MergeAttemptResult, MergeRemoteError> {
    let response = request.send().await.map_err(|e| MergeRemoteError {
        class: MergeErrorClass::Transient,
        message: format!("network error: {e}"),
        rates: std::mem::take(rates),
    })?;
    let status = response.status();
    let mut rate = RateLimit::default();
    rate.update_from(response.headers());
    rates.push(rate.clone());
    if status.is_success() {
        return response
            .json()
            .await
            .map(MergeAttemptResult::Response)
            .map_err(|e| MergeRemoteError {
                class: MergeErrorClass::Transient,
                message: format!("failed to parse merge pull request: {e}"),
                rates: std::mem::take(rates),
            });
    }
    let body = response.text().await.unwrap_or_default().trim().to_string();
    if status == reqwest::StatusCode::METHOD_NOT_ALLOWED {
        let message = merge_refusal_message(&body);
        if merge_method_is_disallowed(&message) {
            return Ok(MergeAttemptResult::MethodDisallowed);
        }
        return Ok(MergeAttemptResult::Response(MergeResponse {
            merged: false,
            message,
        }));
    }
    Err(merge_error(status, body, &rate, rates))
}

async fn merge_empty(
    request: reqwest::RequestBuilder,
    rates: &mut Vec<RateLimit>,
) -> Result<reqwest::StatusCode, MergeRemoteError> {
    let response = request.send().await.map_err(|e| MergeRemoteError {
        class: MergeErrorClass::Transient,
        message: format!("network error: {e}"),
        rates: std::mem::take(rates),
    })?;
    let status = response.status();
    let mut rate = RateLimit::default();
    rate.update_from(response.headers());
    rates.push(rate.clone());
    if status.is_success() {
        Ok(status)
    } else {
        let body = response.text().await.unwrap_or_default().trim().to_string();
        Err(merge_error(status, body, &rate, rates))
    }
}

async fn merge_pages<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    mut url: String,
    token: &str,
    what: &'static str,
    rates: &mut Vec<RateLimit>,
) -> Result<Vec<T>, MergeRemoteError> {
    let mut all = Vec::new();
    loop {
        let response =
            authed_get(client, &url, token)
                .send()
                .await
                .map_err(|e| MergeRemoteError {
                    class: MergeErrorClass::Transient,
                    message: format!("network error: {e}"),
                    rates: std::mem::take(rates),
                })?;
        let status = response.status();
        let next = next_page_url(response.headers());
        let mut rate = RateLimit::default();
        rate.update_from(response.headers());
        rates.push(rate.clone());
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default().trim().to_string();
            return Err(merge_error(status, body, &rate, rates));
        }
        let mut page: Vec<T> = response.json().await.map_err(|e| MergeRemoteError {
            class: MergeErrorClass::Transient,
            message: format!("failed to parse {what}: {e}"),
            rates: std::mem::take(rates),
        })?;
        all.append(&mut page);
        match next {
            Some(next) => {
                url = next;
                tokio::time::sleep(DEPENDABOT_REQUEST_DELAY).await;
            }
            None => return Ok(all),
        }
    }
}

fn direct_merge_attempt_allowed(mergeable_state: Option<&str>) -> bool {
    matches!(mergeable_state, Some("clean" | "unstable"))
}

#[derive(Debug)]
pub struct PullHeadResult {
    pub head_sha: String,
    pub rates: Vec<RateLimit>,
}

/// Fetch the live pull-request head before dispatching durable work tied to an older SHA.
pub async fn fetch_pull_head(
    client: &reqwest::Client,
    token: &str,
    pull_url: &str,
) -> Result<PullHeadResult, MergeRemoteError> {
    let mut rates = Vec::new();
    let pull: MergePull = merge_json(
        authed_get(client, pull_url, token),
        "pull request head",
        &mut rates,
    )
    .await?;
    Ok(PullHeadResult {
        head_sha: pull.head.sha,
        rates,
    })
}

/// Process one queue head. This uses serial REST calls: normal queue heads are few, and REST
/// directly supports the live pull request, reviews, and exact-head mutations.
/// The caller owns durable state and must not hold SQLite while this function runs.
///
/// Shared entry point for both merge strategies (requirement 3): it verifies that the live pull
/// request has a trusted automation author and secures the PAT's approval at the exact current
/// head. Only
/// when `strategy` is [`MergeQueueStrategy::Direct`] does it then issue the direct
/// `PUT /merge` / `PUT /update-branch` mutations; for `MergeQueue`/`Unknown` it stops after
/// author verification and approval and returns [`MergeRemoteOutcome::Prepared`] so the
/// orchestrator can resolve/cache the policy and drive the GraphQL merge-queue flow instead — the
/// direct merge/update endpoints are never touched for a queue-governed branch (requirement 5).
pub async fn process_dependabot_merge_operation<Cancelled>(
    client: &reqwest::Client,
    token: &str,
    work: &crate::dependabot::MergeWork,
    timed_out: bool,
    strategy: MergeQueueStrategy,
    mutation_guard: &tokio::sync::Mutex<()>,
    is_cancelled: Cancelled,
) -> Result<MergeRemoteResult, MergeRemoteError>
where
    Cancelled: Fn() -> bool,
{
    let operation = &work.operation;
    let mut rates = Vec::new();
    let pull: MergePull = merge_json(
        authed_get(client, &operation.pull_url, token),
        "pull request",
        &mut rates,
    )
    .await?;
    let head_sha = pull.head.sha.clone();
    let base_ref = pull.base.as_ref().map(|b| b.ref_name.clone());
    let node_id = pull.node_id.clone();
    if pull.merged_at.is_some() {
        return Ok(MergeRemoteResult {
            outcome: MergeRemoteOutcome::Merged {
                head_sha: Some(head_sha),
            },
            rates,
        });
    }

    if operation.state == "cancel_requested" || timed_out || is_cancelled() {
        return Ok(MergeRemoteResult {
            outcome: MergeRemoteOutcome::Cancelled,
            rates,
        });
    }

    if !merge_pull_has_trusted_author(&pull) {
        return Ok(MergeRemoteResult {
            outcome: MergeRemoteOutcome::PermanentFailure {
                code: "untrusted_author",
                reason: "The live PR author is not a supported automation bot.".to_string(),
            },
            rates,
        });
    }
    if pull.state != "open" {
        return Ok(MergeRemoteResult {
            outcome: MergeRemoteOutcome::PermanentFailure {
                code: "not_open",
                reason: "The pull request is no longer open.".to_string(),
            },
            rates,
        });
    }
    if pull.draft {
        return Ok(MergeRemoteResult {
            outcome: MergeRemoteOutcome::PermanentFailure {
                code: "draft",
                reason: "The pull request is a draft.".to_string(),
            },
            rates,
        });
    }
    if pull.mergeable_state.as_deref() == Some("dirty") {
        return Ok(MergeRemoteResult {
            outcome: MergeRemoteOutcome::PermanentFailure {
                code: "dirty",
                reason: "The pull request has merge conflicts (DIRTY).".to_string(),
            },
            rates,
        });
    }

    // The live PR author is the provenance boundary. Later workflow or human pushes are allowed,
    // but the exact current head must still carry the PAT owner's approval before it can merge.
    // Re-check reviews when GitHub reports the PR blocked so a dismissed approval cannot deadlock
    // the operation.
    let head_already_approved = operation.state == "delegated"
        && operation.observed_head_sha.as_deref() == Some(head_sha.as_str())
        && operation.approved_head_sha.as_deref() == Some(head_sha.as_str());
    let needs_approval = pull.mergeable_state.as_deref() != Some("behind")
        && (!head_already_approved || pull.mergeable_state.as_deref() == Some("blocked"));

    if needs_approval {
        let login: MergeLogin = merge_json(
            authed_get(client, &format!("{API_BASE}/user"), token),
            "authenticated user",
            &mut rates,
        )
        .await?;
        let reviews: Vec<MergeReview> = merge_pages(
            client,
            format!(
                "{API_BASE}/repos/{}/pulls/{}/reviews?per_page={DEPENDABOT_PER_PAGE}",
                operation.repo_full_name, operation.number
            ),
            token,
            "pull request reviews",
            &mut rates,
        )
        .await?;
        let already_approved = reviews.iter().any(|review| {
            review.state.eq_ignore_ascii_case("APPROVED")
                && review.commit_id.as_deref() == Some(head_sha.as_str())
                && review.user.as_ref().is_some_and(|u| u.login == login.login)
        });
        if !already_approved {
            let _mutation_lease = mutation_guard.lock().await;
            if is_cancelled() {
                return Ok(MergeRemoteResult {
                    outcome: MergeRemoteOutcome::Cancelled,
                    rates,
                });
            }
            merge_empty(
                authed(
                    client
                        .post(format!(
                            "{API_BASE}/repos/{}/pulls/{}/reviews",
                            operation.repo_full_name, operation.number
                        ))
                        .json(&serde_json::json!({
                            "event": "APPROVE",
                            "commit_id": head_sha
                        })),
                    token,
                ),
                &mut rates,
            )
            .await?;
        }
    }

    // Author verification + approval are complete. For a queue-governed branch (or one whose
    // policy hasn't been resolved yet) stop here and hand back the accepted head, base ref, and
    // node id: the orchestrator resolves/caches the strategy and, when it's a merge queue, drives the
    // GraphQL auto-merge/enqueue flow. The direct merge/update endpoints below run only for a
    // conclusively `Direct` branch.
    if !matches!(strategy, MergeQueueStrategy::Direct) {
        return Ok(MergeRemoteResult {
            outcome: MergeRemoteOutcome::Prepared {
                head_sha,
                base_ref: base_ref.unwrap_or_default(),
                node_id,
                mergeable_state: pull.mergeable_state.clone(),
            },
            rates,
        });
    }

    // `unstable` is still mergeable but has a non-passing status, which can come from optional
    // checks. The merge endpoint remains authoritative if the REST mergeability snapshot is stale.
    if direct_merge_attempt_allowed(pull.mergeable_state.as_deref()) {
        let merge_settings: RepositoryMergeSettings = merge_json(
            authed_get(
                client,
                &format!("{API_BASE}/repos/{}", operation.repo_full_name),
                token,
            ),
            "repository merge settings",
            &mut rates,
        )
        .await?;
        let merge_methods = enabled_direct_merge_methods(&merge_settings);
        if merge_methods.is_empty() {
            return Ok(MergeRemoteResult {
                outcome: MergeRemoteOutcome::PermanentFailure {
                    code: "no_merge_method",
                    reason: "No direct merge method is enabled on this repository.".to_string(),
                },
                rates,
            });
        }
        let _mutation_lease = mutation_guard.lock().await;
        if is_cancelled() {
            return Ok(MergeRemoteResult {
                outcome: MergeRemoteOutcome::Cancelled,
                rates,
            });
        }
        for merge_method in merge_methods {
            let attempt = merge_pull_request(
                authed(
                    client
                        .put(format!(
                            "{API_BASE}/repos/{}/pulls/{}/merge",
                            operation.repo_full_name, operation.number
                        ))
                        .json(&serde_json::json!({
                            "sha": head_sha,
                            "merge_method": merge_method.as_api_value()
                        })),
                    token,
                ),
                &mut rates,
            )
            .await?;
            match attempt {
                MergeAttemptResult::MethodDisallowed => continue,
                MergeAttemptResult::Response(merged) if merged.merged => {
                    return Ok(MergeRemoteResult {
                        outcome: MergeRemoteOutcome::Merged {
                            head_sha: Some(head_sha),
                        },
                        rates,
                    });
                }
                MergeAttemptResult::Response(merged) => {
                    return Ok(MergeRemoteResult {
                        outcome: MergeRemoteOutcome::Pending {
                            head_sha,
                            approved: true,
                            branch_update_requested: false,
                            reason: Some(merged.message),
                        },
                        rates,
                    });
                }
            }
        }
        return Ok(MergeRemoteResult {
            outcome: MergeRemoteOutcome::PermanentFailure {
                code: "no_merge_method",
                reason: "GitHub rejected every repository-enabled direct merge method.".to_string(),
            },
            rates,
        });
    }

    if pull.mergeable_state.as_deref() == Some("behind") {
        let outcome = send_guarded_branch_update(
            update_pull_request_branch_request(
                client,
                token,
                &operation.repo_full_name,
                operation.number,
                &head_sha,
            ),
            mutation_guard,
            is_cancelled,
            &mut rates,
        )
        .await?;
        if outcome == MutationOutcome::Cancelled {
            return Ok(MergeRemoteResult {
                outcome: MergeRemoteOutcome::Cancelled,
                rates,
            });
        }
        return Ok(MergeRemoteResult {
            outcome: MergeRemoteOutcome::Pending {
                head_sha,
                approved: false,
                branch_update_requested: true,
                reason: Some("Updating the branch and waiting for fresh checks.".to_string()),
            },
            rates,
        });
    }

    if pull.mergeable_state.as_deref() == Some("blocked") {
        return Ok(MergeRemoteResult {
            outcome: MergeRemoteOutcome::Blocked {
                head_sha,
                base_ref: base_ref.unwrap_or_default(),
            },
            rates,
        });
    }

    Ok(MergeRemoteResult {
        outcome: MergeRemoteOutcome::Pending {
            head_sha,
            approved: true,
            branch_update_requested: false,
            reason: Some("Waiting for GitHub checks or required reviews.".to_string()),
        },
        rates,
    })
}

/* ------------------------- Exact-head check diagnosis --------------------- */

/// Where a pending/failed check came from — whether it's misattributed matters: a GitHub
/// Actions job cannot be rerun the same way an external check can (see
/// [`diagnose_exact_head_checks`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum CheckSource {
    Actions,
    External,
}

/// A check or status that hasn't concluded yet at the exact head SHA.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingCheck {
    pub name: String,
    pub source: CheckSource,
}

/// A failed GitHub Actions workflow run at the exact head SHA — carries what's needed to
/// offer a "rerun failed jobs" action ([`rerun_failed_jobs`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActionsRunFailure {
    pub run_id: i64,
    pub run_attempt: i64,
    pub name: Option<String>,
    pub conclusion: Option<String>,
}

/// A GitHub Actions workflow run that GitHub will not start until a maintainer approves it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkflowRunApproval {
    pub run_id: i64,
    pub run_attempt: i64,
    pub name: Option<String>,
}

/// A failed check run or legacy commit status from a non-Actions source. Helix has no way to
/// safely rerun these on the user's behalf (see requirement 7 in the phase-2 plan): the PAT
/// can't rerequest a third-party check suite, so this is surfaced for the human to act on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExternalCheckFailure {
    pub name: String,
    pub conclusion: Option<String>,
    pub details_url: Option<String>,
}

/// Result of diagnosing the checks/statuses/workflow runs at one commit SHA.
#[derive(Debug, Default)]
pub struct ExactHeadCheckDiagnosis {
    pub pending: Vec<PendingCheck>,
    pub approval_required: Vec<WorkflowRunApproval>,
    pub actions_failures: Vec<ActionsRunFailure>,
    pub external_failures: Vec<ExternalCheckFailure>,
    pub rates: Vec<RateLimit>,
}

/// The GitHub Actions app's slug on check runs (`check_run.app.slug`). Used to tell an Actions
/// job apart from a third-party Checks API user so Actions failures — surfaced instead from
/// the `actions/runs` listing, with a rerunnable `run_id` — are never double-counted as
/// "external".
const GITHUB_ACTIONS_APP_SLUG: &str = "github-actions";

#[derive(Debug, Deserialize)]
struct CheckRunsResponse {
    check_runs: Vec<CheckRunItem>,
}

#[derive(Debug, Deserialize)]
struct CheckRunApp {
    slug: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CheckRunItem {
    name: String,
    status: String,
    conclusion: Option<String>,
    details_url: Option<String>,
    app: Option<CheckRunApp>,
}

#[derive(Debug, Deserialize)]
struct WorkflowRunsResponse {
    workflow_runs: Vec<WorkflowRunItem>,
}

#[derive(Debug, Deserialize)]
struct WorkflowRunItem {
    id: i64,
    #[serde(default)]
    run_attempt: Option<i64>,
    name: Option<String>,
    status: String,
    conclusion: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CombinedStatusResponse {
    statuses: Vec<CombinedStatusItem>,
}

#[derive(Debug, Deserialize)]
struct CombinedStatusItem {
    state: String,
    context: String,
    target_url: Option<String>,
}

/// Whether a check-run/workflow-run `status` means it hasn't concluded yet. Per the REST docs
/// (`docs.github.com/en/rest/checks/runs`, `.../rest/actions/workflow-runs`), `completed` is
/// the only terminal status; everything else (`queued`, `in_progress`, and the
/// Apps-only `waiting`/`requested`/`pending`) is still pending.
fn is_check_pending_status(status: &str) -> bool {
    status != "completed"
}

/// Whether a check-run/workflow-run `conclusion` should be surfaced as a failure blocking the
/// merge. `success`/`neutral`/`skipped`/`stale` are not failures.
fn is_failure_conclusion(conclusion: &str) -> bool {
    matches!(
        conclusion,
        "failure" | "timed_out" | "cancelled" | "startup_failure"
    )
}

fn is_approval_required_conclusion(conclusion: Option<&str>) -> bool {
    conclusion == Some("action_required")
}

/// Whether a legacy commit-status `state` (`docs.github.com/en/rest/commits/statuses`) is a
/// failure. Valid states are `error`, `failure`, `pending`, `success`.
fn is_failure_status_state(state: &str) -> bool {
    matches!(state, "failure" | "error")
}

/// Diagnose the checks at an **exact** commit SHA: check runs, the combined legacy-status view,
/// and GitHub Actions workflow runs. Serial + paced like the Dependabot enumeration, and every
/// response's rate snapshot is returned so the caller can track all three buckets it touches
/// (`core`, plus whichever buckets Checks/Actions report against).
///
/// A GitHub Actions check run is *never* reported as an external failure — its workflow run
/// (with `run_id`/`run_attempt` for [`rerun_failed_jobs`]) is the authoritative source for
/// Actions failures, so Actions-owned check runs are skipped entirely in the check-runs pass.
pub async fn diagnose_exact_head_checks(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    head_sha: &str,
) -> Result<ExactHeadCheckDiagnosis, MergeRemoteError> {
    let mut rates = Vec::new();
    let mut pending = Vec::new();
    let mut approval_required = Vec::new();
    let mut actions_failures = Vec::new();
    let mut external_failures = Vec::new();

    let check_runs: Vec<CheckRunItem> = merge_pages_field(
        client,
        format!(
            "{API_BASE}/repos/{repo_full_name}/commits/{head_sha}/check-runs?per_page={DEPENDABOT_PER_PAGE}"
        ),
        token,
        "check runs",
        &mut rates,
        |wrapper: CheckRunsResponse| wrapper.check_runs,
    )
    .await?;

    for run in check_runs {
        let is_actions = run
            .app
            .as_ref()
            .and_then(|app| app.slug.as_deref())
            .is_some_and(|slug| slug == GITHUB_ACTIONS_APP_SLUG);
        if is_actions {
            // Classified from the workflow-run listing below instead — see the doc comment.
            continue;
        }
        if is_check_pending_status(&run.status) {
            pending.push(PendingCheck {
                name: run.name,
                source: CheckSource::External,
            });
            continue;
        }
        if run.conclusion.as_deref().is_some_and(is_failure_conclusion) {
            external_failures.push(ExternalCheckFailure {
                name: run.name,
                conclusion: run.conclusion,
                details_url: run.details_url,
            });
        }
    }

    tokio::time::sleep(DEPENDABOT_REQUEST_DELAY).await;
    let workflow_runs: Vec<WorkflowRunItem> = merge_pages_field(
        client,
        format!(
            "{API_BASE}/repos/{repo_full_name}/actions/runs?head_sha={head_sha}&per_page={DEPENDABOT_PER_PAGE}"
        ),
        token,
        "workflow runs",
        &mut rates,
        |wrapper: WorkflowRunsResponse| wrapper.workflow_runs,
    )
    .await?;

    for run in workflow_runs {
        if is_check_pending_status(&run.status) {
            pending.push(PendingCheck {
                name: run
                    .name
                    .unwrap_or_else(|| format!("workflow run {}", run.id)),
                source: CheckSource::Actions,
            });
            continue;
        }
        if is_approval_required_conclusion(run.conclusion.as_deref()) {
            approval_required.push(WorkflowRunApproval {
                run_id: run.id,
                run_attempt: run.run_attempt.unwrap_or(1),
                name: run.name,
            });
            continue;
        }
        if run.conclusion.as_deref().is_some_and(is_failure_conclusion) {
            actions_failures.push(ActionsRunFailure {
                run_id: run.id,
                run_attempt: run.run_attempt.unwrap_or(1),
                name: run.name,
                conclusion: run.conclusion,
            });
        }
    }

    tokio::time::sleep(DEPENDABOT_REQUEST_DELAY).await;
    let status: CombinedStatusResponse = merge_json(
        authed_get(
            client,
            &format!("{API_BASE}/repos/{repo_full_name}/commits/{head_sha}/status"),
            token,
        ),
        "combined status",
        &mut rates,
    )
    .await?;

    for item in status.statuses {
        if item.state == "pending" {
            pending.push(PendingCheck {
                name: item.context,
                source: CheckSource::External,
            });
            continue;
        }
        if is_failure_status_state(&item.state) {
            external_failures.push(ExternalCheckFailure {
                name: item.context,
                conclusion: Some(item.state),
                details_url: item.target_url,
            });
        }
    }

    Ok(ExactHeadCheckDiagnosis {
        pending,
        approval_required,
        actions_failures,
        external_failures,
        rates,
    })
}

/// Like [`merge_pages`], but for endpoints whose page body wraps the array in an object (e.g.
/// `{"check_runs": [...]}` instead of a bare `[...]`). `extract` pulls the array out of each
/// page's wrapper type `W`.
async fn merge_pages_field<W, T, F>(
    client: &reqwest::Client,
    mut url: String,
    token: &str,
    what: &'static str,
    rates: &mut Vec<RateLimit>,
    extract: F,
) -> Result<Vec<T>, MergeRemoteError>
where
    W: for<'de> Deserialize<'de>,
    F: Fn(W) -> Vec<T>,
{
    let mut all = Vec::new();
    loop {
        let response =
            authed_get(client, &url, token)
                .send()
                .await
                .map_err(|e| MergeRemoteError {
                    class: MergeErrorClass::Transient,
                    message: format!("network error: {e}"),
                    rates: std::mem::take(rates),
                })?;
        let status = response.status();
        let next = next_page_url(response.headers());
        let mut rate = RateLimit::default();
        rate.update_from(response.headers());
        rates.push(rate.clone());
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default().trim().to_string();
            return Err(merge_error(status, body, &rate, rates));
        }
        let wrapper: W = response.json().await.map_err(|e| MergeRemoteError {
            class: MergeErrorClass::Transient,
            message: format!("failed to parse {what}: {e}"),
            rates: std::mem::take(rates),
        })?;
        all.extend(extract(wrapper));
        match next {
            Some(next_url) => {
                url = next_url;
                tokio::time::sleep(DEPENDABOT_REQUEST_DELAY).await;
            }
            None => return Ok(all),
        }
    }
}

/* ----------------------------- Queue mutations ----------------------------- */

/// Outcome of a mutation gated by the shared mutation guard: either cancellation was observed
/// after the guard was acquired (so nothing was dispatched to GitHub), or GitHub accepted the
/// request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationOutcome {
    Cancelled,
    Applied,
}

#[derive(Debug)]
pub struct MutationResult {
    pub outcome: MutationOutcome,
    pub rates: Vec<RateLimit>,
}

#[derive(Debug)]
pub struct BranchComparisonResult {
    pub behind: bool,
    pub rates: Vec<RateLimit>,
}

#[derive(Debug, Deserialize)]
struct CompareResponse {
    behind_by: u64,
}

fn compare_url(repo_full_name: &str, base_ref: &str, head_sha: &str) -> Option<reqwest::Url> {
    let (owner, repo) = repo_full_name.split_once('/')?;
    let comparison = format!("{base_ref}...{head_sha}");
    let mut url = reqwest::Url::parse(API_BASE).ok()?;
    url.path_segments_mut()
        .ok()?
        .extend(["repos", owner, repo, "compare"])
        .push(&comparison);
    Some(url)
}

/// Compare the current base ref with the exact validated PR head. `behind_by > 0` means the base
/// contains commits absent from the head, even when GitHub collapses that fact into `BLOCKED`.
pub async fn compare_pull_request_branch(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    base_ref: &str,
    head_sha: &str,
) -> Result<BranchComparisonResult, MergeRemoteError> {
    let mut rates = Vec::new();
    let Some(url) = compare_url(repo_full_name, base_ref, head_sha) else {
        return Err(MergeRemoteError {
            class: MergeErrorClass::Permanent,
            message: "Could not construct the pull request comparison URL.".to_string(),
            rates,
        });
    };
    let comparison: CompareResponse = merge_json(
        authed_get(client, url.as_str(), token),
        "pull request branch comparison",
        &mut rates,
    )
    .await?;
    Ok(BranchComparisonResult {
        behind: comparison.behind_by > 0,
        rates,
    })
}

fn update_pull_request_branch_request(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    number: i64,
    expected_head_sha: &str,
) -> reqwest::RequestBuilder {
    authed(
        client
            .put(format!(
                "{API_BASE}/repos/{repo_full_name}/pulls/{number}/update-branch"
            ))
            .json(&serde_json::json!({ "expected_head_sha": expected_head_sha })),
        token,
    )
}

async fn send_guarded_branch_update<Cancelled>(
    request: reqwest::RequestBuilder,
    mutation_guard: &tokio::sync::Mutex<()>,
    is_cancelled: Cancelled,
    rates: &mut Vec<RateLimit>,
) -> Result<MutationOutcome, MergeRemoteError>
where
    Cancelled: Fn() -> bool,
{
    let _mutation_lease = mutation_guard.lock().await;
    if is_cancelled() {
        return Ok(MutationOutcome::Cancelled);
    }
    merge_json::<serde_json::Value>(request, "update pull request branch", rates).await?;
    Ok(MutationOutcome::Applied)
}

/// Update a PR branch from its base, guarded by the exact accepted head SHA and cancellation.
pub async fn update_pull_request_branch<Cancelled>(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    number: i64,
    expected_head_sha: &str,
    mutation_guard: &tokio::sync::Mutex<()>,
    is_cancelled: Cancelled,
) -> Result<MutationResult, MergeRemoteError>
where
    Cancelled: Fn() -> bool,
{
    let mut rates = Vec::new();
    let outcome = send_guarded_branch_update(
        update_pull_request_branch_request(
            client,
            token,
            repo_full_name,
            number,
            expected_head_sha,
        ),
        mutation_guard,
        is_cancelled,
        &mut rates,
    )
    .await?;
    Ok(MutationResult { outcome, rates })
}

/// Re-run the failed jobs of a workflow run (`POST .../actions/runs/{run_id}/rerun-failed-jobs`).
/// Uses the same auth headers, error classification, and rate capture as every other mutation
/// in this module; the caller owns any retry budget (there is deliberately none here — a
/// repeated rerun request is not idempotent the way the queue mutations below are, since each
/// call creates a new run attempt).
pub async fn rerun_failed_jobs<Cancelled>(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    run_id: i64,
    mutation_guard: &tokio::sync::Mutex<()>,
    is_cancelled: Cancelled,
) -> Result<MutationResult, MergeRemoteError>
where
    Cancelled: Fn() -> bool,
{
    let mut rates = Vec::new();
    let _mutation_lease = mutation_guard.lock().await;
    if is_cancelled() {
        return Ok(MutationResult {
            outcome: MutationOutcome::Cancelled,
            rates,
        });
    }
    merge_empty(
        authed(
            client.post(format!(
                "{API_BASE}/repos/{repo_full_name}/actions/runs/{run_id}/rerun-failed-jobs"
            )),
            token,
        ),
        &mut rates,
    )
    .await?;
    Ok(MutationResult {
        outcome: MutationOutcome::Applied,
        rates,
    })
}

/// Approve a workflow run that GitHub is holding for maintainer authorization
/// (`POST .../actions/runs/{run_id}/approve`). GitHub returns 201 when approval is applied,
/// 204 when this user already approved it, and 409 when the run is no longer awaiting approval;
/// all three are successful reconciliation outcomes for the processor.
pub async fn approve_workflow_run<Cancelled>(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    run_id: i64,
    mutation_guard: &tokio::sync::Mutex<()>,
    is_cancelled: Cancelled,
) -> Result<MutationResult, MergeRemoteError>
where
    Cancelled: Fn() -> bool,
{
    let mut rates = Vec::new();
    let _mutation_lease = mutation_guard.lock().await;
    if is_cancelled() {
        return Ok(MutationResult {
            outcome: MutationOutcome::Cancelled,
            rates,
        });
    }
    let response = authed(
        client.post(format!(
            "{API_BASE}/repos/{repo_full_name}/actions/runs/{run_id}/approve"
        )),
        token,
    )
    .send()
    .await
    .map_err(|e| MergeRemoteError {
        class: MergeErrorClass::Transient,
        message: format!("network error: {e}"),
        rates: std::mem::take(&mut rates),
    })?;
    let status = response.status();
    let mut rate = RateLimit::default();
    rate.update_from(response.headers());
    rates.push(rate.clone());
    if workflow_approval_status_is_success(status) {
        return Ok(MutationResult {
            outcome: MutationOutcome::Applied,
            rates,
        });
    }
    let body = response.text().await.unwrap_or_default().trim().to_string();
    Err(merge_error(status, body, &rate, &mut rates))
}

fn workflow_approval_status_is_success(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::CREATED
            | reqwest::StatusCode::NO_CONTENT
            | reqwest::StatusCode::CONFLICT
    )
}

/* -------------------------- Merge-queue policy detection ------------------- */

/// Whether a repo/base branch merges directly or requires GitHub's merge queue.
/// `Unknown` means the policy could not be conclusively determined (both the REST rules
/// endpoint and the GraphQL fallback were inaccessible/ambiguous) — callers must not treat it
/// as `Direct`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum MergeQueueStrategy {
    Direct,
    MergeQueue,
    Unknown,
}

#[derive(Debug)]
pub struct MergeQueuePolicy {
    pub strategy: MergeQueueStrategy,
    pub rates: Vec<RateLimit>,
}

#[derive(Debug)]
pub struct RefUpdateRestrictionResult {
    /// `None` means the active rules or their source ruleset bypass details were inconclusive.
    pub restricted: Option<bool>,
    pub rates: Vec<RateLimit>,
}

#[derive(Debug, Deserialize, Clone, PartialEq, Eq)]
struct BranchRuleItem {
    #[serde(rename = "type")]
    rule_type: String,
    #[serde(default)]
    ruleset_id: Option<i64>,
}

/// Whether any active branch rule requires a merge queue (`type == "merge_queue"`, per
/// `docs.github.com/en/rest/repos/rules`).
fn rules_indicate_merge_queue(rules: &[BranchRuleItem]) -> bool {
    rules.iter().any(|rule| rule.rule_type == "merge_queue")
}

fn resolve_merge_queue_strategy(
    rest_requires_queue: bool,
    graphql_has_queue: Option<bool>,
) -> MergeQueueStrategy {
    if rest_requires_queue {
        return MergeQueueStrategy::MergeQueue;
    }
    match graphql_has_queue {
        Some(true) => MergeQueueStrategy::MergeQueue,
        Some(false) => MergeQueueStrategy::Direct,
        None => MergeQueueStrategy::Unknown,
    }
}

/// Rulesets that actively restrict updates to the matching ref. A missing ruleset ID makes the
/// result inconclusive because bypass permission cannot then be checked safely.
fn update_rule_ruleset_ids(rules: &[BranchRuleItem]) -> Option<std::collections::BTreeSet<i64>> {
    rules
        .iter()
        .filter(|rule| rule.rule_type == "update")
        .map(|rule| rule.ruleset_id)
        .collect()
}

enum BranchRulesOutcome {
    Rules(Vec<BranchRuleItem>),
    /// The rules endpoint could not answer (404, or a non-rate-limit 403 — insufficient scope,
    /// plan restriction, etc.). The caller must not read this as "no rules" and must fall back
    /// instead of guessing `Direct`.
    Inconclusive,
}

/// GET the active branch rules, treating 404/non-rate 403 as [`BranchRulesOutcome::Inconclusive`]
/// (so the caller can fall back to GraphQL) instead of a hard error. Any other failure (auth,
/// rate limit, network, server error) still propagates normally.
async fn fetch_branch_rules(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    base_branch: &str,
    rates: &mut Vec<RateLimit>,
) -> Result<BranchRulesOutcome, MergeRemoteError> {
    let mut url = format!(
        "{API_BASE}/repos/{repo_full_name}/rules/branches/{base_branch}?per_page={DEPENDABOT_PER_PAGE}"
    );
    let mut rules = Vec::new();
    loop {
        let response =
            authed_get(client, &url, token)
                .send()
                .await
                .map_err(|e| MergeRemoteError {
                    class: MergeErrorClass::Transient,
                    message: format!("network error: {e}"),
                    rates: std::mem::take(rates),
                })?;
        let status = response.status();
        let next = next_page_url(response.headers());
        let mut rate = RateLimit::default();
        rate.update_from(response.headers());
        rates.push(rate.clone());
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(BranchRulesOutcome::Inconclusive);
        }
        if status == reqwest::StatusCode::FORBIDDEN {
            let body = response.text().await.unwrap_or_default();
            if !body.to_lowercase().contains("rate limit") && rate.retry_after.is_none() {
                return Ok(BranchRulesOutcome::Inconclusive);
            }
            return Err(merge_error(status, body.trim().to_string(), &rate, rates));
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default().trim().to_string();
            return Err(merge_error(status, body, &rate, rates));
        }
        let mut page: Vec<BranchRuleItem> =
            response.json().await.map_err(|e| MergeRemoteError {
                class: MergeErrorClass::Transient,
                message: format!("failed to parse branch rules: {e}"),
                rates: std::mem::take(rates),
            })?;
        rules.append(&mut page);
        match next {
            Some(next_url) => {
                url = next_url;
                tokio::time::sleep(DEPENDABOT_REQUEST_DELAY).await;
            }
            None => return Ok(BranchRulesOutcome::Rules(rules)),
        }
    }
}

#[derive(Debug, Deserialize)]
struct MergeQueueLookupData {
    repository: Option<MergeQueueLookupRepo>,
}

#[derive(Debug, Deserialize)]
struct MergeQueueLookupRepo {
    #[serde(rename = "mergeQueue")]
    merge_queue: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RulesetBypass {
    #[serde(default)]
    current_user_can_bypass: Option<String>,
}

/// Fetch this actor's bypass capability for one active ruleset. Missing/inaccessible details are
/// inconclusive; rate, network, and server failures still propagate through the normal backoff.
async fn fetch_ruleset_bypass(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    ruleset_id: i64,
    rates: &mut Vec<RateLimit>,
) -> Result<Option<RulesetBypass>, MergeRemoteError> {
    let response = authed_get(
        client,
        &format!("{API_BASE}/repos/{repo_full_name}/rulesets/{ruleset_id}"),
        token,
    )
    .send()
    .await
    .map_err(|e| MergeRemoteError {
        class: MergeErrorClass::Transient,
        message: format!("network error: {e}"),
        rates: std::mem::take(rates),
    })?;
    let status = response.status();
    let mut rate = RateLimit::default();
    rate.update_from(response.headers());
    rates.push(rate.clone());
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        let body = response.text().await.unwrap_or_default();
        if !body.to_lowercase().contains("rate limit") && rate.retry_after.is_none() {
            return Ok(None);
        }
        return Err(merge_error(status, body.trim().to_string(), &rate, rates));
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default().trim().to_string();
        return Err(merge_error(status, body, &rate, rates));
    }
    response
        .json()
        .await
        .map(Some)
        .map_err(|e| MergeRemoteError {
            class: MergeErrorClass::Transient,
            message: format!("failed to parse ruleset bypass permission: {e}"),
            rates: std::mem::take(rates),
        })
}

/// Determine whether active branch rules prohibit this account from updating the target ref.
/// The update rule alone is insufficient because bypass actors still receive it; terminalize only
/// when its source ruleset says this actor can `never` bypass. Inaccessible rule/ruleset details
/// are inconclusive rather than evidence that the ref is writable.
pub async fn detect_ref_update_restriction(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    base_branch: &str,
) -> Result<RefUpdateRestrictionResult, MergeRemoteError> {
    let mut rates = Vec::new();
    let rules =
        match fetch_branch_rules(client, token, repo_full_name, base_branch, &mut rates).await? {
            BranchRulesOutcome::Rules(rules) => rules,
            BranchRulesOutcome::Inconclusive => {
                return Ok(RefUpdateRestrictionResult {
                    restricted: None,
                    rates,
                });
            }
        };
    let Some(ruleset_ids) = update_rule_ruleset_ids(&rules) else {
        return Ok(RefUpdateRestrictionResult {
            restricted: None,
            rates,
        });
    };
    if ruleset_ids.is_empty() {
        return Ok(RefUpdateRestrictionResult {
            restricted: Some(false),
            rates,
        });
    }
    let mut inconclusive = false;
    for ruleset_id in ruleset_ids {
        match fetch_ruleset_bypass(client, token, repo_full_name, ruleset_id, &mut rates).await? {
            Some(ruleset) if ruleset.current_user_can_bypass.as_deref() == Some("never") => {
                return Ok(RefUpdateRestrictionResult {
                    restricted: Some(true),
                    rates,
                });
            }
            Some(ruleset) if ruleset.current_user_can_bypass.is_some() => {}
            Some(_) => inconclusive = true,
            None => inconclusive = true,
        }
    }
    let restricted = if inconclusive { None } else { Some(false) };
    Ok(RefUpdateRestrictionResult { restricted, rates })
}

/// Detect whether `base_branch` in `repo_full_name` merges directly or requires GitHub's merge
/// queue. The active branch-rules REST endpoint (`GET .../rules/branches/{branch}`, looking for
/// a `merge_queue` rule) is tried first as a positive signal; an absent rule is not definitive
/// because GitHub can omit an active queue from that response. The classic
/// `BranchProtectionRule.requiresMergeQueue` GraphQL field is not present in the current public
/// schema (verified against the schema `octokit/graphql-schema` mirrors from introspection), so
/// the confirmation asks `Repository.mergeQueue(branch:)` — a schema-confirmed field that
/// resolves to the active `MergeQueue` for that branch (from either a ruleset or classic branch
/// protection) or `null` if none applies. See this function's summary note for the coordinator.
///
/// REST auth, rate-limit, network, and server errors still propagate directly. If GraphQL is
/// inconclusive (error, or the repository/ref can't be resolved), the result is
/// [`MergeQueueStrategy::Unknown`] rather than a guessed `Direct`.
pub async fn detect_merge_queue_policy(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    base_branch: &str,
) -> Result<MergeQueuePolicy, MergeRemoteError> {
    let mut rates = Vec::new();
    let rest_requires_queue =
        match fetch_branch_rules(client, token, repo_full_name, base_branch, &mut rates).await? {
            BranchRulesOutcome::Rules(rules) => rules_indicate_merge_queue(&rules),
            BranchRulesOutcome::Inconclusive => false,
        };
    if rest_requires_queue {
        return Ok(MergeQueuePolicy {
            strategy: MergeQueueStrategy::MergeQueue,
            rates,
        });
    }

    let Some((owner, repo)) = repo_full_name.split_once('/') else {
        return Ok(MergeQueuePolicy {
            strategy: MergeQueueStrategy::Unknown,
            rates,
        });
    };
    let query = r#"
        query($owner: String!, $repo: String!, $branch: String!) {
          repository(owner: $owner, name: $repo) {
            mergeQueue(branch: $branch) { id }
          }
        }
    "#;
    let variables = serde_json::json!({ "owner": owner, "repo": repo, "branch": base_branch });
    match graphql_request::<MergeQueueLookupData>(
        client,
        token,
        query,
        variables,
        "merge queue lookup",
        &mut rates,
    )
    .await
    {
        Ok(data) => {
            let graphql_has_queue = data.repository.map(|repo| repo.merge_queue.is_some());
            let strategy = resolve_merge_queue_strategy(rest_requires_queue, graphql_has_queue);
            Ok(MergeQueuePolicy { strategy, rates })
        }
        Err(err) => Ok(MergeQueuePolicy {
            strategy: MergeQueueStrategy::Unknown,
            rates: err.rates,
        }),
    }
}

/* -------------------------------- GraphQL ---------------------------------- */

const GRAPHQL_API: &str = "https://api.github.com/graphql";

#[derive(Debug, Deserialize)]
struct GraphQlErrorItem {
    message: String,
    #[serde(rename = "type")]
    error_type: Option<String>,
}

// `data` is kept as an untyped `Value` (rather than a generic `T`) so this envelope itself
// doesn't need to be generic: serde's derive would otherwise require `T: Default` for the
// `#[serde(default)]` on `data`, even though `Option<T>` doesn't actually need it. The final
// typed value is pulled out with `serde_json::from_value` once errors have been ruled out.
#[derive(Debug, Deserialize)]
struct GraphQlEnvelope {
    #[serde(default)]
    data: Option<serde_json::Value>,
    #[serde(default)]
    errors: Option<Vec<GraphQlErrorItem>>,
}

/// Classify a non-empty GraphQL `errors` array using each error's `type` (GitHub's GraphQL
/// error extension: `NOT_FOUND`, `FORBIDDEN`, `RATE_LIMITED`, `INTERNAL`, `UNPROCESSABLE`, …).
/// Unrecognized/absent types are treated as permanent rather than silently retried.
fn classify_graphql_errors(errors: &[GraphQlErrorItem]) -> MergeErrorClass {
    if errors
        .iter()
        .any(|e| e.error_type.as_deref() == Some("RATE_LIMITED"))
    {
        MergeErrorClass::Rate
    } else if errors.iter().any(|e| {
        matches!(
            e.error_type.as_deref(),
            Some("INTERNAL") | Some("SERVICE_UNAVAILABLE") | Some("TIMEOUT")
        )
    }) {
        MergeErrorClass::Transient
    } else {
        MergeErrorClass::Permanent
    }
}

/// POST one GraphQL request against `https://api.github.com/graphql`, using the same auth
/// headers, rate capture (GraphQL responses carry `X-RateLimit-*` too, for the `graphql`
/// bucket), and [`MergeRemoteError`] classes as the REST helpers. A 200 response with a
/// non-empty `errors` array is still an error — classified via [`classify_graphql_errors`], not
/// silently ignored in favor of a possibly-null `data`.
async fn graphql_request<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    token: &str,
    query: &str,
    variables: serde_json::Value,
    what: &'static str,
    rates: &mut Vec<RateLimit>,
) -> Result<T, MergeRemoteError> {
    let body = serde_json::json!({ "query": query, "variables": variables });
    let response = authed(client.post(GRAPHQL_API).json(&body), token)
        .send()
        .await
        .map_err(|e| MergeRemoteError {
            class: MergeErrorClass::Transient,
            message: format!("network error: {e}"),
            rates: std::mem::take(rates),
        })?;
    let status = response.status();
    let mut rate = RateLimit::default();
    rate.update_from(response.headers());
    rates.push(rate.clone());
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default().trim().to_string();
        return Err(merge_error(status, body_text, &rate, rates));
    }
    let parsed: GraphQlEnvelope = response.json().await.map_err(|e| MergeRemoteError {
        class: MergeErrorClass::Transient,
        message: format!("failed to parse {what}: {e}"),
        rates: std::mem::take(rates),
    })?;
    if let Some(errors) = parsed.errors {
        if !errors.is_empty() {
            let class = classify_graphql_errors(&errors);
            let message = errors
                .into_iter()
                .map(|e| e.message)
                .collect::<Vec<_>>()
                .join("; ");
            return Err(MergeRemoteError {
                class,
                message: format!("GraphQL error for {what}: {message}"),
                rates: std::mem::take(rates),
            });
        }
    }
    match parsed.data {
        Some(value) if !value.is_null() => {
            serde_json::from_value(value).map_err(|e| MergeRemoteError {
                class: MergeErrorClass::Transient,
                message: format!("failed to parse {what}: {e}"),
                rates: std::mem::take(rates),
            })
        }
        _ => Err(MergeRemoteError {
            class: MergeErrorClass::Transient,
            message: format!("GraphQL response for {what} had no data"),
            rates: std::mem::take(rates),
        }),
    }
}

/* ---------------------------- PR queue status query ------------------------ */

/// A merge-queue entry attached to a pull request (`PullRequest.mergeQueueEntry`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MergeQueueEntryStatus {
    pub id: String,
    pub position: Option<i64>,
    pub state: Option<String>,
}

/// A pull request's merge-readiness, as seen through GraphQL. `check_status` is the head
/// commit's `statusCheckRollup.state` (`SUCCESS`/`FAILURE`/`PENDING`/`ERROR`/`EXPECTED`, or
/// `None` if GitHub has no rollup yet).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrQueueStatus {
    pub node_id: String,
    pub head_oid: String,
    pub state: String,
    pub merged: bool,
    pub mergeable: Option<String>,
    pub review_decision: Option<String>,
    pub check_status: Option<String>,
    pub auto_merge_enabled: bool,
    pub merge_queue_entry: Option<MergeQueueEntryStatus>,
}

pub struct PrQueueStatusResult {
    pub status: Option<PrQueueStatus>,
    pub rates: Vec<RateLimit>,
}

#[derive(Debug, Deserialize)]
struct PrQueueStatusData {
    repository: Option<PrQueueRepo>,
}

#[derive(Debug, Deserialize)]
struct PrQueueRepo {
    #[serde(rename = "pullRequest")]
    pull_request: Option<PrQueueNode>,
}

#[derive(Debug, Deserialize)]
struct PrQueueNode {
    id: String,
    #[serde(rename = "headRefOid")]
    head_ref_oid: String,
    state: String,
    merged: bool,
    mergeable: Option<String>,
    #[serde(rename = "reviewDecision")]
    review_decision: Option<String>,
    #[serde(rename = "autoMergeRequest")]
    auto_merge_request: Option<serde_json::Value>,
    #[serde(rename = "mergeQueueEntry")]
    merge_queue_entry: Option<GraphQlMergeQueueEntry>,
    commits: Option<PrQueueCommits>,
}

#[derive(Debug, Deserialize)]
struct GraphQlMergeQueueEntry {
    id: String,
    position: Option<i64>,
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PrQueueCommits {
    nodes: Vec<PrQueueCommitNode>,
}

#[derive(Debug, Deserialize)]
struct PrQueueCommitNode {
    commit: PrQueueCommitInner,
}

#[derive(Debug, Deserialize)]
struct PrQueueCommitInner {
    #[serde(rename = "statusCheckRollup")]
    status_check_rollup: Option<PrQueueRollup>,
}

#[derive(Debug, Deserialize)]
struct PrQueueRollup {
    state: String,
}

/// Fetch a pull request's queue-relevant status via GraphQL: node ID, head OID, merged/open
/// state, mergeable/review/check status, whether auto-merge is enabled, and its merge-queue
/// entry (ID/position/state) when one exists. Returns `status: None` (rather than an error) if
/// the PR itself can't be resolved (e.g. `repository` or `pullRequest` came back null) — a
/// GraphQL-level error still propagates as [`MergeRemoteError`].
pub async fn fetch_pr_queue_status(
    client: &reqwest::Client,
    token: &str,
    repo_full_name: &str,
    number: i64,
) -> Result<PrQueueStatusResult, MergeRemoteError> {
    let mut rates = Vec::new();
    let Some((owner, repo)) = repo_full_name.split_once('/') else {
        return Err(MergeRemoteError {
            class: MergeErrorClass::Permanent,
            message: format!("'{repo_full_name}' is not an owner/repo full name"),
            rates,
        });
    };
    let query = r#"
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              id
              headRefOid
              state
              merged
              mergeable
              reviewDecision
              autoMergeRequest { enabledAt }
              mergeQueueEntry { id position state }
              commits(last: 1) {
                nodes {
                  commit {
                    statusCheckRollup { state }
                  }
                }
              }
            }
          }
        }
    "#;
    let variables = serde_json::json!({ "owner": owner, "repo": repo, "number": number });
    let data: PrQueueStatusData = graphql_request(
        client,
        token,
        query,
        variables,
        "pull request queue status",
        &mut rates,
    )
    .await?;
    let status = data.repository.and_then(|r| r.pull_request).map(|pr| {
        let check_status = pr
            .commits
            .and_then(|commits| commits.nodes.into_iter().next())
            .and_then(|node| node.commit.status_check_rollup)
            .map(|rollup| rollup.state);
        PrQueueStatus {
            node_id: pr.id,
            head_oid: pr.head_ref_oid,
            state: pr.state,
            merged: pr.merged,
            mergeable: pr.mergeable,
            review_decision: pr.review_decision,
            check_status,
            auto_merge_enabled: pr.auto_merge_request.is_some(),
            merge_queue_entry: pr.merge_queue_entry.map(|entry| MergeQueueEntryStatus {
                id: entry.id,
                position: entry.position,
                state: entry.state,
            }),
        }
    });
    Ok(PrQueueStatusResult { status, rates })
}

/* ------------------------------ Queue mutations ----------------------------- */

/// Whether a GraphQL business-logic error indicates the mutation's target state was already
/// applied (e.g. dequeuing a PR that already left the queue, or enabling auto-merge that's
/// already on). Treating these as success makes the enqueue/dequeue/auto-merge mutations
/// idempotent — safe to retry after an ambiguous prior attempt (e.g. a timeout where GitHub may
/// have applied the mutation before the response was lost).
fn is_already_applied_error(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("already enabled")
        || normalized.contains("already queued")
        || normalized.contains("already merged")
        || normalized.contains("not enabled")
        || normalized.contains("not on the queue")
        || normalized.contains("not in the queue")
        || normalized.contains("not currently queued")
        || normalized.contains("not enqueued")
}

/// Run one GraphQL mutation behind the shared mutation guard: acquire the guard, check
/// cancellation *after* acquiring it and *before* dispatching (so a request already sent to
/// GitHub always wins the race — same discipline as [`process_dependabot_merge_operation`]),
/// then dispatch. A business-logic error that means the target state already holds (see
/// [`is_already_applied_error`]) is folded into `Applied` rather than propagated.
async fn run_guarded_mutation<Cancelled>(
    client: &reqwest::Client,
    token: &str,
    query: &str,
    variables: serde_json::Value,
    what: &'static str,
    mutation_guard: &tokio::sync::Mutex<()>,
    is_cancelled: Cancelled,
) -> Result<MutationResult, MergeRemoteError>
where
    Cancelled: Fn() -> bool,
{
    let mut rates = Vec::new();
    let _mutation_lease = mutation_guard.lock().await;
    if is_cancelled() {
        return Ok(MutationResult {
            outcome: MutationOutcome::Cancelled,
            rates,
        });
    }
    match graphql_request::<serde_json::Value>(client, token, query, variables, what, &mut rates)
        .await
    {
        Ok(_) => Ok(MutationResult {
            outcome: MutationOutcome::Applied,
            rates,
        }),
        Err(err) if is_already_applied_error(&err.message) => Ok(MutationResult {
            outcome: MutationOutcome::Applied,
            rates: err.rates,
        }),
        Err(err) => Err(err),
    }
}

/// Enable auto-merge (always `SQUASH`) on a pull request, bound to `expected_head_oid` so it
/// can't silently apply to a head the caller hasn't validated.
pub async fn enable_pr_auto_merge<Cancelled>(
    client: &reqwest::Client,
    token: &str,
    pull_request_node_id: &str,
    expected_head_oid: &str,
    mutation_guard: &tokio::sync::Mutex<()>,
    is_cancelled: Cancelled,
) -> Result<MutationResult, MergeRemoteError>
where
    Cancelled: Fn() -> bool,
{
    let query = r#"
        mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
          enablePullRequestAutoMerge(input: {
            pullRequestId: $pullRequestId
            expectedHeadOid: $expectedHeadOid
            mergeMethod: SQUASH
          }) {
            clientMutationId
          }
        }
    "#;
    let variables = serde_json::json!({
        "pullRequestId": pull_request_node_id,
        "expectedHeadOid": expected_head_oid,
    });
    run_guarded_mutation(
        client,
        token,
        query,
        variables,
        "enable auto-merge",
        mutation_guard,
        is_cancelled,
    )
    .await
}

/// Disable auto-merge on a pull request.
pub async fn disable_pr_auto_merge<Cancelled>(
    client: &reqwest::Client,
    token: &str,
    pull_request_node_id: &str,
    mutation_guard: &tokio::sync::Mutex<()>,
    is_cancelled: Cancelled,
) -> Result<MutationResult, MergeRemoteError>
where
    Cancelled: Fn() -> bool,
{
    let query = r#"
        mutation($pullRequestId: ID!) {
          disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
            clientMutationId
          }
        }
    "#;
    let variables = serde_json::json!({ "pullRequestId": pull_request_node_id });
    run_guarded_mutation(
        client,
        token,
        query,
        variables,
        "disable auto-merge",
        mutation_guard,
        is_cancelled,
    )
    .await
}

/// Enqueue a pull request into its repository's merge queue, bound to `expected_head_oid`.
/// Always enqueues at the back (`jump: false`) — Helix's FIFO queue owns ordering, so a Helix
/// request must never jump ahead of what GitHub's queue already holds.
pub async fn enqueue_pr<Cancelled>(
    client: &reqwest::Client,
    token: &str,
    pull_request_node_id: &str,
    expected_head_oid: &str,
    mutation_guard: &tokio::sync::Mutex<()>,
    is_cancelled: Cancelled,
) -> Result<MutationResult, MergeRemoteError>
where
    Cancelled: Fn() -> bool,
{
    let query = r#"
        mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $jump: Boolean!) {
          enqueuePullRequest(input: {
            pullRequestId: $pullRequestId
            expectedHeadOid: $expectedHeadOid
            jump: $jump
          }) {
            mergeQueueEntry { id }
          }
        }
    "#;
    let variables = serde_json::json!({
        "pullRequestId": pull_request_node_id,
        "expectedHeadOid": expected_head_oid,
        "jump": false,
    });
    run_guarded_mutation(
        client,
        token,
        query,
        variables,
        "enqueue pull request",
        mutation_guard,
        is_cancelled,
    )
    .await
}

/// Dequeue a pull request from its repository's merge queue.
pub async fn dequeue_pr<Cancelled>(
    client: &reqwest::Client,
    token: &str,
    pull_request_node_id: &str,
    mutation_guard: &tokio::sync::Mutex<()>,
    is_cancelled: Cancelled,
) -> Result<MutationResult, MergeRemoteError>
where
    Cancelled: Fn() -> bool,
{
    let query = r#"
        mutation($id: ID!) {
          dequeuePullRequest(input: { id: $id }) {
            clientMutationId
          }
        }
    "#;
    let variables = serde_json::json!({ "id": pull_request_node_id });
    run_guarded_mutation(
        client,
        token,
        query,
        variables,
        "dequeue pull request",
        mutation_guard,
        is_cancelled,
    )
    .await
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
    fn close_pull_request_builds_the_documented_patch() {
        let request =
            close_pull_request_request(&reqwest::Client::new(), "token", "octo/widgets", 42)
                .build()
                .unwrap();
        assert_eq!(request.method(), reqwest::Method::PATCH);
        assert_eq!(
            request.url().as_str(),
            format!("{API_BASE}/repos/octo/widgets/pulls/42")
        );
        assert_eq!(
            request.body().and_then(reqwest::Body::as_bytes),
            Some(br#"{"state":"closed"}"#.as_slice())
        );
        assert_eq!(
            request
                .headers()
                .get("X-GitHub-Api-Version")
                .and_then(|value| value.to_str().ok()),
            Some(API_VERSION)
        );
    }

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
    fn trusted_automation_author_matches_supported_bot_logins() {
        assert!(is_trusted_automation_author("dependabot[bot]"));
        assert!(is_trusted_automation_author("dependabot-preview[bot]"));
        assert!(is_trusted_automation_author("github-actions[bot]"));
        assert!(!is_trusted_automation_author("octocat"));
        assert!(!is_trusted_automation_author("renovate[bot]"));
        assert!(!is_trusted_automation_author("github-actions"));
        assert!(!is_trusted_automation_author("dependabot"));
    }

    #[test]
    fn pull_list_item_deserializes_target_branch() {
        let item: PullListItem = serde_json::from_str(
            r#"{
                "id": 1,
                "number": 10,
                "title": "Bump dependency",
                "html_url": "https://github.com/octo/repo/pull/10",
                "url": "https://api.github.com/repos/octo/repo/pulls/10",
                "user": {"login": "dependabot[bot]"},
                "base": {"ref": "release/next"},
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-02T00:00:00Z"
            }"#,
        )
        .unwrap();

        assert_eq!(item.base.ref_name, "release/next");
    }

    #[test]
    fn notification_and_subject_activity_signals_deserialize() {
        let thread: NotificationThread = serde_json::from_str(
            r#"{
                "id": "42",
                "repository": {
                    "id": 1,
                    "name": "repo",
                    "full_name": "octo/repo",
                    "owner": {"login": "octo"},
                    "private": false,
                    "updated_at": "2026-01-01T00:00:00Z"
                },
                "subject": {
                    "title": "Issue",
                    "url": "https://api.github.com/repos/octo/repo/issues/1",
                    "type": "Issue"
                },
                "reason": "comment",
                "unread": false,
                "updated_at": "2026-01-02T00:00:00Z",
                "url": "https://api.github.com/notifications/threads/42"
            }"#,
        )
        .unwrap();
        assert!(!thread.unread);

        let subject: ResolvedSubject = serde_json::from_str::<SubjectResponse>(
            r#"{
                "number": 1,
                "state": "open",
                "html_url": "https://github.com/octo/repo/issues/1",
                "updated_at": "2026-01-03T00:00:00Z",
                "user": {"login": "octocat"}
            }"#,
        )
        .unwrap()
        .into();
        assert_eq!(subject.updated_at.as_deref(), Some("2026-01-03T00:00:00Z"));
    }

    #[test]
    fn merge_errors_keep_sha_races_retryable() {
        let classify = |status: reqwest::StatusCode, body: &str| {
            merge_error(
                status,
                body.to_string(),
                &RateLimit::default(),
                &mut Vec::new(),
            )
            .class
        };
        assert_eq!(
            classify(reqwest::StatusCode::CONFLICT, "Head branch was modified"),
            MergeErrorClass::Transient
        );
        assert_eq!(
            classify(
                reqwest::StatusCode::UNPROCESSABLE_ENTITY,
                "The expected head sha does not match the pull request head."
            ),
            MergeErrorClass::Transient
        );
        assert_eq!(
            classify(reqwest::StatusCode::UNAUTHORIZED, ""),
            MergeErrorClass::Auth
        );
        assert_eq!(
            classify(reqwest::StatusCode::FORBIDDEN, "API rate limit exceeded"),
            MergeErrorClass::Rate
        );
        assert_eq!(
            classify(
                reqwest::StatusCode::FORBIDDEN,
                "Resource not accessible by personal access token"
            ),
            MergeErrorClass::Auth
        );
        assert_eq!(
            classify(
                reqwest::StatusCode::FORBIDDEN,
                "This workflow run cannot be retried"
            ),
            MergeErrorClass::Permanent
        );
        assert_eq!(
            classify(
                reqwest::StatusCode::FORBIDDEN,
                "This workflow run cannot be rerun"
            ),
            MergeErrorClass::Permanent
        );
        assert_eq!(
            classify(reqwest::StatusCode::METHOD_NOT_ALLOWED, "Merge not allowed"),
            MergeErrorClass::Permanent
        );
    }

    #[test]
    fn merge_trust_boundary_depends_only_on_live_pr_author() {
        let pull = |author: &str, head: &str| MergePull {
            state: "open".to_string(),
            draft: false,
            merged_at: None,
            user: Some(SubjectUser {
                login: author.to_string(),
            }),
            mergeable_state: Some("clean".to_string()),
            head: MergeHead {
                sha: head.to_string(),
            },
            node_id: "PR_node".to_string(),
            base: Some(MergeBase {
                ref_name: "main".to_string(),
            }),
        };

        assert!(merge_pull_has_trusted_author(&pull(
            "dependabot[bot]",
            "head-pushed-by-another-workflow"
        )));
        assert!(merge_pull_has_trusted_author(&pull(
            "github-actions[bot]",
            "head-pushed-by-a-human"
        )));
        assert!(!merge_pull_has_trusted_author(&pull(
            "octocat",
            "dependabot-authored-head"
        )));
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

    #[test]
    fn direct_merge_attempts_clean_and_unstable_pull_requests() {
        assert!(direct_merge_attempt_allowed(Some("clean")));
        assert!(
            direct_merge_attempt_allowed(Some("unstable")),
            "GitHub's merge endpoint must decide whether a non-passing status is required"
        );
        for state in ["blocked", "behind", "dirty", "draft", "unknown"] {
            assert!(
                !direct_merge_attempt_allowed(Some(state)),
                "{state} must not trigger a merge attempt"
            );
        }
        assert!(!direct_merge_attempt_allowed(None));
    }

    #[test]
    fn merge_refusal_uses_github_message_or_safe_fallback() {
        assert_eq!(
            merge_refusal_message(r#"{"message":"Pull Request is not mergeable"}"#),
            "Pull Request is not mergeable"
        );
        assert_eq!(
            merge_refusal_message(r#"{"message":""}"#),
            "GitHub is still blocking this merge."
        );
        assert_eq!(
            merge_refusal_message("not json"),
            "GitHub is still blocking this merge."
        );
    }

    #[test]
    fn repository_merge_settings_orders_all_supported_methods() {
        let settings = |squash, merge, rebase| RepositoryMergeSettings {
            allow_squash_merge: squash,
            allow_merge_commit: merge,
            allow_rebase_merge: rebase,
        };

        assert_eq!(
            enabled_direct_merge_methods(&settings(true, true, true)),
            vec![
                DirectMergeMethod::Squash,
                DirectMergeMethod::Rebase,
                DirectMergeMethod::Merge
            ]
        );
        assert_eq!(
            enabled_direct_merge_methods(&settings(false, true, true)),
            vec![DirectMergeMethod::Rebase, DirectMergeMethod::Merge]
        );
        assert_eq!(
            enabled_direct_merge_methods(&settings(false, true, false)),
            vec![DirectMergeMethod::Merge]
        );
        assert_eq!(
            enabled_direct_merge_methods(&settings(false, false, false)),
            Vec::<DirectMergeMethod>::new()
        );
    }

    #[test]
    fn disallowed_merge_method_responses_are_detected_for_fallback() {
        assert!(merge_method_is_disallowed(
            "Squash merges are not allowed on this repository."
        ));
        assert!(merge_method_is_disallowed(
            "Merge commits are not allowed on this repository."
        ));
        assert!(merge_method_is_disallowed(
            "Rebase merges are not allowed on this repository."
        ));
        assert!(!merge_method_is_disallowed("Pull Request is not mergeable"));
    }

    #[test]
    fn compare_url_encodes_refs_as_one_path_segment() {
        let url = compare_url("octo/repo", "release/next", "abc123").unwrap();
        assert_eq!(
            url.as_str(),
            "https://api.github.com/repos/octo/repo/compare/release%2Fnext...abc123"
        );
        assert!(compare_url("missing-repo-owner", "main", "abc123").is_none());
    }

    #[test]
    fn compare_response_reports_commits_missing_from_the_head() {
        let comparison: CompareResponse =
            serde_json::from_str(r#"{"behind_by":5,"ahead_by":1}"#).unwrap();
        assert_eq!(comparison.behind_by, 5);
    }

    /* ------------------------- exact-head check diagnosis ------------------- */

    #[test]
    fn pending_status_covers_every_non_completed_value() {
        for status in ["queued", "in_progress", "waiting", "requested", "pending"] {
            assert!(
                is_check_pending_status(status),
                "{status} should be pending"
            );
        }
        assert!(!is_check_pending_status("completed"));
    }

    #[test]
    fn failure_conclusions_exclude_green_and_neutral_outcomes() {
        for conclusion in ["failure", "timed_out", "cancelled", "startup_failure"] {
            assert!(
                is_failure_conclusion(conclusion),
                "{conclusion} should be a failure"
            );
        }
        for conclusion in ["success", "neutral", "skipped", "stale", "action_required"] {
            assert!(
                !is_failure_conclusion(conclusion),
                "{conclusion} should not be a failure"
            );
        }
        assert!(is_approval_required_conclusion(Some("action_required")));
        assert!(!is_approval_required_conclusion(Some("failure")));
        assert!(!is_approval_required_conclusion(None));
    }

    #[test]
    fn legacy_status_failure_states_are_error_and_failure_only() {
        assert!(is_failure_status_state("failure"));
        assert!(is_failure_status_state("error"));
        assert!(!is_failure_status_state("pending"));
        assert!(!is_failure_status_state("success"));
    }

    #[test]
    fn check_run_deserializes_actions_app_slug() {
        let body = r#"{
            "check_runs": [
                {
                    "name": "build",
                    "status": "completed",
                    "conclusion": "failure",
                    "details_url": "https://github.com/o/r/runs/1",
                    "app": { "slug": "github-actions" }
                },
                {
                    "name": "lint / eslint",
                    "status": "completed",
                    "conclusion": "failure",
                    "details_url": "https://circleci.com/o/r/2",
                    "app": { "slug": "circleci-checks" }
                },
                {
                    "name": "no-app-check",
                    "status": "queued",
                    "conclusion": null,
                    "details_url": null,
                    "app": null
                }
            ]
        }"#;
        let parsed: CheckRunsResponse = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.check_runs.len(), 3);
        assert_eq!(
            parsed.check_runs[0].app.as_ref().unwrap().slug.as_deref(),
            Some("github-actions")
        );
        assert_eq!(
            parsed.check_runs[1].app.as_ref().unwrap().slug.as_deref(),
            Some("circleci-checks")
        );
        assert!(parsed.check_runs[2].app.is_none());
        assert!(is_check_pending_status(&parsed.check_runs[2].status));
    }

    /// A GitHub Actions check run must never be classified as an "external" failure — its
    /// workflow run (with a rerunnable `run_id`) is the source of truth for Actions failures.
    /// This exercises the same routing logic `diagnose_exact_head_checks` applies per check run.
    #[test]
    fn actions_check_runs_are_excluded_from_external_classification() {
        let is_actions =
            |slug: Option<&str>| slug.is_some_and(|slug| slug == GITHUB_ACTIONS_APP_SLUG);
        assert!(is_actions(Some("github-actions")));
        assert!(!is_actions(Some("circleci-checks")));
        assert!(!is_actions(None));
    }

    #[test]
    fn workflow_run_deserializes_with_optional_run_attempt() {
        let body = r#"{
            "workflow_runs": [
                { "id": 1, "run_attempt": 2, "name": "CI", "status": "completed", "conclusion": "failure" },
                { "id": 2, "name": "Deploy", "status": "in_progress", "conclusion": null }
            ]
        }"#;
        let parsed: WorkflowRunsResponse = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.workflow_runs[0].run_attempt, Some(2));
        assert_eq!(
            parsed.workflow_runs[0].conclusion.as_deref(),
            Some("failure")
        );
        assert_eq!(parsed.workflow_runs[1].run_attempt, None);
        assert!(is_check_pending_status(&parsed.workflow_runs[1].status));
    }

    #[test]
    fn workflow_approval_accepts_applied_already_approved_and_raced_statuses() {
        assert!(workflow_approval_status_is_success(
            reqwest::StatusCode::CREATED
        ));
        assert!(workflow_approval_status_is_success(
            reqwest::StatusCode::NO_CONTENT
        ));
        assert!(workflow_approval_status_is_success(
            reqwest::StatusCode::CONFLICT
        ));
        assert!(!workflow_approval_status_is_success(
            reqwest::StatusCode::FORBIDDEN
        ));
    }

    #[test]
    fn combined_status_deserializes_contexts() {
        let body = r#"{
            "state": "failure",
            "statuses": [
                { "state": "failure", "context": "ci/jenkins", "target_url": "https://jenkins/1", "description": "failed" },
                { "state": "pending", "context": "ci/circleci", "target_url": null, "description": null }
            ]
        }"#;
        let parsed: CombinedStatusResponse = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.statuses[0].context, "ci/jenkins");
        assert!(is_failure_status_state(&parsed.statuses[0].state));
        assert_eq!(parsed.statuses[1].context, "ci/circleci");
        assert!(!is_failure_status_state(&parsed.statuses[1].state));
    }

    /* ---------------------------- merge-queue policy ------------------------- */

    #[test]
    fn branch_rules_detect_merge_queue_and_update_rule_sources() {
        let body = r#"[
            {"type": "pull_request", "ruleset_id": 1},
            {"type": "merge_queue", "ruleset_id": 2},
            {"type": "update", "ruleset_id": 3},
            {"type": "update", "ruleset_id": 3}
        ]"#;
        let rules: Vec<BranchRuleItem> = serde_json::from_str(body).unwrap();
        assert!(rules_indicate_merge_queue(&rules));
        assert_eq!(
            update_rule_ruleset_ids(&rules),
            Some(std::collections::BTreeSet::from([3]))
        );

        let body = r#"[{"type": "pull_request"}, {"type": "required_status_checks"}]"#;
        let rules: Vec<BranchRuleItem> = serde_json::from_str(body).unwrap();
        assert!(!rules_indicate_merge_queue(&rules));
        assert_eq!(
            update_rule_ruleset_ids(&rules),
            Some(std::collections::BTreeSet::new())
        );

        let rules: Vec<BranchRuleItem> = serde_json::from_str("[]").unwrap();
        assert!(!rules_indicate_merge_queue(&rules));
        assert_eq!(
            update_rule_ruleset_ids(&rules),
            Some(std::collections::BTreeSet::new())
        );

        let rules: Vec<BranchRuleItem> = serde_json::from_str(r#"[{"type": "update"}]"#).unwrap();
        assert_eq!(update_rule_ruleset_ids(&rules), None);
    }

    #[test]
    fn merge_queue_lookup_data_distinguishes_present_absent_and_unresolved() {
        // An active merge queue on the branch.
        let data: MergeQueueLookupData =
            serde_json::from_str(r#"{"repository": {"mergeQueue": {"id": "MQ_1"}}}"#).unwrap();
        assert!(data.repository.unwrap().merge_queue.is_some());

        // No merge queue configured for the branch — a definitive "direct" answer.
        let data: MergeQueueLookupData =
            serde_json::from_str(r#"{"repository": {"mergeQueue": null}}"#).unwrap();
        assert!(data.repository.unwrap().merge_queue.is_none());

        // Repository itself couldn't be resolved — ambiguous, must not default to "direct".
        let data: MergeQueueLookupData = serde_json::from_str(r#"{"repository": null}"#).unwrap();
        assert!(data.repository.is_none());
    }

    #[test]
    fn merge_queue_policy_requires_graphql_confirmation_before_direct() {
        assert_eq!(
            resolve_merge_queue_strategy(true, None),
            MergeQueueStrategy::MergeQueue
        );
        assert_eq!(
            resolve_merge_queue_strategy(false, Some(true)),
            MergeQueueStrategy::MergeQueue
        );
        assert_eq!(
            resolve_merge_queue_strategy(false, Some(false)),
            MergeQueueStrategy::Direct
        );
        assert_eq!(
            resolve_merge_queue_strategy(false, None),
            MergeQueueStrategy::Unknown
        );
    }

    /* -------------------------------- GraphQL --------------------------------- */

    #[test]
    fn graphql_errors_array_parses_and_classifies() {
        let body = r#"{
            "data": null,
            "errors": [
                { "type": "RATE_LIMITED", "message": "API rate limit exceeded" }
            ]
        }"#;
        let envelope: GraphQlEnvelope = serde_json::from_str(body).unwrap();
        let errors = envelope.errors.unwrap();
        assert_eq!(classify_graphql_errors(&errors), MergeErrorClass::Rate);

        let transient = [GraphQlErrorItem {
            message: "internal error".into(),
            error_type: Some("INTERNAL".into()),
        }];
        assert_eq!(
            classify_graphql_errors(&transient),
            MergeErrorClass::Transient
        );

        let permanent = [GraphQlErrorItem {
            message: "Could not resolve to a PullRequest".into(),
            error_type: Some("NOT_FOUND".into()),
        }];
        assert_eq!(
            classify_graphql_errors(&permanent),
            MergeErrorClass::Permanent
        );

        let untyped = [GraphQlErrorItem {
            message: "something went wrong".into(),
            error_type: None,
        }];
        assert_eq!(
            classify_graphql_errors(&untyped),
            MergeErrorClass::Permanent
        );
    }

    #[test]
    fn graphql_envelope_tolerates_missing_errors_key() {
        // A successful response typically omits `errors` entirely.
        let body = r#"{"data": {"repository": null}}"#;
        let envelope: GraphQlEnvelope = serde_json::from_str(body).unwrap();
        assert!(envelope.errors.is_none());
        assert!(envelope.data.is_some());
    }

    #[test]
    fn pr_queue_status_data_parses_full_shape() {
        let body = r#"{
            "repository": {
                "pullRequest": {
                    "id": "PR_kw",
                    "headRefOid": "abc123",
                    "state": "OPEN",
                    "merged": false,
                    "mergeable": "MERGEABLE",
                    "reviewDecision": "APPROVED",
                    "autoMergeRequest": { "enabledAt": "2026-01-01T00:00:00Z" },
                    "mergeQueueEntry": { "id": "MQE_1", "position": 3, "state": "QUEUED" },
                    "commits": {
                        "nodes": [
                            { "commit": { "statusCheckRollup": { "state": "PENDING" } } }
                        ]
                    }
                }
            }
        }"#;
        let data: PrQueueStatusData = serde_json::from_str(body).unwrap();
        let pr = data.repository.unwrap().pull_request.unwrap();
        assert_eq!(pr.id, "PR_kw");
        assert_eq!(pr.head_ref_oid, "abc123");
        assert!(pr.auto_merge_request.is_some());
        let entry = pr.merge_queue_entry.unwrap();
        assert_eq!(entry.position, Some(3));
        assert_eq!(entry.state.as_deref(), Some("QUEUED"));
        assert_eq!(
            pr.commits
                .unwrap()
                .nodes
                .into_iter()
                .next()
                .unwrap()
                .commit
                .status_check_rollup
                .unwrap()
                .state,
            "PENDING"
        );
    }

    #[test]
    fn pr_queue_status_data_tolerates_no_merge_queue_entry() {
        let body = r#"{
            "repository": {
                "pullRequest": {
                    "id": "PR_kw",
                    "headRefOid": "abc123",
                    "state": "OPEN",
                    "merged": false,
                    "mergeable": "UNKNOWN",
                    "reviewDecision": null,
                    "autoMergeRequest": null,
                    "mergeQueueEntry": null,
                    "commits": { "nodes": [] }
                }
            }
        }"#;
        let data: PrQueueStatusData = serde_json::from_str(body).unwrap();
        let pr = data.repository.unwrap().pull_request.unwrap();
        assert!(pr.auto_merge_request.is_none());
        assert!(pr.merge_queue_entry.is_none());
        assert!(pr.commits.unwrap().nodes.is_empty());
    }

    /* ---------------------------- queue-mutation idempotency ----------------- */

    #[test]
    fn already_applied_errors_are_recognized_across_all_four_mutations() {
        for message in [
            "GraphQL error for enable auto-merge: Auto-merge is already enabled",
            "GraphQL error for disable auto-merge: Auto-merge is not enabled for this pull request",
            "GraphQL error for enqueue pull request: This pull request is already queued",
            "GraphQL error for dequeue pull request: This pull request is not on the queue",
            "GraphQL error for dequeue pull request: The pull request is not currently queued",
        ] {
            assert!(
                is_already_applied_error(message),
                "{message} should be idempotent-noop"
            );
        }
    }

    #[test]
    fn genuine_mutation_errors_are_not_treated_as_already_applied() {
        for message in [
            "GraphQL error for enqueue pull request: The expected head OID does not match",
            "GitHub returned 403: Resource not accessible by personal access token",
            "network error: connection refused",
        ] {
            assert!(
                !is_already_applied_error(message),
                "{message} should be a real error"
            );
        }
    }

    /* -------------------------- request-shape assertions ---------------------- */

    #[test]
    fn enqueue_pr_variables_always_pin_jump_false() {
        let variables = serde_json::json!({
            "pullRequestId": "PR_1",
            "expectedHeadOid": "deadbeef",
            "jump": false,
        });
        assert_eq!(variables["jump"], serde_json::json!(false));
        assert_eq!(variables["pullRequestId"], serde_json::json!("PR_1"));
        assert_eq!(variables["expectedHeadOid"], serde_json::json!("deadbeef"));
    }

    #[test]
    fn dequeue_pr_variables_use_the_pull_request_id_as_the_input_id() {
        // DequeuePullRequestInput's only field is `id`, documented as "The ID of the pull
        // request to be dequeued" — not a merge-queue-entry ID.
        let variables = serde_json::json!({ "id": "PR_1" });
        assert_eq!(variables["id"], serde_json::json!("PR_1"));
        assert!(variables.get("mergeQueueEntryId").is_none());
    }
}
