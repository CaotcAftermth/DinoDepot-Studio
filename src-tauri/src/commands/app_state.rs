use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// Machine-local project state: where a project lives on *this* computer, which
/// GitHub account it authenticates as, and which repositories it is bound to.
///
/// Kept in the OS application-data folder rather than in the project, because
/// none of it is true of the project — it is true of this machine. Storing it
/// in `project.json` (schema 1) meant every administrator's drive letters and
/// repository name synchronized to everybody else, and the first save on the
/// other machine put them straight back.
///
/// Files are named by the project's immutable id. Never by a path: a project
/// folder gets moved, and a binding that a move can orphan is not a binding.
///
/// No credential is ever written here. The record names the GitHub account; the
/// token itself lives in Windows Credential Manager.

const PROJECTS_DIR: &str = "projects";

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// The app-data folder, created on first use.
fn state_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not locate the application data folder: {e}"))?
        .join(PROJECTS_DIR);
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Keeps a project id to one safe file-name segment.
///
/// The id is a UUID the app generates, but it arrives here from a project file
/// that may have been edited by hand — an opened project is untrusted input,
/// and `../../` in an id must not be able to name a file outside the folder.
fn state_file_name(project_id: &str) -> Result<String, String> {
    let safe: String = project_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() || safe.len() > 128 {
        return Err("Invalid project id".into());
    }
    Ok(format!("{safe}.json"))
}

/// Reads this machine's record for a project. `None` when there is none yet.
#[tauri::command]
pub fn local_state_get(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Option<String>, String> {
    let path = state_root(&app)?.join(state_file_name(&project_id)?);
    if !path.is_file() {
        return Ok(None);
    }
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        // A corrupt local record must never stop a project opening: everything
        // in it can be re-established, and none of it is the admin's work.
        Err(e) => Err(format!("Could not read local project settings: {e}")),
    }
}

/// Writes this machine's record for a project, atomically.
#[tauri::command]
pub fn local_state_set(
    app: tauri::AppHandle,
    project_id: String,
    content: String,
) -> Result<(), String> {
    // Refusing here rather than at the call site means a credential cannot
    // reach this file even through a caller that forgot.
    if looks_like_credential(&content) {
        return Err("Refusing to store credentials in project settings".into());
    }
    let path = state_root(&app)?.join(state_file_name(&project_id)?);
    super::project_io::write_atomic(&path, content.as_bytes())
}

#[tauri::command]
pub fn local_state_delete(app: tauri::AppHandle, project_id: String) -> Result<(), String> {
    let path = state_root(&app)?.join(state_file_name(&project_id)?);
    if path.is_file() {
        fs::remove_file(&path).map_err(err)?;
    }
    Ok(())
}

/// Every project this machine knows about, as raw JSON records.
///
/// Drives the recents list, which used to live in `localStorage` and therefore
/// vanished whenever the webview data was cleared.
#[tauri::command]
pub fn local_state_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = state_root(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(err)? {
        let entry = entry.map_err(err)?;
        if !entry.file_type().map_err(err)?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        // One unreadable record must not hide every other project.
        if let Ok(text) = fs::read_to_string(entry.path()) {
            out.push(text);
        }
    }
    Ok(out)
}

/// Working copy of a project's delivery repository.
///
/// Kept in application data rather than beside the project, for two reasons: it
/// is generated output that no administrator should be editing, and putting a
/// second Git repository inside the project folder would make the project's own
/// repository try to track it.
///
/// Keyed by project id, like everything else here — a moved project folder must
/// not orphan its published site.
#[tauri::command]
pub fn delivery_dir(app: tauri::AppHandle, project_id: String) -> Result<String, String> {
    let name = state_file_name(&project_id)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not locate the application data folder: {e}"))?
        .join("delivery")
        // `state_file_name` appends .json; the folder wants the bare id.
        .join(name.trim_end_matches(".json"));
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.to_string_lossy().to_string())
}

/// A cheap guard against a token reaching disk in the clear.
///
/// Not a security boundary — the boundary is that the frontend cannot read a
/// token at all — but it catches the mistake at the moment it is made rather
/// than months later in somebody's roaming profile.
pub fn looks_like_credential(text: &str) -> bool {
    text.contains("github_pat_")
        || text.contains("ghp_")
        || text.contains("gho_")
        || text.contains("ghs_")
        || text.contains("ghu_")
        || text.contains("ghr_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_file_names_stay_inside_the_folder() {
        assert_eq!(
            state_file_name("11111111-2222-4333-8444-555555555555").unwrap(),
            "11111111-2222-4333-8444-555555555555.json"
        );
        // Separators and dots are dropped rather than rejected, so a slightly
        // odd id still resolves — but never outside the folder.
        assert_eq!(state_file_name("../../evil").unwrap(), "evil.json");
        assert!(state_file_name("").is_err());
        assert!(state_file_name("///").is_err());
        assert!(state_file_name(&"x".repeat(200)).is_err());
    }

    #[test]
    fn credential_shaped_content_is_refused() {
        assert!(looks_like_credential(
            r#"{"token":"github_pat_11ABCDEF0abcdefghij"}"#
        ));
        assert!(looks_like_credential(r#"{"t":"ghp_abcdefghijklmnop"}"#));
        assert!(!looks_like_credential(
            r#"{"githubLogin":"ggfizz","source":{"owner":"ggfizz"}}"#
        ));
    }
}
