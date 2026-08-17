use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use url::Url;

const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageHttpResponse {
    pub status: u16,
    pub content_type: String,
    pub body_b64: String,
}

fn validate_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw).map_err(|_| "The package URL is not valid".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Package downloads require HTTPS".into());
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("The package URL must not contain credentials".into());
    }
    Ok(parsed)
}

/// Downloads public package metadata or an asset outside the webview.
///
/// The desktop CSP intentionally has no external `connect-src`. Keeping this
/// unauthenticated reader in Rust means installing a public pack does not widen
/// the webview's network boundary or expose any GitHub credential to it.
#[tauri::command]
pub async fn package_http_get(url: String) -> Result<PackageHttpResponse, String> {
    let url = validate_url(&url)?;
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "DinoDepotStudio/",
            env!("CARGO_PKG_VERSION"),
            " (package manager)"
        ))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(url)
        .header(
            ACCEPT,
            "application/vnd.github+json, application/json, image/*;q=0.9, */*;q=0.5",
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;

    validate_url(response.url().as_str())
        .map_err(|_| "Package download redirected to an unsafe URL".to_string())?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err("Package response is larger than 16 MB".into());
    }

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("Package response is larger than 16 MB".into());
    }

    Ok(PackageHttpResponse {
        status,
        content_type,
        body_b64: STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_public_https_urls() {
        let url = validate_url("https://raw.githubusercontent.com/o/r/main/pack.json").unwrap();
        assert_eq!(url.scheme(), "https");
    }

    #[test]
    fn rejects_insecure_or_credentialed_urls() {
        assert!(validate_url("http://example.com/pack.json").is_err());
        assert!(validate_url("https://token@example.com/pack.json").is_err());
        assert!(validate_url("not a url").is_err());
    }
}
