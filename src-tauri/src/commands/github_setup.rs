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
        .map_err(|e| {
            Failure::new(
                "unknown",
                "Could not start the GitHub connection.",
                e.to_string(),
            )
        })
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

/** GitHub access-management requests need Administration-specific advice. */
fn access_status(status: u16, what: &str, detail: impl Into<String>, wait: Option<u64>) -> Failure {
    if status == 403 && wait.is_none() {
        return Failure::new(
            "auth.forbidden",
            "Project Access needs Administration: Read and write for this repository. Update the token on GitHub, then reconnect it in Studio.",
            detail,
        );
    }
    classify_status(status, what, detail, wait)
}

async fn access_get(token: &str, url: &str, what: &str) -> Outcome<serde_json::Value> {
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
        return Err(access_status(status, what, truncate(&body, 300), wait));
    }
    if body.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&body).map_err(|e| {
        Failure::new(
            "unknown",
            "GitHub sent something DinoDepot could not read.",
            format!("{what}: {e}"),
        )
    })
}

async fn access_put(
    token: &str,
    url: &str,
    what: &str,
    body: serde_json::Value,
) -> Outcome<(u16, serde_json::Value)> {
    let client = client()?;
    let response = client
        .put(url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| classify_transport(&e, what))?;
    let status = response.status().as_u16();
    let wait = retry_after(response.headers());
    let text = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        if status == 404 || status == 422 {
            return Err(Failure::new(
                "repo.conflict",
                "GitHub could not invite that username. Check the spelling and try again.",
                truncate(&text, 300),
            ));
        }
        return Err(access_status(status, what, truncate(&text, 300), wait));
    }
    let parsed = if text.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&text).map_err(|e| {
            Failure::new(
                "unknown",
                "GitHub sent something DinoDepot could not read.",
                format!("{what}: {e}"),
            )
        })?
    };
    Ok((status, parsed))
}

/** Reads every page, with a hard ceiling against a broken pagination loop. */
async fn access_pages(token: &str, base_url: &str, what: &str) -> Outcome<Vec<serde_json::Value>> {
    let mut all = Vec::new();
    for page in 1..=100 {
        let separator = if base_url.contains('?') { '&' } else { '?' };
        let value = access_get(
            token,
            &format!("{base_url}{separator}per_page=100&page={page}"),
            what,
        )
        .await?;
        let entries = value.as_array().ok_or_else(|| {
            Failure::new(
                "unknown",
                "GitHub sent something DinoDepot could not read.",
                format!("{what}: expected an array"),
            )
        })?;
        let count = entries.len();
        all.extend(entries.iter().cloned());
        if count < 100 {
            return Ok(all);
        }
    }
    Err(Failure::new(
        "unknown",
        "This repository has too many access entries to display safely.",
        what,
    ))
}

fn is_account_access_failure(failure: &Failure) -> bool {
    matches!(
        failure.code.as_str(),
        "auth.missing" | "auth.expired" | "auth.forbidden"
    )
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
        Err(failure) if is_account_access_failure(&failure) => Ok(AccountStatus {
            connected: false,
            login: String::new(),
            problem: failure.message,
        }),
        Err(failure) => Err(failure.to_string()),
    }
}

#[tauri::command]
pub fn github_disconnect_account(account_id: String) -> Result<(), String> {
    secrets::secret_delete(secrets::github_key(&account_id))?;
    // An upgraded install may still hold the single-account credential. Every
    // current command uses the account-specific key, but Sign out must remove
    // the old fallback too or the credential remains on the machine unnoticed.
    secrets::secret_delete(secrets::LEGACY_GITHUB_KEY.to_string())
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
    /// Whether GitHub Pages is enabled for this repository.
    pub has_pages: bool,
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
        is_private: repo
            .get("private")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
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
        has_pages: repo
            .get("has_pages")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
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

// ---------------------------------------------------------------------------
// Project access
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCollaborator {
    pub login: String,
    pub avatar_url: String,
    pub html_url: String,
    pub role_name: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInvitation {
    pub id: String,
    pub login: String,
    pub avatar_url: String,
    pub html_url: String,
    pub permission: String,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryAccess {
    pub current_permission: String,
    pub can_admin: bool,
    pub management_available: bool,
    pub management_problem: String,
    pub collaborators: Vec<RepositoryCollaborator>,
    pub invitations: Vec<RepositoryInvitation>,
}

fn permission_from_repo(repo: &serde_json::Value) -> String {
    let permissions = repo.get("permissions");
    for (key, role) in [
        ("admin", "admin"),
        ("maintain", "maintain"),
        ("push", "write"),
        ("triage", "triage"),
        ("pull", "read"),
    ] {
        if permissions
            .and_then(|value| value.get(key))
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            return role.to_string();
        }
    }
    "none".to_string()
}

fn collaborator_from(value: &serde_json::Value) -> Option<RepositoryCollaborator> {
    let login = value.get("login")?.as_str()?.to_string();
    Some(RepositoryCollaborator {
        login,
        avatar_url: value
            .get("avatar_url")
            .and_then(|field| field.as_str())
            .unwrap_or_default()
            .to_string(),
        html_url: value
            .get("html_url")
            .and_then(|field| field.as_str())
            .unwrap_or_default()
            .to_string(),
        role_name: value
            .get("role_name")
            .or_else(|| value.get("permission"))
            .and_then(|field| field.as_str())
            .unwrap_or("read")
            .to_string(),
    })
}

fn invitation_from(value: &serde_json::Value) -> Option<RepositoryInvitation> {
    let invitee = value.get("invitee");
    let login = invitee
        .and_then(|user| user.get("login"))
        .and_then(|field| field.as_str())
        .or_else(|| value.get("email").and_then(|field| field.as_str()))
        .unwrap_or("Pending invitation")
        .to_string();
    Some(RepositoryInvitation {
        id: value.get("id")?.as_u64()?.to_string(),
        login,
        avatar_url: invitee
            .and_then(|user| user.get("avatar_url"))
            .and_then(|field| field.as_str())
            .unwrap_or_default()
            .to_string(),
        html_url: invitee
            .and_then(|user| user.get("html_url"))
            .and_then(|field| field.as_str())
            .unwrap_or_default()
            .to_string(),
        permission: value
            .get("permissions")
            .and_then(|field| field.as_str())
            .unwrap_or("write")
            .to_string(),
        created_at: value
            .get("created_at")
            .and_then(|field| field.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

fn valid_github_login(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 39
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        && bytes.first() != Some(&b'-')
        && bytes.last() != Some(&b'-')
}

fn collaborator_invite_body(repository: &serde_json::Value) -> serde_json::Value {
    let organization_owned = repository
        .get("owner")
        .and_then(|owner| owner.get("type"))
        .and_then(|value| value.as_str())
        == Some("Organization");
    if organization_owned {
        // Organization repositories support explicit roles.
        serde_json::json!({ "permission": "push" })
    } else {
        // Personal repositories always add collaborators with Write access;
        // GitHub documents the permission argument as organization-only.
        serde_json::json!({})
    }
}

#[tauri::command]
pub async fn github_repository_access(
    account_id: String,
    owner: String,
    repo: String,
) -> Result<RepositoryAccess, String> {
    let token = credential(&account_id)?;
    let slug = format!("{owner}/{repo}");
    let repository = access_get(
        &token,
        &format!("{API}/repos/{slug}"),
        &format!("access to {slug}"),
    )
    .await
    .map_err(|failure| failure.to_string())?;
    let current_permission = permission_from_repo(&repository);
    let can_admin = current_permission == "admin";
    let collaborators = access_pages(
        &token,
        &format!("{API}/repos/{slug}/collaborators?affiliation=all"),
        &format!("collaborators for {slug}"),
    )
    .await
    .map_err(|failure| failure.to_string())?
    .iter()
    .filter_map(collaborator_from)
    .collect();

    let (management_available, management_problem, invitations) = if can_admin {
        match access_pages(
            &token,
            &format!("{API}/repos/{slug}/invitations"),
            &format!("pending invitations for {slug}"),
        )
        .await
        {
            Ok(values) => (
                true,
                String::new(),
                values.iter().filter_map(invitation_from).collect(),
            ),
            Err(failure) => (false, failure.message, Vec::new()),
        }
    } else {
        (false, String::new(), Vec::new())
    };

    Ok(RepositoryAccess {
        current_permission,
        can_admin,
        management_available,
        management_problem,
        collaborators,
        invitations,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteResult {
    pub status: String,
    pub login: String,
    pub permission: String,
}

#[tauri::command]
pub async fn github_invite_collaborator(
    account_id: String,
    owner: String,
    repo: String,
    username: String,
) -> Result<InviteResult, String> {
    let username = username.trim().to_string();
    if !valid_github_login(&username) {
        return Err(Failure::new(
            "repo.conflict",
            "Enter a valid GitHub username.",
            "invalid username",
        )
        .to_string());
    }

    let token = credential(&account_id)?;
    let slug = format!("{owner}/{repo}");
    let repository = access_get(
        &token,
        &format!("{API}/repos/{slug}"),
        &format!("access to {slug}"),
    )
    .await
    .map_err(|failure| failure.to_string())?;
    if permission_from_repo(&repository) != "admin" {
        return Err(Failure::new(
            "auth.forbidden",
            "Only a repository administrator can invite project administrators.",
            slug,
        )
        .to_string());
    }

    let invite_body = collaborator_invite_body(&repository);
    let (status, _) = access_put(
        &token,
        &format!("{API}/repos/{slug}/collaborators/{username}"),
        &format!("project access to {slug}"),
        invite_body,
    )
    .await
    .map_err(|failure| failure.to_string())?;

    Ok(InviteResult {
        status: if status == 204 {
            "alreadyCollaborator".to_string()
        } else {
            "invited".to_string()
        },
        login: username,
        permission: "write".to_string(),
    })
}

fn credential(account_id: &str) -> Result<String, String> {
    secrets::github_token(account_id).map_err(|detail| {
        Failure::new("auth.missing", "Connect your GitHub account first.", detail).to_string()
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
    fn only_access_failures_look_like_an_expired_sign_in() {
        for code in ["auth.missing", "auth.expired", "auth.forbidden"] {
            assert!(is_account_access_failure(&Failure::new(code, "x", "")));
        }
        for code in ["network.offline", "network.timeout", "network.rateLimited"] {
            assert!(!is_account_access_failure(&Failure::new(code, "x", "")));
        }
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
        let identity =
            identity_from(&repo_json(serde_json::json!({ "permissions": null }))).unwrap();
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

    #[test]
    fn repository_permission_uses_highest_available_role() {
        let repository = repo_json(serde_json::json!({
            "permissions": { "pull": true, "push": true, "admin": true }
        }));
        assert_eq!(permission_from_repo(&repository), "admin");
        assert_eq!(
            permission_from_repo(&repo_json(serde_json::json!({
                "permissions": { "pull": true, "push": true }
            }))),
            "write"
        );
    }

    #[test]
    fn collaborator_and_invitation_are_reduced_to_display_fields() {
        let collaborator = collaborator_from(&serde_json::json!({
            "login": "rex-admin",
            "avatar_url": "https://avatars.example/rex",
            "html_url": "https://github.com/rex-admin",
            "role_name": "maintain",
            "secret": "ignored"
        }))
        .unwrap();
        assert_eq!(collaborator.login, "rex-admin");
        assert_eq!(collaborator.role_name, "maintain");

        let invitation = invitation_from(&serde_json::json!({
            "id": 9007199254740993u64,
            "invitee": {
                "login": "new-admin",
                "avatar_url": "https://avatars.example/new",
                "html_url": "https://github.com/new-admin"
            },
            "permissions": "write",
            "created_at": "2026-08-23T12:00:00Z"
        }))
        .unwrap();
        assert_eq!(invitation.id, "9007199254740993");
        assert_eq!(invitation.login, "new-admin");
    }

    #[test]
    fn github_login_validation_keeps_urls_path_safe() {
        for good in ["admin", "Dino-Admin", "a1"] {
            assert!(valid_github_login(good), "{good}");
        }
        for bad in ["", "-admin", "admin-", "admin/name", "admin@example.com"] {
            assert!(!valid_github_login(bad), "{bad}");
        }
    }

    #[test]
    fn collaborator_role_is_only_sent_where_github_accepts_it() {
        let personal = repo_json(serde_json::json!({
            "owner": { "login": "ggfizz", "type": "User" }
        }));
        assert_eq!(collaborator_invite_body(&personal), serde_json::json!({}));

        let organization = repo_json(serde_json::json!({
            "owner": { "login": "dino-org", "type": "Organization" }
        }));
        assert_eq!(
            collaborator_invite_body(&organization),
            serde_json::json!({ "permission": "push" })
        );
    }
}
