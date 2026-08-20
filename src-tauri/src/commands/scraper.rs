use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};

/// Holds the running scraper child process so it can be cancelled.
pub struct ScraperState(pub Mutex<Option<tokio::process::Child>>);

impl Default for ScraperState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Strips Windows verbatim prefixes (`\\?\`) that canonicalize() adds —
/// Node's module loader cannot resolve a main script given as a `\\?\` path.
fn de_verbatim(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{stripped}"))
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

fn resolve_script(app: &AppHandle) -> Result<PathBuf, String> {
    // Bundled app: sidecar shipped as a resource.
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("sidecar").join("scraper.mjs");
        if bundled.exists() {
            return Ok(de_verbatim(bundled));
        }
    }
    // Dev: working directory is src-tauri; the sidecar lives one level up.
    if let Ok(cwd) = std::env::current_dir() {
        let dev = cwd.join("..").join("sidecar").join("scraper.mjs");
        if dev.exists() {
            return Ok(de_verbatim(dev.canonicalize().unwrap_or(dev)));
        }
    }
    Err("scraper.mjs not found (sidecar missing)".to_string())
}

#[tauri::command]
pub async fn scraper_start(
    app: AppHandle,
    state: State<'_, ScraperState>,
    mode: String,
    watch_list_json: Option<String>,
) -> Result<(), String> {
    if !matches!(mode.as_str(), "cosmetics" | "watch" | "lookup") {
        return Err(format!("Unknown scraper mode '{mode}'"));
    }
    {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("A scraper run is already in progress".to_string());
        }
    }

    let script = resolve_script(&app)?;
    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(&script).arg(&mode);

    // Every mode takes a JSON list argument — required for watch and lookup,
    // optional for cosmetics, where it is the cosmetics already recorded and
    // lets the sidecar skip detail pages it does not need to open. Separate
    // temp files so one mode's run cannot clobber another's input.
    match mode.as_str() {
        "watch" => {
            let json = watch_list_json.ok_or("watch mode requires a watch list")?;
            let tmp = std::env::temp_dir().join("ddstudio-watchlist.json");
            std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
            cmd.arg(tmp);
        }
        "lookup" => {
            let json = watch_list_json.ok_or("lookup mode requires a list of mods")?;
            let tmp = std::env::temp_dir().join("ddstudio-lookup.json");
            std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
            cmd.arg(tmp);
        }
        "cosmetics" => {
            if let Some(json) = watch_list_json {
                let tmp = std::env::temp_dir().join("ddstudio-known-cosmetics.json");
                std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
                cmd.arg(tmp);
            }
        }
        _ => unreachable!("mode was validated above"),
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start Node (is it installed?): {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout handle")?;
    let stderr = child.stderr.take().ok_or("no stderr handle")?;

    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    // Stream stdout NDJSON lines to the frontend.
    let app_out = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit("scraper-event", line);
        }
        // Signal end-of-stream; clear the child handle.
        if let Some(state) = app_out.try_state::<ScraperState>() {
            if let Ok(mut guard) = state.0.lock() {
                *guard = None;
            }
        }
        let _ = app_out.emit("scraper-event", "{\"type\":\"exit\"}".to_string());
    });

    // Surface stderr lines as status events (Chrome/Node warnings, crashes).
    let app_err = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let event = serde_json::json!({ "type": "stderr", "message": line });
            let _ = app_err.emit("scraper-event", event.to_string());
        }
    });

    Ok(())
}

#[tauri::command]
pub fn scraper_cancel(state: State<'_, ScraperState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        child.start_kill().map_err(|e| e.to_string())?;
        *guard = None;
        Ok(())
    } else {
        Err("No scraper run in progress".to_string())
    }
}

#[tauri::command]
pub fn scraper_running(state: State<'_, ScraperState>) -> Result<bool, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.is_some())
}
