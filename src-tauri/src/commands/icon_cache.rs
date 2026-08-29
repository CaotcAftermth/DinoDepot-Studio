use super::failure::{Failure, Outcome};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// A persistent cache for remote previews and legacy HTTPS icon overrides.
/// Managed official/modpack icons resolve from the immutable package library.
///
/// Content-addressed by hash, so the same image fetched twice under two names
/// is stored once and an image that changes gets a new key rather than a stale
/// hit. Bounded by total bytes, evicted least-recently-used, and readable with
/// no network at all - an administrator working offline still sees their icons.
///
/// Deliberately not Git LFS and not a custom asset service. These are small
/// WebP/PNG files; the cheapest correct thing is a folder with a size limit.

/// Total bytes kept before the least recently used are dropped.
const MAX_BYTES: u64 = 64 * 1024 * 1024;

const CACHE_DIR: &str = "icon-cache";

/// Only the two managed icon formats are served through the asset protocol.
const MAGIC_RIFF: &[u8] = b"RIFF";
const MAGIC_WEBP: &[u8] = b"WEBP";
const MAGIC_PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

fn root(app: &tauri::AppHandle) -> Outcome<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| {
            Failure::new(
                "unknown",
                "Could not find the icon cache folder.",
                e.to_string(),
            )
        })?
        .join(CACHE_DIR);
    fs::create_dir_all(&dir).map_err(|e| {
        Failure::new(
            "save.failed",
            "The icon cache folder could not be made.",
            e.to_string(),
        )
    })?;
    Ok(dir)
}

/// A cache key must be one safe file-name segment.
///
/// Keys are content hashes the app computes, but they arrive here from the
/// frontend - which renders untrusted modpack content - so the shape is checked
/// rather than trusted.
fn key_path(dir: &Path, key: &str, extension: &str) -> Outcome<PathBuf> {
    let safe = key.len() >= 8
        && key.len() <= 128
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !safe {
        return Err(Failure::new(
            "unknown",
            "That is not a valid icon reference.",
            format!("refused cache key '{key}'"),
        ));
    }
    Ok(dir.join(format!("{key}.{extension}")))
}

fn icon_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() > 12 && &bytes[0..4] == MAGIC_RIFF && &bytes[8..12] == MAGIC_WEBP {
        Some("webp")
    } else if bytes.starts_with(MAGIC_PNG) {
        Some("png")
    } else {
        None
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedIcon {
    /// Absolute path, for the asset protocol. Empty when not cached.
    pub path: String,
    pub cached: bool,
    /// The stored ETag, for a conditional request. Empty when unknown.
    pub etag: String,
}

/// Looks an icon up without fetching anything.
///
/// Touches the file's modified time on a hit, which is what makes eviction
/// least-recently-*used* rather than least-recently-written.
#[tauri::command]
pub fn icon_cache_get(app: tauri::AppHandle, key: String) -> Result<CachedIcon, String> {
    get_inner(&app, &key).map_err(|e| e.to_string())
}

fn get_inner(app: &tauri::AppHandle, key: &str) -> Outcome<CachedIcon> {
    let dir = root(app)?;
    for extension in ["webp", "png"] {
        let path = key_path(&dir, key, extension)?;
        if !path.is_file() {
            continue;
        }

        // A truncated or mislabeled file is a disposable cache miss.
        match fs::read(&path) {
            Ok(bytes) if icon_extension(&bytes) == Some(extension) => {}
            _ => {
                let _ = fs::remove_file(&path);
                let _ = fs::remove_file(etag_path(&path));
                continue;
            }
        }

        // Best-effort: a cache whose timestamps cannot be updated still works,
        // it simply evicts in a less useful order.
        let _ = filetime_touch(&path);

        return Ok(CachedIcon {
            path: path.to_string_lossy().to_string(),
            cached: true,
            etag: fs::read_to_string(etag_path(&path)).unwrap_or_default(),
        });
    }

    Ok(CachedIcon {
        path: String::new(),
        cached: false,
        etag: String::new(),
    })
}

fn etag_path(icon: &Path) -> PathBuf {
    icon.with_extension("etag")
}

/// Marks a file as used now, by rewriting its modified time.
fn filetime_touch(path: &Path) -> std::io::Result<()> {
    let file = fs::OpenOptions::new().append(true).open(path)?;
    // Appending nothing is enough to move the modified time on Windows.
    file.set_len(file.metadata()?.len())?;
    Ok(())
}

/// Stores an icon, then prunes the cache back under its limit.
#[tauri::command]
pub fn icon_cache_put(
    app: tauri::AppHandle,
    key: String,
    content_b64: String,
    etag: String,
) -> Result<CachedIcon, String> {
    put_inner(&app, &key, &content_b64, &etag).map_err(|e| e.to_string())
}

fn put_inner(
    app: &tauri::AppHandle,
    key: &str,
    content_b64: &str,
    etag: &str,
) -> Outcome<CachedIcon> {
    let dir = root(app)?;

    let cleaned: String = content_b64.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, cleaned)
        .map_err(|e| Failure::new("unknown", "That icon could not be read.", e.to_string()))?;

    let extension = icon_extension(&bytes).ok_or_else(|| {
        Failure::new(
            "unknown",
            "That icon is not a WebP or PNG image and was not saved.",
            "content did not have an accepted image header",
        )
    })?;
    let path = key_path(&dir, key, extension)?;
    let alternate = key_path(&dir, key, if extension == "webp" { "png" } else { "webp" })?;
    let _ = fs::remove_file(alternate);

    super::project_io::write_atomic(&path, &bytes)
        .map_err(|detail| Failure::new("save.failed", "That icon could not be saved.", detail))?;
    if !etag.is_empty() {
        let _ = super::project_io::write_atomic(&etag_path(&path), etag.as_bytes());
    } else {
        let _ = fs::remove_file(etag_path(&path));
    }

    prune(&dir)?;

    Ok(CachedIcon {
        path: path.to_string_lossy().to_string(),
        cached: true,
        etag: etag.to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedIcon {
    /// Base64 body. Empty when the server answered "not modified".
    pub content_b64: String,
    pub etag: String,
    pub not_modified: bool,
}

/// Fetches an icon over HTTP, here rather than in the webview.
///
/// The webview cannot do this: `connect-src` is `'self'`, and `img-src` allows
/// no remote host either. That is deliberate - a project's catalog is untrusted
/// input, and an icon URL in it must not be able to make the page reach an
/// arbitrary server or leak a page visit. Fetching in Rust and serving the
/// result from the cache through the asset protocol keeps the rendering side
/// entirely local.
#[tauri::command]
pub async fn icon_fetch(url: String, etag: String) -> Result<FetchedIcon, String> {
    fetch_inner(&url, &etag).await.map_err(|e| e.to_string())
}

async fn fetch_inner(url: &str, etag: &str) -> Outcome<FetchedIcon> {
    // HTTPS only, and never a local address: an icon URL comes from project
    // content, and this must not become a way to probe the machine's network.
    let parsed = url::Url::parse(url)
        .map_err(|e| Failure::new("unknown", "That icon address is not valid.", e.to_string()))?;
    if parsed.scheme() != "https" {
        return Err(Failure::new(
            "unknown",
            "Icons can only be loaded over a secure connection.",
            format!("refused scheme '{}'", parsed.scheme()),
        ));
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!("DinoDepotStudio/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| Failure::new("unknown", "Could not start the download.", e.to_string()))?;

    let mut request = client.get(url);
    if !etag.is_empty() {
        request = request.header("If-None-Match", etag);
    }

    let response = request.send().await.map_err(|e| {
        Failure::new(
            "network.offline",
            "That icon could not be downloaded.",
            e.to_string(),
        )
    })?;

    if response.status().as_u16() == 304 {
        return Ok(FetchedIcon {
            content_b64: String::new(),
            etag: etag.to_string(),
            not_modified: true,
        });
    }
    if !response.status().is_success() {
        return Err(Failure::new(
            "repo.unavailable",
            "That icon is not there.",
            format!("HTTP {}", response.status().as_u16()),
        ));
    }

    let new_etag = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let bytes = response.bytes().await.map_err(|e| {
        Failure::new(
            "network.offline",
            "That icon could not be read.",
            e.to_string(),
        )
    })?;

    // Checked before it is handed back, so a server answering with something
    // else never reaches the cache.
    if icon_extension(&bytes).is_none() {
        return Err(Failure::new(
            "unknown",
            "That icon is not a WebP or PNG image.",
            "content did not have an accepted image header",
        ));
    }

    Ok(FetchedIcon {
        content_b64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes),
        etag: new_etag,
        not_modified: false,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub files: usize,
    pub bytes: u64,
    pub limit: u64,
}

#[tauri::command]
pub fn icon_cache_stats(app: tauri::AppHandle) -> Result<CacheStats, String> {
    let dir = root(&app).map_err(|e| e.to_string())?;
    let entries = list(&dir).map_err(|e| e.to_string())?;
    Ok(CacheStats {
        files: entries.iter().filter(|e| e.is_icon).count(),
        bytes: entries.iter().map(|e| e.size).sum(),
        limit: MAX_BYTES,
    })
}

/// Empties the cache. Everything in it is re-fetchable, so this is always safe.
#[tauri::command]
pub fn icon_cache_clear(app: tauri::AppHandle) -> Result<usize, String> {
    let dir = root(&app).map_err(|e| e.to_string())?;
    let entries = list(&dir).map_err(|e| e.to_string())?;
    let mut removed = 0;
    for entry in &entries {
        if fs::remove_file(&entry.path).is_ok() && entry.is_icon {
            removed += 1;
        }
    }
    Ok(removed)
}

struct Entry {
    path: PathBuf,
    size: u64,
    /// Epoch seconds; 0 when the OS will not say.
    used_at: i64,
    is_icon: bool,
}

fn list(dir: &Path) -> Outcome<Vec<Entry>> {
    let mut out = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| {
        Failure::new(
            "unknown",
            "The icon cache could not be read.",
            e.to_string(),
        )
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        out.push(Entry {
            used_at: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            size: meta.len(),
            is_icon: matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("webp" | "png")
            ),
            path,
        });
    }
    Ok(out)
}

/// Drops the least recently used icons until the cache fits.
fn prune(dir: &Path) -> Outcome<()> {
    let mut entries = list(dir)?;
    let mut total: u64 = entries.iter().map(|e| e.size).sum();
    if total <= MAX_BYTES {
        return Ok(());
    }

    entries.sort_by_key(|e| e.used_at);
    for entry in entries {
        if total <= MAX_BYTES {
            break;
        }
        if !entry.is_icon {
            continue;
        }
        if fs::remove_file(&entry.path).is_ok() {
            total = total.saturating_sub(entry.size);
            let _ = fs::remove_file(etag_path(&entry.path));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The smallest thing that passes the WebP header check.
    fn webp(payload: &[u8]) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WEBP".to_vec();
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn only_webp_and_png_are_accepted() {
        assert_eq!(icon_extension(&webp(b"VP8 data")), Some("webp"));
        assert_eq!(icon_extension(b"\x89PNG\r\n\x1a\nfixture"), Some("png"));
        assert_eq!(icon_extension(b"RIFF short"), None);
        assert_eq!(icon_extension(b""), None);
        // RIFF but not WebP - a WAV file, say.
        assert_eq!(icon_extension(b"RIFF\0\0\0\0WAVEfmt "), None);
    }

    #[test]
    fn cache_keys_stay_inside_the_folder() {
        let dir = PathBuf::from("C:\\cache");
        assert!(key_path(&dir, "a1b2c3d4e5f6", "webp").is_ok());
        assert!(key_path(&dir, "sha256-a1b2c3d4", "png").is_ok());
        for bad in [
            "",
            "short",
            "../escaped",
            "a/b",
            "a\\b",
            "a.b.c.d.e.f",
            "has space here",
        ] {
            assert!(
                key_path(&dir, bad, "webp").is_err(),
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn an_over_long_key_is_refused() {
        assert!(key_path(&PathBuf::from("C:\\cache"), &"a".repeat(129), "webp").is_err());
    }

    #[test]
    fn the_etag_sits_beside_the_icon() {
        assert_eq!(
            etag_path(Path::new("C:\\cache\\abcdefgh.webp")),
            PathBuf::from("C:\\cache\\abcdefgh.etag")
        );
    }

    // --- the parts that need a real folder ---------------------------------

    fn write(dir: &Path, name: &str, bytes: &[u8], used_at_offset_secs: i64) {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        // Backdating is what makes the eviction order testable.
        let when = std::time::SystemTime::now()
            - std::time::Duration::from_secs(used_at_offset_secs.unsigned_abs());
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(when).unwrap();
    }

    #[test]
    fn listing_separates_icons_from_their_etags() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "aaaaaaaa.webp", &webp(b"x"), 0);
        write(dir.path(), "aaaaaaaa.etag", b"\"abc\"", 0);

        let entries = list(dir.path()).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries.iter().filter(|e| e.is_icon).count(), 1);
    }

    /// Under the limit, nothing is dropped - the common case.
    #[test]
    fn pruning_leaves_a_cache_that_fits_alone() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "aaaaaaaa.webp", &webp(b"small"), 0);
        prune(dir.path()).unwrap();
        assert!(dir.path().join("aaaaaaaa.webp").exists());
    }

    #[test]
    fn pruning_drops_the_least_recently_used_first() {
        let dir = tempfile::tempdir().unwrap();
        let big = webp(&vec![0u8; (MAX_BYTES / 2) as usize]);
        // Three halves do not fit in one whole.
        write(dir.path(), "oldest00.webp", &big, 3000);
        write(dir.path(), "middle00.webp", &big, 2000);
        write(dir.path(), "newest00.webp", &big, 1000);

        prune(dir.path()).unwrap();

        assert!(!dir.path().join("oldest00.webp").exists());
        assert!(dir.path().join("newest00.webp").exists());
        let total: u64 = list(dir.path()).unwrap().iter().map(|e| e.size).sum();
        assert!(total <= MAX_BYTES, "cache still over its limit: {total}");
    }

    #[test]
    fn pruning_takes_the_etag_with_the_icon() {
        let dir = tempfile::tempdir().unwrap();
        let big = webp(&vec![0u8; (MAX_BYTES / 2) as usize]);
        write(dir.path(), "oldest00.webp", &big, 3000);
        write(dir.path(), "oldest00.etag", b"\"gone\"", 3000);
        write(dir.path(), "middle00.webp", &big, 2000);
        write(dir.path(), "newest00.webp", &big, 1000);

        prune(dir.path()).unwrap();
        assert!(!dir.path().join("oldest00.etag").exists());
    }
}
