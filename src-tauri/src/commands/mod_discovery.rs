use std::fs;
use std::path::{Path, PathBuf};

/// Mod Discovery: reading an installed ASA mod's own files.
///
/// An installed mod ships a plain-text listing of everything it cooked, so the
/// whole feature is directory walking and reading two text files per mod. No
/// pak parsing, no decryption, no mappings file — see `src/model/modDiscovery.ts`
/// for what is then made of them.
///
/// This is deliberately split in two. Listing is cheap (a `.uplugin` is about a
/// kilobyte) and gives the review screen something to show immediately; reading
/// manifests is not (60 KB each, 32 MB across a full install), so it happens
/// only for the mods an admin actually picks.

/// CurseForge's game id for Ark: Survival Ascended, which is also the folder
/// the launcher groups installed mods under.
const ASA_GAME_ID: &str = "83374";

/// Where the mods folder sits relative to a game installation root.
const MODS_SUFFIX: &str = "ShooterGame/Binaries/Win64/ShooterGame/Mods";

/// One installed mod, cheap enough to list every one of them.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMod {
    /// Installed folder name, `<projectId>_<fileId>`.
    pub folder_name: String,
    /// The mod's plugin name, which is also its blueprint mount point.
    pub short_name: String,
    /// Raw `.uplugin` text, or empty when it could not be read.
    pub uplugin: String,
    /// False when the manifest is missing, which makes the mod undiscoverable.
    pub has_manifest: bool,
}

/// One mod's two text files.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawModFiles {
    pub folder_name: String,
    pub short_name: String,
    pub uplugin: String,
    pub manifest: String,
}

/// Whether a directory looks like the folder mods are installed into.
///
/// Identified by content rather than by name: any child matching
/// `<digits>_<digits>` is an installed mod, and nothing else uses that shape.
fn holds_installed_mods(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    entries.filter_map(|e| e.ok()).any(|e| {
        e.path().is_dir()
            && e.file_name()
                .to_str()
                .map(|n| {
                    let mut parts = n.split('_');
                    matches!((parts.next(), parts.next(), parts.next()), (Some(a), Some(b), None)
                        if !a.is_empty()
                            && !b.is_empty()
                            && a.bytes().all(|c| c.is_ascii_digit())
                            && b.bytes().all(|c| c.is_ascii_digit()))
                })
                .unwrap_or(false)
    })
}

/// Finds the mods folder from whatever path the admin supplied.
///
/// The real location is six levels deep, and the path people have to hand is
/// the one they gave FModel — the game's install root. Accepting either (and
/// the intermediate `Mods` folder, since ASA groups by game id beneath it)
/// avoids making anyone hand-navigate to a folder called `83374`.
#[tauri::command]
pub fn resolve_mods_root(dir: String) -> Result<String, String> {
    let base = PathBuf::from(dir.trim());
    if !base.is_dir() {
        return Err(format!("{} is not a folder", base.display()));
    }

    let candidates = [
        base.clone(),
        base.join(ASA_GAME_ID),
        base.join(MODS_SUFFIX).join(ASA_GAME_ID),
        base.join(MODS_SUFFIX),
    ];
    for candidate in candidates {
        if candidate.is_dir() && holds_installed_mods(&candidate) {
            return Ok(candidate.to_string_lossy().replace('\\', "/"));
        }
    }

    Err(format!(
        "No installed mods found under {}. Point this at the Ark: Survival Ascended \
         install folder (the one containing ShooterGame), or directly at a Mods/{ASA_GAME_ID} folder.",
        base.display()
    ))
}

/// The mod's own folder inside its versioned install folder.
///
/// Every mod nests its content one level deeper under its plugin name. Anything
/// other than exactly one subdirectory means the layout is not what discovery
/// understands, and guessing would silently catalogue the wrong thing.
fn mod_content_dir(mod_dir: &Path) -> Option<(PathBuf, String)> {
    let entries = fs::read_dir(mod_dir).ok()?;
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    if dirs.len() != 1 {
        return None;
    }
    let dir = dirs.remove(0);
    let name = dir.file_name()?.to_str()?.to_string();
    Some((dir, name))
}

fn read_text(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// Lists every mod installed under the mods root.
///
/// Reads each `.uplugin` so the review screen can show real mod names rather
/// than folder ids, but stops short of the manifests.
#[tauri::command]
pub fn list_installed_mods(root: String) -> Result<Vec<InstalledMod>, String> {
    let base = Path::new(root.trim());
    if !base.is_dir() {
        return Err(format!("{} is not a folder", base.display()));
    }

    let entries = fs::read_dir(base).map_err(|e| e.to_string())?;
    let mut mods = Vec::new();

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(folder_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // Folders that are not `<projectId>_<fileId>` are left to the frontend
        // to warn about rather than dropped, so an unexpected layout is visible.
        let Some((content_dir, short_name)) = mod_content_dir(&path) else {
            continue;
        };

        mods.push(InstalledMod {
            folder_name: folder_name.to_string(),
            uplugin: read_text(&content_dir.join(format!("{short_name}.uplugin"))),
            has_manifest: content_dir.join("Manifest_UFSFiles_Win64.txt").is_file(),
            short_name,
        });
    }

    mods.sort_by(|a, b| a.folder_name.cmp(&b.folder_name));
    Ok(mods)
}

/// Reads the manifests for the mods an admin selected.
///
/// A mod that cannot be read is skipped rather than failing the batch — one
/// broken install should not stop the other forty from being catalogued.
#[tauri::command]
pub fn read_installed_mods(
    root: String,
    folder_names: Vec<String>,
) -> Result<Vec<RawModFiles>, String> {
    let base = Path::new(root.trim());
    if !base.is_dir() {
        return Err(format!("{} is not a folder", base.display()));
    }

    let mut out = Vec::new();
    for folder_name in folder_names {
        // Refuse anything that could climb out of the mods root.
        if folder_name.contains('/') || folder_name.contains('\\') || folder_name.contains("..") {
            continue;
        }
        let mod_dir = base.join(&folder_name);
        if !mod_dir.is_dir() {
            continue;
        }
        let Some((content_dir, short_name)) = mod_content_dir(&mod_dir) else {
            continue;
        };
        let manifest = read_text(&content_dir.join("Manifest_UFSFiles_Win64.txt"));
        if manifest.is_empty() {
            continue;
        }
        out.push(RawModFiles {
            folder_name,
            uplugin: read_text(&content_dir.join(format!("{short_name}.uplugin"))),
            short_name,
            manifest,
        });
    }
    Ok(out)
}
