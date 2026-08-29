use git2::{
    Cred, ErrorClass, ErrorCode, FetchOptions, ObjectType, PushOptions, RemoteCallbacks,
    Repository, Signature,
};
use super::super::failure::{Failure, Outcome};
#[cfg(test)]
use super::super::failure::redact;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The remote name every project uses. Fixed, so nothing has to guess.
const REMOTE: &str = "origin";

/// Author recorded on commits DinoDepot creates.
///
/// Deliberately not the administrator's GitHub identity: the useful attribution
/// is in the structured actions inside the commit body, and asking for a name
/// and email would be one more thing to set up before anything works.
const COMMIT_NAME: &str = "DinoDepot Studio";
const COMMIT_EMAIL: &str = "studio@dinodepot.invalid";

/// Turns a libgit2 error into something the app can act on.
fn classify(error: git2::Error, what: &str) -> Failure {
    let detail = format!("{}: {}", what, error.message());
    match (error.class(), error.code()) {
        (_, ErrorCode::Auth) => Failure::new(
            "auth.expired",
            "Your GitHub access has expired. Sign in again to continue.",
            detail,
        ),
        (_, ErrorCode::NotFastForward) => Failure::new(
            "repo.nonFastForward",
            "Somebody else saved changes first. Checking for their changes…",
            detail,
        ),
        (ErrorClass::Net, _) | (ErrorClass::Ssl, _) => Failure::new(
            "network.offline",
            "DinoDepot cannot reach GitHub right now. Your work is saved on this computer.",
            detail,
        ),
        (_, ErrorCode::NotFound) => Failure::new(
            "repo.unavailable",
            "The project repository could not be found. It may have been deleted, or your access to it removed.",
            detail,
        ),
        _ => Failure::new("unknown", "Something went wrong talking to GitHub.", detail),
    }
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCapabilities {
    pub version: String,
    /// Whether this build can talk HTTPS. Without it, nothing here works.
    pub https: bool,
    pub ssh: bool,
    pub threads: bool,
}

/// What the linked libgit2 can actually do.
///
/// Asserted at runtime rather than assumed, because the feature set is decided
/// when the crate is compiled - a build configured without HTTPS would fail on
/// the first fetch with a message about an unsupported URL, which is a long way
/// from the actual cause.
#[tauri::command]
pub fn git_capabilities() -> GitCapabilities {
    let version = git2::Version::get();
    let (major, minor, patch) = version.libgit2_version();
    GitCapabilities {
        version: format!("{major}.{minor}.{patch}"),
        https: version.https(),
        ssh: version.ssh(),
        threads: version.threads(),
    }
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/// Opens the project's repository, creating it on first use.
///
/// Initialising rather than cloning: the administrator already has a project
/// folder with their work in it, and cloning over the top of that would be a
/// destructive way to start. The first Sync pushes what is here.
fn open_or_init(dir: &str) -> Outcome<Repository> {
    let path = PathBuf::from(dir);
    match Repository::open(&path) {
        Ok(repo) => Ok(repo),
        Err(e) if e.code() == ErrorCode::NotFound => {
            Repository::init(&path).map_err(|e| classify(e, "initialising the project repository"))
        }
        Err(e) => Err(classify(e, "opening the project repository")),
    }
}

fn signature<'a>() -> Outcome<Signature<'a>> {
    Signature::now(COMMIT_NAME, COMMIT_EMAIL)
        .map_err(|e| classify(e, "building the commit signature"))
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// Fetches the credential for an account, here rather than from the caller.
///
/// The frontend names the *account*; it never sees the token. Taking the token
/// as a command argument - which an earlier cut of this module did - would have
/// required the webview to be able to read it, undoing the whole point of
/// removing `secret_get`.
fn credential(account_id: &str) -> Result<String, String> {
    super::super::secrets::github_token(account_id).map_err(|detail| {
        Failure::new(
            "auth.missing",
            "Connect your GitHub account before sharing changes.",
            detail,
        )
        .to_string()
    })
}

/// Callbacks that hand the token to the transport, in memory, per request.
///
/// This is the whole reason the remote URL on disk stays clean. libgit2 asks
/// for a credential when it needs one; nothing is ever persisted, and the token
/// never appears in `.git/config`, in a remote URL, or in a process argument.
fn callbacks(token: String) -> RemoteCallbacks<'static> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, _username, _allowed| {
        // GitHub accepts the token as the password with any non-empty username;
        // `x-access-token` is the documented placeholder.
        Cred::userpass_plaintext("x-access-token", &token)
    });
    callbacks
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    /// Commit the local branch points at, or "" before the first commit.
    pub head: String,
    /// Commit the remote-tracking ref points at, or "" if never fetched.
    pub remote: String,
    /// Whether the working tree has changes not yet committed.
    pub dirty: bool,
    pub branch: String,
}

/// Where the local repository and its remote stand, without touching either.
#[tauri::command]
pub fn git_state(dir: String, branch: String) -> Result<RepoState, String> {
    let repo = open_or_init(&dir).map_err(|e| e.to_string())?;
    Ok(RepoState {
        head: resolve(&repo, &format!("refs/heads/{branch}")).unwrap_or_default(),
        remote: resolve(&repo, &format!("refs/remotes/{REMOTE}/{branch}")).unwrap_or_default(),
        dirty: is_dirty(&repo).map_err(|e| e.to_string())?,
        branch,
    })
}

fn resolve(repo: &Repository, refname: &str) -> Option<String> {
    repo.find_reference(refname)
        .ok()?
        .target()
        .map(|oid| oid.to_string())
}

fn is_dirty(repo: &Repository) -> Outcome<bool> {
    let mut options = git2::StatusOptions::new();
    options.include_untracked(true).include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|e| classify(e, "reading the working tree"))?;
    Ok(!statuses.is_empty())
}

/// Reads every file in a commit's tree, as text, keyed by repository path.
///
/// Used to get at the other administrator's version of the project for the
/// semantic merge - which needs the *content*, not a diff, because the merge
/// happens over parsed domain objects rather than over lines.
#[tauri::command]
pub fn git_read_tree(
    dir: String,
    commit: String,
    prefix: String,
) -> Result<HashMap<String, String>, String> {
    let repo = open_or_init(&dir).map_err(|e| e.to_string())?;
    let oid = git2::Oid::from_str(&commit)
        .map_err(|e| classify(e, "reading the commit id").to_string())?;
    let tree = repo
        .find_commit(oid)
        .and_then(|c| c.tree())
        .map_err(|e| classify(e, "reading the commit tree").to_string())?;

    let mut files = HashMap::new();
    let mut failure: Option<String> = None;
    tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
        if entry.kind() != Some(ObjectType::Blob) {
            return git2::TreeWalkResult::Ok;
        }
        let path = format!("{root}{}", entry.name().unwrap_or_default());
        if !prefix.is_empty() && !path.starts_with(&prefix) {
            return git2::TreeWalkResult::Ok;
        }
        match entry.to_object(&repo).and_then(|o| {
            o.peel_to_blob()
                .map(|b| String::from_utf8_lossy(b.content()).to_string())
        }) {
            Ok(text) => {
                files.insert(path, text);
            }
            Err(e) => failure = Some(e.message().to_string()),
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(|e| classify(e, "walking the commit tree").to_string())?;

    match failure {
        Some(detail) => Err(Failure::new(
            "project.corrupt",
            "Part of the project's history could not be read.",
            detail,
        )
        .to_string()),
        None => Ok(files),
    }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub dir: String,
    pub branch: String,
    /// Subject line, then the structured trailers as the body.
    pub message: String,
    /// Repository-relative paths to stage. Empty stages everything tracked.
    pub paths: Vec<String>,
}

/// Stages and commits, returning the new commit id.
///
/// One commit per operation, by construction: the caller assembles the whole
/// message - subject plus structured `DinoDepot-Action` trailers - and this
/// writes it once.
#[tauri::command]
pub fn git_commit(request: CommitRequest) -> Result<String, String> {
    commit_inner(request).map_err(|e| e.to_string())
}

fn commit_inner(request: CommitRequest) -> Outcome<String> {
    let repo = open_or_init(&request.dir)?;
    let mut index = repo.index().map_err(|e| classify(e, "opening the index"))?;

    if request.paths.is_empty() {
        // These folders are recovery material or private machine-local data.
        // Remove old tracked entries too: skipping them during add would leave
        // a previously committed profile or snapshot in every future tree.
        let local_only: Vec<PathBuf> = index
            .iter()
            .filter_map(|entry| {
                let path = PathBuf::from(String::from_utf8_lossy(&entry.path).as_ref());
                is_local_only_path(&path).then_some(path)
            })
            .collect();
        for path in local_only {
            index
                .remove_path(&path)
                .map_err(|e| classify(e, "removing local-only data from the index"))?;
        }
        let mut include = |path: &Path, _matched: &[u8]| {
            if is_local_only_path(path) { 1 } else { 0 }
        };
        index
            .add_all(
                ["*"].iter(),
                git2::IndexAddOption::DEFAULT,
                Some(&mut include),
            )
            .map_err(|e| classify(e, "staging the project"))?;
    } else {
        for path in &request.paths {
            // An opened project is untrusted input, so a path out of its own
            // folder is refused rather than resolved.
            if !is_safe_repo_path(path) {
                return Err(Failure::new(
                    "project.corrupt",
                    "That file is not part of the project.",
                    format!("refused path '{path}'"),
                ));
            }
            if is_local_only_path(Path::new(path)) {
                return Err(Failure::new(
                    "publish.privacyViolation",
                    "That local-only file cannot be shared.",
                    format!("refused local-only path '{path}'"),
                ));
            }
            index
                .add_path(Path::new(path))
                .map_err(|e| classify(e, "staging a file"))?;
        }
    }
    index.write().map_err(|e| classify(e, "writing the index"))?;

    let tree_id = index
        .write_tree()
        .map_err(|e| classify(e, "writing the tree"))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| classify(e, "reading the new tree"))?;

    let refname = format!("refs/heads/{}", request.branch);
    let parent = repo
        .find_reference(&refname)
        .ok()
        .and_then(|r| r.target())
        .and_then(|oid| repo.find_commit(oid).ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();

    let signature = signature()?;
    let oid = repo
        .commit(
            Some(&refname),
            &signature,
            &signature,
            &request.message,
            &tree,
            &parents,
        )
        .map_err(|e| classify(e, "writing the commit"))?;

    // A freshly initialised repository points HEAD at whatever libgit2's
    // default branch name is, which is rarely the project's. Leaving it there
    // makes HEAD unborn relative to the branch actually being committed to, and
    // every file then reports as a pending addition forever.
    repo.set_head(&refname)
        .map_err(|e| classify(e, "pointing the repository at the project branch"))?;
    Ok(oid.to_string())
}

/// A repository path must stay inside the repository.
fn is_safe_repo_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains("..")
        && !path.contains(':')
        && !path.split(['/', '\\']).any(|part| part == ".git")
}

// ---------------------------------------------------------------------------
// Remote
// ---------------------------------------------------------------------------

/// Points the repository at a remote, replacing any previous one.
///
/// The URL must be credential-free; the token is supplied per request by the
/// credential callback instead. A URL carrying one would be written straight
/// into `.git/config`, where anything that can read the folder can read it.
#[tauri::command]
pub fn git_set_remote(dir: String, url: String, reset_history: bool) -> Result<(), String> {
    if url.contains('@') || !url.starts_with("https://") {
        return Err(Failure::new(
            "repo.conflict",
            "That repository address cannot be used.",
            "remote URLs must be https and must not carry credentials",
        )
        .to_string());
    }
    let repo = open_or_init(&dir).map_err(|e| e.to_string())?;
    // Delete-then-add rather than set_url: it is the one form that behaves the
    // same whether or not the remote is already there.
    let _ = repo.remote_delete(REMOTE);
    repo.remote(REMOTE, &url)
        .map_err(|e| classify(e, "setting the remote").to_string())?;
    if reset_history {
        reset_repository_history(&repo).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/** Data that stays on this computer and must never enter source history. */
fn is_local_only_path(path: &Path) -> bool {
    let first = path
        .components()
        .next()
        .map(|part| part.as_os_str().to_string_lossy())
        .unwrap_or_default();
    first.eq_ignore_ascii_case("backups")
        || first.eq_ignore_ascii_case("profiles")
        || first.eq_ignore_ascii_case("recovery")
        || first.eq_ignore_ascii_case(".dinodepot-staging")
        || first.to_ascii_lowercase().starts_with(".dinodepot-lock")
}

/**
 * Starts an unrelated repository with clean history while keeping old commits
 * reachable from a private recovery ref. Working files are never touched.
 */
fn reset_repository_history(repo: &Repository) -> Outcome<()> {
    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            repo.reference(
                &format!("refs/dinodepot/recovery/rebind-{stamp}"),
                oid,
                true,
                "DinoDepot repository rebind",
            )
            .map_err(|e| classify(e, "preserving the previous repository history"))?;
        }
    }

    let names: Vec<String> = repo
        .references()
        .map_err(|e| classify(e, "listing repository history"))?
        .filter_map(|reference| {
            reference
                .ok()
                .and_then(|r| r.name().map(str::to_string))
                .filter(|name| {
                    name.starts_with("refs/heads/")
                        || name.starts_with(&format!("refs/remotes/{REMOTE}/"))
                })
        })
        .collect();
    for name in names {
        if let Ok(mut reference) = repo.find_reference(&name) {
            reference
                .delete()
                .map_err(|e| classify(e, "clearing the previous repository history"))?;
        }
    }

    let mut index = repo.index().map_err(|e| classify(e, "opening the index"))?;
    index.clear().map_err(|e| classify(e, "clearing the index"))?;
    index.write().map_err(|e| classify(e, "writing the index"))?;
    Ok(())
}

/// Fetches the branch, updating the remote-tracking ref only.
///
/// Never touches the working tree. What arrives is compared semantically
/// afterwards; letting Git near the files is how conflict markers end up inside
/// a JSON file the administrator then has to read.
#[tauri::command]
pub fn git_fetch(dir: String, branch: String, account_id: String) -> Result<String, String> {
    let token = credential(&account_id)?;
    fetch_inner(&dir, &branch, token).map_err(|e| e.to_string())
}

fn fetch_inner(dir: &str, branch: &str, token: String) -> Outcome<String> {
    let repo = open_or_init(dir)?;
    let mut remote = repo
        .find_remote(REMOTE)
        .map_err(|e| classify(e, "finding the remote"))?;

    let mut options = FetchOptions::new();
    options.remote_callbacks(callbacks(token));
    let refspec = format!("+refs/heads/{branch}:refs/remotes/{REMOTE}/{branch}");
    remote
        .fetch(&[refspec], Some(&mut options), None)
        .map_err(|e| classify(e, "fetching from GitHub"))?;

    // An empty result is not a failure: it is a repository nobody has pushed to
    // yet, which is exactly the state a new project's remote is in.
    Ok(resolve(&repo, &format!("refs/remotes/{REMOTE}/{branch}")).unwrap_or_default())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub pushed: bool,
    /// True when the remote moved on. The caller refetches and reconciles -
    /// it never retries the same push.
    pub rejected: bool,
    pub commit: String,
}

/// Pushes the branch **without force**, ever.
///
/// The refspec has no leading `+`, so a non-fast-forward is rejected by the
/// server. That rejection is the final race guard: everything upstream of here
/// tries to avoid it, and this is what makes it impossible to lose somebody
/// else's commit if all of that fails.
#[tauri::command]
pub fn git_push(dir: String, branch: String, account_id: String) -> Result<PushOutcome, String> {
    let token = credential(&account_id)?;
    push_inner(&dir, &branch, token).map_err(|e| e.to_string())
}

fn push_inner(dir: &str, branch: &str, token: String) -> Outcome<PushOutcome> {
    let repo = open_or_init(dir)?;
    let head = resolve(&repo, &format!("refs/heads/{branch}")).unwrap_or_default();
    let mut remote = repo
        .find_remote(REMOTE)
        .map_err(|e| classify(e, "finding the remote"))?;

    // libgit2 reports a per-ref rejection through this callback rather than as
    // an error from `push`, so a rejection would otherwise look like success.
    let rejection: std::sync::Arc<std::sync::Mutex<Option<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let seen = rejection.clone();

    let mut cb = callbacks(token);
    cb.push_update_reference(move |_refname, status| {
        if let Some(reason) = status {
            *seen.lock().unwrap() = Some(reason.to_string());
        }
        Ok(())
    });

    let mut options = PushOptions::new();
    options.remote_callbacks(cb);
    // No '+' prefix: this is the non-force push, and it stays that way.
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");

    match remote.push(&[refspec], Some(&mut options)) {
        Ok(()) => {}
        Err(e) if e.code() == ErrorCode::NotFastForward => {
            return Ok(PushOutcome {
                pushed: false,
                rejected: true,
                commit: head,
            })
        }
        Err(e) => return Err(classify(e, "pushing to GitHub")),
    }

    let reason = rejection.lock().unwrap().clone();
    match reason {
        Some(detail) => {
            // GitHub words this several ways; anything mentioning the fast-forward
            // rule is the race, and the race is recoverable.
            let lower = detail.to_lowercase();
            if lower.contains("fetch first")
                || lower.contains("non-fast-forward")
                || lower.contains("fast forward")
            {
                Ok(PushOutcome {
                    pushed: false,
                    rejected: true,
                    commit: head,
                })
            } else {
                Err(Failure::new(
                    "auth.forbidden",
                    "GitHub refused the update. Check that your access covers this repository and grants Contents read and write.",
                    detail,
                ))
            }
        }
        None => Ok(PushOutcome {
            pushed: true,
            rejected: false,
            commit: head,
        }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FastForwardOutcome {
    /// True when the branch moved and the files on disk were updated.
    pub advanced: bool,
    /// Why it was refused, when it was. Empty on success.
    pub refused: String,
    pub commit: String,
}

/// Takes the other administrators' work when this computer has none of its own.
///
/// The narrow case, and deliberately so: local is either unborn or already an
/// ancestor of the remote, so adopting the remote loses nothing. Anything else
/// is a divergence, which is reconciled semantically a layer up - never here,
/// because a Git-level merge would write conflict markers into JSON files the
/// administrator then has to read.
///
/// Refuses outright on a dirty working tree. Checking out over unsaved edits is
/// exactly the "where did my afternoon go" failure this whole design exists to
/// prevent.
#[tauri::command]
pub fn git_fast_forward(dir: String, branch: String) -> Result<FastForwardOutcome, String> {
    fast_forward_inner(&dir, &branch).map_err(|e| e.to_string())
}

fn fast_forward_inner(dir: &str, branch: &str) -> Outcome<FastForwardOutcome> {
    let repo = open_or_init(dir)?;
    let local = resolve(&repo, &format!("refs/heads/{branch}"));
    let remote = match resolve(&repo, &format!("refs/remotes/{REMOTE}/{branch}")) {
        Some(oid) => oid,
        None => {
            return Ok(FastForwardOutcome {
                advanced: false,
                refused: "nothing has been shared yet".into(),
                commit: local.unwrap_or_default(),
            })
        }
    };

    if local.as_deref() == Some(remote.as_str()) {
        return Ok(FastForwardOutcome {
            advanced: false,
            refused: String::new(),
            commit: remote,
        });
    }

    if is_dirty(&repo)? {
        return Ok(FastForwardOutcome {
            advanced: false,
            refused: "there are unsaved changes on this computer".into(),
            commit: local.unwrap_or_default(),
        });
    }

    let remote_oid =
        git2::Oid::from_str(&remote).map_err(|e| classify(e, "reading the shared version"))?;

    // Only a genuine fast-forward. `descendant_of` is what makes that a fact
    // rather than an assumption.
    if let Some(head) = &local {
        let head_oid =
            git2::Oid::from_str(head).map_err(|e| classify(e, "reading the local version"))?;
        let can = repo
            .graph_descendant_of(remote_oid, head_oid)
            .map_err(|e| classify(e, "comparing the two versions"))?;
        if !can {
            return Ok(FastForwardOutcome {
                advanced: false,
                refused: "this computer has changes of its own".into(),
                commit: head.clone(),
            });
        }
    }

    let refname = format!("refs/heads/{branch}");
    repo.reference(&refname, remote_oid, true, "DinoDepot fast-forward")
        .map_err(|e| classify(e, "moving the project branch"))?;
    repo.set_head(&refname)
        .map_err(|e| classify(e, "pointing the repository at the project branch"))?;
    // Force is safe and necessary here: the tree was verified clean above, and
    // without it the files on disk would still be the older version.
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .map_err(|e| classify(e, "updating the project files"))?;

    Ok(FastForwardOutcome {
        advanced: true,
        refused: String::new(),
        commit: remote,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedTree {
    pub written: usize,
    pub removed: usize,
}

/// Replaces a whole generated directory with a new set of files.
///
/// Publishing is a *replacement*, not an update: a creature removed from the
/// project has to disappear from the site, and merging generated output would
/// leave last week's page behind forever. So the directory is emptied and
/// rewritten, and the single commit that follows carries the difference -
/// additions, changes and deletions together.
///
/// Never merged for the same reason. Generated files have no authorship to
/// reconcile; if the delivery repository moved on, the answer is to regenerate,
/// not to combine two machines' output.
#[tauri::command]
pub fn git_replace_dir(
    dir: String,
    prefix: String,
    files: HashMap<String, String>,
) -> Result<StagedTree, String> {
    replace_dir_inner(&dir, &prefix, files).map_err(|e| e.to_string())
}

fn replace_dir_inner(
    dir: &str,
    prefix: &str,
    files: HashMap<String, String>,
) -> Outcome<StagedTree> {
    if !is_safe_repo_path(prefix) {
        return Err(Failure::new(
            "project.corrupt",
            "That is not a folder inside the repository.",
            format!("refused prefix '{prefix}'"),
        ));
    }
    for name in files.keys() {
        // Each file's path is checked on its own, so a crafted name cannot
        // climb out of the folder being replaced.
        if !is_safe_repo_path(name) {
            return Err(Failure::new(
                "project.corrupt",
                "That is not a file inside the repository.",
                format!("refused path '{name}'"),
            ));
        }
    }

    let root = PathBuf::from(dir).join(prefix);
    let mut removed = 0;
    if root.exists() {
        removed = count_files(&root)?;
        std::fs::remove_dir_all(&root).map_err(|e| {
            Failure::new(
                "save.failed",
                "The previous published files could not be cleared.",
                e.to_string(),
            )
        })?;
    }

    for (name, content) in &files {
        super::super::project_io::write_atomic(&root.join(name), content.as_bytes()).map_err(
            |detail| {
                Failure::new(
                    "save.failed",
                    "The published files could not be written.",
                    detail,
                )
            },
        )?;
    }

    Ok(StagedTree {
        written: files.len(),
        removed,
    })
}

fn count_files(root: &Path) -> Outcome<usize> {
    let mut count = 0;
    let entries = std::fs::read_dir(root).map_err(|e| {
        Failure::new("save.failed", "Could not read the published files.", e.to_string())
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| {
            Failure::new("save.failed", "Could not read the published files.", e.to_string())
        })?;
        if entry.path().is_dir() {
            count += count_files(&entry.path())?;
        } else {
            count += 1;
        }
    }
    Ok(count)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub sha: String,
    /// Full message, subject and trailers. Decoded on the TypeScript side.
    pub message: String,
    /// Author time, epoch milliseconds.
    pub at: i64,
    pub author: String,
    /// True when this commit is an ancestor of nothing else - the current tip.
    pub is_head: bool,
}

/// The project's history, newest first.
///
/// This is what Recent Activity reads. The previous version kept its own
/// `activity.json` in the project and synchronized it as a shared append-only
/// array - which two administrators fight over forever, and which lies the
/// moment anybody edits a file outside Studio. Git already records exactly what
/// happened, signed with who did it and when.
#[tauri::command]
pub fn git_log(dir: String, branch: String, limit: u32) -> Result<Vec<CommitSummary>, String> {
    log_inner(&dir, &branch, limit).map_err(|e| e.to_string())
}

fn log_inner(dir: &str, branch: &str, limit: u32) -> Outcome<Vec<CommitSummary>> {
    let repo = open_or_init(dir)?;
    let head = match resolve(&repo, &format!("refs/heads/{branch}")) {
        Some(oid) => oid,
        // A project that has never been committed to has no history, which is
        // a normal state rather than a failure.
        None => return Ok(Vec::new()),
    };

    let mut walk = repo
        .revwalk()
        .map_err(|e| classify(e, "reading the project history"))?;
    walk.push(git2::Oid::from_str(&head).map_err(|e| classify(e, "reading the latest version"))?)
        .map_err(|e| classify(e, "reading the project history"))?;
    walk.set_sorting(git2::Sort::TIME)
        .map_err(|e| classify(e, "ordering the project history"))?;

    let mut out = Vec::new();
    for oid in walk.take(limit as usize) {
        let oid = oid.map_err(|e| classify(e, "reading the project history"))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| classify(e, "reading a version"))?;
        let sha = oid.to_string();
        out.push(CommitSummary {
            is_head: sha == head,
            sha,
            message: commit.message().unwrap_or_default().to_string(),
            at: commit.time().seconds() * 1000,
            author: commit.author().name().unwrap_or_default().to_string(),
        });
    }
    Ok(out)
}

/// Writes an older version's files back into the working tree.
///
/// Restoring produces a *new commit* on top of history - it never resets or
/// rewrites, because the history is shared and somebody else may already have
/// pulled it. The result is "we went back to how it was on Tuesday", which is
/// true, rather than Tuesday's commit pretending the intervening week never
/// happened.
///
/// Only files the caller names are restored, so a restore can be one file or
/// the whole project.
#[tauri::command]
pub fn git_restore_files(
    dir: String,
    commit: String,
    paths: Vec<String>,
) -> Result<usize, String> {
    restore_inner(&dir, &commit, paths).map_err(|e| e.to_string())
}

fn restore_inner(dir: &str, commit: &str, paths: Vec<String>) -> Outcome<usize> {
    let repo = open_or_init(dir)?;
    let oid = git2::Oid::from_str(commit)
        .map_err(|e| classify(e, "reading the version to restore"))?;
    let tree = repo
        .find_commit(oid)
        .and_then(|c| c.tree())
        .map_err(|e| classify(e, "reading the version to restore"))?;

    let root = PathBuf::from(dir);
    let mut restored = 0;
    for path in &paths {
        if !is_safe_repo_path(path) {
            return Err(Failure::new(
                "project.corrupt",
                "That file is not part of the project.",
                format!("refused path '{path}'"),
            ));
        }
        let entry = match tree.get_path(Path::new(path)) {
            Ok(entry) => entry,
            // A file that did not exist in that version is not an error - it
            // simply was not there, and restoring means putting back what was.
            Err(_) => continue,
        };
        let blob = entry
            .to_object(&repo)
            .and_then(|o| o.peel_to_blob())
            .map_err(|e| classify(e, "reading a file from that version"))?;
        super::super::project_io::write_atomic(&root.join(path), blob.content()).map_err(
            |detail| Failure::new("save.failed", "That version could not be written.", detail),
        )?;
        restored += 1;
    }
    Ok(restored)
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/// Records where the work is, before an operation that could be interrupted.
///
/// A local ref, so an interrupted Sync leaves something reachable rather than a
/// commit only the reflog remembers.
#[tauri::command]
pub fn git_mark_recovery(dir: String, operation_id: String, commit: String) -> Result<(), String> {
    let repo = open_or_init(&dir).map_err(|e| e.to_string())?;
    let safe: String = operation_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if safe.is_empty() {
        return Err("Invalid operation id".into());
    }
    let oid = git2::Oid::from_str(&commit)
        .map_err(|e| classify(e, "reading the commit id").to_string())?;
    repo.reference(
        &format!("refs/dinodepot/recovery/{safe}"),
        oid,
        true,
        "DinoDepot recovery point",
    )
    .map_err(|e| classify(e, "recording a recovery point").to_string())?;
    Ok(())
}

/// Forgets a recovery point once its operation is known to have finished.
#[tauri::command]
pub fn git_clear_recovery(dir: String, operation_id: String) -> Result<(), String> {
    let repo = open_or_init(&dir).map_err(|e| e.to_string())?;
    let safe: String = operation_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if let Ok(mut reference) = repo.find_reference(&format!("refs/dinodepot/recovery/{safe}")) {
        let _ = reference.delete();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project(dir: &Path, files: &[(&str, &str)]) {
        for (name, content) in files {
            fs::write(dir.join(name), content).unwrap();
        }
    }

    fn commit(dir: &Path, branch: &str, message: &str) -> String {
        commit_inner(CommitRequest {
            dir: dir.to_string_lossy().into(),
            branch: branch.into(),
            message: message.into(),
            paths: vec![],
        })
        .unwrap()
    }

    /// A bare repository standing in for GitHub, so the whole push path is
    /// exercised without a network or a credential.
    fn bare_remote() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        Repository::init_bare(dir.path()).unwrap();
        dir
    }

    /// Points a working repository at a local bare one.
    ///
    /// A plain filesystem path rather than a `file://` URL: libgit2 on Windows
    /// will not resolve `file://C:/…`, and the local transport takes the path
    /// directly. Test-only - `git_set_remote` still requires HTTPS.
    fn connect(work: &Path, remote: &Path) {
        let repo = Repository::open(work).unwrap();
        let _ = repo.remote_delete(REMOTE);
        repo.remote(REMOTE, &remote.to_string_lossy()).unwrap();
    }

    fn push(work: &Path, branch: &str) -> PushOutcome {
        push_inner(&work.to_string_lossy(), branch, String::new()).unwrap()
    }

    // -----------------------------------------------------------------------

    /// Without HTTPS compiled in, every remote operation fails on a URL it
    /// claims not to understand - a long way from the real cause.
    #[test]
    fn the_linked_libgit2_can_speak_https() {
        let caps = git_capabilities();
        assert!(caps.https, "libgit2 was built without HTTPS support");
        assert!(!caps.version.is_empty());
    }

    #[test]
    fn opening_a_plain_folder_initialises_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        assert!(open_or_init(&dir.path().to_string_lossy()).is_ok());
        assert!(dir.path().join(".git").exists());
    }

    #[test]
    fn a_commit_records_its_message_and_becomes_head() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{\"v\":1}")]);
        let oid = commit(dir.path(), "main", "Updated creature configuration\n\nDinoDepot-Action: {}");

        let repo = Repository::open(dir.path()).unwrap();
        let head = repo.find_reference("refs/heads/main").unwrap();
        assert_eq!(head.target().unwrap().to_string(), oid);
        let message = repo.find_commit(head.target().unwrap()).unwrap();
        assert!(message.message().unwrap().starts_with("Updated creature"));
        assert!(message.message().unwrap().contains("DinoDepot-Action"));
    }

    #[test]
    fn a_second_commit_keeps_the_first_as_its_parent() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{\"v\":1}")]);
        let first = commit(dir.path(), "main", "first");
        project(dir.path(), &[("project.json", "{\"v\":2}")]);
        let second = commit(dir.path(), "main", "second");

        let repo = Repository::open(dir.path()).unwrap();
        let parent = repo
            .find_commit(git2::Oid::from_str(&second).unwrap())
            .unwrap()
            .parent(0)
            .unwrap();
        assert_eq!(parent.id().to_string(), first);
    }

    #[test]
    fn a_default_commit_excludes_machine_local_and_private_folders() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        for folder in ["backups", "profiles", "recovery", ".dinodepot-staging"] {
            fs::create_dir_all(dir.path().join(folder)).unwrap();
            fs::write(dir.path().join(folder).join("private.bin"), b"private").unwrap();
        }
        fs::write(dir.path().join(".dinodepot-lock-owner"), "local").unwrap();

        let oid = commit(dir.path(), "main", "safe");
        let files = git_read_tree(
            dir.path().to_string_lossy().into(),
            oid,
            String::new(),
        )
        .unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files.get("project.json").map(String::as_str), Some("{}"));
    }

    #[test]
    fn an_explicit_local_only_path_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("profiles")).unwrap();
        fs::write(dir.path().join("profiles/player.arkprofile"), b"private").unwrap();
        let result = commit_inner(CommitRequest {
            dir: dir.path().to_string_lossy().into(),
            branch: "main".into(),
            message: "unsafe".into(),
            paths: vec!["profiles/player.arkprofile".into()],
        });
        assert_eq!(result.unwrap_err().code, "publish.privacyViolation");
    }

    #[test]
    fn a_later_commit_removes_local_only_data_tracked_by_an_older_build() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        fs::create_dir_all(dir.path().join("profiles")).unwrap();
        fs::write(dir.path().join("profiles/player.arkprofile"), b"private").unwrap();

        // Simulate a tree written before the local-only boundary existed.
        let repo = open_or_init(&dir.path().to_string_lossy()).unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = signature().unwrap();
        repo.commit(
            Some("refs/heads/main"),
            &signature,
            &signature,
            "old build",
            &tree,
            &[],
        )
        .unwrap();
        drop(tree);
        drop(index);
        drop(repo);

        let oid = commit(dir.path(), "main", "enforce local boundary");
        let files = git_read_tree(
            dir.path().to_string_lossy().into(),
            oid,
            String::new(),
        )
        .unwrap();
        assert!(!files.contains_key("profiles/player.arkprofile"));
        assert!(dir.path().join("profiles/player.arkprofile").is_file());
    }

    #[test]
    fn rebinding_preserves_files_but_starts_unrelated_history() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{\"v\":1}")]);
        let old = commit(dir.path(), "main", "old repository");
        let path = dir.path().to_string_lossy().to_string();

        git_set_remote(
            path,
            "https://github.com/example/new-project.git".into(),
            true,
        )
        .unwrap();

        let repo = Repository::open(dir.path()).unwrap();
        assert!(repo.find_reference("refs/heads/main").is_err());
        assert_eq!(read(dir.path(), "project.json"), "{\"v\":1}");
        assert!(repo.references_glob("refs/dinodepot/recovery/rebind-*")
            .unwrap()
            .any(|reference| reference.unwrap().target().unwrap().to_string() == old));

        let new = commit(dir.path(), "main", "new repository");
        assert_eq!(
            repo.find_commit(git2::Oid::from_str(&new).unwrap())
                .unwrap()
                .parent_count(),
            0,
        );
    }

    #[test]
    fn reading_a_tree_returns_the_files_as_text() {
        let dir = tempfile::tempdir().unwrap();
        project(
            dir.path(),
            &[("project.json", "{\"v\":1}"), ("players.json", "[]")],
        );
        let oid = commit(dir.path(), "main", "first");

        let files =
            git_read_tree(dir.path().to_string_lossy().into(), oid, String::new()).unwrap();
        assert_eq!(files.get("project.json").map(String::as_str), Some("{\"v\":1}"));
        assert_eq!(files.get("players.json").map(String::as_str), Some("[]"));
    }

    #[test]
    fn state_reports_a_dirty_working_tree() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{\"v\":1}")]);
        commit(dir.path(), "main", "first");
        let clean = git_state(dir.path().to_string_lossy().into(), "main".into()).unwrap();
        assert!(!clean.dirty);
        assert!(!clean.head.is_empty());
        assert_eq!(clean.remote, "");

        project(dir.path(), &[("project.json", "{\"v\":2}")]);
        let dirty = git_state(dir.path().to_string_lossy().into(), "main".into()).unwrap();
        assert!(dirty.dirty);
    }

    // --- pushing against a local bare repository ---------------------------

    #[test]
    fn a_normal_push_reaches_the_remote() {
        let remote = bare_remote();
        let work = tempfile::tempdir().unwrap();
        project(work.path(), &[("project.json", "{\"v\":1}")]);
        let oid = commit(work.path(), "main", "first");
        connect(work.path(), remote.path());

        let outcome = push(work.path(), "main");
        assert!(outcome.pushed);
        assert!(!outcome.rejected);

        let bare = Repository::open(remote.path()).unwrap();
        assert_eq!(
            bare.find_reference("refs/heads/main")
                .unwrap()
                .target()
                .unwrap()
                .to_string(),
            oid
        );
    }

    #[test]
    fn fetching_updates_the_remote_tracking_ref_only() {
        let remote = bare_remote();

        // One administrator pushes.
        let first = tempfile::tempdir().unwrap();
        project(first.path(), &[("project.json", "{\"from\":\"first\"}")]);
        let theirs = commit(first.path(), "main", "first");
        connect(first.path(), remote.path());
        push(first.path(), "main");

        // Another fetches it.
        let second = tempfile::tempdir().unwrap();
        project(second.path(), &[("project.json", "{\"from\":\"second\"}")]);
        commit(second.path(), "main", "mine");
        connect(second.path(), remote.path());
        let fetched = fetch_inner(&second.path().to_string_lossy(), "main", String::new()).unwrap();

        assert_eq!(fetched, theirs);
        // The working tree is untouched: a fetch must never rewrite the file
        // the administrator is editing.
        assert_eq!(
            fs::read_to_string(second.path().join("project.json")).unwrap(),
            "{\"from\":\"second\"}"
        );
    }

    /// The guarantee the whole design rests on: when the branch has moved on,
    /// the push is refused rather than silently replacing somebody's commit.
    #[test]
    fn a_push_onto_a_moved_branch_is_rejected_not_forced() {
        let remote = bare_remote();

        let first = tempfile::tempdir().unwrap();
        project(first.path(), &[("project.json", "{\"from\":\"first\"}")]);
        let theirs = commit(first.path(), "main", "theirs");
        connect(first.path(), remote.path());
        assert!(push(first.path(), "main").pushed);

        // A second administrator, whose history does not contain theirs.
        let second = tempfile::tempdir().unwrap();
        project(second.path(), &[("project.json", "{\"from\":\"second\"}")]);
        commit(second.path(), "main", "mine");
        connect(second.path(), remote.path());

        let outcome = push(second.path(), "main");
        assert!(!outcome.pushed);
        assert!(outcome.rejected);

        // And the first administrator's commit is still what the remote holds.
        let bare = Repository::open(remote.path()).unwrap();
        assert_eq!(
            bare.find_reference("refs/heads/main")
                .unwrap()
                .target()
                .unwrap()
                .to_string(),
            theirs
        );
    }

    /// The common case: somebody else worked, this computer did not.
    #[test]
    fn fast_forward_takes_the_other_administrators_work() {
        let remote = bare_remote();

        let first = tempfile::tempdir().unwrap();
        project(first.path(), &[("project.json", "{\"from\":\"first\"}")]);
        let theirs = commit(first.path(), "main", "theirs");
        connect(first.path(), remote.path());
        push(first.path(), "main");

        // A second machine with no work of its own.
        let second = tempfile::tempdir().unwrap();
        Repository::init(second.path()).unwrap();
        connect(second.path(), remote.path());
        fetch_inner(&second.path().to_string_lossy(), "main", String::new()).unwrap();

        let outcome = fast_forward_inner(&second.path().to_string_lossy(), "main").unwrap();
        assert!(outcome.advanced);
        assert_eq!(outcome.commit, theirs);
        // And the files are actually there, not just the ref.
        assert_eq!(
            fs::read_to_string(second.path().join("project.json")).unwrap(),
            "{\"from\":\"first\"}"
        );
    }

    /// Checking out over unsaved edits is the failure the whole design exists
    /// to prevent, so a dirty tree refuses rather than advancing.
    #[test]
    fn fast_forward_refuses_over_unsaved_work() {
        let remote = bare_remote();

        let first = tempfile::tempdir().unwrap();
        project(first.path(), &[("project.json", "{\"from\":\"first\"}")]);
        commit(first.path(), "main", "theirs");
        connect(first.path(), remote.path());
        push(first.path(), "main");

        let second = tempfile::tempdir().unwrap();
        Repository::init(second.path()).unwrap();
        connect(second.path(), remote.path());
        fetch_inner(&second.path().to_string_lossy(), "main", String::new()).unwrap();
        // An unsaved edit appears before the fast-forward runs.
        project(second.path(), &[("notes.json", "{\"mine\":true}")]);

        let outcome = fast_forward_inner(&second.path().to_string_lossy(), "main").unwrap();
        assert!(!outcome.advanced);
        assert!(outcome.refused.contains("unsaved"));
        assert!(fs::read_to_string(second.path().join("notes.json")).is_ok());
    }

    /// A divergence is not a fast-forward, and must not be resolved here - the
    /// semantic merge is a layer up.
    #[test]
    fn fast_forward_refuses_a_divergence() {
        let remote = bare_remote();

        let first = tempfile::tempdir().unwrap();
        project(first.path(), &[("project.json", "{\"from\":\"first\"}")]);
        commit(first.path(), "main", "theirs");
        connect(first.path(), remote.path());
        push(first.path(), "main");

        let second = tempfile::tempdir().unwrap();
        project(second.path(), &[("project.json", "{\"from\":\"second\"}")]);
        let mine = commit(second.path(), "main", "mine");
        connect(second.path(), remote.path());
        fetch_inner(&second.path().to_string_lossy(), "main", String::new()).unwrap();

        let outcome = fast_forward_inner(&second.path().to_string_lossy(), "main").unwrap();
        assert!(!outcome.advanced);
        assert!(outcome.refused.contains("changes of its own"));
        // The local work is untouched.
        assert_eq!(outcome.commit, mine);
        assert_eq!(
            fs::read_to_string(second.path().join("project.json")).unwrap(),
            "{\"from\":\"second\"}"
        );
    }

    #[test]
    fn fast_forward_says_so_when_there_is_nothing_to_take() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        commit(dir.path(), "main", "mine");
        let outcome = fast_forward_inner(&dir.path().to_string_lossy(), "main").unwrap();
        assert!(!outcome.advanced);
        assert!(outcome.refused.contains("nothing has been shared"));
    }

    fn read(dir: &Path, name: &str) -> String {
        fs::read_to_string(dir.join(name)).expect("read")
    }

    fn staged(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn replacing_a_directory_writes_the_new_files() {
        let dir = tempfile::tempdir().unwrap();
        let result = replace_dir_inner(
            &dir.path().to_string_lossy(),
            "docs",
            staged(&[("index.html", "<html>"), ("data/viewer.json", "{}")]),
        )
        .unwrap();

        assert_eq!(result.written, 2);
        assert_eq!(result.removed, 0);
        assert_eq!(read(dir.path(), "docs/index.html"), "<html>");
        assert_eq!(read(dir.path(), "docs/data/viewer.json"), "{}");
    }

    /// A creature removed from the project has to disappear from the site.
    /// Merging generated output would leave last week's page behind forever.
    #[test]
    fn replacing_a_directory_removes_what_is_no_longer_generated() {
        let dir = tempfile::tempdir().unwrap();
        replace_dir_inner(
            &dir.path().to_string_lossy(),
            "docs",
            staged(&[("index.html", "old"), ("data/gone.json", "{}")]),
        )
        .unwrap();

        let result = replace_dir_inner(
            &dir.path().to_string_lossy(),
            "docs",
            staged(&[("index.html", "new")]),
        )
        .unwrap();

        assert_eq!(result.removed, 2);
        assert_eq!(read(dir.path(), "docs/index.html"), "new");
        assert!(!dir.path().join("docs/data/gone.json").exists());
    }

    #[test]
    fn replacing_a_directory_leaves_the_rest_of_the_repository_alone() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "keep me").unwrap();
        replace_dir_inner(
            &dir.path().to_string_lossy(),
            "docs",
            staged(&[("index.html", "<html>")]),
        )
        .unwrap();
        assert_eq!(read(dir.path(), "README.md"), "keep me");
    }

    #[test]
    fn a_staged_path_may_not_escape_the_published_folder() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("secrets.json"), "private").unwrap();

        for bad in ["../secrets.json", "/etc/passwd", "a/../../b.json", ".git/config"] {
            let result = replace_dir_inner(
                &dir.path().to_string_lossy(),
                "docs",
                staged(&[(bad, "x")]),
            );
            assert!(result.is_err(), "{bad} should be refused");
        }
        // And nothing was touched on the way to refusing.
        assert_eq!(read(dir.path(), "secrets.json"), "private");
    }

    #[test]
    fn the_published_folder_itself_may_not_escape() {
        let dir = tempfile::tempdir().unwrap();
        assert!(replace_dir_inner(
            &dir.path().to_string_lossy(),
            "../elsewhere",
            staged(&[("index.html", "x")]),
        )
        .is_err());
    }

    /// The whole replacement lands in one commit, carrying additions, changes
    /// and deletions together.
    #[test]
    fn a_replacement_commits_as_one_change() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        replace_dir_inner(
            &dir.path().to_string_lossy(),
            "docs",
            staged(&[("index.html", "v1"), ("data/a.json", "{}")]),
        )
        .unwrap();
        commit(dir.path(), "main", "Published v1");

        replace_dir_inner(
            &dir.path().to_string_lossy(),
            "docs",
            staged(&[("index.html", "v2")]),
        )
        .unwrap();
        let second = commit(dir.path(), "main", "Published v2");

        let files =
            git_read_tree(dir.path().to_string_lossy().into(), second, "docs".into()).unwrap();
        assert_eq!(files.get("docs/index.html").map(String::as_str), Some("v2"));
        assert!(!files.contains_key("docs/data/a.json"));
    }

    #[test]
    fn the_log_is_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{\"v\":1}")]);
        commit(dir.path(), "main", "first");
        project(dir.path(), &[("project.json", "{\"v\":2}")]);
        commit(dir.path(), "main", "second");

        let log = log_inner(&dir.path().to_string_lossy(), "main", 10).unwrap();
        assert_eq!(log.len(), 2);
        assert!(log[0].message.starts_with("second"));
        assert!(log[1].message.starts_with("first"));
        assert!(log[0].is_head);
        assert!(!log[1].is_head);
    }

    #[test]
    fn the_log_carries_the_whole_message_for_decoding() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        commit(
            dir.path(),
            "main",
            "Updated creature configuration\n\nDinoDepot-Action: {\"type\":\"creature.updated\"}",
        );
        let log = log_inner(&dir.path().to_string_lossy(), "main", 10).unwrap();
        assert!(log[0].message.contains("DinoDepot-Action"));
        assert!(log[0].at > 0);
        assert_eq!(log[0].author, COMMIT_NAME);
    }

    #[test]
    fn the_log_respects_its_limit() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        for i in 0..5 {
            project(dir.path(), &[("project.json", &format!("{{\"v\":{i}}}"))]);
            commit(dir.path(), "main", &format!("change {i}"));
        }
        assert_eq!(log_inner(&dir.path().to_string_lossy(), "main", 2).unwrap().len(), 2);
    }

    /// A project nobody has committed to has no history, which is normal.
    #[test]
    fn the_log_of_an_empty_project_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        assert!(log_inner(&dir.path().to_string_lossy(), "main", 10).unwrap().is_empty());
    }

    /// Restoring writes the old contents back; it never resets shared history.
    #[test]
    fn restoring_puts_an_older_version_back_in_the_working_tree() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{\"v\":1}")]);
        let first = commit(dir.path(), "main", "first");
        project(dir.path(), &[("project.json", "{\"v\":2}")]);
        let second = commit(dir.path(), "main", "second");

        let restored = restore_inner(
            &dir.path().to_string_lossy(),
            &first,
            vec!["project.json".into()],
        )
        .unwrap();

        assert_eq!(restored, 1);
        assert_eq!(read(dir.path(), "project.json"), "{\"v\":1}");
        // History is untouched - the tip is still the newer commit.
        let repo = Repository::open(dir.path()).unwrap();
        assert_eq!(
            repo.find_reference("refs/heads/main").unwrap().target().unwrap().to_string(),
            second
        );
    }

    #[test]
    fn restoring_skips_a_file_that_did_not_exist_then() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        let first = commit(dir.path(), "main", "first");
        assert_eq!(
            restore_inner(
                &dir.path().to_string_lossy(),
                &first,
                vec!["never-existed.json".into()]
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn restoring_refuses_a_path_that_escapes() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        let first = commit(dir.path(), "main", "first");
        assert!(restore_inner(
            &dir.path().to_string_lossy(),
            &first,
            vec!["../escaped.json".into()]
        )
        .is_err());
    }

    #[test]
    fn a_recovery_point_survives_until_it_is_cleared() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        let oid = commit(dir.path(), "main", "first");
        let path: String = dir.path().to_string_lossy().into();

        git_mark_recovery(path.clone(), "op-1".into(), oid.clone()).unwrap();
        let repo = Repository::open(dir.path()).unwrap();
        assert_eq!(
            repo.find_reference("refs/dinodepot/recovery/op-1")
                .unwrap()
                .target()
                .unwrap()
                .to_string(),
            oid
        );

        git_clear_recovery(path, "op-1".into()).unwrap();
        assert!(repo.find_reference("refs/dinodepot/recovery/op-1").is_err());
    }

    // --- guards -------------------------------------------------------------

    #[test]
    fn a_remote_url_carrying_a_token_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        let path: String = dir.path().to_string_lossy().into();
        assert!(git_set_remote(
            path.clone(),
            "https://x-access-token:ghp_abcdefghijklmnop@github.com/o/r.git".into(),
            false,
        )
        .is_err());
        assert!(git_set_remote(path.clone(), "http://github.com/o/r.git".into(), false).is_err());
        assert!(git_set_remote(path, "https://github.com/o/r.git".into(), false).is_ok());
    }

    #[test]
    fn repository_paths_may_not_escape_the_repository() {
        for bad in [
            "",
            "/etc/passwd",
            "..\\..\\secrets.json",
            "../outside.json",
            "C:\\Windows\\System32",
            ".git/config",
            "nested/.git/config",
        ] {
            assert!(!is_safe_repo_path(bad), "{bad} should be refused");
        }
        for good in ["project.json", "dinodepot/players.json", "profiles/a.arkprofile"] {
            assert!(is_safe_repo_path(good), "{good} should be allowed");
        }
    }

    #[test]
    fn committing_a_path_that_escapes_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        project(dir.path(), &[("project.json", "{}")]);
        let result = commit_inner(CommitRequest {
            dir: dir.path().to_string_lossy().into(),
            branch: "main".into(),
            message: "x".into(),
            paths: vec!["../escaped.json".into()],
        });
        assert_eq!(result.unwrap_err().code, "project.corrupt");
    }

    #[test]
    fn redaction_removes_credentials_from_anything_leaving_this_module() {
        assert_eq!(
            redact("failed to connect to https://x-access-token:secret@github.com/o/r.git"),
            "failed to connect to https://«credentials»@github.com/o/r.git"
        );
        assert_eq!(redact("token ghp_abcdefghijklmnopqrs failed"), "token «token» failed");
        assert_eq!(
            redact("github_pat_11ABCDEF0abcdefghij is bad"),
            "«token» is bad"
        );
        // Ordinary text, and an email address, survive untouched.
        let plain = "cannot reach github.com";
        assert_eq!(redact(plain), plain);
        assert_eq!(redact("studio@dinodepot.invalid"), "studio@dinodepot.invalid");
    }

    #[test]
    fn a_failure_serializes_with_a_code_the_frontend_can_branch_on() {
        let failure = Failure::new("repo.nonFastForward", "Somebody else saved first.", "x");
        let text = failure.to_string();
        assert!(text.contains("\"code\":\"repo.nonFastForward\""));
        assert!(text.contains("\"message\""));
    }

    #[test]
    fn a_failure_detail_is_redacted_on_construction() {
        let failure = Failure::new("unknown", "x", "url https://u:ghp_abcdefghijkl@github.com/o/r");
        assert!(!failure.detail.contains("ghp_"));
    }
}
