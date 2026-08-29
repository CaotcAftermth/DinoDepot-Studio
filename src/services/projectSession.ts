import { ipc } from "./ipc";
import { asStudioError, StudioError } from "../model/errors";
import { newId } from "../model/ids";
import {
  assessCompatibility,
  type CompatibilityResult,
  CURRENT_PROJECT_SCHEMA,
  PROJECT_FORMAT,
  readProjectHeader,
  type ReadHeaderResult,
} from "../model/manifest";
import {
  LocalProjectStateSchema,
  newLocalProjectState,
  type LocalProjectState,
} from "../model/localState";
import { migrateProject, type MigrationReport } from "../model/migrations";
import { PROJECT_FILE, ProjectSettingsSchema, type ProjectSettings } from "../model/project";

/**
 * Opening a project, in the order the checks have to happen.
 *
 * The order is the whole point. Reading the manifest header comes before
 * hydrating anything, because a project from a newer Studio parses as garbage
 * under this build's schema and would otherwise look corrupt. Taking the lock
 * comes before migrating, because a migration is the one operation where two
 * instances would destroy each other's work outright.
 */

export interface LockStatus {
  held: boolean;
  owned: boolean;
  stale: boolean;
  machine: string;
  instanceId: string;
  heartbeatAt: number;
}

/** What an open attempt found, before anything has been changed. */
export interface ProjectInspection {
  dir: string;
  header: ReadHeaderResult;
  compatibility: CompatibilityResult;
  files: Record<string, string>;
  lock: LockStatus;
}

export type ProjectMode = "editable" | "read-only";

export interface OpenProjectResult {
  dir: string;
  settings: ProjectSettings;
  local: LocalProjectState;
  files: Record<string, string>;
  mode: ProjectMode;
  /** Why the project opened read-only. Empty when it is editable. */
  readOnlyReason: string;
  /** Present when a migration ran as part of this open. */
  migration: MigrationReport | null;
  /** Absolute path of the snapshot a migration took, for the recovery UI. */
  migrationSnapshot: string;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/**
 * Reads a project folder and works out what may be done with it.
 *
 * Changes nothing. The caller decides whether to migrate, whether to take a
 * contended lock, and whether the admin gets asked first.
 */
export async function inspectProject(dir: string): Promise<ProjectInspection> {
  let files: Record<string, string>;
  try {
    files = await ipc<Record<string, string>>("load_project", { dir });
  } catch (e) {
    throw asStudioError(
      e,
      "project.corrupt",
      "That folder could not be opened as a DinoDepot project.",
    );
  }

  const header = readProjectHeader(files[PROJECT_FILE.settings] ?? "");
  const compatibility = assessCompatibility(header);
  const lock = await lockStatus(dir);
  return { dir, header, compatibility, files, lock };
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

const NO_LOCK: LockStatus = {
  held: false,
  owned: false,
  stale: false,
  machine: "",
  instanceId: "",
  heartbeatAt: 0,
};

export async function lockStatus(dir: string): Promise<LockStatus> {
  try {
    return await ipc<LockStatus>("project_lock_status", { dir });
  } catch {
    // Browser mock mode, or an older backend. A lock that cannot be read is
    // treated as absent - it is an advisory, and refusing to open a project
    // because the advisory system is unavailable helps nobody.
    return NO_LOCK;
  }
}

export async function acquireLock(dir: string, force = false): Promise<LockStatus> {
  try {
    return await ipc<LockStatus>("project_lock_acquire", { dir, force });
  } catch (e) {
    throw asStudioError(
      e,
      "project.locked",
      e instanceof Error ? e.message : String(e ?? "This project is open elsewhere."),
    );
  }
}

export async function releaseLock(dir: string): Promise<void> {
  try {
    await ipc("project_lock_release", { dir });
  } catch {
    /* releasing is best-effort; a stale lock times out on its own */
  }
}

export async function refreshLock(dir: string): Promise<LockStatus> {
  try {
    return await ipc<LockStatus>("project_lock_refresh", { dir });
  } catch {
    return NO_LOCK;
  }
}

// ---------------------------------------------------------------------------
// Machine-local state
// ---------------------------------------------------------------------------

export async function loadLocalState(
  projectId: string,
  dir: string,
  name: string,
): Promise<LocalProjectState> {
  let text: string | null = null;
  try {
    text = await ipc<string | null>("local_state_get", { projectId });
  } catch {
    /* first run, or no app-data folder - fall through to a fresh record */
  }
  if (!text) return newLocalProjectState(projectId, dir, name);

  const parsed = LocalProjectStateSchema.safeParse(safeJson(text));
  if (!parsed.success) {
    // Nothing in here is the admin's work: a bad record is rebuilt, never
    // mourned. The repository binding is re-established on next connect.
    return newLocalProjectState(projectId, dir, name);
  }
  // The folder may have been moved since last time. The record follows it -
  // the id is the identity, not the path.
  return { ...parsed.data, localPath: dir, name, openedAt: new Date().toISOString() };
}

export async function saveLocalState(state: LocalProjectState): Promise<void> {
  await ipc("local_state_set", {
    projectId: state.projectId,
    content: JSON.stringify(state, null, 2),
  });
}

/** Every project this machine has opened, newest first. */
export async function listLocalProjects(): Promise<LocalProjectState[]> {
  let records: string[];
  try {
    records = await ipc<string[]>("local_state_list", {});
  } catch {
    return [];
  }
  return records
    .flatMap((text) => {
      const parsed = LocalProjectStateSchema.safeParse(safeJson(text));
      return parsed.success ? [parsed.data] : [];
    })
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface MigrationOutcome {
  files: Record<string, string>;
  local: LocalProjectState;
  report: MigrationReport;
  snapshotPath: string;
}

/**
 * Migrates a project on disk.
 *
 * The transformation is pure and already tested against fixtures; what happens
 * here is the part that touches files. Rust takes a complete snapshot, stages
 * every new file, reads them back, and only then swaps them in - so a failure
 * before the swap leaves the project exactly as it was, and a failure during it
 * leaves a snapshot to restore from.
 */
export async function runMigration(
  dir: string,
  files: Record<string, string>,
  existingProjectId: string | null,
): Promise<MigrationOutcome> {
  const projectId = existingProjectId || newId();
  const result = migrateProject(files, { projectId, now: new Date() });

  // Only the files the migration actually changed are written back. Rewriting
  // the untouched ones would churn every backup for nothing.
  const changed: Record<string, string> = {};
  for (const [name, content] of Object.entries(result.files)) {
    if (files[name] !== content) changed[name] = content;
  }

  let snapshotPath = "";
  try {
    const info = await ipc<{ path: string; fileCount: number }>(
      "commit_migrated_project",
      { dir, files: changed },
    );
    snapshotPath = info.path;
  } catch (e) {
    throw asStudioError(
      e,
      "migration.failed",
      "This project could not be updated. Nothing was changed - your original is untouched.",
    );
  }

  const base = await loadLocalState(projectId, dir, "");
  const local: LocalProjectState = {
    ...base,
    ...result.localHints,
    projectId,
    localPath: dir,
  };
  await saveLocalState(local);

  return { files: result.files, local, report: result.report, snapshotPath };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface QuarantineResult {
  fileName: string;
  movedTo: string;
}

/**
 * Sets a file aside that could not be understood.
 *
 * Called instead of carrying on with empty data. The old behaviour - hydrate
 * empty, keep going - meant the next autosave wrote nothing over a file that
 * was merely unreadable, turning a recoverable problem into a lost roster.
 */
export async function quarantineFile(
  dir: string,
  fileName: string,
): Promise<QuarantineResult> {
  const movedTo = await ipc<string>("quarantine_project_file", { dir, fileName });
  return { fileName, movedTo };
}

/** Takes a full copy of the project, for a destructive operation or on demand. */
export async function snapshotProject(dir: string, label: string): Promise<string> {
  const info = await ipc<{ path: string; fileCount: number }>("snapshot_project", {
    dir,
    label,
  });
  return info.path;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Turns inspected files into a hydrated project, migrating if that is what the
 * compatibility check asked for.
 *
 * `force` carries the admin's decision to take over a lock somebody else holds;
 * nothing here decides that on their behalf.
 */
export async function openInspectedProject(
  inspection: ProjectInspection,
  options: { force?: boolean } = {},
): Promise<OpenProjectResult> {
  const { dir, compatibility, header } = inspection;

  if (compatibility.compatibility === "reject") {
    throw new StudioError("project.corrupt", compatibility.message, {
      detail: compatibility.detail,
    });
  }

  const readOnly = compatibility.compatibility === "read-only";
  // A read-only project takes no lock: it cannot write, so it cannot collide,
  // and holding the lock would keep an administrator with a newer Studio out.
  if (!readOnly) {
    await acquireLock(dir, options.force ?? false);
  }

  let files = inspection.files;
  let migration: MigrationReport | null = null;
  let migrationSnapshot = "";
  let local: LocalProjectState | null = null;

  if (compatibility.compatibility === "migrate") {
    const outcome = await runMigration(dir, files, header.projectId);
    files = outcome.files;
    migration = outcome.report;
    migrationSnapshot = outcome.snapshotPath;
    local = outcome.local;
  }

  const settings = parseSettings(files[PROJECT_FILE.settings] ?? "", readOnly);
  if (!local) {
    local = await loadLocalState(settings.projectId, dir, settings.name);
    if (!readOnly) await saveLocalState(local);
  } else {
    local = { ...local, name: settings.name };
    await saveLocalState(local);
  }

  return {
    dir,
    settings,
    local,
    files,
    mode: readOnly ? "read-only" : "editable",
    readOnlyReason: readOnly ? compatibility.message : "",
    migration,
    migrationSnapshot,
  };
}

/**
 * Parses the manifest into the current schema.
 *
 * A read-only project is one this build does not fully understand, so it gets a
 * best-effort parse: enough to show the admin what they have, never enough to
 * be written back.
 */
function parseSettings(text: string, readOnly: boolean): ProjectSettings {
  const raw = safeJson(text);
  const parsed = ProjectSettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (!readOnly) {
    throw new StudioError(
      "project.corrupt",
      "This project file could not be read. Its previous versions are in the project's backups folder.",
      { detail: parsed.error.message },
    );
  }
  // Fill in what a newer schema may have moved or renamed, so the read-only
  // view has something to show rather than refusing outright.
  const record = (raw ?? {}) as Record<string, unknown>;
  return ProjectSettingsSchema.parse({
    ...record,
    format: PROJECT_FORMAT,
    projectId: typeof record.projectId === "string" ? record.projectId : newId(),
    // Coerced so the in-memory copy satisfies this build's schema. Safe only
    // because a read-only project is never written back - the file on disk
    // keeps its real version, and its unknown fields, untouched.
    schemaVersion: CURRENT_PROJECT_SCHEMA,
    name: typeof record.name === "string" && record.name ? record.name : "Unknown project",
    cluster: typeof record.cluster === "string" ? record.cluster : "",
    defaults:
      record.defaults ??
      {
        intervalSeconds: 300,
        chanceToProduce: 1,
        quantityPerDino: 1,
        maxQuantityPerCycle: 0,
        maxQuantityInTerminal: 0,
      },
    simulator:
      record.simulator ??
      {
        defaultHours: 24,
        defaultCreatureCount: 10,
        highOutputPerHour: 500,
        lowOutputPerHour: 1,
      },
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
