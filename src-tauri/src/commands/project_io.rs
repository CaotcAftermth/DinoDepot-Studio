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
pub(crate) fn validate_file_name(file_name: &str) -> Result<(), String> {
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

/// Writes bytes so that a crash leaves either the old file or the new one.
///
/// The temp-file-then-rename dance is only half of it: without the explicit
/// flush, the rename can reach the disk before the contents do, and a power
/// cut in that window leaves a correctly-named file full of zeroes. This is
/// the single write primitive — the project files, the lock, and the local
/// state records all go through it.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(err)?;
        }
    }
    let tmp = with_suffix(target, ".tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(err)?;
        file.write_all(bytes).map_err(err)?;
        file.flush().map_err(err)?;
        file.sync_all().map_err(err)?;
    }
    // Windows will not rename onto an existing file, so the old one goes first.
    // The temp file is already durable at this point, so the gap is recoverable:
    // the .tmp is right there next to it.
    if target.exists() {
        fs::remove_file(target).map_err(err)?;
    }
    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        err(e)
    })?;
    Ok(())
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
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

    write_atomic(&target, content.as_bytes())
}

/// Moves a file that could not be understood out of the way, unread.
///
/// The alternative — carrying on with empty data — is what turns one bad file
/// into a lost roster: the store starts from nothing, the next keystroke
/// autosaves, and the damaged original is gone. Renaming it first means the
/// worst case is a file the admin has to go and look at.
#[tauri::command]
pub fn quarantine_project_file(dir: String, file_name: String) -> Result<String, String> {
    validate_file_name(&file_name)?;
    let path = PathBuf::from(&dir);
    let source = path.join(&file_name);
    if !source.is_file() {
        return Err(format!("{file_name} is not there to set aside"));
    }
    let quarantine = path.join("recovery");
    fs::create_dir_all(&quarantine).map_err(err)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let target = quarantine.join(format!("{stamp}_{file_name}"));
    // Copy-then-remove rather than rename: the two can be on different volumes
    // once someone points a project at a network share.
    fs::copy(&source, &target).map_err(err)?;
    fs::remove_file(&source).map_err(err)?;
    Ok(target.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Whole-project staging, for migrations and other destructive operations
// ---------------------------------------------------------------------------

/// Where a migration assembles its result before anything real is touched.
const STAGING_DIR: &str = ".dinodepot-staging";
/// Where the complete pre-migration project is kept.
const SNAPSHOTS_DIR: &str = "backups/snapshots";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub path: String,
    pub file_count: usize,
}

/// Copies the entire project folder somewhere safe.
///
/// Per-file backups are not enough for a migration: a migration changes several
/// files as one unit, and recovering it means recovering the set. Excludes the
/// backup tree itself, or every snapshot would contain the last one.
#[tauri::command]
pub fn snapshot_project(dir: String, label: String) -> Result<SnapshotInfo, String> {
    let root = PathBuf::from(&dir);
    if !root.join("project.json").is_file() {
        return Err("No project.json found in that folder".into());
    }
    let safe_label: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let target = root
        .join(SNAPSHOTS_DIR)
        .join(format!("{stamp}_{}", safe_label.trim_matches('-')));
    fs::create_dir_all(&target).map_err(err)?;
    let file_count = copy_tree(&root, &target)?;
    Ok(SnapshotInfo {
        path: target.to_string_lossy().to_string(),
        file_count,
    })
}

/// Recursively copies a project, skipping the folders that are not project data.
fn copy_tree(from: &Path, to: &Path) -> Result<usize, String> {
    let mut count = 0;
    for entry in fs::read_dir(from).map_err(err)? {
        let entry = entry.map_err(err)?;
        let name = entry.file_name().to_string_lossy().to_string();
        // `backups` holds previous snapshots, `.dinodepot-staging` holds a
        // migration in flight, and neither belongs inside a new snapshot. The
        // lock files describe who is editing right now, which is never true of
        // a copy — restoring one would hand the restored project a lock.
        if name == "backups"
            || name == STAGING_DIR
            || name == "recovery"
            || name.starts_with(".dinodepot-lock")
        {
            continue;
        }
        let target = to.join(&name);
        if entry.file_type().map_err(err)?.is_dir() {
            fs::create_dir_all(&target).map_err(err)?;
            count += copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(err)?;
            count += 1;
        }
    }
    Ok(count)
}

/// Replaces a project's JSON files with a migrated set, atomically enough.
///
/// The sequence is: snapshot the whole project, write every new file into a
/// staging folder, verify each landed, and only then move them across. A
/// failure anywhere before the final loop leaves the project exactly as it
/// was; a failure *during* it leaves the snapshot, which the recovery flow
/// restores from.
///
/// The migration itself is not here — it is pure TypeScript, tested against
/// fixtures. This is only the part that has to touch the disk.
#[tauri::command]
pub fn commit_migrated_project(
    dir: String,
    files: std::collections::HashMap<String, String>,
) -> Result<SnapshotInfo, String> {
    let root = PathBuf::from(&dir);
    for name in files.keys() {
        validate_file_name(name)?;
    }

    let snapshot = snapshot_project(dir.clone(), "pre-migration".into())?;

    let staging = root.join(STAGING_DIR);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(err)?;
    }
    fs::create_dir_all(&staging).map_err(err)?;

    for (name, content) in &files {
        write_atomic(&staging.join(name), content.as_bytes())?;
    }
    // Read the staged files back before anything real is replaced. A disk that
    // accepted the write and returned something else is exactly the failure
    // this whole dance exists for.
    for (name, content) in &files {
        let staged = fs::read_to_string(staging.join(name)).map_err(err)?;
        if &staged != content {
            fs::remove_dir_all(&staging).map_err(err)?;
            return Err(format!(
                "The updated {name} did not read back correctly — nothing was changed"
            ));
        }
    }

    for name in files.keys() {
        fs::rename(staging.join(name), root.join(name)).map_err(|e| {
            format!("Could not put the updated {name} in place: {e}. Your project is in {}", snapshot.path)
        })?;
    }
    let _ = fs::remove_dir_all(&staging);
    Ok(snapshot)
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

    // -----------------------------------------------------------------------
    // On-disk behaviour
    // -----------------------------------------------------------------------

    fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        for (name, content) in files {
            fs::write(dir.path().join(name), content).expect("write fixture");
        }
        dir
    }

    fn read(dir: &Path, name: &str) -> String {
        fs::read_to_string(dir.join(name)).expect("read")
    }

    #[test]
    fn write_atomic_creates_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.json");
        write_atomic(&target, b"{\"v\":1}").unwrap();
        assert_eq!(read(dir.path(), "a.json"), "{\"v\":1}");
        write_atomic(&target, b"{\"v\":2}").unwrap();
        assert_eq!(read(dir.path(), "a.json"), "{\"v\":2}");
    }

    #[test]
    fn write_atomic_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        write_atomic(&dir.path().join("a.json"), b"x").unwrap();
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a.json".to_string()]);
    }

    #[test]
    fn write_atomic_creates_missing_parents() {
        let dir = tempfile::tempdir().unwrap();
        write_atomic(&dir.path().join("nested/deep/a.json"), b"x").unwrap();
        assert_eq!(read(dir.path(), "nested/deep/a.json"), "x");
    }

    /// The failure this exists to prevent: a file the app could not understand
    /// being left in place, hydrated as empty, and then autosaved over.
    #[test]
    fn quarantine_moves_the_damaged_file_out_of_reach() {
        let dir = project(&[
            ("project.json", "{}"),
            ("players.json", "{ truncated roster"),
        ]);
        let moved =
            quarantine_project_file(dir.path().to_string_lossy().into(), "players.json".into())
                .unwrap();

        assert!(!dir.path().join("players.json").exists());
        assert!(Path::new(&moved).is_file());
        assert_eq!(fs::read_to_string(&moved).unwrap(), "{ truncated roster");
        // And it is somewhere `load_project` will never read it back from.
        assert!(moved.contains("recovery"));
    }

    #[test]
    fn quarantine_refuses_a_file_that_is_not_there() {
        let dir = project(&[("project.json", "{}")]);
        assert!(quarantine_project_file(
            dir.path().to_string_lossy().into(),
            "players.json".into()
        )
        .is_err());
    }

    #[test]
    fn snapshot_copies_the_whole_project_but_not_its_own_backups() {
        let dir = project(&[("project.json", "{\"a\":1}"), ("players.json", "[]")]);
        fs::create_dir_all(dir.path().join("profiles")).unwrap();
        fs::write(dir.path().join("profiles/x.arkprofile"), b"\x00\x01").unwrap();
        fs::create_dir_all(dir.path().join("backups")).unwrap();
        fs::write(dir.path().join("backups/old_project.json"), "stale").unwrap();

        let info =
            snapshot_project(dir.path().to_string_lossy().into(), "pre-migration".into()).unwrap();
        let snap = PathBuf::from(&info.path);

        assert_eq!(read(&snap, "project.json"), "{\"a\":1}");
        assert!(snap.join("profiles/x.arkprofile").is_file());
        // Binary project data is copied byte-for-byte, not through a string.
        assert_eq!(fs::read(snap.join("profiles/x.arkprofile")).unwrap(), vec![0, 1]);
        assert!(!snap.join("backups").exists());
        assert_eq!(info.file_count, 3);
    }

    #[test]
    fn snapshot_refuses_a_folder_that_is_not_a_project() {
        let dir = tempfile::tempdir().unwrap();
        assert!(snapshot_project(dir.path().to_string_lossy().into(), "x".into()).is_err());
    }

    #[test]
    fn committing_a_migration_snapshots_first_then_replaces() {
        let dir = project(&[
            ("project.json", "{\"schemaVersion\":1}"),
            ("players.json", "{\"old\":true}"),
        ]);
        let mut files = std::collections::HashMap::new();
        files.insert("project.json".to_string(), "{\"schemaVersion\":2}".to_string());
        files.insert("players.json".to_string(), "{\"new\":true}".to_string());

        let snapshot =
            commit_migrated_project(dir.path().to_string_lossy().into(), files).unwrap();

        assert_eq!(read(dir.path(), "project.json"), "{\"schemaVersion\":2}");
        assert_eq!(read(dir.path(), "players.json"), "{\"new\":true}");
        // The pre-migration project is recoverable in full.
        let snap = PathBuf::from(&snapshot.path);
        assert_eq!(read(&snap, "project.json"), "{\"schemaVersion\":1}");
        assert_eq!(read(&snap, "players.json"), "{\"old\":true}");
        // Staging is cleaned up, so a later snapshot cannot pick it up.
        assert!(!dir.path().join(STAGING_DIR).exists());
    }

    /// A migrated file name still has to be a project file name. An opened
    /// project is untrusted input, and a migration is not an excuse to write
    /// outside the folder.
    #[test]
    fn committing_a_migration_refuses_a_path_that_escapes() {
        let dir = project(&[("project.json", "{}")]);
        let mut files = std::collections::HashMap::new();
        files.insert("../escaped.json".to_string(), "{}".to_string());
        assert!(commit_migrated_project(dir.path().to_string_lossy().into(), files).is_err());
        assert_eq!(read(dir.path(), "project.json"), "{}");
    }

    #[test]
    fn a_refused_migration_changes_nothing() {
        let dir = project(&[("project.json", "{\"schemaVersion\":1}")]);
        let mut files = std::collections::HashMap::new();
        files.insert("notes.txt".to_string(), "hello".to_string());
        assert!(commit_migrated_project(dir.path().to_string_lossy().into(), files).is_err());
        assert_eq!(read(dir.path(), "project.json"), "{\"schemaVersion\":1}");
        assert!(!dir.path().join("notes.txt").exists());
    }

    #[test]
    fn saving_a_project_file_rotates_a_backup_of_the_previous_one() {
        let dir = project(&[("project.json", "{\"v\":1}")]);
        save_project_file(
            dir.path().to_string_lossy().into(),
            "project.json".into(),
            "{\"v\":2}".into(),
        )
        .unwrap();

        assert_eq!(read(dir.path(), "project.json"), "{\"v\":2}");
        let backups: Vec<String> = fs::read_dir(dir.path().join("backups"))
            .unwrap()
            .map(|e| fs::read_to_string(e.unwrap().path()).unwrap())
            .collect();
        assert_eq!(backups, vec!["{\"v\":1}".to_string()]);
    }

    #[test]
    fn saving_identical_content_does_not_churn_backups() {
        let dir = project(&[("project.json", "{\"v\":1}")]);
        save_project_file(
            dir.path().to_string_lossy().into(),
            "project.json".into(),
            "{\"v\":1}".into(),
        )
        .unwrap();
        assert!(!dir.path().join("backups").exists());
    }

    #[test]
    fn loading_a_project_ignores_everything_that_is_not_project_data() {
        let dir = project(&[
            ("project.json", "{}"),
            ("players.json", "[]"),
            ("notes.txt", "ignored"),
            (".dinodepot-lock", "{}"),
        ]);
        let files = load_project(dir.path().to_string_lossy().into()).unwrap();
        let mut names: Vec<&String> = files.keys().collect();
        names.sort();
        assert_eq!(names, vec!["players.json", "project.json"]);
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
