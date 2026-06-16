//! Minimal GitHub REST client.
//!
//! v1 only needs the authenticated-user lookup (to verify a PAT). Subsequent milestones
//! grow this module with notifications + pagination + rate-limit handling. All calls go
//! to `api.github.com` over HTTPS and follow the API discipline in `AGENT.md`: explicit
//! headers, the pinned API version, and actionable error messages.

use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://api.github.com";
/// Pinned REST API version (see docs.github.com/en/rest).
pub const API_VERSION: &str = "2026-03-10";
/// GitHub requires a User-Agent on every request.
const USER_AGENT: &str = "Helix";

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
    let resp = client
        .get(format!("{API_BASE}/user"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .header("User-Agent", USER_AGENT)
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
