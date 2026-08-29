import { ipc } from "./ipc";
import { base64ToBytes, isProfileFileName, type ProfileFile } from "./profileImport";

/**
 * Reading `.arkprofile` files that live outside the project folder.
 *
 * Three places need this - the drop zone, the import picker, and the template
 * picker - and each one previously repeated the same read-and-decode dance.
 */

/** What `read_profile_file_b64` returns. Field names must match the Rust struct. */
export interface ProfileFileContent {
  contentB64: string;
  /** Epoch milliseconds; 0 when the OS would not say. */
  modifiedAt: number;
}

export interface ReadPathsResult {
  files: ProfileFile[];
  /** Names that were not profiles at all. */
  ignored: string[];
  /** Files that are profiles but could not be read off disk. */
  errors: string[];
}

export const fileNameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Reads one profile by path, bytes and timestamp together. */
export async function readProfilePath(path: string): Promise<ProfileFile> {
  const content = await ipc<ProfileFileContent>("read_profile_file_b64", { path });
  return {
    fileName: fileNameOf(path),
    bytes: base64ToBytes(content.contentB64),
    modifiedAt: content.modifiedAt,
  };
}

/**
 * Reads a batch of paths, keeping going past anything that fails.
 *
 * An import of a hundred files must not be lost to one unreadable name, so
 * failures are collected and reported rather than thrown.
 */
export async function readProfilePaths(paths: string[]): Promise<ReadPathsResult> {
  const files: ProfileFile[] = [];
  const ignored: string[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    const fileName = fileNameOf(path);
    if (!isProfileFileName(fileName)) {
      ignored.push(fileName);
      continue;
    }
    try {
      files.push(await readProfilePath(path));
    } catch (e) {
      errors.push(`${fileName}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { files, ignored, errors };
}
