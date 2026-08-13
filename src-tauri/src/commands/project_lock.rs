use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A per-project advisory lock, so two DinoDepot Studio instances never write
/// the same project folder.
///
/// Two instances editing one project is not a merge problem — it is a lost-work
/// problem. Both hold the whole project in memory, both autosave, and whichever
/// debounce fires last wins the file outright.
///
/// The lock is a file in the project folder rather than an OS-level handle:
/// it survives a hard kill in a readable form, it works for a project sitting
/// on a synced folder, and — because it names the machine and the instance —
/// the message can say *what* holds it rather than just refusing.
///
/// Advisory by design. A stale lock never blocks the admin permanently; they
/// are told what holds it and can take it over.
const LOCK_FILE: &str = ".dinodepot-lock";

/// How long a heartbeat stays trustworthy.
///
/// The frontend refreshes every 30s. Five minutes is long enough to survive a
/// machine that went to sleep mid-session, short enough that a crashed
/// instance does not lock somebody out for an afternoon.
const STALE_AFTER_SECS: i64 = 300;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LockRecord {
    /// Unique to this run of the application.
    pub instance_id: String,
    pub machine: String,
    pub pid: u32,
    /// Epoch milliseconds of the last heartbeat.
    pub heartbeat_at: i64,
    pub acquired_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    pub held: bool,
    /// True when *we* hold it. False with `held` true means somebody else does.
    pub owned: bool,
    pub stale: bool,
    pub machine: String,
    pub instance_id: String,
    /// Epoch milliseconds; 0 when there is no lock.
    pub heartbeat_at: i64,
}

/// This process's identity, generated once.
#[derive(Default)]
pub struct LockState {
    pub instance_id: Mutex<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn instance_id(state: &LockState) -> String {
    let mut guard = state.instance_id.lock().map_err(|_| ()).ok();
    match guard.as_deref_mut() {
        Some(existing) if !existing.is_empty() => existing.clone(),
        Some(slot) => {
            // Process id plus start time: unique enough to tell two instances
            // apart, and free of any dependency worth adding for it.
            let id = format!("{}-{}", std::process::id(), now_ms());
            *slot = id.clone();
            id
        }
        None => format!("{}-{}", std::process::id(), now_ms()),
    }
}

fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "this computer".into())
}

fn lock_path(dir: &str) -> PathBuf {
    Path::new(dir).join(LOCK_FILE)
}

fn read_lock(path: &Path) -> Option<LockRecord> {
    let text = fs::read_to_string(path).ok()?;
    // A lock file we cannot parse is treated as absent rather than as a
    // permanent block — it is a hint, not a source of truth about anyone's work.
    serde_json::from_str(&text).ok()
}

fn status_from(record: Option<LockRecord>, mine: &str) -> LockStatus {
    match record {
        None => LockStatus {
            held: false,
            owned: false,
            stale: false,
            machine: String::new(),
            instance_id: String::new(),
            heartbeat_at: 0,
        },
        Some(record) => {
            let age_secs = (now_ms() - record.heartbeat_at) / 1000;
            LockStatus {
                held: true,
                owned: record.instance_id == mine,
                stale: age_secs > STALE_AFTER_SECS,
                machine: record.machine.clone(),
                instance_id: record.instance_id.clone(),
                heartbeat_at: record.heartbeat_at,
            }
        }
    }
}

/// Who, if anyone, currently holds the project.
#[tauri::command]
pub fn project_lock_status(
    state: tauri::State<'_, LockState>,
    dir: String,
) -> Result<LockStatus, String> {
    let mine = instance_id(&state);
    Ok(status_from(read_lock(&lock_path(&dir)), &mine))
}

/// Takes the lock.
///
/// Succeeds when the folder is free, when we already hold it, or when the
/// existing lock is stale. Refuses — without touching anything — when another
/// live instance holds it, unless `force` is set, which is what the admin's
/// "open anyway" choice sends.
#[tauri::command]
pub fn project_lock_acquire(
    state: tauri::State<'_, LockState>,
    dir: String,
    force: bool,
) -> Result<LockStatus, String> {
    let mine = instance_id(&state);
    let path = lock_path(&dir);
    let existing = status_from(read_lock(&path), &mine);

    if existing.held && !existing.owned && !existing.stale && !force {
        return Err(format!(
            "This project is already open in DinoDepot Studio on {}. Close it there first, or open this copy anyway to take over.",
            existing.machine
        ));
    }

    let now = now_ms();
    let record = LockRecord {
        instance_id: mine.clone(),
        machine: machine_name(),
        pid: std::process::id(),
        heartbeat_at: now,
        acquired_at: now,
    };
    let text = serde_json::to_string_pretty(&record).map_err(err)?;
    super::project_io::write_atomic(&path, text.as_bytes())?;
    Ok(status_from(Some(record), &mine))
}

/// Refreshes our heartbeat. Cheap; called on a timer while a project is open.
///
/// Returns the status rather than a bare unit so the caller notices when the
/// lock has been taken over from under it — which is exactly when it must stop
/// writing.
#[tauri::command]
pub fn project_lock_refresh(
    state: tauri::State<'_, LockState>,
    dir: String,
) -> Result<LockStatus, String> {
    let mine = instance_id(&state);
    let path = lock_path(&dir);
    let current = read_lock(&path);
    let status = status_from(current.clone(), &mine);
    if !status.owned {
        return Ok(status);
    }
    let record = LockRecord {
        heartbeat_at: now_ms(),
        ..current.expect("owned implies a record")
    };
    let text = serde_json::to_string_pretty(&record).map_err(err)?;
    super::project_io::write_atomic(&path, text.as_bytes())?;
    Ok(status_from(Some(record), &mine))
}

/// Gives the lock up. Only ever removes our own — releasing somebody else's
/// would turn a tidy-up into a way to trample a live session.
#[tauri::command]
pub fn project_lock_release(
    state: tauri::State<'_, LockState>,
    dir: String,
) -> Result<(), String> {
    let mine = instance_id(&state);
    let path = lock_path(&dir);
    if let Some(record) = read_lock(&path) {
        if record.instance_id == mine {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(instance: &str, age_secs: i64) -> LockRecord {
        LockRecord {
            instance_id: instance.into(),
            machine: "DESKTOP-TEST".into(),
            pid: 1234,
            heartbeat_at: now_ms() - age_secs * 1000,
            acquired_at: now_ms() - age_secs * 1000,
        }
    }

    #[test]
    fn no_lock_file_means_free() {
        let status = status_from(None, "me");
        assert!(!status.held);
        assert!(!status.owned);
    }

    #[test]
    fn our_own_lock_is_owned_not_contended() {
        let status = status_from(Some(record("me", 5)), "me");
        assert!(status.held);
        assert!(status.owned);
        assert!(!status.stale);
    }

    #[test]
    fn a_live_lock_from_elsewhere_is_held_and_not_ours() {
        let status = status_from(Some(record("other", 5)), "me");
        assert!(status.held);
        assert!(!status.owned);
        assert!(!status.stale);
        assert_eq!(status.machine, "DESKTOP-TEST");
    }

    /// A crashed instance leaves its lock behind. Without staleness it would
    /// lock the admin out of their own project until they found the file.
    #[test]
    fn a_lock_that_stopped_beating_goes_stale() {
        let status = status_from(Some(record("other", STALE_AFTER_SECS + 60)), "me");
        assert!(status.held);
        assert!(status.stale);
    }

    #[test]
    fn a_lock_just_under_the_limit_is_still_live() {
        let status = status_from(Some(record("other", STALE_AFTER_SECS - 30)), "me");
        assert!(!status.stale);
    }

    #[test]
    fn the_lock_file_is_hidden_from_project_loading() {
        // load_project only takes plain *.json names, and this starts with a
        // dot — so the lock can never be parsed as project data.
        assert!(super::super::project_io::validate_file_name(LOCK_FILE).is_err());
    }
}
