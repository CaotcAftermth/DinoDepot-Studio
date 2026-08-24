/**
 * Where new projects are kept on this machine.
 *
 * Creating a project used to mean picking an empty folder every time, which
 * left an administrator's projects scattered wherever the file dialog happened
 * to open. Instead the location is asked for once — a folder named
 * `DinoDepot Studio Projects` is made inside whatever the administrator picks —
 * and every later project becomes a subfolder of it, named after the project.
 *
 * This is a machine preference, not project data: it says where *this* computer
 * files things, and synchronizing it to everybody editing the same cluster
 * would push one person's drive letters onto another's. It is kept in the
 * application-data folder, beside the machine-local project records, for that
 * reason — and, just as importantly, because it used to live in the webview's
 * `localStorage` and was therefore forgotten whenever that store was cleared.
 *
 * Nothing here is a lock-in. The location can be pointed somewhere else at any
 * time, and an existing project is opened by its own path.
 */

import { ipc } from "./ipc";

/** The folder made inside whatever parent the administrator picks. */
export const PROJECTS_FOLDER_NAME = "DinoDepot Studio Projects";

/** The name of the throwaway project offered on the welcome screen. */
export const SANDBOX_PROJECT_NAME = "Sandbox";

const ROOT_KEY = "ddstudio.projectsRoot";

/** Longest folder segment a project name is allowed to become. */
const MAX_SEGMENT = 64;

/** Characters Windows will not accept anywhere in a file or folder name. */
const ILLEGAL = new Set('<>:"/\\|?*'.split(""));

/**
 * Names Windows refuses to give a file or folder, with or without an
 * extension. Rare in a cluster name, fatal when it happens.
 */
const RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Joins with the separator already in use, so Windows paths stay Windows paths. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[/\\]+$/, "")}${sep}${name}`;
}

/** The last path segment, ignoring any trailing separator. */
export function lastSegment(dir: string): string {
  const parts = dir.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * The projects folder to use, given the parent an administrator picked.
 *
 * Picking the projects folder itself is the obvious mistake to make on the
 * second run — the dialog opens where it was last used — so a parent that is
 * already the projects folder is taken as the answer rather than nested inside
 * a second copy of itself.
 */
export function projectsRootIn(parentDir: string): string {
  const trimmed = parentDir.trim();
  if (!trimmed) return "";
  if (
    lastSegment(trimmed).toLowerCase() === PROJECTS_FOLDER_NAME.toLowerCase()
  ) {
    return trimmed.replace(/[/\\]+$/, "");
  }
  return joinPath(trimmed, PROJECTS_FOLDER_NAME);
}

/**
 * A project name reduced to one folder segment.
 *
 * Returns an empty string when nothing usable is left, which the caller must
 * treat as "ask for a different name" rather than writing to the parent folder.
 */
export function folderNameFor(projectName: string): string {
  const cleaned = [...projectName]
    .map((ch) => ((ch.codePointAt(0) ?? 0) < 0x20 || ILLEGAL.has(ch) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    // Windows silently drops a trailing dot or space, so a folder created with
    // one is not the folder that is looked for afterwards.
    .replace(/[. ]+$/, "")
    .slice(0, MAX_SEGMENT)
    .replace(/[. ]+$/, "");
  if (!cleaned) return "";
  const stem = cleaned.split(".")[0]?.toLowerCase() ?? "";
  return RESERVED.has(stem) ? `${cleaned} project` : cleaned;
}

/** Where a project of this name goes. Empty when the name yields no folder. */
export function projectDirFor(root: string, projectName: string): string {
  const segment = folderNameFor(projectName);
  if (!root.trim() || !segment) return "";
  return joinPath(root.trim(), segment);
}

/** The copy older installs wrote, kept only long enough to be adopted once. */
function legacyRoot(): string {
  try {
    return localStorage.getItem(ROOT_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** The projects folder this machine has been given, or "" if never asked. */
export async function loadProjectsRoot(): Promise<string> {
  try {
    const stored = await ipc<string | null>("projects_root_get");
    const trimmed = stored?.trim() ?? "";
    if (trimmed) return trimmed;
  } catch {
    // Unreadable is treated as never-asked: the administrator is asked again,
    // and nothing anybody made is lost.
    return "";
  }
  // An install made before the location moved out of the webview still has it
  // in the old place. Adopt it once, so upgrading is not a re-run of the very
  // question this store exists to stop asking.
  const legacy = legacyRoot();
  if (legacy) void saveProjectsRoot(legacy);
  return legacy;
}

export async function saveProjectsRoot(dir: string): Promise<void> {
  try {
    await ipc<void>("projects_root_set", { dir: dir.trim() });
  } catch {
    // Storage refused: the location is asked for again next time, which is
    // the same behaviour as a first run.
  }
}
