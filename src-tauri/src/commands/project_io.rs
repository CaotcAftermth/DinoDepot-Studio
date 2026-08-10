use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};

const BACKUP_KEEP: usize = 20;

/// Subfolder holding stored .arkprofile files, one per player.
const PROFILES_DIR: &str = "profiles";

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// A project file must be a plain `*.json` name directly in the project folder.
///
/// This checks the shape rather than matching a fixed list: the list only ever
/// existed to stop path traversal, and keeping a copy of it here in sync with
/// the TypeScript one was a silent-failure waiting to happen — a new project
/// file would be rejected at runtime with nothing to show for it.
fn validate_file_name(file_name: &str) -> Result<(), String> {
    let bad_shape = file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
        || file_name.starts_with('.')
        || !file_name.ends_with(".json");
    if bad_shape {
        return Err(format!(
            "'{file_name}' is not a valid project file name (expected a *.json file in the project folder)"
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn project_exists(dir: String) -> bool {
    Path::new(&dir).join("project.json").is_file()
}

#[tauri::command]
pub fn create_project_dir(dir: String) -> Result<(), String> {
    let path = PathBuf::from(&dir);
    if path.join("project.json").is_file() {
        return Err("A project already exists in that folder".into());
    }
    fs::create_dir_all(path.join("backups")).map_err(err)?;
    Ok(())
}

/// Loads every `*.json` in the project folder. Returns file name -> content.
///
/// Reads whatever is there rather than a fixed list, so the frontend alone
/// decides which files a project has.
#[tauri::command]
pub fn load_project(dir: String) -> Result<std::collections::HashMap<String, String>, String> {
    let path = PathBuf::from(&dir);
    if !path.join("project.json").is_file() {
        return Err("No project.json found in that folder".into());
    }
    let mut files = std::collections::HashMap::new();
    for entry in fs::read_dir(&path).map_err(err)? {
        let entry = entry.map_err(err)?;
        if !entry.file_type().map_err(err)?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if validate_file_name(&name).is_err() {
            continue; // .tmp write files, stray non-JSON, dotfiles
        }
        files.insert(name, fs::read_to_string(entry.path()).map_err(err)?);
    }
    Ok(files)
}

/// Writes a project file, backing up the previous version first.
#[tauri::command]
pub fn save_project_file(dir: String, file_name: String, content: String) -> Result<(), String> {
    validate_file_name(&file_name)?;
    let path = PathBuf::from(&dir);
    fs::create_dir_all(&path).map_err(err)?;
    let target = path.join(&file_name);

    if target.is_file() {
        let existing = fs::read_to_string(&target).map_err(err)?;
        // Skip the write (and the backup churn) when nothing changed.
        if existing == content {
            return Ok(());
        }
        backup_file(&path, &file_name, &existing)?;
    }

    // Write via temp file + rename so a crash mid-write can't corrupt the file.
    let tmp = path.join(format!("{file_name}.tmp"));
    fs::write(&tmp, &content).map_err(err)?;
    fs::rename(&tmp, &target).map_err(err)?;
    Ok(())
}

fn backup_file(project_dir: &Path, file_name: &str, content: &str) -> Result<(), String> {
    let backups = project_dir.join("backups");
    fs::create_dir_all(&backups).map_err(err)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
    fs::write(backups.join(format!("{stamp}_{file_name}")), content).map_err(err)?;
    prune_backups(&backups, file_name)?;
    Ok(())
}

fn prune_backups(backups: &Path, file_name: &str) -> Result<(), String> {
    let suffix = format!("_{file_name}");
    let mut entries: Vec<PathBuf> = fs::read_dir(backups)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with(&suffix))
                .unwrap_or(false)
        })
        .collect();
    entries.sort();
    while entries.len() > BACKUP_KEEP {
        let oldest = entries.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_every_project_file_the_frontend_writes() {
        for name in [
            "project.json",
            "production.draft.json",
            "remaps.draft.json",
            "cosmetics.draft.json",
            "catalog.mods.json",
            "watchlist.json",
            "history.json",
            "players.json",
            // A file added later must not need a change here — that drift is
            // what silently dropped player data.
            "something-new.json",
        ] {
            assert!(validate_file_name(name).is_ok(), "{name} should be allowed");
        }
    }

    #[test]
    fn rejects_anything_that_could_escape_the_project_folder() {
        for name in [
            "../secrets.json",
            "sub/dir.json",
            "sub\\dir.json",
            ".hidden.json",
            "notes.txt",
            "players.json.tmp",
            "",
        ] {
            assert!(validate_file_name(name).is_err(), "{name} should be rejected");
        }
    }

    #[test]
    fn profile_names_stay_inside_the_profiles_folder() {
        assert!(validate_profile_name("112233.arkprofile").is_ok());
        for bad in ["../x", "a/b", "a\\b", ""] {
            assert!(validate_profile_name(bad).is_err(), "{bad} should be rejected");
        }
    }

    /// Tauri renames arguments but not return values, so a snake_case field
    /// here reaches TypeScript as `undefined` — which is exactly how a whole
    /// player roster once got dropped on load.
    #[test]
    fn stored_profile_info_serializes_as_camel_case() {
        let json = serde_json::to_string(&StoredProfileInfo {
            file_name: "112233.arkprofile".into(),
            size_bytes: 4096,
        })
        .unwrap();
        assert!(json.contains("\"fileName\""), "got {json}");
        assert!(json.contains("\"sizeBytes\""), "got {json}");
        assert!(!json.contains("file_name"), "got {json}");
    }

    #[test]
    fn profile_file_content_serializes_as_camel_case() {
        let json = serde_json::to_string(&ProfileFileContent {
            content_b64: "AAAA".into(),
            modified_at: 1_700_000_000_000,
        })
        .unwrap();
        assert!(json.contains("\"contentB64\""), "got {json}");
        assert!(json.contains("\"modifiedAt\""), "got {json}");
        assert!(!json.contains("content_b64"), "got {json}");
    }

    #[test]
    fn only_profile_files_can_be_read_from_outside_the_project() {
        for bad in ["C:\\Windows\\System32\\config\\SAM", "notes.txt", "profile", ""] {
            assert!(
                read_profile_file_b64(bad.into()).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn profile_file_name_sanitizes_an_admin_typed_id() {
        assert_eq!(profile_file_name("112233"), "112233.arkprofile");
        assert_eq!(profile_file_name("../../etc"), "etc.arkprofile");
        assert_eq!(profile_file_name(""), "player.arkprofile");
    }
}

/// Reads an arbitrary text file (used by importers for live config files).
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(err)
}

/// Reads any file as base64 — used to carry icon images into a modpack.
#[tauri::command]
pub fn read_file_b64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(err)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Writes base64 content to a path, creating the parent directory.
#[tauri::command]
pub fn save_file_b64(path: String, content_b64: String) -> Result<(), String> {
    let cleaned: String = content_b64.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned)
        .map_err(|e| e.to_string())?;
    let target = std::path::Path::new(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(err)?;
        }
    }
    fs::write(target, bytes).map_err(err)
}

/// Writes an arbitrary text file to a path the user chose in a save dialog.
///
/// Creates the parent directory so a template can be saved into a new folder
/// in one step, which is how anyone actually starts a modpack.
#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(err)?;
        }
    }
    fs::write(target, contents).map_err(err)
}

// ---------------------------------------------------------------------------
// Player .arkprofile storage
// ---------------------------------------------------------------------------

/// Returned to the frontend, so the field names must be camelCase.
///
/// Tauri renames command *arguments* automatically, but return values go
/// through serde untouched — a snake_case field here silently arrives as
/// `undefined` in TypeScript.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProfileInfo {
    pub file_name: String,
    pub size_bytes: u64,
}

/// Keeps a stored profile name to a single safe path segment. The player id is
/// admin-entered, so it must never be able to escape the profiles folder.
fn profile_file_name(player_id: &str) -> String {
    let safe: String = player_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let trimmed = safe.trim_matches('_');
    let stem = if trimmed.is_empty() { "player" } else { trimmed };
    format!("{stem}.arkprofile")
}

/// Copies a .arkprofile into the project's profiles/ folder, replacing any
/// previous one for that player.
#[tauri::command]
pub fn store_player_profile(
    dir: String,
    player_id: String,
    source_path: String,
) -> Result<StoredProfileInfo, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("That file no longer exists".into());
    }
    let profiles = PathBuf::from(&dir).join(PROFILES_DIR);
    fs::create_dir_all(&profiles).map_err(err)?;

    let file_name = profile_file_name(&player_id);
    let target = profiles.join(&file_name);
    fs::copy(&source, &target).map_err(err)?;
    let size_bytes = fs::metadata(&target).map_err(err)?.len();
    Ok(StoredProfileInfo { file_name, size_bytes })
}

/// Writes profile bytes the app produced into the project's profiles/ folder.
///
/// The bulk importer and the profile generator both hold the file in memory —
/// the importer because it has already parsed it to work out who it belongs
/// to, the generator because it built it — so neither has a source path to
/// copy from the way `store_player_profile` does.
#[tauri::command]
pub fn store_player_profile_b64(
    dir: String,
    player_id: String,
    content_b64: String,
) -> Result<StoredProfileInfo, String> {
    let bytes = decode_b64(&content_b64)?;
    let profiles = PathBuf::from(&dir).join(PROFILES_DIR);
    fs::create_dir_all(&profiles).map_err(err)?;

    let file_name = profile_file_name(&player_id);
    fs::write(profiles.join(&file_name), &bytes).map_err(err)?;
    Ok(StoredProfileInfo {
        file_name,
        size_bytes: bytes.len() as u64,
    })
}

/// A profile read from outside the project, with the file's own timestamp.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileFileContent {
    pub content_b64: String,
    /// Last-modified time in epoch milliseconds; 0 when the OS will not say.
    pub modified_at: i64,
}

/// Reads a .arkprofile from anywhere on disk.
///
/// Dropped files arrive as paths, and picking a template for a generated
/// profile reaches outside the project folder, so neither can go through the
/// profiles/-scoped reader. The extension check keeps this from becoming a
/// general "read any file" command.
///
/// The modified time comes back with the bytes because it is the only thing
/// that distinguishes two saves of the same account — a server backup folder
/// holds several, and the admin picks between them by date.
#[tauri::command]
pub fn read_profile_file_b64(path: String) -> Result<ProfileFileContent, String> {
    let source = PathBuf::from(&path);
    let is_profile = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("arkprofile"))
        .unwrap_or(false);
    if !is_profile {
        return Err(format!(
            "'{path}' is not a .arkprofile — only profile files can be read here"
        ));
    }
    if !source.is_file() {
        return Err("That file no longer exists".into());
    }
    let modified_at = fs::metadata(&source)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let bytes = fs::read(&source).map_err(err)?;
    Ok(ProfileFileContent {
        content_b64: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            bytes,
        ),
        modified_at,
    })
}

fn decode_b64(content_b64: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = content_b64.chars().filter(|c| !c.is_whitespace()).collect();
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, cleaned)
        .map_err(|e| format!("Profile content is not valid base64: {e}"))
}

/// Copies a stored profile back out to a location the admin picked.
#[tauri::command]
pub fn export_player_profile(
    dir: String,
    file_name: String,
    dest_path: String,
) -> Result<(), String> {
    validate_profile_name(&file_name)?;
    let source = PathBuf::from(&dir).join(PROFILES_DIR).join(&file_name);
    if !source.is_file() {
        return Err("No stored profile found for that player".into());
    }
    fs::copy(&source, PathBuf::from(&dest_path)).map_err(err)?;
    Ok(())
}

/// Reads a stored profile as base64, for uploading it to GitHub.
#[tauri::command]
pub fn read_player_profile_b64(dir: String, file_name: String) -> Result<String, String> {
    validate_profile_name(&file_name)?;
    let source = PathBuf::from(&dir).join(PROFILES_DIR).join(&file_name);
    if !source.is_file() {
        return Err("No stored profile found for that player".into());
    }
    let bytes = fs::read(&source).map_err(err)?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        bytes,
    ))
}

/// Writes a base64 profile into the project's profiles/ folder (restore).
#[tauri::command]
pub fn write_player_profile_b64(
    dir: String,
    file_name: String,
    content_b64: String,
) -> Result<u64, String> {
    validate_profile_name(&file_name)?;
    let profiles = PathBuf::from(&dir).join(PROFILES_DIR);
    fs::create_dir_all(&profiles).map_err(err)?;
    let bytes = decode_b64(&content_b64)?;
    let target = profiles.join(&file_name);
    fs::write(&target, &bytes).map_err(err)?;
    Ok(bytes.len() as u64)
}

/// Rejects anything that isn't a plain name inside profiles/.
fn validate_profile_name(file_name: &str) -> Result<(), String> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
    {
        return Err("Invalid profile file name".into());
    }
    Ok(())
}

/// Deletes a stored profile. Missing files are treated as already gone.
#[tauri::command]
pub fn delete_player_profile(dir: String, file_name: String) -> Result<(), String> {
    validate_profile_name(&file_name)?;
    let target = PathBuf::from(&dir).join(PROFILES_DIR).join(&file_name);
    if target.is_file() {
        fs::remove_file(&target).map_err(err)?;
    }
    Ok(())
}
