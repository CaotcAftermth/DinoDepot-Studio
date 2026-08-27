use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::project_io::write_atomic;

const MAX_PACKAGE_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    path: String,
    sha256: String,
    size: usize,
    #[serde(default)]
    blob: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageManifest {
    format: String,
    format_version: u32,
    kind: String,
    package_id: String,
    version: String,
    content: ManifestFile,
    #[serde(default)]
    assets: Vec<ManifestFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageLibraryFile {
    path: String,
    content_b64: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInstallInfo {
    kind: String,
    package_id: String,
    version: String,
    path: String,
    installed_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageReadResult {
    manifest_json: String,
    content_json: String,
    info: PackageInstallInfo,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPackageRegistry {
    #[serde(default = "registry_version")]
    schema_version: u32,
    #[serde(default)]
    packages: Vec<PackageInstallInfo>,
}

fn registry_version() -> u32 {
    1
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('.')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
}

fn safe_relative(path: &str) -> bool {
    if path.is_empty() || path.contains('\\') || path.contains(':') {
        return false;
    }
    Path::new(path)
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
}

fn image_extension(path: &str) -> Option<&'static str> {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())?;
    if extension.eq_ignore_ascii_case("webp") {
        Some("webp")
    } else if extension.eq_ignore_ascii_case("png") {
        Some("png")
    } else {
        None
    }
}

fn image_signature_matches(path: &str, bytes: &[u8]) -> bool {
    match image_extension(path) {
        Some("webp") => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        Some("png") => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        _ => false,
    }
}

fn canonical_public_blob(file: &ManifestFile) -> Option<String> {
    let extension = image_extension(&file.path)?;
    let hash = file.sha256.to_ascii_lowercase();
    Some(format!(
        "assets/sha256/{}/{}.{}",
        &hash[0..2],
        hash,
        extension
    ))
}

fn local_blob_target(root: &Path, file: &ManifestFile) -> Result<PathBuf, String> {
    let extension = image_extension(&file.path)
        .ok_or_else(|| format!("Package asset '{}' is not an image", file.path))?;
    let hash = file.sha256.to_ascii_lowercase();
    Ok(root
        .join("blobs")
        .join("sha256")
        .join(&hash[0..2])
        .join(format!("{hash}.{extension}")))
}

fn parse_manifest(text: &str) -> Result<PackageManifest, String> {
    let manifest: PackageManifest =
        serde_json::from_str(text).map_err(|e| format!("Package manifest is invalid: {e}"))?;
    if manifest.format != "dinodepot.package" || !matches!(manifest.format_version, 2 | 3 | 4) {
        return Err("Unsupported package manifest format".into());
    }
    if !matches!(manifest.kind.as_str(), "modpack" | "official") {
        return Err("Package kind must be modpack or official".into());
    }
    if manifest.kind == "official" && manifest.package_id != "official-asa" {
        return Err("Official packages must use the official-asa identity".into());
    }
    if !safe_segment(&manifest.package_id) || !safe_segment(&manifest.version) {
        return Err("Package ID or version is not safe for storage".into());
    }
    if manifest.content.path != "content.json" {
        return Err("Package content must be content.json".into());
    }
    if manifest.format_version == 4 && !manifest.assets.is_empty() {
        return Err("Package v4 is data-only and cannot contain assets".into());
    }

    let mut seen = HashSet::new();
    if manifest.content.blob.is_some() {
        return Err("Package content cannot be stored as an image blob".into());
    }
    for file in std::iter::once(&manifest.content).chain(manifest.assets.iter()) {
        if !safe_relative(&file.path) || !valid_sha256(&file.sha256) {
            return Err(format!("Package file '{}' is invalid", file.path));
        }
        if file.path != "content.json" && !file.path.starts_with("assets/") {
            return Err(format!("Package asset '{}' is outside assets/", file.path));
        }
        if file.path.starts_with("assets/") && image_extension(&file.path).is_none() {
            return Err(format!(
                "Package asset '{}' is not a WebP or PNG image",
                file.path
            ));
        }
        if file.path.starts_with("assets/") {
            match manifest.format_version {
                2 if file.blob.is_some() => {
                    return Err("Package v2 assets cannot declare blob paths".into());
                }
                3 if file.blob.as_deref() != canonical_public_blob(file).as_deref() => {
                    return Err(format!(
                        "Package asset '{}' has a non-canonical blob path",
                        file.path
                    ));
                }
                _ => {}
            }
        }
        if !seen.insert(file.path.to_ascii_lowercase()) {
            return Err(format!("Package file '{}' is duplicated", file.path));
        }
    }
    Ok(manifest)
}

fn package_target(root: &Path, manifest: &PackageManifest) -> PathBuf {
    match manifest.kind.as_str() {
        "official" => root.join("official").join("asa").join(&manifest.version),
        _ => root
            .join("modpacks")
            .join(&manifest.package_id)
            .join(&manifest.version),
    }
}

fn expected_files(manifest: &PackageManifest) -> HashMap<String, ManifestFile> {
    std::iter::once(manifest.content.clone())
        .chain(manifest.assets.iter().cloned())
        .map(|file| (file.path.clone(), file))
        .collect()
}

fn required_files(manifest: &PackageManifest) -> HashMap<String, ManifestFile> {
    // Package v2/v3 artwork is quarantined compatibility input. Content stays
    // installable after those optional binaries have been removed.
    if manifest.format_version < 4 {
        [(manifest.content.path.clone(), manifest.content.clone())]
            .into_iter()
            .collect()
    } else {
        expected_files(manifest)
    }
}

fn installed_is_valid(target: &Path, manifest_json: &str, manifest: &PackageManifest) -> bool {
    if fs::read_to_string(target.join("manifest.json"))
        .ok()
        .as_deref()
        != Some(manifest_json)
    {
        return false;
    }
    required_files(manifest).values().all(|expected| {
        fs::read(target.join(&expected.path)).is_ok_and(|bytes| {
            bytes.len() == expected.size
                && sha256_hex(&bytes).eq_ignore_ascii_case(&expected.sha256)
                && (!expected.path.starts_with("assets/")
                    || image_signature_matches(&expected.path, &bytes))
        })
    })
}

fn installed_is_self_consistent(target: &Path) -> bool {
    let Ok(manifest_json) = fs::read_to_string(target.join("manifest.json")) else {
        return false;
    };
    let Ok(manifest) = parse_manifest(&manifest_json) else {
        return false;
    };
    installed_is_valid(target, &manifest_json, &manifest)
}

fn ensure_local_blob(root: &Path, record: &ManifestFile, bytes: &[u8]) -> Result<PathBuf, String> {
    let target = local_blob_target(root, record)?;
    let existing_is_valid = fs::read(&target).is_ok_and(|existing| {
        existing.len() == record.size
            && sha256_hex(&existing).eq_ignore_ascii_case(&record.sha256)
            && image_signature_matches(&record.path, &existing)
    });
    if !existing_is_valid {
        write_atomic(&target, bytes)?;
    }
    Ok(target)
}

fn link_blob(blob: &Path, logical: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = logical.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    match fs::hard_link(blob, logical) {
        Ok(()) => Ok(()),
        // App data and its blob store normally share a filesystem. A copy is a
        // safe fallback for filesystems or policies that disallow hard links.
        Err(_) => write_atomic(logical, bytes),
    }
}

fn install_at(
    root: &Path,
    manifest_json: &str,
    manifest_integrity: &str,
    files: Vec<PackageLibraryFile>,
) -> Result<PackageInstallInfo, String> {
    let mut decoded = Vec::with_capacity(files.len());
    for file in files {
        let bytes = STANDARD
            .decode(&file.content_b64)
            .map_err(|_| format!("Package file '{}' is not valid base64", file.path))?;
        decoded.push((file.path, bytes));
    }
    install_bytes(root, manifest_json, manifest_integrity, decoded)
}

/// The install itself, once the bytes are in hand however they arrived.
///
/// Downloads reach this through base64 over IPC; the bundled package reaches
/// it straight off disk. Both verify identically — every file is checked
/// against the size and SHA-256 its manifest pins, and images against their
/// own signature — so "it shipped with us" buys no trust at all.
fn install_bytes(
    root: &Path,
    manifest_json: &str,
    manifest_integrity: &str,
    files: Vec<(String, Vec<u8>)>,
) -> Result<PackageInstallInfo, String> {
    let manifest = parse_manifest(manifest_json)?;
    if !manifest_integrity.is_empty()
        && !sha256_hex(manifest_json.as_bytes()).eq_ignore_ascii_case(manifest_integrity)
    {
        return Err("Package manifest failed its integrity check".into());
    }
    let expected = expected_files(&manifest);
    let mut supplied = HashMap::new();
    let mut total = 0usize;
    for (path, bytes) in files {
        if manifest.format_version < 4 && path.starts_with("assets/") {
            // Legacy artwork is quarantined input. Ignore supplied bytes even
            // when present so a compatibility import can only install data.
            continue;
        }
        if !expected.contains_key(&path) || supplied.contains_key(&path) {
            return Err(format!("Unexpected or duplicate package file '{path}'"));
        }
        let record = &expected[&path];
        if bytes.len() != record.size || !sha256_hex(&bytes).eq_ignore_ascii_case(&record.sha256) {
            return Err(format!("Package file '{path}' failed its integrity check"));
        }
        if path.starts_with("assets/") && !image_signature_matches(&path, &bytes) {
            return Err(format!(
                "Package image '{path}' does not match its PNG/WebP extension"
            ));
        }
        total = total.saturating_add(bytes.len());
        if total > MAX_PACKAGE_BYTES {
            return Err("Package is larger than 256 MB".into());
        }
        supplied.insert(path, bytes);
    }
    let required = required_files(&manifest);
    let missing: Vec<_> = required
        .keys()
        .filter(|path| !supplied.contains_key(*path))
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(format!("Package is incomplete: {}", missing.join(", ")));
    }

    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let target = package_target(root, &manifest);
    if target.is_dir() && installed_is_valid(&target, manifest_json, &manifest) {
        return Ok(PackageInstallInfo {
            kind: manifest.kind,
            package_id: manifest.package_id,
            version: manifest.version,
            path: target.to_string_lossy().to_string(),
            installed_at: "already-installed".into(),
        });
    }
    if target.is_dir() && installed_is_self_consistent(&target) {
        return Err(format!(
            "Immutable package {}@{} is already installed with different bytes",
            manifest.package_id, manifest.version
        ));
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let staging = root.join(".staging").join(format!(
        "{}-{}-{}-{stamp}",
        manifest.package_id,
        manifest.version,
        std::process::id()
    ));
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    if let Err(error) = write_atomic(&staging.join("manifest.json"), manifest_json.as_bytes()) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    for (path, bytes) in supplied {
        let record = &expected[&path];
        let result = if manifest.format_version == 3 && path.starts_with("assets/") {
            ensure_local_blob(root, record, &bytes)
                .and_then(|blob| link_blob(&blob, &staging.join(&path), &bytes))
        } else {
            write_atomic(&staging.join(&path), &bytes)
        };
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    }
    if !installed_is_valid(&staging, manifest_json, &manifest) {
        let _ = fs::remove_dir_all(&staging);
        return Err("Staged package did not verify after writing".into());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if target.exists() {
        // A corrupt copy is reconstructable cache data. Its exact target has
        // already been derived from validated package identity.
        fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    fs::rename(&staging, &target).map_err(|e| e.to_string())?;

    Ok(PackageInstallInfo {
        kind: manifest.kind,
        package_id: manifest.package_id,
        version: manifest.version,
        path: target.to_string_lossy().to_string(),
        installed_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Reads a package straight from a folder on disk, verifying as it goes.
///
/// The bundled official package is thousands of files. Carrying them through
/// IPC meant one round trip per file, base64 in both directions, and the whole
/// library held in the webview's memory before a single byte was written —
/// seconds of it on first launch, for files that were already on this disk.
fn install_from_disk(root: &Path, manifest_path: &Path) -> Result<PackageInstallInfo, String> {
    let manifest_json = fs::read_to_string(manifest_path)
        .map_err(|e| format!("Could not read the bundled package manifest: {e}"))?;
    let manifest = parse_manifest(&manifest_json)?;
    let dir = manifest_path
        .parent()
        .ok_or("The bundled package manifest has no folder")?;
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total = 0usize;
    // Package v2/v3 artwork remains quarantined even when the source files are
    // present. Data-only v4 has no assets, so every format reads content only.
    for record in std::iter::once(&manifest.content) {
        let stored = record.path.as_str();
        if !safe_relative(stored) {
            return Err(format!(
                "Package file '{stored}' is not a safe relative path"
            ));
        }
        let bytes = fs::read(dir.join(stored))
            .map_err(|error| format!("Could not read package file '{stored}': {error}"))?;
        total = total.saturating_add(bytes.len());
        if total > MAX_PACKAGE_BYTES {
            return Err("Package is larger than 256 MB".into());
        }
        files.push((record.path.clone(), bytes));
    }

    // Integrity is checked per file by `install_bytes`, and the manifest
    // itself is checked against the project's pin once the caller reads the
    // installed copy back.
    install_bytes(root, &manifest_json, "", files)
}

/// Installs the official package this build shipped with, without moving a
/// single byte through IPC. `None` when the build carries no such resource.
#[tauri::command]
pub fn package_library_install_bundled(
    app: tauri::AppHandle,
    version: String,
) -> Result<Option<PackageInstallInfo>, String> {
    if !safe_segment(&version) {
        return Err("Package version is not safe for storage".into());
    }
    let Ok(resources) = app.path().resource_dir() else {
        return Ok(None);
    };
    let Some(manifest_path) = bundled_manifest_in(&resources, &version) else {
        return Ok(None);
    };
    let root = library_root(&app)?;
    let info = install_from_disk(&root, &manifest_path)?;
    update_registry(&root, info.clone())?;
    Ok(Some(info))
}

fn registry_path(root: &Path) -> PathBuf {
    root.join("registry.json")
}

fn update_registry(root: &Path, info: PackageInstallInfo) -> Result<(), String> {
    let path = registry_path(root);
    let mut registry = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<LocalPackageRegistry>(&text).ok())
        .unwrap_or_default();
    registry.packages.retain(|entry| {
        !(entry.kind == info.kind
            && entry.package_id == info.package_id
            && entry.version == info.version)
    });
    registry.packages.push(info);
    registry.packages.sort_by(|a, b| {
        (&a.kind, &a.package_id, &a.version).cmp(&(&b.kind, &b.package_id, &b.version))
    });
    let text = serde_json::to_string_pretty(&registry).map_err(|e| e.to_string())?;
    write_atomic(&path, format!("{text}\n").as_bytes())
}

fn library_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("content"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn package_library_install(
    app: tauri::AppHandle,
    manifest_json: String,
    manifest_integrity: String,
    files: Vec<PackageLibraryFile>,
) -> Result<PackageInstallInfo, String> {
    let root = library_root(&app)?;
    let info = install_at(&root, &manifest_json, &manifest_integrity, files)?;
    update_registry(&root, info.clone())?;
    Ok(info)
}

#[tauri::command]
pub fn package_library_list(app: tauri::AppHandle) -> Result<Vec<PackageInstallInfo>, String> {
    let root = library_root(&app)?;
    let registry = fs::read_to_string(registry_path(&root))
        .ok()
        .and_then(|text| serde_json::from_str::<LocalPackageRegistry>(&text).ok())
        .unwrap_or_default();
    Ok(registry
        .packages
        .into_iter()
        .filter(|entry| Path::new(&entry.path).join("manifest.json").is_file())
        .collect())
}

fn read_at(
    root: &Path,
    kind: &str,
    package_id: &str,
    version: &str,
) -> Result<Option<PackageReadResult>, String> {
    if !matches!(kind, "modpack" | "official")
        || !safe_segment(package_id)
        || !safe_segment(version)
    {
        return Err("Package identity is not safe for storage".into());
    }
    let requested = PackageManifest {
        format: "dinodepot.package".into(),
        format_version: 2,
        kind: kind.into(),
        package_id: package_id.into(),
        version: version.into(),
        content: ManifestFile {
            path: "content.json".into(),
            sha256: String::new(),
            size: 0,
            blob: None,
        },
        assets: vec![],
    };
    let target = package_target(root, &requested);
    if !target.is_dir() {
        return Ok(None);
    }
    let manifest_json =
        fs::read_to_string(target.join("manifest.json")).map_err(|error| error.to_string())?;
    let manifest = parse_manifest(&manifest_json)?;
    if manifest.kind != kind
        || manifest.package_id != package_id
        || manifest.version != version
        || !installed_is_valid(&target, &manifest_json, &manifest)
    {
        return Err(format!(
            "Installed package {package_id}@{version} failed verification"
        ));
    }
    let content_json = fs::read_to_string(target.join(&manifest.content.path))
        .map_err(|error| error.to_string())?;
    Ok(Some(PackageReadResult {
        manifest_json,
        content_json,
        info: PackageInstallInfo {
            kind: manifest.kind,
            package_id: manifest.package_id,
            version: manifest.version,
            path: target.to_string_lossy().to_string(),
            installed_at: "installed".into(),
        },
    }))
}

#[tauri::command]
pub fn package_library_read(
    app: tauri::AppHandle,
    kind: String,
    package_id: String,
    version: String,
) -> Result<Option<PackageReadResult>, String> {
    read_at(&library_root(&app)?, &kind, &package_id, &version)
}

/// Absolute path of the bundled official package manifest for one exact
/// version, or `None` when this build does not carry it.
///
/// Only the path is returned. The bytes still travel through the same
/// download-and-verify path every other package uses, so a tampered resource
/// fails the identical integrity check rather than a weaker "it shipped with
/// us, so trust it" one.
#[tauri::command]
pub fn package_bundled_manifest(
    app: tauri::AppHandle,
    version: String,
) -> Result<Option<String>, String> {
    if !safe_segment(&version) {
        return Err("Package version is not safe for storage".into());
    }
    let Ok(resources) = app.path().resource_dir() else {
        return Ok(None);
    };
    Ok(bundled_manifest_in(&resources, &version).map(|path| path.to_string_lossy().to_string()))
}

/// Both layouts a directory resource can land in.
///
/// Whether the bundler copies the mapped directory's *contents* or the
/// directory itself differs by target, and guessing wrong turns the bundled
/// package into a silent no-op. Checking both costs one `is_file`.
fn bundled_manifest_in(resources: &Path, version: &str) -> Option<PathBuf> {
    let root = resources.join("official-package");
    [
        root.join(version).join("manifest.json"),
        root.join("versions").join(version).join("manifest.json"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (String, Vec<PackageLibraryFile>) {
        let content = br#"{"format":"dinodepot.package-content","schemaVersion":1}"#;
        let hash = sha256_hex(content);
        let manifest = format!(
            r#"{{"format":"dinodepot.package","formatVersion":2,"kind":"modpack","packageId":"test-pack","version":"1.0.0","meta":{{"name":"Test"}},"content":{{"path":"content.json","sha256":"{hash}","size":{},"mediaType":"application/json"}},"assets":[]}}"#,
            content.len()
        );
        (
            manifest,
            vec![PackageLibraryFile {
                path: "content.json".into(),
                content_b64: STANDARD.encode(content),
            }],
        )
    }

    /// A package laid out on disk the way a published one is, for the
    /// bundled-resource install path.
    fn on_disk_fixture(dir: &Path, format_version: u32) -> PathBuf {
        // 1x1 WebP, so the image-signature check has something real to accept.
        let webp = {
            let mut bytes = b"RIFF".to_vec();
            bytes.extend_from_slice(&[0, 0, 0, 0]);
            bytes.extend_from_slice(b"WEBP");
            bytes.extend_from_slice(b"VP8 padding");
            bytes
        };
        let content = br#"{"format":"dinodepot.package-content","schemaVersion":1}"#;
        let asset_hash = sha256_hex(&webp);
        let blob = format!("assets/sha256/{}/{asset_hash}.webp", &asset_hash[..2]);
        let stored = if format_version == 3 {
            blob.clone()
        } else {
            "assets/creatures/Rex.webp".to_string()
        };
        // A v2 manifest may not declare a blob path at all, so the two shapes
        // differ by more than where the bytes sit.
        let blob_field = if format_version == 3 {
            format!(r#""blob":"{blob}","#)
        } else {
            String::new()
        };
        let manifest = format!(
            r#"{{"format":"dinodepot.package","formatVersion":{format_version},"kind":"official","packageId":"official-asa","version":"1.1.0","meta":{{"name":"Official"}},"content":{{"path":"content.json","sha256":"{}","size":{},"mediaType":"application/json"}},"assets":[{{"path":"assets/creatures/Rex.webp",{blob_field}"sha256":"{asset_hash}","size":{},"mediaType":"image/webp"}}]}}"#,
            sha256_hex(content),
            content.len(),
            webp.len()
        );

        let version_dir = dir.join("versions").join("1.1.0");
        fs::create_dir_all(&version_dir).unwrap();
        fs::write(version_dir.join("manifest.json"), &manifest).unwrap();
        fs::write(version_dir.join("content.json"), content).unwrap();
        let asset_path = if format_version == 3 {
            dir.join(&stored)
        } else {
            version_dir.join(&stored)
        };
        fs::create_dir_all(asset_path.parent().unwrap()).unwrap();
        fs::write(&asset_path, &webp).unwrap();
        version_dir.join("manifest.json")
    }

    #[test]
    fn installs_a_bundled_package_from_disk_in_both_formats() {
        for format_version in [2, 3] {
            let source = tempfile::tempdir().unwrap();
            let library = tempfile::tempdir().unwrap();
            let manifest_path = on_disk_fixture(source.path(), format_version);
            let info = install_from_disk(library.path(), &manifest_path).unwrap();
            let installed = Path::new(&info.path);
            assert!(installed.join("content.json").is_file());
            assert!(!installed.join("assets/creatures/Rex.webp").exists());
            assert_eq!(info.package_id, "official-asa");
        }
    }

    #[test]
    fn refuses_a_bundled_file_whose_bytes_changed() {
        // "It shipped with us" buys no trust: a tampered resource has to fail
        // the same integrity check a download would.
        let source = tempfile::tempdir().unwrap();
        let library = tempfile::tempdir().unwrap();
        let manifest_path = on_disk_fixture(source.path(), 3);
        fs::write(
            manifest_path.parent().unwrap().join("content.json"),
            b"tampered",
        )
        .unwrap();
        assert!(install_from_disk(library.path(), &manifest_path).is_err());
    }

    #[test]
    fn installs_and_reuses_an_exact_immutable_version() {
        let temp = tempfile::tempdir().unwrap();
        let (manifest, files) = fixture();
        let first = install_at(temp.path(), &manifest, "", files).unwrap();
        assert!(Path::new(&first.path).join("content.json").is_file());

        let (_, files) = fixture();
        let second = install_at(temp.path(), &manifest, "", files).unwrap();
        assert_eq!(second.installed_at, "already-installed");
        assert_eq!(first.path, second.path);
    }

    #[test]
    fn refuses_incomplete_or_changed_content() {
        let temp = tempfile::tempdir().unwrap();
        let (manifest, _) = fixture();
        assert!(install_at(temp.path(), &manifest, "", vec![]).is_err());
        assert!(install_at(
            temp.path(),
            &manifest,
            "",
            vec![PackageLibraryFile {
                path: "content.json".into(),
                content_b64: STANDARD.encode(b"changed"),
            }],
        )
        .is_err());
    }

    #[test]
    fn quarantines_supplied_legacy_package_images() {
        let temp = tempfile::tempdir().unwrap();
        let content = br#"{"format":"dinodepot.package-content","schemaVersion":1}"#;
        let image = b"not a png";
        let content_hash = sha256_hex(content);
        let image_hash = sha256_hex(image);
        let manifest = format!(
            r#"{{"format":"dinodepot.package","formatVersion":2,"kind":"modpack","packageId":"test-pack","version":"1.0.0","meta":{{"name":"Test"}},"content":{{"path":"content.json","sha256":"{content_hash}","size":{},"mediaType":"application/json"}},"assets":[{{"path":"assets/Icon.png","sha256":"{image_hash}","size":{},"mediaType":"image/png"}}]}}"#,
            content.len(),
            image.len()
        );
        let installed = install_at(
            temp.path(),
            &manifest,
            "",
            vec![
                PackageLibraryFile {
                    path: "content.json".into(),
                    content_b64: STANDARD.encode(content),
                },
                PackageLibraryFile {
                    path: "assets/Icon.png".into(),
                    content_b64: STANDARD.encode(image),
                },
            ],
        )
        .unwrap();
        assert!(!Path::new(&installed.path).join("assets/Icon.png").exists());

        assert!(parse_manifest(&manifest.replace("Icon.png", "Icon.jpg")).is_err());
    }

    #[test]
    fn reads_only_a_verified_exact_identity() {
        let temp = tempfile::tempdir().unwrap();
        let (manifest, files) = fixture();
        install_at(temp.path(), &manifest, "", files).unwrap();

        let read = read_at(temp.path(), "modpack", "test-pack", "1.0.0")
            .unwrap()
            .unwrap();
        assert!(read.content_json.contains("package-content"));
        assert!(read_at(temp.path(), "modpack", "test-pack", "2.0.0")
            .unwrap()
            .is_none());
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture bytes";

    fn asset_fixture(version: &str) -> (String, Vec<PackageLibraryFile>) {
        let content = br#"{"format":"dinodepot.package-content","schemaVersion":1}"#;
        let manifest = format!(
            r#"{{"format":"dinodepot.package","formatVersion":2,"kind":"official","packageId":"official-asa","version":"{version}","meta":{{"name":"Core"}},"content":{{"path":"content.json","sha256":"{}","size":{},"mediaType":"application/json"}},"assets":[{{"path":"assets/creatures/Achatina.png","sha256":"{}","size":{},"mediaType":"image/png"}}]}}"#,
            sha256_hex(content),
            content.len(),
            sha256_hex(PNG),
            PNG.len()
        );
        (
            manifest,
            vec![
                PackageLibraryFile {
                    path: "content.json".into(),
                    content_b64: STANDARD.encode(content),
                },
                PackageLibraryFile {
                    path: "assets/creatures/Achatina.png".into(),
                    content_b64: STANDARD.encode(PNG),
                },
            ],
        )
    }

    fn v3_asset_fixture(version: &str) -> (String, Vec<PackageLibraryFile>) {
        let content = br#"{"format":"dinodepot.package-content","schemaVersion":1}"#;
        let image_hash = sha256_hex(PNG);
        let blob = format!("assets/sha256/{}/{}.png", &image_hash[0..2], image_hash);
        let manifest = format!(
            r#"{{"format":"dinodepot.package","formatVersion":3,"kind":"official","packageId":"official-asa","version":"{version}","meta":{{"name":"Core"}},"content":{{"path":"content.json","sha256":"{}","size":{},"mediaType":"application/json"}},"assets":[{{"path":"assets/creatures/Achatina.png","blob":"{blob}","sha256":"{}","size":{},"mediaType":"image/png"}}]}}"#,
            sha256_hex(content),
            content.len(),
            image_hash,
            PNG.len()
        );
        (
            manifest,
            vec![
                PackageLibraryFile {
                    path: "content.json".into(),
                    content_b64: STANDARD.encode(content),
                },
                PackageLibraryFile {
                    path: "assets/creatures/Achatina.png".into(),
                    content_b64: STANDARD.encode(PNG),
                },
            ],
        )
    }

    #[test]
    fn finds_the_bundled_manifest_in_either_resource_layout() {
        let temp = tempfile::tempdir().unwrap();
        let flat = temp.path().join("official-package/1.0.0");
        fs::create_dir_all(&flat).unwrap();
        fs::write(flat.join("manifest.json"), "{}").unwrap();
        assert_eq!(
            bundled_manifest_in(temp.path(), "1.0.0"),
            Some(flat.join("manifest.json"))
        );
        assert_eq!(bundled_manifest_in(temp.path(), "9.9.9"), None);

        let nested = temp.path().join("official-package/versions/2.0.0");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("manifest.json"), "{}").unwrap();
        assert_eq!(
            bundled_manifest_in(temp.path(), "2.0.0"),
            Some(nested.join("manifest.json"))
        );
    }

    #[test]
    fn legacy_install_keeps_nested_assets_out_of_managed_storage() {
        let temp = tempfile::tempdir().unwrap();
        let (manifest, files) = asset_fixture("1.0.0");
        let info = install_at(temp.path(), &manifest, "", files).unwrap();

        let icon = Path::new(&info.path).join("assets/creatures/Achatina.png");
        assert!(!icon.exists());
        assert!(Path::new(&info.path).join("content.json").is_file());
        assert!(info.path.replace('\\', "/").contains("/official/asa/1.0.0"));
    }

    #[test]
    fn v3_versions_never_promote_legacy_artwork_into_the_blob_store() {
        let temp = tempfile::tempdir().unwrap();
        let (first_manifest, first_files) = v3_asset_fixture("1.0.0");
        let (second_manifest, second_files) = v3_asset_fixture("1.0.1");
        let first = install_at(temp.path(), &first_manifest, "", first_files).unwrap();
        let second = install_at(temp.path(), &second_manifest, "", second_files).unwrap();

        let hash = sha256_hex(PNG);
        let blob = temp
            .path()
            .join("blobs/sha256")
            .join(&hash[0..2])
            .join(format!("{hash}.png"));
        assert!(!blob.exists());
        assert!(!Path::new(&first.path)
            .join("assets/creatures/Achatina.png")
            .exists());
        assert!(!Path::new(&second.path)
            .join("assets/creatures/Achatina.png")
            .exists());
    }

    #[test]
    fn v3_rejects_a_blob_path_that_does_not_match_its_hash() {
        let (manifest, _) = v3_asset_fixture("1.0.0");
        let changed = manifest.replace("assets/sha256/", "assets/sha256/ff/");
        assert!(parse_manifest(&changed).is_err());
    }

    #[test]
    fn two_exact_versions_coexist_without_touching_each_other() {
        let temp = tempfile::tempdir().unwrap();
        let (first_manifest, first_files) = asset_fixture("1.0.0");
        let (second_manifest, second_files) = asset_fixture("1.0.1");
        let first = install_at(temp.path(), &first_manifest, "", first_files).unwrap();
        let second = install_at(temp.path(), &second_manifest, "", second_files).unwrap();

        assert_ne!(first.path, second.path);
        assert!(Path::new(&first.path).join("manifest.json").is_file());
        assert!(Path::new(&second.path).join("manifest.json").is_file());
        assert!(read_at(temp.path(), "official", "official-asa", "1.0.0")
            .unwrap()
            .is_some());
        assert!(read_at(temp.path(), "official", "official-asa", "1.0.1")
            .unwrap()
            .is_some());
    }

    #[test]
    fn rejects_a_manifest_whose_integrity_pin_does_not_match() {
        let temp = tempfile::tempdir().unwrap();
        let (manifest, files) = fixture();
        let wrong = "a".repeat(64);
        assert!(install_at(temp.path(), &manifest, &wrong, files)
            .unwrap_err()
            .contains("integrity"));

        let (manifest, files) = fixture();
        let right = sha256_hex(manifest.as_bytes());
        assert!(install_at(temp.path(), &manifest, &right, files).is_ok());
    }

    #[test]
    fn refuses_traversal_and_absolute_package_paths() {
        for bad in [
            "../escape.png",
            "assets/../../escape.png",
            "/absolute.png",
            "C:/absolute.png",
            "assets\\backslash.png",
        ] {
            assert!(!safe_relative(bad), "{bad} should not be a safe path");
        }
        assert!(safe_relative("assets/creatures/Achatina.png"));
        assert!(safe_relative("assets/Acrocanthosaurus (mod).webp"));
    }

    #[test]
    fn never_replaces_a_valid_immutable_version_with_different_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let (manifest, files) = fixture();
        install_at(temp.path(), &manifest, "", files).unwrap();

        let changed = br#"{"format":"dinodepot.package-content","schemaVersion":1,"changed":true}"#;
        let hash = sha256_hex(changed);
        let changed_manifest = format!(
            r#"{{"format":"dinodepot.package","formatVersion":2,"kind":"modpack","packageId":"test-pack","version":"1.0.0","meta":{{"name":"Test"}},"content":{{"path":"content.json","sha256":"{hash}","size":{},"mediaType":"application/json"}},"assets":[]}}"#,
            changed.len()
        );
        let result = install_at(
            temp.path(),
            &changed_manifest,
            "",
            vec![PackageLibraryFile {
                path: "content.json".into(),
                content_b64: STANDARD.encode(changed),
            }],
        );

        assert!(result.unwrap_err().contains("Immutable package"));
        assert_eq!(
            fs::read_to_string(temp.path().join("modpacks/test-pack/1.0.0/content.json")).unwrap(),
            r#"{"format":"dinodepot.package-content","schemaVersion":1}"#
        );
    }
}
