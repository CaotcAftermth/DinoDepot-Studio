//! Reading artwork out of a mod installed on this machine.
//!
//! Discovery already catalogues a mod's creatures and items from plain text -
//! its manifest lists every cooked asset path. What it cannot do is say which
//! of those assets is a picture, because on disk every one of them is a
//! `.uasset`, and matching icons to entries by name does not work: measured
//! across the local corpus, only 5.5% of items have a name-matching icon.
//!
//! So the administrator picks. This module runs the asset sidecar, which reads
//! the mod's IoStore container and reports the textures inside it, then hands
//! one back as PNG on request. Turning that into a project icon is
//! `icon_import`'s job, so the 160x160 WebP rule holds no matter where the
//! image came from.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Long enough for the largest mod on the test corpus (a 5.2 GB pack of 3,294
/// assets scans in about 7 seconds), with room for a slower disk.
const SCAN_TIMEOUT_SECS: u64 = 120;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModTexture {
    /// Container-relative asset path, and the handle `export` takes.
    pub path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum SidecarEvent {
    Status {
        #[allow(dead_code)]
        message: String,
    },
    Texture {
        path: String,
        name: String,
        #[serde(default)]
        width: u32,
        #[serde(default)]
        height: u32,
    },
    Image {
        #[allow(dead_code)]
        name: String,
        // `rename_all` on an enum renames its *variants*, not their fields, so
        // this one has to be spelled out. Without it the event silently fails
        // to parse and the export looks like a texture that was never there.
        #[serde(rename = "pngB64")]
        png_b64: String,
    },
    Done {
        #[allow(dead_code)]
        count: usize,
    },
    Error {
        message: String,
    },
}

/// Windows verbatim prefixes confuse the process launcher, same as they do for
/// the scraper sidecar.
fn de_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

const TOOL_NAME: &str = if cfg!(windows) {
    "DinoDepot.AssetTool.exe"
} else {
    "DinoDepot.AssetTool"
};

fn resolve_tool(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("sidecar-assets").join(TOOL_NAME);
        if bundled.exists() {
            return Ok(de_verbatim(bundled));
        }
    }
    // Dev: the working directory is src-tauri, and the tool builds in place.
    if let Ok(cwd) = std::env::current_dir() {
        for profile in ["Release", "Debug"] {
            let dev = cwd
                .join("..")
                .join("sidecar-assets")
                .join("bin")
                .join(profile)
                .join("net8.0")
                .join(TOOL_NAME);
            if dev.exists() {
                return Ok(de_verbatim(dev.canonicalize().unwrap_or(dev)));
            }
        }
    }
    Err("The mod asset reader is not installed with this build".to_string())
}

/// The folder holding a mod's `.utoc`, given the mod's own folder.
///
/// Every installed mod is laid out the same way, so this is derived rather
/// than searched for: `<mod>/<ShortName>/Content/Paks/Windows`.
fn mod_paks_dir(mod_dir: &Path) -> Result<PathBuf, String> {
    let entries = std::fs::read_dir(mod_dir)
        .map_err(|e| format!("Could not read the mod folder: {e}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_dir());
    for entry in entries {
        let paks = entry.join("Content").join("Paks").join("Windows");
        if paks.is_dir() {
            return Ok(paks);
        }
    }
    Err("That mod ships no content containers".to_string())
}

/// The game's `Content/Paks` folder, found from the mod's own location.
///
/// Derived rather than stored: an installed mod always sits under the same
/// install whose global container it needs, and asking the administrator to
/// point at a second folder they have already pointed at once is a setting
/// nobody should have to keep correct.
fn game_paks_from(mod_dir: &Path) -> Option<PathBuf> {
    for ancestor in mod_dir.ancestors() {
        let paks = ancestor.join("ShooterGame").join("Content").join("Paks");
        if paks.join("global.utoc").is_file() {
            return Some(paks);
        }
    }
    None
}

fn resolve_game_paks(mod_dir: &Path, supplied: &str) -> Result<String, String> {
    if !supplied.trim().is_empty() {
        return Ok(supplied.trim().to_string());
    }
    game_paks_from(mod_dir)
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| {
            "The ARK install's global.utoc was not found above that mod folder".to_string()
        })
}

fn run_tool(app: &AppHandle, args: &[&str]) -> Result<Vec<SidecarEvent>, String> {
    let tool = resolve_tool(app)?;
    let mut command = std::process::Command::new(&tool);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = command
        .output()
        .map_err(|e| format!("Could not start the mod asset reader: {e}"))?;

    let mut events = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            // CUE4Parse logs progress on stdout as plain text; it is not ours
            // to interpret, and it is not an error.
            continue;
        }
        if let Ok(event) = serde_json::from_str::<SidecarEvent>(line) {
            if let SidecarEvent::Error { message } = &event {
                return Err(message.clone());
            }
            events.push(event);
        }
    }
    if events.is_empty() && !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .lines()
            .last()
            .unwrap_or("The mod asset reader failed")
            .to_string());
    }
    Ok(events)
}

/// Every texture one installed mod carries.
///
/// Blocking rather than streamed: the scan is seconds, not minutes, and the
/// picker has nothing to show until the list is complete anyway.
#[tauri::command]
pub async fn mod_textures(
    app: AppHandle,
    mod_dir: String,
    game_paks_dir: String,
) -> Result<Vec<ModTexture>, String> {
    let root = PathBuf::from(&mod_dir);
    let paks = mod_paks_dir(&root)?;
    let paks_arg = paks.to_string_lossy().to_string();
    let game_paks_dir = resolve_game_paks(&root, &game_paks_dir)?;
    let handle = tokio::task::spawn_blocking(move || {
        run_tool(&app, &["textures", &paks_arg, &game_paks_dir])
    });
    let events = tokio::time::timeout(
        std::time::Duration::from_secs(SCAN_TIMEOUT_SECS),
        handle,
    )
    .await
    .map_err(|_| "Reading that mod's artwork took too long".to_string())?
    .map_err(|e| e.to_string())??;

    Ok(events
        .into_iter()
        .filter_map(|event| match event {
            SidecarEvent::Texture {
                path,
                name,
                width,
                height,
            } => Some(ModTexture {
                path,
                name,
                width,
                height,
            }),
            _ => None,
        })
        .collect())
}

/// One texture, decoded, as base64 PNG. Conversion to a project icon happens
/// in `icon_import` so every icon lands the same shape however it was found.
#[tauri::command]
pub async fn mod_texture_png(
    app: AppHandle,
    mod_dir: String,
    game_paks_dir: String,
    asset_path: String,
) -> Result<String, String> {
    let root = PathBuf::from(&mod_dir);
    let paks = mod_paks_dir(&root)?;
    let paks_arg = paks.to_string_lossy().to_string();
    let game_paks_dir = resolve_game_paks(&root, &game_paks_dir)?;
    let handle = tokio::task::spawn_blocking(move || {
        run_tool(&app, &["export", &paks_arg, &game_paks_dir, &asset_path])
    });
    let events = tokio::time::timeout(
        std::time::Duration::from_secs(SCAN_TIMEOUT_SECS),
        handle,
    )
    .await
    .map_err(|_| "Reading that texture took too long".to_string())?
    .map_err(|e| e.to_string())??;

    events
        .into_iter()
        .find_map(|event| match event {
            SidecarEvent::Image { png_b64, .. } => Some(png_b64),
            _ => None,
        })
        .ok_or_else(|| "That asset holds no texture".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_pak_folder_by_the_layout_every_mod_shares() {
        let temp = tempfile::tempdir().unwrap();
        let paks = temp
            .path()
            .join("SomeMod")
            .join("Content")
            .join("Paks")
            .join("Windows");
        std::fs::create_dir_all(&paks).unwrap();
        assert_eq!(mod_paks_dir(temp.path()).unwrap(), paks);
    }

    #[test]
    fn says_so_when_a_mod_ships_no_containers() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("SomeMod").join("Content")).unwrap();
        assert!(mod_paks_dir(temp.path()).is_err());
    }

    #[test]
    fn finds_the_game_paks_above_a_mod_folder() {
        let temp = tempfile::tempdir().unwrap();
        let paks = temp.path().join("ShooterGame").join("Content").join("Paks");
        std::fs::create_dir_all(&paks).unwrap();
        std::fs::write(paks.join("global.utoc"), b"x").unwrap();
        let mod_dir = temp
            .path()
            .join("ShooterGame/Binaries/Win64/ShooterGame/Mods/83374/1_2");
        std::fs::create_dir_all(&mod_dir).unwrap();
        assert_eq!(game_paks_from(&mod_dir), Some(paks));
    }

    #[test]
    fn an_explicit_paks_folder_wins_over_the_search() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_game_paks(temp.path(), "  D:/elsewhere  ").unwrap(),
            "D:/elsewhere"
        );
        assert!(resolve_game_paks(temp.path(), "").is_err());
    }

    #[test]
    fn reads_an_image_event_exactly_as_the_sidecar_writes_it() {
        // Verbatim from the sidecar's own output. The field is camelCase, and
        // `rename_all` on the enum renames variants rather than their fields,
        // so an unnoticed mismatch here reads as "that asset holds no texture"
        // for every icon anybody picks.
        let line = r#"{"type":"image","name":"Icon_Rex","width":256,"height":256,"pngB64":"AAAA"}"#;
        match serde_json::from_str::<SidecarEvent>(line).unwrap() {
            SidecarEvent::Image { png_b64, .. } => assert_eq!(png_b64, "AAAA"),
            _ => panic!("expected an image event"),
        }
    }

    #[test]
    fn reads_the_events_the_sidecar_emits() {
        let line = r#"{"type":"texture","path":"a/b.uasset","name":"b","width":256,"height":256}"#;
        let event: SidecarEvent = serde_json::from_str(line).unwrap();
        match event {
            SidecarEvent::Texture { name, width, .. } => {
                assert_eq!(name, "b");
                assert_eq!(width, 256);
            }
            _ => panic!("expected a texture event"),
        }
    }
}
