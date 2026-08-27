use super::failure::{Failure, Outcome};
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const ASSET_CACHE_DIR: &str = "asset-cache";
const REGISTRY_CACHE_DIR: &str = "registry-cache";
const ASSET_ORIGIN: &str = "https://assets.dinodepot.app";
const MAX_ASSET_BYTES: u64 = 1_048_576;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetIndexEntry {
    asset_version: u64,
    sha256: String,
    file: String,
    last_rights_verified_at: i64,
}

#[derive(Default, Deserialize, Serialize)]
struct AssetIndex {
    entries: BTreeMap<String, AssetIndexEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCacheResult {
    path: String,
    cached: bool,
    asset_version: u64,
    sha256: String,
    last_rights_verified_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryCacheRecord {
    body: serde_json::Value,
    etag: String,
    fetched_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryFetchResult {
    status: u16,
    body: Option<serde_json::Value>,
    etag: String,
}

#[derive(Default, Deserialize, Serialize)]
struct RegistryIndex {
    entries: BTreeMap<String, RegistryCacheRecord>,
}

fn app_data(app: &tauri::AppHandle) -> Outcome<PathBuf> {
    app.path().app_data_dir().map_err(|error| {
        Failure::new(
            "unknown",
            "Could not find application data storage.",
            error.to_string(),
        )
    })
}

fn cache_root(app: &tauri::AppHandle) -> Outcome<PathBuf> {
    let root = app_data(app)?.join(ASSET_CACHE_DIR);
    fs::create_dir_all(root.join("files")).map_err(|error| {
        Failure::new(
            "save.failed",
            "The asset cache could not be created.",
            error.to_string(),
        )
    })?;
    Ok(root)
}

fn registry_root(app: &tauri::AppHandle) -> Outcome<PathBuf> {
    let root = app_data(app)?.join(REGISTRY_CACHE_DIR);
    fs::create_dir_all(&root).map_err(|error| {
        Failure::new(
            "save.failed",
            "The registry cache could not be created.",
            error.to_string(),
        )
    })?;
    Ok(root)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn valid_icon_key(value: &str) -> bool {
    let parts: Vec<_> = value.split(':').collect();
    if parts.len() < 3 || parts.len() > 4 {
        return false;
    }
    parts.iter().all(|part| {
        !part.is_empty()
            && part.len() <= 96
            && part
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch))
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Outcome<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        Failure::new(
            "save.failed",
            "Cache metadata could not be encoded.",
            error.to_string(),
        )
    })?;
    super::project_io::write_atomic(path, &bytes)
        .map_err(|detail| Failure::new("save.failed", "Cache metadata could not be saved.", detail))
}

fn asset_index_path(root: &Path) -> PathBuf {
    root.join("index.json")
}

fn cached_result(root: &Path, entry: &AssetIndexEntry) -> AssetCacheResult {
    AssetCacheResult {
        path: root.join(&entry.file).to_string_lossy().to_string(),
        cached: true,
        asset_version: entry.asset_version,
        sha256: entry.sha256.clone(),
        last_rights_verified_at: entry.last_rights_verified_at,
    }
}

fn miss(asset_version: u64, sha256: String) -> AssetCacheResult {
    AssetCacheResult {
        path: String::new(),
        cached: false,
        asset_version,
        sha256,
        last_rights_verified_at: 0,
    }
}

fn verify_webp(bytes: &[u8], expected_sha256: &str) -> Outcome<()> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err(Failure::new(
            "unknown",
            "The reference asset is not WebP.",
            "invalid WebP signature",
        ));
    }
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected_sha256 {
        return Err(Failure::new(
            "unknown",
            "The reference asset failed its integrity check.",
            format!("expected {expected_sha256}, received {actual}"),
        ));
    }
    let image =
        image::load_from_memory_with_format(bytes, image::ImageFormat::WebP).map_err(|error| {
            Failure::new(
                "unknown",
                "The reference asset could not be decoded.",
                error.to_string(),
            )
        })?;
    if image.dimensions() != (160, 160) {
        return Err(Failure::new(
            "unknown",
            "The reference asset has the wrong dimensions.",
            format!(
                "expected 160x160, received {}x{}",
                image.width(),
                image.height()
            ),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn asset_cache_get(
    app: tauri::AppHandle,
    icon_key: String,
    asset_version: u64,
    sha256: String,
) -> Result<AssetCacheResult, String> {
    get_asset(&app, &icon_key, asset_version, &sha256).map_err(|error| error.to_string())
}

fn get_asset(
    app: &tauri::AppHandle,
    icon_key: &str,
    asset_version: u64,
    sha256: &str,
) -> Outcome<AssetCacheResult> {
    if !valid_icon_key(icon_key) || !valid_sha256(sha256) {
        return Err(Failure::new(
            "unknown",
            "That is not a valid asset identity.",
            "invalid icon key or SHA-256",
        ));
    }
    let root = cache_root(app)?;
    let index_path = asset_index_path(&root);
    let mut index: AssetIndex = read_json(&index_path);
    let Some(entry) = index.entries.get_mut(icon_key) else {
        return Ok(miss(asset_version, sha256.to_string()));
    };
    if entry.asset_version != asset_version || entry.sha256 != sha256 {
        let stale = root.join(&entry.file);
        let _ = fs::remove_file(stale);
        index.entries.remove(icon_key);
        write_json(&index_path, &index)?;
        return Ok(miss(asset_version, sha256.to_string()));
    }
    let path = root.join(&entry.file);
    let valid = fs::read(&path)
        .ok()
        .map(|bytes| verify_webp(&bytes, sha256).is_ok())
        .unwrap_or(false);
    if !valid {
        let _ = fs::remove_file(path);
        index.entries.remove(icon_key);
        write_json(&index_path, &index)?;
        return Ok(miss(asset_version, sha256.to_string()));
    }
    entry.last_rights_verified_at = now_ms();
    let result = cached_result(&root, entry);
    write_json(&index_path, &index)?;
    Ok(result)
}

#[tauri::command]
pub async fn asset_cache_fetch_and_put(
    app: tauri::AppHandle,
    icon_key: String,
    asset_version: u64,
    sha256: String,
    url: String,
) -> Result<AssetCacheResult, String> {
    fetch_and_put(&app, &icon_key, asset_version, &sha256, &url)
        .await
        .map_err(|error| error.to_string())
}

async fn fetch_and_put(
    app: &tauri::AppHandle,
    icon_key: &str,
    asset_version: u64,
    sha256: &str,
    url: &str,
) -> Outcome<AssetCacheResult> {
    if !valid_icon_key(icon_key) || !valid_sha256(sha256) {
        return Err(Failure::new(
            "unknown",
            "That is not a valid asset identity.",
            "invalid icon key or SHA-256",
        ));
    }
    let parsed = url::Url::parse(url).map_err(|error| {
        Failure::new(
            "unknown",
            "That asset address is invalid.",
            error.to_string(),
        )
    })?;
    if parsed.origin().ascii_serialization() != ASSET_ORIGIN || !parsed.path().ends_with(".webp") {
        return Err(Failure::new(
            "unknown",
            "Reference assets must use the DDS asset service.",
            url.to_string(),
        ));
    }
    let response = reqwest::Client::builder()
        .user_agent(concat!("DinoDepotStudio/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| {
            Failure::new(
                "unknown",
                "Could not start the asset download.",
                error.to_string(),
            )
        })?
        .get(parsed)
        .send()
        .await
        .map_err(|error| {
            Failure::new(
                "network.offline",
                "The reference asset could not be downloaded.",
                error.to_string(),
            )
        })?;
    if !response.status().is_success() {
        return Err(Failure::new(
            "repo.unavailable",
            "The reference asset is unavailable.",
            format!("HTTP {}", response.status()),
        ));
    }
    if response.content_length().unwrap_or(0) > MAX_ASSET_BYTES {
        return Err(Failure::new(
            "unknown",
            "The reference asset is unexpectedly large.",
            "response exceeds 1 MiB",
        ));
    }
    let bytes = response.bytes().await.map_err(|error| {
        Failure::new(
            "network.offline",
            "The reference asset could not be read.",
            error.to_string(),
        )
    })?;
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err(Failure::new(
            "unknown",
            "The reference asset is unexpectedly large.",
            "response exceeds 1 MiB",
        ));
    }
    verify_webp(&bytes, sha256)?;

    let root = cache_root(app)?;
    let relative = format!("files/{}/{}.v{}.webp", &sha256[0..2], sha256, asset_version);
    let target = root.join(&relative);
    super::project_io::write_atomic(&target, &bytes).map_err(|detail| {
        Failure::new(
            "save.failed",
            "The reference asset could not be cached.",
            detail,
        )
    })?;
    let index_path = asset_index_path(&root);
    let mut index: AssetIndex = read_json(&index_path);
    if let Some(old) = index.entries.insert(
        icon_key.to_string(),
        AssetIndexEntry {
            asset_version,
            sha256: sha256.to_string(),
            file: relative,
            last_rights_verified_at: now_ms(),
        },
    ) {
        if old.sha256 != sha256 || old.asset_version != asset_version {
            let _ = fs::remove_file(root.join(old.file));
        }
    }
    write_json(&index_path, &index)?;
    Ok(cached_result(
        &root,
        index.entries.get(icon_key).expect("inserted entry"),
    ))
}

#[tauri::command]
pub fn asset_cache_purge(app: tauri::AppHandle, icon_key: String) -> Result<bool, String> {
    purge_asset(&app, &icon_key).map_err(|error| error.to_string())
}

fn purge_asset(app: &tauri::AppHandle, icon_key: &str) -> Outcome<bool> {
    if !valid_icon_key(icon_key) {
        return Err(Failure::new(
            "unknown",
            "That is not a valid asset identity.",
            icon_key.to_string(),
        ));
    }
    let root = cache_root(app)?;
    let index_path = asset_index_path(&root);
    let mut index: AssetIndex = read_json(&index_path);
    let Some(entry) = index.entries.remove(icon_key) else {
        return Ok(false);
    };
    let _ = fs::remove_file(root.join(entry.file));
    write_json(&index_path, &index)?;
    Ok(true)
}

fn valid_registry_key(key: &str) -> bool {
    key == "/registry/index.json"
        || key == "/registry/official.json"
        || (key.starts_with("/registry/mods/")
            && key.ends_with(".json")
            && key[15..key.len() - 5].chars().all(|ch| ch.is_ascii_digit()))
}

#[tauri::command]
pub fn registry_cache_get(
    app: tauri::AppHandle,
    key: String,
) -> Result<Option<RegistryCacheRecord>, String> {
    if !valid_registry_key(&key) {
        return Err("Invalid registry cache key".to_string());
    }
    let root = registry_root(&app).map_err(|error| error.to_string())?;
    let index: RegistryIndex = read_json(&root.join("index.json"));
    Ok(index.entries.get(&key).cloned())
}

#[tauri::command]
pub fn registry_cache_put(
    app: tauri::AppHandle,
    key: String,
    value: RegistryCacheRecord,
) -> Result<(), String> {
    if !valid_registry_key(&key) {
        return Err("Invalid registry cache key".to_string());
    }
    let root = registry_root(&app).map_err(|error| error.to_string())?;
    let path = root.join("index.json");
    let mut index: RegistryIndex = read_json(&path);
    index.entries.insert(key, value);
    write_json(&path, &index).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn registry_cache_delete(app: tauri::AppHandle, key: String) -> Result<(), String> {
    if !valid_registry_key(&key) {
        return Err("Invalid registry cache key".to_string());
    }
    let root = registry_root(&app).map_err(|error| error.to_string())?;
    let path = root.join("index.json");
    let mut index: RegistryIndex = read_json(&path);
    index.entries.remove(&key);
    write_json(&path, &index).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn registry_fetch(path: String, etag: String) -> Result<RegistryFetchResult, String> {
    if !valid_registry_key(&path) {
        return Err("Invalid registry path".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("DinoDepotStudio/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.get(format!("{ASSET_ORIGIN}{path}"));
    if !etag.is_empty() {
        request = request.header("If-None-Match", &etag)
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    if response.status().as_u16() == 304 {
        return Ok(RegistryFetchResult {
            status: 304,
            body: None,
            etag,
        });
    }
    if !response.status().is_success() {
        return Err(format!("registry HTTP {}", response.status()));
    }
    if response.content_length().unwrap_or(0) > 2 * MAX_ASSET_BYTES {
        return Err("Registry response exceeds 2 MiB".to_string());
    }
    let response_etag = response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(RegistryFetchResult {
        status: 200,
        body: Some(body),
        etag: response_etag,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_and_registry_keys_are_bounded() {
        assert!(valid_icon_key("mod:123:creature:rex"));
        assert!(!valid_icon_key("mod:123:creature:../rex"));
        assert!(valid_registry_key("/registry/mods/123.json"));
        assert!(!valid_registry_key("/registry/mods/../private.json"));
    }

    #[test]
    fn dimension_and_hash_checks_fail_closed() {
        let bytes = b"RIFF\0\0\0\0WEBPinvalid";
        assert!(verify_webp(bytes, &format!("{:x}", Sha256::digest(bytes))).is_err());
        assert!(verify_webp(bytes, &"0".repeat(64)).is_err());
    }
}
