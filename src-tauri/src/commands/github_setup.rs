use super::failure::{classify_status, classify_transport, Failure, Outcome};
use super::secrets;
use serde::{Deserialize, Serialize};

/// Connecting a GitHub account, and binding a project to repositories.
///
/// The credential crosses into the application exactly once, in
/// `github_connect_account`, and is filed under the account's numeric id. After
/// that the frontend names an *account*; it never sees a token again, and there
/// is no command that would return one.
///
/// Everything here identifies a repository by GitHub's **immutable numeric id**.
/// Owner and name are cached for display and rebuilt whenever the id shows they
/// have moved — a rename or a transfer is news about the same repository, not a
/// reason to disconnect a project from it.
const API: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
const TIMEOUT_SECS: u64 = 20;

fn client() -> Outcome<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("DinoDepotStudio/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| Failure::new("unknown", "Could not start the GitHub connection.", e.to_string()))
}

/// `Retry-After`, or the seconds until the rate limit resets.
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    if let Some(value) = headers.get("retry-after").and_then(|v| v.to_str().ok()) {
        if let Ok(seconds) = value.parse::<u64>() {
            return Some(seconds);
        }
    }
    // A zero remaining count with a reset time is the primary rate limit.
    let remaining = headers
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())?;
    if remaining > 0 {
        return None;
    }
    let reset = headers
        .get("x-ratelimit-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some((reset - now).max(0) as u64)
}

/// One authenticated GET, with the failure already classified.
async fn get(token: &str, url: &str, what: &str) -> Outcome<serde_json::Value> {
    let client = client()?;
    let response = client
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .send()
        .await
        .map_err(|e| classify_transport(&e, what))?;

    let status = response.status().as_u16();
    let wait = retry_after(response.headers());
    let body = response.text().await.unwrap_or_default();

    if !(200..300).contains(&status) {
        return Err(classify_status(status, what, truncate(&body, 300), wait));
    }
    serde_json::from_str(&body).map_err(|e| {
        Failure::new(
            "unknown",
            "GitHub sent something DinoDepot could not read.",
            format!("{what}: {e}"),
        )
    })
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        text.to_string()
    } else {
        format!("{}…", &text[..max])
    }
}

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccount {
    /// GitHub's numeric user id, as a string. The credential is filed under it.
    pub account_id: String,
    pub login: String,
    pub avatar_url: String,
}

/// Verifies a pasted token and files it under the account it belongs to.
///
/// The **only** command that accepts a credential. It is validated before being
/// stored, so a mistyped token fails here rather than at the first Sync, and the
/// account id comes from GitHub rather than from anything the administrator
/// typed. Nothing is returned but the account's public identity.
#[tauri::command]
pub async fn github_connect_account(token: String) -> Result<GithubAccount, String> {
    connect_inner(token).await.map_err(|e| e.to_string())
}

async fn connect_inner(token: String) -> Outcome<GithubAccount> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(Failure::new(
            "auth.missing",
            "Paste your GitHub personal access token to connect.",
            "empty token",
        ));
    }

    let me = get(&token, &format!("{API}/user"), "your GitHub account").await?;
    let account_id = me
        .get("id")
        .and_then(|v| v.as_u64())
        .map(|id| id.to_string())
        .ok_or_else(|| {
            Failure::new(
                "unknown",
                "GitHub did not say which account this token belongs to.",
                "no id on /user",
            )
        })?;
    let login = me
        .get("login")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    secrets::secret_set(secrets::github_key(&account_id), token).map_err(|detail| {
        Failure::new(
            "unknown",
            "Your sign-in could not be saved to Windows Credential Manager.",
            detail,
        )
    })?;

    Ok(GithubAccount {
        account_id,
        login,
        avatar_url: me
            .get("avatar_url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Whether a stored credential still works, without revealing it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub connected: bool,
    pub login: String,
    /// Set when the credential exists but no longer works.
    pub problem: String,
}

#[tauri::command]
pub async fn github_account_status(account_id: String) -> Result<AccountStatus, String> {
    let token = match secrets::github_token(&account_id) {
        Ok(token) => token,
        Err(_) => {
            return Ok(AccountStatus {
                connected: false,
                login: String::new(),
                problem: String::new(),
            })
        }
    };
    match get(&token, &format!("{API}/user"), "your GitHub account").await {
        Ok(me) => Ok(AccountStatus {
            connected: true,
            login: me
                .get("login")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            problem: String::new(),
        }),
        Err(failure) => Ok(AccountStatus {
            connected: false,
            login: String::new(),
            problem: failure.message,
        }),
    }
}

#[tauri::command]
pub fn github_disconnect_account(account_id: String) -> Result<(), String> {
    secrets::secret_delete(secrets::github_key(&account_id))
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIdentity {
    /// Immutable numeric id. The only thing that establishes identity.
    pub github_id: String,
    pub owner: String,
    pub name: String,
    pub is_private: bool,
    pub default_branch: String,
    /// Whether this token can write to it — decides whether Sync can work.
    pub can_push: bool,
    /// True when the repository has no commits yet.
    pub is_empty: bool,
    pub html_url: String,
}

fn identity_from(repo: &serde_json::Value) -> Outcome<RepoIdentity> {
    let github_id = repo
        .get("id")
        .and_then(|v| v.as_u64())
        .map(|id| id.to_string())
        .ok_or_else(|| {
            Failure::new(
                "unknown",
                "GitHub did not identify that repository.",
                "no id on repository",
            )
        })?;
    let owner = repo
        .get("owner")
        .and_then(|o| o.get("login"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(RepoIdentity {
        github_id,
        owner,
        name: repo
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        is_private: repo.get("private").and_then(|v| v.as_bool()).unwrap_or(true),
        default_branch: repo
            .get("default_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("main")
            .to_string(),
        can_push: repo
            .get("permissions")
            .and_then(|p| p.get("push"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        // GitHub reports 0 for a repository with no commits.
        is_empty: repo.get("size").and_then(|v| v.as_u64()).unwrap_or(1) == 0,
        html_url: repo
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Looks a repository up by owner and name — the first binding, before an id
/// is known.
#[tauri::command]
pub async fn github_repo_by_slug(
    account_id: String,
    owner: String,
    name: String,
) -> Result<RepoIdentity, String> {
    let token = credential(&account_id)?;
    let repo = get(
        &token,
        &format!("{API}/repos/{owner}/{name}"),
        &format!("the repository {owner}/{name}"),
    )
    .await
    .map_err(|e| e.to_string())?;
    identity_from(&repo).map_err(|e| e.to_string())
}

/// Looks a repository up by its immutable id.
///
/// This is how a rename or a transfer is noticed: the id still resolves, and
/// the owner and name that come back are the current ones. Nothing else in the
/// app is allowed to decide a repository has "gone" — only a 404 here means it
/// is genuinely unreachable.
#[tauri::command]
pub async fn github_repo_by_id(
    account_id: String,
    github_id: String,
) -> Result<RepoIdentity, String> {
    let token = credential(&account_id)?;
    // The by-id endpoint follows renames and transfers; the by-name one only
    // works while GitHub's redirect lasts.
    let repo = get(
        &token,
        &format!("{API}/repositories/{github_id}"),
        "the project repository",
    )
    .await
    .map_err(|e| e.to_string())?;
    identity_from(&repo).map_err(|e| e.to_string())
}

/// Whether a branch exists, so setup can tell "empty repository" from
/// "wrong branch name".
#[tauri::command]
pub async fn github_branch_exists(
    account_id: String,
    owner: String,
    name: String,
    branch: String,
) -> Result<bool, String> {
    let token = credential(&account_id)?;
    match get(
        &token,
        &format!("{API}/repos/{owner}/{name}/branches/{branch}"),
        &format!("the {branch} branch"),
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(failure) if failure.code == "repo.unavailable" => Ok(false),
        Err(failure) => Err(failure.to_string()),
    }
}

fn credential(account_id: &str) -> Result<String, String> {
    secrets::github_token(account_id).map_err(|detail| {
        Failure::new(
            "auth.missing",
            "Connect your GitHub account first.",
            detail,
        )
        .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (key, value) in pairs {
            map.insert(
                reqwest::header::HeaderName::from_bytes(key.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn retry_after_is_read_when_github_sends_it() {
        assert_eq!(retry_after(&headers(&[("retry-after", "45")])), Some(45));
    }

    #[test]
    fn a_spent_rate_limit_is_read_from_the_reset_time() {
        let soon = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 30;
        let wait = retry_after(&headers(&[
            ("x-ratelimit-remaining", "0"),
            ("x-ratelimit-reset", &soon.to_string()),
        ]));
        assert!(wait.is_some());
        assert!(wait.unwrap() <= 30);
    }

    /// Requests still inside the limit must not be treated as rate limited.
    #[test]
    fn a_healthy_rate_limit_asks_for_no_wait() {
        assert_eq!(
            retry_after(&headers(&[
                ("x-ratelimit-remaining", "4999"),
                ("x-ratelimit-reset", "9999999999"),
            ])),
            None
        );
        assert_eq!(retry_after(&headers(&[])), None);
    }

    #[test]
    fn a_reset_time_already_past_asks_for_no_negative_wait() {
        assert_eq!(
            retry_after(&headers(&[
                ("x-ratelimit-remaining", "0"),
                ("x-ratelimit-reset", "1"),
            ])),
            Some(0)
        );
    }

    fn repo_json(over: serde_json::Value) -> serde_json::Value {
        let mut base = serde_json::json!({
            "id": 123456789u64,
            "name": "cluster-source",
            "owner": { "login": "ggfizz" },
            "private": true,
            "default_branch": "main",
            "permissions": { "push": true, "pull": true },
            "size": 42,
            "html_url": "https://github.com/ggfizz/cluster-source"
        });
        if let (Some(base_map), Some(over_map)) = (base.as_object_mut(), over.as_object()) {
            for (key, value) in over_map {
                base_map.insert(key.clone(), value.clone());
            }
        }
        base
    }

    #[test]
    fn identity_reads_what_binding_depends_on() {
        let identity = identity_from(&repo_json(serde_json::json!({}))).unwrap();
        assert_eq!(identity.github_id, "123456789");
        assert_eq!(identity.owner, "ggfizz");
        assert_eq!(identity.name, "cluster-source");
        assert_eq!(identity.default_branch, "main");
        assert!(identity.is_private);
        assert!(identity.can_push);
        assert!(!identity.is_empty);
    }

    /// A repository with no commits is a normal starting state, not a fault —
    /// setup has to be able to tell it apart from a wrong branch name.
    #[test]
    fn a_repository_with_no_commits_reads_as_empty() {
        let identity = identity_from(&repo_json(serde_json::json!({ "size": 0 }))).unwrap();
        assert!(identity.is_empty);
    }

    /// Missing permissions must read as "cannot write", never as "can".
    #[test]
    fn absent_permissions_are_treated_as_read_only() {
        let identity = identity_from(&repo_json(serde_json::json!({ "permissions": {} }))).unwrap();
        assert!(!identity.can_push);
        let identity = identity_from(&repo_json(serde_json::json!({ "permissions": null }))).unwrap();
        assert!(!identity.can_push);
    }

    /// Likewise visibility: assuming public would be the dangerous default for
    /// a repository holding a private roster.
    #[test]
    fn absent_visibility_is_treated_as_private() {
        let identity = identity_from(&repo_json(serde_json::json!({ "private": null }))).unwrap();
        assert!(identity.is_private);
    }

    #[test]
    fn a_repository_with_no_id_is_refused() {
        assert!(identity_from(&repo_json(serde_json::json!({ "id": null }))).is_err());
    }

    #[test]
    fn the_id_is_carried_as_a_string_so_it_never_loses_precision() {
        let identity =
            identity_from(&repo_json(serde_json::json!({ "id": 9007199254740993u64 }))).unwrap();
        assert_eq!(identity.github_id, "9007199254740993");
    }
}
