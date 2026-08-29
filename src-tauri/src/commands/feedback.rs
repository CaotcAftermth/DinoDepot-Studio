//! The Feedback Center's back end inside the desktop app.
//!
//! Three jobs, and they are here together because they share one rule: the
//! webview must not be able to reach the network, read arbitrary files, or
//! hold a credential. The application's content security policy has no
//! external `connect-src` at all, so a report cannot be posted from
//! JavaScript even in principle - it is posted from here, by a client that
//! carries no authentication of any kind.
//!
//! That last part is deliberate. The feedback service authenticates to GitHub
//! as a GitHub App using a key that lives on the service; nothing in this
//! binary can file an issue, and nothing in this binary needs to. An
//! installation that is compromised gains the ability to send text to a
//! rate-limited endpoint, which is the ability it already had.
//!
//! The three jobs:
//!
//! - **State.** Reports live in the application-data folder, next to the
//!   machine-local project records and for the same reason: they describe this
//!   machine, and they must survive the webview's storage being cleared.
//! - **Requests.** One narrow client for the configured feedback service.
//! - **Attachments.** A picked image is decoded and re-encoded here, which is
//!   the only way to be sure the thing being attached is an image at all.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{ImageEncoder, ImageReader, RgbaImage};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use tauri::Manager;
use url::Url;

use super::failure::{classify_transport, Failure};

/// Folder inside application data. Sibling of `projects/`, never inside one.
const STATE_DIR: &str = "feedback";
const STATE_FILE: &str = "reports.json";

/// A few hundred reports with their text. Past this the file is not a report
/// history, it is something that has gone wrong.
const MAX_STATE_BYTES: usize = 32 * 1024 * 1024;

/// One report, with a couple of screenshots already encoded.
const MAX_REQUEST_BYTES: usize = 6 * 1024 * 1024;

/// A page of issues from the service. Nothing it returns is ever this large.
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Enough for an uncompressed screenshot of a very large display.
const MAX_SOURCE_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

/// What one attachment may weigh once re-encoded. Matches the client and the
/// service, because a limit only one of the three enforces is not a limit.
const MAX_ATTACHMENT_BYTES: usize = 1 * 1024 * 1024;

/// Longest edge an attachment is kept at.
///
/// A 4K screenshot scaled to this is still legible for every kind of interface
/// bug, and is a fraction of the bytes. Bugs are reported about layouts and
/// labels, neither of which needs pixel-for-pixel fidelity.
const MAX_IMAGE_EDGE: u32 = 2560;

/// The second attempt's edge, when the first re-encode is still too heavy.
const FALLBACK_IMAGE_EDGE: u32 = 1600;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not locate the application data folder: {e}"))?
        .join(STATE_DIR);
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join(STATE_FILE))
}

/// Reads the stored reports. `None` before anything has ever been written.
///
/// A read failure is reported rather than swallowed, but the caller treats it
/// as "no history" - the Feedback Center is not allowed to stop the app, and
/// nothing in this file is the administrator's project work.
#[tauri::command]
pub fn feedback_state_get(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = state_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("Could not read your saved reports: {e}"))
}

/// Writes the stored reports, atomically.
#[tauri::command]
pub fn feedback_state_set(app: tauri::AppHandle, content: String) -> Result<(), String> {
    if content.len() > MAX_STATE_BYTES {
        return Err("The feedback history is too large to save".into());
    }
    // The same refusal the machine-local project records carry. Nothing should
    // ever put a credential in here, and this is where that stops being a
    // matter of everyone remembering.
    if super::app_state::looks_like_credential(&content) {
        return Err("Refusing to store credentials in the feedback history".into());
    }
    super::project_io::write_atomic(&state_path(&app)?, content.as_bytes())
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackApiResponse {
    pub status: u16,
    pub body: String,
}

/// The service address, checked before anything is sent to it.
///
/// HTTPS, no credentials, no query, no fragment. The address is configurable
/// by the administrator, which makes it untrusted input - a base URL carrying
/// a password would put that password in every request this makes.
fn validate_base(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw.trim_end_matches('/'))
        .map_err(|_| "The feedback service address is not a valid URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("The feedback service address must use HTTPS".into());
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("The feedback service address must not contain credentials".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("The feedback service address must not carry a query string".into());
    }
    Ok(parsed)
}

/// Joins a path onto the base without letting it escape.
///
/// The path comes from this application's own code rather than from an
/// administrator, but it carries an issue number that came back from a
/// service - so it is checked anyway. `join` on a URL would happily accept an
/// absolute URL and send the request somewhere else entirely.
fn build_url(base: &Url, path: &str) -> Result<Url, String> {
    // Checked before the leading slashes come off, not after. `//host/path` is
    // a protocol-relative URL, and stripping its slashes first would turn it
    // into an ordinary-looking path that happens to name somebody else's host.
    let raw = path.trim();
    if raw.starts_with("//") || raw.contains("://") || raw.contains("..") {
        return Err("Invalid feedback request path".into());
    }
    let trimmed = raw.trim_start_matches('/');
    let joined = format!("{}/{}", base.as_str().trim_end_matches('/'), trimmed);
    let url = Url::parse(&joined).map_err(|_| "Invalid feedback request path".to_string())?;
    if url.host_str() != base.host_str() || url.scheme() != base.scheme() {
        return Err("Invalid feedback request path".into());
    }
    Ok(url)
}

/// Turns a service response into something the app can act on.
///
/// The codes are the application's own vocabulary, so the Feedback Center can
/// tell "you are offline, your report is safe" from "the service refused this"
/// without reading English out of a response body.
fn classify(status: u16, detail: &str) -> Failure {
    match status {
        400 | 422 => Failure::new(
            "validation.failed",
            "The feedback service could not accept this report.",
            detail,
        ),
        401 | 403 => Failure::new(
            "auth.forbidden",
            "The feedback service refused this report.",
            detail,
        ),
        404 => Failure::new(
            "repo.unavailable",
            "The feedback service is configured, but that address does not answer.",
            detail,
        ),
        413 => Failure::new(
            "validation.failed",
            "The report is too large to send. Removing an attachment will help.",
            detail,
        ),
        429 => Failure::new(
            "network.rateLimited",
            "Too many reports have been sent from here recently. Try again a little later.",
            detail,
        ),
        s if s >= 500 => Failure::new(
            "network.serverError",
            "The feedback service is having trouble. Your report is saved on this computer.",
            detail,
        ),
        _ => Failure::new(
            "unknown",
            "The feedback service could not be reached.",
            detail,
        ),
    }
}

/// Sends one request to the configured feedback service.
///
/// Carries no credential, no cookie and no identifying header beyond a user
/// agent naming the product and version - which the service needs in order to
/// know which build a report came from when the payload itself is malformed.
#[tauri::command]
pub async fn feedback_api_request(
    base_url: String,
    path: String,
    method: String,
    body: Option<String>,
) -> Result<FeedbackApiResponse, String> {
    let base = validate_base(&base_url)?;
    let url = build_url(&base, &path)?;

    let method = method.to_ascii_uppercase();
    if method != "GET" && method != "POST" {
        return Err("Unsupported feedback request".into());
    }
    let payload = body.unwrap_or_default();
    if payload.len() > MAX_REQUEST_BYTES {
        return Err(classify(413, "request body over the local limit").to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "DinoDepotStudio/",
            env!("CARGO_PKG_VERSION"),
            " (feedback)"
        ))
        .timeout(Duration::from_secs(30))
        // A redirect off the configured host would be a request to somewhere
        // the administrator did not name. There is no legitimate reason for
        // the service to issue one.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(err)?;

    let request = if method == "POST" {
        client
            .post(url)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .body(payload)
    } else {
        client.get(url).header(ACCEPT, "application/json")
    };

    let response = match request.send().await {
        Ok(response) => response,
        Err(e) => return Err(classify_transport(&e, "the feedback service").to_string()),
    };

    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| classify_transport(&e, "the feedback service").to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(classify(500, "response over the local limit").to_string());
    }
    let text = String::from_utf8_lossy(&bytes).to_string();

    // 2xx and 409 both carry a body the caller wants: 409 is how the service
    // says "this report is already filed", which is a success from the
    // reporter's point of view and must not be turned into an error here.
    if (200..300).contains(&status) || status == 409 {
        return Ok(FeedbackApiResponse { status, body: text });
    }
    Err(classify(status, &text).to_string())
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackImage {
    pub file_name: String,
    pub content_type: String,
    pub size_bytes: usize,
    pub width: u32,
    pub height: u32,
    pub data_b64: String,
}

/// The display name for an attachment: the file's own name, and nothing above it.
///
/// The path is never returned. `C:\Users\jane\Desktop\bug.png` names a real
/// person, and the report only needs to say `bug.png`.
fn display_name(path: &Path) -> String {
    let stem = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "attachment".to_string());
    let cleaned: String = stem
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' '))
        .collect();
    let trimmed = cleaned.trim();
    let base: String = trimmed.chars().take(100).collect();
    // The extension is replaced rather than kept, because the bytes are
    // re-encoded - a file called `shot.png` that is now a WebP would be a
    // small lie in the one place somebody checks what they attached.
    let stem = match base.rsplit_once('.') {
        Some((name, _)) => name,
        None => base.as_str(),
    };
    let stem = stem.trim();
    format!("{}.webp", if stem.is_empty() { "attachment" } else { stem })
}

fn scale_to_fit(source: &RgbaImage, edge: u32) -> RgbaImage {
    let (width, height) = source.dimensions();
    if width <= edge && height <= edge {
        return source.clone();
    }
    let scale = f64::from(edge) / f64::from(width.max(height));
    let target_width = ((f64::from(width) * scale).round() as u32).max(1);
    let target_height = ((f64::from(height) * scale).round() as u32).max(1);
    image::imageops::resize(
        source,
        target_width,
        target_height,
        image::imageops::FilterType::Lanczos3,
    )
}

fn encode_lossless(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("Could not prepare the image: {e}"))?;
    Ok(out)
}

/// Reads a picked image and re-encodes it as a lossless WebP.
///
/// Re-encoding is the point, not a convenience. It proves the file really is
/// an image - an executable renamed to `.png` fails to decode and is refused
/// here rather than at the service - and it drops every scrap of metadata the
/// original carried. Camera and phone screenshots routinely carry EXIF with a
/// GPS position in it, and a bug report is not a place to publish where
/// somebody lives.
#[tauri::command]
pub fn feedback_read_image(path: String) -> Result<FeedbackImage, String> {
    let source = Path::new(&path);
    let meta = fs::metadata(source).map_err(|_| "That file could not be read".to_string())?;
    if !meta.is_file() {
        return Err("That is not a file".into());
    }
    if meta.len() > MAX_SOURCE_IMAGE_BYTES {
        return Err("That image is too large to attach".into());
    }

    let decoded = ImageReader::open(source)
        .map_err(|_| "That file could not be read".to_string())?
        // Format is guessed from the content, never from the extension: the
        // extension is what an attacker controls and the content is not.
        .with_guessed_format()
        .map_err(|_| "That file is not an image".to_string())?
        .decode()
        .map_err(|_| "That file is not an image DinoDepot can read".to_string())?;

    let rgba = decoded.to_rgba8();
    let mut scaled = scale_to_fit(&rgba, MAX_IMAGE_EDGE);
    let mut bytes = encode_lossless(&scaled)?;

    if bytes.len() > MAX_ATTACHMENT_BYTES {
        scaled = scale_to_fit(&rgba, FALLBACK_IMAGE_EDGE);
        bytes = encode_lossless(&scaled)?;
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("That image is too detailed to attach - try cropping it".into());
    }

    Ok(FeedbackImage {
        file_name: display_name(source),
        content_type: "image/webp".to_string(),
        size_bytes: bytes.len(),
        width: scaled.width(),
        height: scaled.height(),
        data_b64: STANDARD.encode(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_service_addresses_are_accepted() {
        assert!(validate_base("https://feedback.example.com").is_ok());
        assert!(validate_base("https://feedback.example.com/").is_ok());
        assert!(validate_base("http://feedback.example.com").is_err());
        assert!(validate_base("https://user:pass@feedback.example.com").is_err());
        assert!(validate_base("https://feedback.example.com?key=1").is_err());
        assert!(validate_base("not a url").is_err());
    }

    #[test]
    fn a_path_cannot_move_the_request_to_another_host() {
        let base = validate_base("https://feedback.example.com").unwrap();
        assert_eq!(
            build_url(&base, "/api/feedback").unwrap().as_str(),
            "https://feedback.example.com/api/feedback"
        );
        assert!(build_url(&base, "https://evil.example.com/api").is_err());
        assert!(build_url(&base, "//evil.example.com/api").is_err());
        assert!(build_url(&base, "../../../etc").is_err());
    }

    /// The reporter's Windows account name is in every path they pick from.
    #[test]
    fn an_attachment_is_named_without_its_path() {
        assert_eq!(
            display_name(Path::new(r"C:\Users\jane\Desktop\quantity bug.png")),
            "quantity bug.webp"
        );
        assert_eq!(display_name(Path::new("/home/jane/shot.jpeg")), "shot.webp");
        assert_eq!(display_name(Path::new("noextension")), "noextension.webp");
    }

    #[test]
    fn a_name_of_nothing_usable_still_produces_a_file_name() {
        assert_eq!(display_name(Path::new("★★★.png")), "attachment.webp");
    }

    #[test]
    fn a_rate_limit_is_told_apart_from_a_refusal() {
        assert_eq!(classify(429, "").code, "network.rateLimited");
        assert_eq!(classify(403, "").code, "auth.forbidden");
        assert_eq!(classify(413, "").code, "validation.failed");
        assert_eq!(classify(503, "").code, "network.serverError");
    }

    #[test]
    fn service_failures_never_mention_a_status_code() {
        for status in [400, 401, 404, 413, 429, 500] {
            let message = classify(status, "").message;
            assert!(!message.contains(&status.to_string()), "{status}: {message}");
        }
    }

    /// A large screenshot has to come back inside the limit the service will
    /// accept, or the reporter is told to remove an attachment they cannot see
    /// the size of.
    #[test]
    fn a_large_image_is_scaled_within_the_attachment_limit() {
        let mut source = RgbaImage::new(4000, 3000);
        for (x, y, pixel) in source.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x % 256) as u8, (y % 256) as u8, 90, 255]);
        }
        let scaled = scale_to_fit(&source, MAX_IMAGE_EDGE);
        assert_eq!(scaled.width(), MAX_IMAGE_EDGE);
        assert_eq!(scaled.height(), 1920);
        assert!(encode_lossless(&scaled).unwrap().len() <= MAX_ATTACHMENT_BYTES);
    }

    #[test]
    fn a_small_image_is_left_alone() {
        let source = RgbaImage::new(320, 200);
        let scaled = scale_to_fit(&source, MAX_IMAGE_EDGE);
        assert_eq!(scaled.dimensions(), (320, 200));
    }

    #[test]
    fn something_that_is_not_an_image_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("payload.png");
        fs::write(&path, b"MZ\x90\x00 this is an executable").unwrap();
        assert!(feedback_read_image(path.to_string_lossy().to_string()).is_err());
    }
}
