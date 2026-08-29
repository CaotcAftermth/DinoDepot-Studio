use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A per-project advisory lock, so two DinoDepot Studio instances never write
/// the same project folder.
///
/// Two instances editing one project is not a merge problem - it is a lost-work
/// problem. Both hold the whole project in memory, both autosave, and whichever
/// debounce fires last wins the file outright.
///
/// The lock is a file in the project folder rather than an OS-level handle:
/// it survives a hard kill in a readable form, it works for a project sitting
/// on a synced folder, and - because it names the machine and the instance -
/// the message can say *what* holds it rather than just refusing.
///
/// Advisory by design. A stale lock never blocks the admin permanently; they
/// are told what holds it and can take it over.
const LOCK_FILE: &str = ".dinodepot-lock";

/// The holder's proof of life: a file kept open for as long as the instance
/// runs, opened so that no second instance may open it for writing.
///
/// The JSON lock alone cannot tell "another instance is editing this" apart
/// from "the last instance died holding it" - and the second is by far the
/// commoner case, because an update relaunches the app and a relaunch is a
/// kill. Waiting out the heartbeat for that is five minutes of an administrator
/// being locked out of their own project on their own machine.
///
/// An operating-system handle answers the question exactly: it is released the
/// instant the process ends, however it ends. It is only conclusive locally,
/// which is why it is consulted only for a lock this machine wrote - a project
/// on a synced folder held by another machine is still judged by its heartbeat.
const HOLD_FILE: &str = ".dinodepot-lock.hold";

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

/// This process's identity, generated once, plus the hold handles it owns.
#[derive(Default)]
pub struct LockState {
    pub instance_id: Mutex<String>,
    /// Open handle per project folder we hold. Dropped on release, and by the
    /// operating system if this process dies without releasing anything.
    holds: Mutex<HashMap<PathBuf, File>>,
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

fn hold_path(dir: &str) -> PathBuf {
    Path::new(dir).join(HOLD_FILE)
}

/// Opens the hold file so that others may read it but none may write it.
///
/// Read sharing matters: a snapshot copies the whole project folder, and a file
/// opened with no sharing at all cannot even be copied.
#[cfg(windows)]
fn open_hold(path: &Path) -> Option<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    OpenOptions::new()
        .create(true)
        .write(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .ok()
}

#[cfg(not(windows))]
fn open_hold(_path: &Path) -> Option<File> {
    None
}

/// Whether a process on this machine still holds `dir`.
///
/// A hold file that opens for writing has no live owner. A missing one means
/// the same: either the holder released it, or the lock was written by a build
/// from before hold files existed - and in that case its process is a build
/// that has since been replaced, which is exactly the update case this exists
/// for.
///
/// Off Windows there is no share-mode check to make, so nothing is ever
/// declared dead and the heartbeat remains the only judge.
#[cfg(windows)]
fn holder_is_alive(dir: &str) -> bool {
    let path = hold_path(dir);
    if !path.is_file() {
        return false;
    }
    OpenOptions::new().write(true).open(&path).is_err()
}

#[cfg(not(windows))]
fn holder_is_alive(_dir: &str) -> bool {
    true
}

/// Takes and remembers the hold for a folder we have just locked.
///
/// Best-effort: taking over a lock a live instance still holds cannot open it,
/// and the refresh tick tries again once that instance lets go.
fn take_hold(state: &LockState, dir: &str) {
    let path = hold_path(dir);
    if let Ok(holds) = state.holds.lock() {
        if holds.contains_key(&path) {
            return;
        }
    }
    if let Some(file) = open_hold(&path) {
        if let Ok(mut holds) = state.holds.lock() {
            holds.insert(path, file);
        }
    }
}

fn drop_hold(state: &LockState, dir: &str) {
    if let Ok(mut holds) = state.holds.lock() {
        holds.remove(&hold_path(dir));
    }
}

fn read_lock(path: &Path) -> Option<LockRecord> {
    let text = fs::read_to_string(path).ok()?;
    // A lock file we cannot parse is treated as absent rather than as a
    // permanent block - it is a hint, not a source of truth about anyone's work.
    serde_json::from_str(&text).ok()
}

fn status_from(record: Option<LockRecord>, mine: &str, dir: &str) -> LockStatus {
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
            let owned = record.instance_id == mine;
            let age_secs = (now_ms() - record.heartbeat_at) / 1000;
            // A lock this machine wrote whose owner is no longer running is
            // abandoned, not contended - reported stale immediately rather
            // than after the heartbeat times out.
            let abandoned =
                !owned && record.machine == machine_name() && !holder_is_alive(dir);
            LockStatus {
                held: true,
                owned,
                stale: age_secs > STALE_AFTER_SECS || abandoned,
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
    Ok(status_from(read_lock(&lock_path(&dir)), &mine, &dir))
}

/// Takes the lock.
///
/// Succeeds when the folder is free, when we already hold it, or when the
/// existing lock is stale. Refuses - without touching anything - when another
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
    let existing = status_from(read_lock(&path), &mine, &dir);

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
    take_hold(&state, &dir);
    Ok(status_from(Some(record), &mine, &dir))
}

/// Refreshes our heartbeat. Cheap; called on a timer while a project is open.
///
/// Returns the status rather than a bare unit so the caller notices when the
/// lock has been taken over from under it - which is exactly when it must stop
/// writing.
#[tauri::command]
pub fn project_lock_refresh(
    state: tauri::State<'_, LockState>,
    dir: String,
) -> Result<LockStatus, String> {
    let mine = instance_id(&state);
    let path = lock_path(&dir);
    let current = read_lock(&path);
    let status = status_from(current.clone(), &mine, &dir);
    if !status.owned {
        return Ok(status);
    }
    // Retried here because an "open anyway" takeover cannot open the hold file
    // while the instance it took over from is still running.
    take_hold(&state, &dir);
    let record = LockRecord {
        heartbeat_at: now_ms(),
        ..current.expect("owned implies a record")
    };
    let text = serde_json::to_string_pretty(&record).map_err(err)?;
    super::project_io::write_atomic(&path, text.as_bytes())?;
    Ok(status_from(Some(record), &mine, &dir))
}

/// Gives the lock up. Only ever removes our own - releasing somebody else's
/// would turn a tidy-up into a way to trample a live session.
#[tauri::command]
pub fn project_lock_release(
    state: tauri::State<'_, LockState>,
    dir: String,
) -> Result<(), String> {
    let mine = instance_id(&state);
    let path = lock_path(&dir);
    // Our handle goes first: on Windows the hold file cannot be deleted while
    // it is open.
    drop_hold(&state, &dir);
    if let Some(record) = read_lock(&path) {
        if record.instance_id == mine {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(hold_path(&dir));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A machine that is definitely not this one, so the hold-file check -
    /// which only applies locally - stays out of the way.
    fn elsewhere() -> String {
        format!("NOT-{}", machine_name())
    }

    fn record_on(machine: &str, instance: &str, age_secs: i64) -> LockRecord {
        LockRecord {
            instance_id: instance.into(),
            machine: machine.into(),
            pid: 1234,
            heartbeat_at: now_ms() - age_secs * 1000,
            acquired_at: now_ms() - age_secs * 1000,
        }
    }

    fn record(instance: &str, age_secs: i64) -> LockRecord {
        record_on(&elsewhere(), instance, age_secs)
    }

    #[test]
    fn no_lock_file_means_free() {
        let status = status_from(None, "me", "");
        assert!(!status.held);
        assert!(!status.owned);
    }

    #[test]
    fn our_own_lock_is_owned_not_contended() {
        let status = status_from(Some(record("me", 5)), "me", "");
        assert!(status.held);
        assert!(status.owned);
        assert!(!status.stale);
    }

    #[test]
    fn a_live_lock_from_elsewhere_is_held_and_not_ours() {
        let status = status_from(Some(record("other", 5)), "me", "");
        assert!(status.held);
        assert!(!status.owned);
        assert!(!status.stale);
        assert_eq!(status.machine, elsewhere());
    }

    /// A crashed instance leaves its lock behind. Without staleness it would
    /// lock the admin out of their own project until they found the file.
    #[test]
    fn a_lock_that_stopped_beating_goes_stale() {
        let status = status_from(Some(record("other", STALE_AFTER_SECS + 60)), "me", "");
        assert!(status.held);
        assert!(status.stale);
    }

    #[test]
    fn a_lock_just_under_the_limit_is_still_live() {
        let status = status_from(Some(record("other", STALE_AFTER_SECS - 30)), "me", "");
        assert!(!status.stale);
    }

    /// The update case: the installer relaunched the app, so the lock is
    /// seconds old and its owner no longer exists. Waiting out the heartbeat
    /// for that is five minutes of being locked out of your own project.
    #[cfg(windows)]
    #[test]
    fn a_lock_whose_owner_died_on_this_machine_is_reclaimable_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let record = record_on(&machine_name(), "the-instance-that-died", 5);
        let status = status_from(Some(record), "me", &path);
        assert!(status.held);
        assert!(status.stale, "an owner that is gone does not hold anything");
    }

    /// Two instances really running on one machine still contend.
    #[cfg(windows)]
    #[test]
    fn a_lock_held_by_a_running_instance_on_this_machine_still_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let held = open_hold(&hold_path(&path)).expect("hold file opens");
        let record = record_on(&machine_name(), "the-other-instance", 5);
        let status = status_from(Some(record), "me", &path);
        assert!(!status.stale);
        drop(held);
        // With the handle gone the same lock reads as abandoned.
        let record = record_on(&machine_name(), "the-other-instance", 5);
        assert!(status_from(Some(record), "me", &path).stale);
    }

    #[test]
    fn the_lock_file_is_hidden_from_project_loading() {
        // load_project only takes plain *.json names, and this starts with a
        // dot - so the lock can never be parsed as project data.
        assert!(super::super::project_io::validate_file_name(LOCK_FILE).is_err());
    }
}
