use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};

use super::project_io::write_atomic;

const MAX_ICON_BYTES: usize = 8 * 1024 * 1024;
const MAX_BATCH_BYTES: usize = 64 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageIconWrite {
    pub name: String,
    pub content_b64: String,
}

fn safe_icon_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && matches!(
            Path::new(name)
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase())
                .as_deref(),
            Some("png" | "webp")
        )
}

fn signature_matches(name: &str, bytes: &[u8]) -> bool {
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        Some("webp") => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn rollback(committed: &[(PathBuf, PathBuf, bool)]) {
    for (target, backup, had_original) in committed.iter().rev() {
        let _ = fs::remove_file(target);
        if *had_original && backup.is_file() {
            let _ = fs::rename(backup, target).or_else(|_| {
                fs::copy(backup, target)?;
                fs::remove_file(backup)
            });
        }
    }
}

fn write_icon_batch(root: &Path, files: Vec<PackageIconWrite>) -> Result<usize, String> {
    if files.is_empty() {
        return Ok(0);
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;

    let mut names = HashSet::new();
    let mut decoded = Vec::with_capacity(files.len());
    let mut total = 0usize;
    for file in files {
        if !safe_icon_name(&file.name) {
            return Err(format!("'{}' is not a safe package icon name", file.name));
        }
        if !names.insert(file.name.to_ascii_lowercase()) {
            return Err(format!("Package icon '{}' is duplicated", file.name));
        }
        let bytes = STANDARD
            .decode(file.content_b64)
            .map_err(|_| format!("Package icon '{}' is not valid base64", file.name))?;
        if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES {
            return Err(format!("Package icon '{}' has an invalid size", file.name));
        }
        if !signature_matches(&file.name, &bytes) {
            return Err(format!(
                "Package icon '{}' has the wrong file signature",
                file.name
            ));
        }
        total = total.saturating_add(bytes.len());
        if total > MAX_BATCH_BYTES {
            return Err("Package icons are larger than 64 MB together".into());
        }
        decoded.push((file.name, bytes));
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let staging = root.join(format!(
        ".dinodepot-icon-staging-{}-{stamp}",
        std::process::id()
    ));
    let incoming = staging.join("incoming");
    let backups = staging.join("backups");
    fs::create_dir_all(&incoming).map_err(|e| e.to_string())?;
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;

    for (name, bytes) in &decoded {
        if let Err(error) = write_atomic(&incoming.join(name), bytes) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    }

    let mut committed: Vec<(PathBuf, PathBuf, bool)> = Vec::new();
    for (name, _) in &decoded {
        let target = root.join(name);
        let backup = backups.join(name);
        let had_original = target.is_file();
        if had_original {
            if let Err(error) = fs::copy(&target, &backup) {
                rollback(&committed);
                let _ = fs::remove_dir_all(&staging);
                return Err(error.to_string());
            }
        }
        committed.push((target.clone(), backup, had_original));
        if had_original {
            if let Err(error) = fs::remove_file(&target) {
                rollback(&committed);
                let _ = fs::remove_dir_all(&staging);
                return Err(error.to_string());
            }
        }
        if let Err(error) = fs::rename(incoming.join(name), &target) {
            rollback(&committed);
            let _ = fs::remove_dir_all(&staging);
            return Err(error.to_string());
        }
    }

    fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
    Ok(decoded.len())
}

/// Writes every referenced package icon or leaves the images directory as it was.
#[tauri::command]
pub fn write_package_icons(dir: String, files: Vec<PackageIconWrite>) -> Result<usize, String> {
    write_icon_batch(Path::new(&dir), files)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";

    #[test]
    fn writes_a_valid_batch() {
        let temp = tempfile::tempdir().unwrap();
        let count = write_icon_batch(
            temp.path(),
            vec![PackageIconWrite {
                name: "Creature.png".into(),
                content_b64: STANDARD.encode(PNG),
            }],
        )
        .unwrap();
        assert_eq!(count, 1);
        assert_eq!(fs::read(temp.path().join("Creature.png")).unwrap(), PNG);
    }

    #[test]
    fn refuses_traversal_and_wrong_signatures() {
        let temp = tempfile::tempdir().unwrap();
        assert!(write_icon_batch(
            temp.path(),
            vec![PackageIconWrite {
                name: "../Creature.png".into(),
                content_b64: STANDARD.encode(PNG),
            }],
        )
        .is_err());
        assert!(write_icon_batch(
            temp.path(),
            vec![PackageIconWrite {
                name: "Creature.jpg".into(),
                content_b64: STANDARD.encode(PNG),
            }],
        )
        .is_err());
    }
}
