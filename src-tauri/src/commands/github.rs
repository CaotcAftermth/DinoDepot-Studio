use base64::Engine;
use serde::{Deserialize, Serialize};

const API: &str = "https://api.github.com";

/// The REST API version this code was written against.
///
/// GitHub changes behaviour behind this header, so pinning it means an API
/// revision cannot quietly alter what a publish does. Sent on every request.
const API_VERSION: &str = "2022-11-28";

/// Nothing here should ever sit waiting on a socket forever - a Sync that
/// hangs looks identical to a Sync that is working.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// The credential for the signed-in account.
///
/// Goes through `secrets` rather than reading the keyring directly so the
/// per-account key layout, and the fallback for installs that predate it, live
/// in exactly one place.
fn token(account_id: &str) -> Result<String, String> {
    super::secrets::github_token(account_id)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("DinoDepotStudio/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct GithubStatus {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn github_test(
    account_id: String,
    owner: String,
    repo: String,
    branch: String,
) -> Result<GithubStatus, String> {
    let token = token(&account_id)?;
    let client = client()?;
    let url = format!("{API}/repos/{owner}/{repo}/branches/{branch}");
    let res = client
        .get(&url)
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    if status.is_success() {
        Ok(GithubStatus {
            ok: true,
            message: format!("Connected - {owner}/{repo}@{branch} is reachable"),
        })
    } else {
        let body = res.text().await.unwrap_or_default();
        Ok(GithubStatus {
            ok: false,
            message: format!("GitHub returned {status}: {}", truncate(&body, 200)),
        })
    }
}

#[derive(Serialize)]
pub struct RemoteFile {
    pub exists: bool,
    pub sha: Option<String>,
    pub content: Option<String>,
}

#[derive(Deserialize)]
struct ContentsResponse {
    sha: String,
    content: Option<String>,
    encoding: Option<String>,
}

#[tauri::command]
pub async fn github_get_file(
    account_id: String,
    owner: String,
    repo: String,
    branch: String,
    path: String,
) -> Result<RemoteFile, String> {
    let token = token(&account_id)?;
    let client = client()?;
    let url = format!("{API}/repos/{owner}/{repo}/contents/{path}?ref={branch}");
    let res = client
        .get(&url)
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(RemoteFile {
            exists: false,
            sha: None,
            content: None,
        });
    }
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("GitHub returned {status}: {}", truncate(&body, 200)));
    }

    let parsed: ContentsResponse = res.json().await.map_err(|e| e.to_string())?;
    let content = match (parsed.content, parsed.encoding.as_deref()) {
        (Some(b64), Some("base64")) => {
            let cleaned: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(cleaned)
                .map_err(|e| e.to_string())?;
            Some(String::from_utf8_lossy(&bytes).to_string())
        }
        _ => None,
    };

    Ok(RemoteFile {
        exists: true,
        sha: Some(parsed.sha),
        content,
    })
}

#[derive(Serialize)]
pub struct PublishResult {
    pub commit_sha: String,
    pub content_sha: String,
}

#[derive(Deserialize)]
struct PutResponse {
    content: PutContent,
    commit: PutCommit,
}

#[derive(Deserialize)]
struct PutContent {
    sha: String,
}

#[derive(Deserialize)]
struct PutCommit {
    sha: String,
}

#[tauri::command]
pub async fn github_put_file(
    account_id: String,
    owner: String,
    repo: String,
    branch: String,
    path: String,
    content: String,
    message: String,
) -> Result<PublishResult, String> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    put_encoded(account_id, owner, repo, branch, path, encoded, message).await
}

/// Uploads already-base64 content - used for binary files such as .arkprofile
/// saves, which have no meaningful text representation.
#[tauri::command]
pub async fn github_put_file_b64(
    account_id: String,
    owner: String,
    repo: String,
    branch: String,
    path: String,
    content_b64: String,
    message: String,
) -> Result<PublishResult, String> {
    let cleaned: String = content_b64.chars().filter(|c| !c.is_whitespace()).collect();
    put_encoded(account_id, owner, repo, branch, path, cleaned, message).await
}

/// Fetches a file's raw bytes as base64, for binary downloads.
#[tauri::command]
pub async fn github_get_file_b64(
    account_id: String,
    owner: String,
    repo: String,
    branch: String,
    path: String,
) -> Result<Option<String>, String> {
    let token = token(&account_id)?;
    let client = client()?;
    let url = format!("{API}/repos/{owner}/{repo}/contents/{path}?ref={branch}");
    let res = client
        .get(&url)
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("GitHub returned {status}: {}", truncate(&body, 200)));
    }
    let parsed: ContentsResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(parsed
        .content
        .map(|b64| b64.chars().filter(|c| !c.is_whitespace()).collect()))
}

async fn put_encoded(
    account_id: String,
    owner: String,
    repo: String,
    branch: String,
    path: String,
    content_b64: String,
    message: String,
) -> Result<PublishResult, String> {
    let token = token(&account_id)?;
    let client = client()?;

    // The Contents API requires the current blob sha when updating a file.
    let existing = github_get_file(
        account_id,
        owner.clone(),
        repo.clone(),
        branch.clone(),
        path.clone(),
    )
    .await?;

    let mut body = serde_json::json!({
        "message": message,
        "content": content_b64,
        "branch": branch,
    });
    if let Some(sha) = existing.sha {
        body["sha"] = serde_json::Value::String(sha);
    }

    let url = format!("{API}/repos/{owner}/{repo}/contents/{path}");
    let res = client
        .put(&url)
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Publish failed - GitHub returned {status}: {}", truncate(&text, 300)));
    }

    let parsed: PutResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(PublishResult {
        commit_sha: parsed.commit.sha,
        content_sha: parsed.content.sha,
    })
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

// ---------------------------------------------------------------------------
// Pull-request submission
//
// Publishing a modpack means opening a PR against a repository the submitter
// usually cannot push to. That is fork -> branch -> commit -> PR, several
// round trips; doing it here keeps the token in the credential manager rather
// than handing it to the webview.
// ---------------------------------------------------------------------------

/// Shared GET returning parsed JSON, with GitHub's error body surfaced.
async fn api_get(account_id: &str, url: &str) -> Result<serde_json::Value, String> {
    let token = token(account_id)?;
    let client = client()?;
    let res = client
        .get(url)
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub returned {status}: {}", truncate(&body, 200)));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

/// Shared POST returning parsed JSON.
async fn api_post(
    account_id: &str,
    url: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let token = token(account_id)?;
    let client = client()?;
    let res = client
        .post(url)
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub returned {status}: {}", truncate(&text, 300)));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// The signed-in account's login, used to build the PR's `head` reference.
#[tauri::command]
pub async fn github_me(account_id: String) -> Result<String, String> {
    let me = api_get(&account_id, &format!("{API}/user")).await?;
    me.get("login")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "GitHub did not return an account login".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Whether this token can push directly - decides fork or no fork.
    pub can_push: bool,
    pub default_branch: String,
}

#[tauri::command]
pub async fn github_repo_info(
    account_id: String,
    owner: String,
    repo: String,
) -> Result<RepoInfo, String> {
    let repo_json = api_get(&account_id, &format!("{API}/repos/{owner}/{repo}")).await?;
    Ok(RepoInfo {
        can_push: repo_json
            .get("permissions")
            .and_then(|p| p.get("push"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        default_branch: repo_json
            .get("default_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("main")
            .to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkResult {
    pub owner: String,
    pub repo: String,
}

/// Forks a repository, waiting for GitHub to finish creating it.
///
/// A fresh fork is not immediately usable - the API returns 202 and the repo
/// materialises a moment later, so committing straight away fails. Polling
/// here keeps that detail out of the frontend.
#[tauri::command]
pub async fn github_fork(
    account_id: String,
    owner: String,
    repo: String,
) -> Result<ForkResult, String> {
    let created = api_post(
        &account_id,
        &format!("{API}/repos/{owner}/{repo}/forks"),
        serde_json::json!({}),
    )
    .await?;
    let full = created
        .get("full_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "GitHub did not name the fork".to_string())?;
    let (fork_owner, fork_repo) = full
        .split_once('/')
        .ok_or_else(|| format!("Unexpected fork name '{full}'"))?;
    let fork_owner = fork_owner.to_string();
    let fork_repo = fork_repo.to_string();

    for attempt in 0..10u64 {
        if api_get(&account_id, &format!("{API}/repos/{fork_owner}/{fork_repo}"))
            .await
            .is_ok()
        {
            return Ok(ForkResult {
                owner: fork_owner,
                repo: fork_repo,
            });
        }
        tokio::time::sleep(std::time::Duration::from_millis(600 + attempt * 300)).await;
    }
    Err("The fork was requested but is still not ready - try again shortly".to_string())
}

/// Creates `branch` pointing at the tip of `from_branch`.
///
/// An existing branch of the same name counts as success: a resubmission
/// should reuse it rather than failing halfway through.
#[tauri::command]
pub async fn github_create_branch(
    account_id: String,
    owner: String,
    repo: String,
    from_branch: String,
    branch: String,
) -> Result<(), String> {
    let head = api_get(&account_id, &format!(
        "{API}/repos/{owner}/{repo}/git/ref/heads/{from_branch}"
    ))
    .await?;
    let sha = head
        .get("object")
        .and_then(|o| o.get("sha"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Could not read the tip of {from_branch}"))?;

    match api_post(
        &account_id,
        &format!("{API}/repos/{owner}/{repo}/git/refs"),
        serde_json::json!({ "ref": format!("refs/heads/{branch}"), "sha": sha }),
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(e) if e.contains("Reference already exists") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Points a fork's branch at the upstream tip.
///
/// Without this, a second submission from a fork made weeks ago branches off
/// stale history and the PR carries unrelated changes.
#[tauri::command]
pub async fn github_sync_branch(
    account_id: String,
    owner: String,
    repo: String,
    branch: String,
    upstream_owner: String,
    upstream_repo: String,
    upstream_branch: String,
) -> Result<(), String> {
    let head = api_get(&account_id, &format!(
        "{API}/repos/{upstream_owner}/{upstream_repo}/git/ref/heads/{upstream_branch}"
    ))
    .await?;
    let sha = head
        .get("object")
        .and_then(|o| o.get("sha"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Could not read the upstream tip".to_string())?;

    let token = token(&account_id)?;
    let client = client()?;
    let res = client
        .patch(&format!("{API}/repos/{owner}/{repo}/git/refs/heads/{branch}"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .json(&serde_json::json!({ "sha": sha, "force": true }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("GitHub returned {status}: {}", truncate(&body, 200)));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub url: String,
    pub number: u64,
}

/// Opens a pull request, reusing the open one for this branch if it exists.
#[tauri::command]
pub async fn github_open_pr(
    account_id: String,
    owner: String,
    repo: String,
    head: String,
    base: String,
    title: String,
    body: String,
) -> Result<PullRequest, String> {
    let existing = api_get(&account_id, &format!(
        "{API}/repos/{owner}/{repo}/pulls?state=open&head={head}"
    ))
    .await
    .ok()
    .and_then(|v| v.as_array().and_then(|a| a.first().cloned()));

    let pr = match existing {
        Some(pr) => pr,
        None => {
            api_post(
                &account_id,
                &format!("{API}/repos/{owner}/{repo}/pulls"),
                serde_json::json!({
                    "title": title,
                    "body": body,
                    "head": head,
                    "base": base,
                }),
            )
            .await?
        }
    };

    Ok(PullRequest {
        url: pr
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        number: pr.get("number").and_then(|v| v.as_u64()).unwrap_or(0),
    })
}
