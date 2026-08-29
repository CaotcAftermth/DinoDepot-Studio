import { asStudioError, StudioError } from "../model/errors";
import { compareVersions, parseSemVer, STUDIO_VERSION } from "../model/studio";
import { isTauri } from "./ipc";

/**
 * Updating DinoDepot Studio itself.
 *
 * The update is signed, and the signature is checked by the Tauri updater
 * before anything is run. That is the whole security model: the manifest lives
 * on a GitHub release, which anybody with push access could replace, so the
 * only thing making an update trustworthy is that it was signed with a key that
 * never leaves the maintainer's hands.
 *
 * Two rules this layer adds on top:
 *
 * 1. **Never a downgrade.** A release mistakenly published with an older
 *    version tag must not roll everybody back.
 * 2. **Never silent.** The administrator is told what version, and is the one
 *    who says go - this app holds a cluster's configuration, and restarting it
 *    mid-edit is not something to decide on their behalf.
 */

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "ready"
  | "failed"
  | "unsupported";

export const UPDATE_STATE_LABELS: Record<UpdateState, string> = {
  idle: "",
  checking: "Checking for updates",
  available: "Update available",
  "up-to-date": "Up to date",
  downloading: "Downloading update",
  ready: "Ready to restart",
  failed: "Could not check for updates",
  unsupported: "Updates are handled by the desktop app",
};

export interface AvailableUpdate {
  version: string;
  /** Release notes, as published. May be empty. */
  notes: string;
  date: string;
}

/**
 * Whether an offered version should be installed.
 *
 * The updater already refuses same-version updates, but not older ones - a
 * release published with the wrong tag would otherwise roll every install
 * backwards. An unparseable version is refused rather than guessed at.
 */
export function isUpgrade(offered: string, current = STUDIO_VERSION): boolean {
  if (!parseSemVer(offered) || !parseSemVer(current)) return false;
  return compareVersions(offered, current) > 0;
}

/** What to say about an update that is not one. */
export function describeRejection(offered: string, current = STUDIO_VERSION): string {
  if (!parseSemVer(offered)) {
    return `The update server offered a version DinoDepot cannot read (${offered}). Nothing has been installed.`;
  }
  if (compareVersions(offered, current) < 0) {
    return `The update server offered ${offered}, which is older than the ${current} you are running. Nothing has been installed.`;
  }
  return `You are running the latest version (${current}).`;
}

/**
 * The updater plugin, loaded on demand.
 *
 * Imported lazily so browser mock mode - which has no Tauri at all - does not
 * fail at module load.
 */
async function plugin() {
  return import("@tauri-apps/plugin-updater");
}

export interface CheckResult {
  state: UpdateState;
  update: AvailableUpdate | null;
  message: string;
  /** Opaque handle for `downloadAndInstall`. Held by the caller, not stored. */
  handle: unknown;
}

/** Asks the release endpoint whether there is anything newer. */
export async function checkForUpdate(): Promise<CheckResult> {
  if (!isTauri) {
    return {
      state: "unsupported",
      update: null,
      message: UPDATE_STATE_LABELS.unsupported,
      handle: null,
    };
  }

  try {
    const { check } = await plugin();
    const found = await check();

    if (!found) {
      return {
        state: "up-to-date",
        update: null,
        message: describeRejection(STUDIO_VERSION),
        handle: null,
      };
    }

    // The signature has already been verified by the plugin; this is the
    // version check on top of it.
    if (!isUpgrade(found.version)) {
      return {
        state: "up-to-date",
        update: null,
        message: describeRejection(found.version),
        handle: null,
      };
    }

    return {
      state: "available",
      update: {
        version: found.version,
        notes: found.body ?? "",
        date: found.date ?? "",
      },
      message: `DinoDepot Studio ${found.version} is available.`,
      handle: found,
    };
  } catch (e) {
    return {
      state: "failed",
      update: null,
      message: updateFailureMessage(e),
      handle: null,
    };
  }
}

/**
 * Turns an updater failure into something an administrator can act on.
 *
 * A signature failure is worth saying plainly: it means the file on the release
 * is not one this build will trust, which is either a broken upload or
 * something worse. Either way it must not be installed.
 */
export function updateFailureMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const lower = text.toLowerCase();

  if (lower.includes("signature") || lower.includes("verify")) {
    return "The update could not be verified as genuine and has not been installed. Download DinoDepot Studio from the releases page instead.";
  }
  if (
    lower.includes("network") ||
    lower.includes("dns") ||
    lower.includes("connect") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return "DinoDepot could not reach the update server. Your work is unaffected - try again later.";
  }
  return "DinoDepot could not check for updates. Your work is unaffected.";
}

export interface InstallProgress {
  /** Bytes downloaded so far, when the server said how many to expect. */
  downloaded: number;
  total: number;
}

/**
 * Downloads and installs, then relaunches.
 *
 * The caller is expected to have flushed and closed anything unsaved first -
 * this restarts the application, and an administrator mid-edit should have been
 * asked before reaching here.
 */
export async function installUpdate(
  handle: unknown,
  onProgress?: (progress: InstallProgress) => void,
): Promise<void> {
  if (!isTauri || !handle) {
    throw new StudioError(
      "unknown",
      "Updates are handled by the desktop app.",
      { detail: "no updater available" },
    );
  }

  let downloaded = 0;
  let total = 0;

  try {
    const update = handle as {
      downloadAndInstall(
        onEvent: (event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void,
      ): Promise<void>;
    };

    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data?.contentLength ?? 0;
        downloaded = 0;
      } else if (event.event === "Progress") {
        downloaded += event.data?.chunkLength ?? 0;
      }
      onProgress?.({ downloaded, total });
    });

    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    throw asStudioError(e, "unknown", updateFailureMessage(e));
  }
}

/** Progress as a percentage, or null when the size was never announced. */
export function progressPercent(progress: InstallProgress): number | null {
  if (progress.total <= 0) return null;
  return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
}
