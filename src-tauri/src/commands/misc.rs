use std::fs;
use std::path::Path;

/// One wiki page's source, with the revision it was read at.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPage {
    pub page: String,
    pub wikitext: String,
    pub revision_id: u64,
    pub url: String,
}

/// Fetches a page's wikitext from a MediaWiki site via the stable API.
///
/// Goes through Rust rather than the webview so there is no CORS dependency,
/// and so the importer reads the documented `action=parse` endpoint instead of
/// scraping rendered HTML, which would break on any theme change.
#[tauri::command]
pub async fn wiki_fetch_page(host: String, page: String) -> Result<WikiPage, String> {
    // Only the wikis the importer is designed against.
    const ALLOWED_HOSTS: &[&str] = &["ark.wiki.gg"];
    if !ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(format!("'{host}' is not an allowed wiki host"));
    }

    let client = reqwest::Client::builder()
        .user_agent("DinoDepotStudio/0.1 (creature acquisition importer)")
        .build()
        .map_err(|e| e.to_string())?;

    let encoded = page.replace(' ', "_");
    let url = format!(
        "https://{host}/api.php?action=parse&page={encoded}&prop=wikitext%7Crevid&format=json&formatversion=2"
    );
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{host} returned {}", res.status()));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if let Some(err) = body.get("error") {
        return Err(format!(
            "{host}: {}",
            err.get("info")
                .and_then(|v| v.as_str())
                .unwrap_or("page not found")
        ));
    }
    let parse = body.get("parse").ok_or("Unexpected API response")?;
    Ok(WikiPage {
        page: parse
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or(&page)
            .to_string(),
        wikitext: parse
            .get("wikitext")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        revision_id: parse.get("revid").and_then(|v| v.as_u64()).unwrap_or(0),
        url: format!("https://{host}/wiki/{encoded}"),
    })
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const MAX_DEPTH: usize = 3;

fn collect_images(dir: &Path, base: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            collect_images(&path, base, depth + 1, out);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                if let Ok(rel) = path.strip_prefix(base) {
                    // Forward slashes so the frontend can treat paths uniformly.
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
}

/// Lists image files inside a directory (recursive, up to 3 levels), as
/// relative paths like `creatures/Achatina.png`. Returns an empty list when
/// the directory doesn't exist.
#[tauri::command]
pub fn list_images(dir: String) -> Result<Vec<String>, String> {
    let path = Path::new(&dir);
    if !path.is_dir() {
        return Ok(vec![]);
    }
    let mut names = Vec::new();
    collect_images(path, path, 0, &mut names);
    names.sort();
    Ok(names)
}

/// Posts a message to the Discord webhook stored in the credential manager.
#[tauri::command]
pub async fn discord_post(content: String) -> Result<(), String> {
    let entry =
        keyring::Entry::new("DinoDepotStudio", "discord-webhook").map_err(|e| e.to_string())?;
    let webhook = match entry.get_password() {
        Ok(url) => url,
        Err(keyring::Error::NoEntry) => {
            return Err("No Discord webhook stored — add one in Settings".to_string())
        }
        Err(e) => return Err(e.to_string()),
    };
    if !webhook.starts_with("https://") {
        return Err("Stored Discord webhook is not an https:// URL".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent("DinoDepotStudio/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    // Discord limits messages to 2000 characters; chunk on line boundaries.
    let mut chunks: Vec<String> = vec![];
    let mut current = String::new();
    for line in content.lines() {
        if current.len() + line.len() + 1 > 1900 && !current.is_empty() {
            chunks.push(current.clone());
            current.clear();
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(line);
    }
    if !current.is_empty() {
        chunks.push(current);
    }

    for chunk in chunks {
        let res = client
            .post(&webhook)
            .json(&serde_json::json!({ "content": chunk }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Discord returned {status}: {body}"));
        }
    }
    Ok(())
}
