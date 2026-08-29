import { ipc } from "./ipc";
import { asStudioError, StudioError } from "../model/errors";
import { sanitizeProfile, type SanitizedProfile } from "../model/profileSanitizer";
import { profileBackupPath, type PublishResult } from "./publish";
import type { GithubConfig } from "../model/project";

/**
 * Backing a player's `.arkprofile` up.
 *
 * The one route a profile takes off this computer, and it goes through the
 * sanitizer. There is deliberately no "upload this file" function next to it:
 * a second path would eventually be the one somebody called.
 *
 * The original always stays on disk untouched. What is uploaded is a copy with
 * the player's IP address removed and verified removed.
 */

/** Result of one backup, for the roster record and the activity line. */
export interface BackupResult {
  publish: PublishResult;
  sanitized: SanitizedProfile;
}

/**
 * Reads a stored profile, sanitizes it, and uploads the sanitized copy.
 *
 * Throws `profile.unsanitizable` and uploads nothing when the file cannot be
 * read or cleaned - see `sanitizeProfile`. That is a blocking error by design:
 * skipping the player is a decision for the administrator, not a fallback.
 */
export async function backupProfile(
  config: GithubConfig,
  dir: string,
  fileName: string,
  message: string,
): Promise<BackupResult> {
  let originalB64: string;
  try {
    originalB64 = await ipc<string>("read_player_profile_b64", { dir, fileName });
  } catch (e) {
    throw asStudioError(
      e,
      "profile.unsanitizable",
      `${fileName} could not be read, so it has not been uploaded.`,
    );
  }

  // Throws rather than returning something half-cleaned. Nothing below this
  // line ever sees the original bytes.
  const sanitized = sanitizeProfile(decodeBase64(originalB64));

  const publish = await ipc<PublishResult>("github_put_file_b64", {
    accountId: config.accountId,
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    path: profileBackupPath(config, fileName),
    contentB64: encodeBase64(sanitized.bytes),
    message,
  });

  return { publish, sanitized };
}

/**
 * Pulls a backed-up profile into the project's profiles/ folder.
 *
 * What comes back is the sanitized copy - the address was never uploaded, so
 * restoring cannot bring one back. Everything the game needs is there; a
 * restored character simply has no record of where it last connected from,
 * which is a field the game rewrites on the next login anyway.
 *
 * Resolves false when the repository has no backup for that player.
 */
export async function restoreProfile(
  config: GithubConfig,
  dir: string,
  fileName: string,
): Promise<boolean> {
  const contentB64 = await ipc<string | null>("github_get_file_b64", {
    accountId: config.accountId,
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    path: profileBackupPath(config, fileName),
  });
  if (!contentB64) return false;

  // Checked on the way in as well as on the way out. A backup taken by an older
  // build, or edited by hand, does not get to put an address back on this disk
  // unnoticed - and a file that will not parse is not written over a working
  // profile.
  const bytes = decodeBase64(contentB64);
  try {
    sanitizeProfile(bytes);
  } catch (e) {
    throw asStudioError(
      e,
      "profile.unsanitizable",
      `The backup of ${fileName} could not be checked, so it has not been restored.`,
    );
  }

  await ipc<number>("write_player_profile_b64", { dir, fileName, contentB64 });
  return true;
}

// ---------------------------------------------------------------------------

/** Chunked, so a large profile cannot blow the argument limit of fromCharCode. */
const CHUNK = 0x8000;

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  const cleaned = value.replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(cleaned);
  } catch (e) {
    throw new StudioError(
      "profile.unsanitizable",
      "That profile could not be decoded, so it has not been uploaded.",
      { detail: e instanceof Error ? e.message : String(e) },
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
