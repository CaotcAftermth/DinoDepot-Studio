import { ipc } from "./ipc";
import type { GithubConfig } from "../model/project";
import type { OutputFamily } from "../model/history";

export interface GithubStatus {
  ok: boolean;
  message: string;
}

export interface RemoteFile {
  exists: boolean;
  sha: string | null;
  content: string | null;
}

export interface PublishResult {
  commit_sha: string;
  content_sha: string;
}

export function outputPath(config: GithubConfig, family: OutputFamily): string {
  return config.paths[family];
}

export function rawUrl(config: GithubConfig, family: OutputFamily): string {
  return `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/${outputPath(config, family)}`;
}

/** RAW base URL of the repo's images/ folder (used by the cluster viewer). */
export function rawImagesUrl(config: GithubConfig): string {
  return `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/images`;
}

export function githubConfigComplete(config: GithubConfig): boolean {
  return Boolean(config.owner && config.repo && config.branch);
}

export async function testConnection(config: GithubConfig): Promise<GithubStatus> {
  return ipc<GithubStatus>("github_test", {
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
  });
}

export async function fetchRemote(
  config: GithubConfig,
  family: OutputFamily,
): Promise<RemoteFile> {
  return ipc<RemoteFile>("github_get_file", {
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    path: outputPath(config, family),
  });
}

export async function publishFile(
  config: GithubConfig,
  family: OutputFamily,
  content: string,
  message: string,
): Promise<PublishResult> {
  return ipc<PublishResult>("github_put_file", {
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    path: outputPath(config, family),
    content,
    message,
  });
}

// ---------------------------------------------------------------------------
// Player .arkprofile backup — binary files, published one per player
// ---------------------------------------------------------------------------

/** Repo path a player's profile backup lives at. */
export function profileBackupPath(
  config: GithubConfig,
  fileName: string,
): string {
  return `${config.paths.profiles.replace(/\/+$/, "")}/${fileName}`;
}

/**
 * Uploads a stored .arkprofile to the repo. The file never passes through the
 * frontend as text — Rust reads it as base64 and GitHub takes it that way.
 */
export async function backupProfile(
  config: GithubConfig,
  dir: string,
  fileName: string,
  message: string,
): Promise<PublishResult> {
  const contentB64 = await ipc<string>("read_player_profile_b64", {
    dir,
    fileName,
  });
  return ipc<PublishResult>("github_put_file_b64", {
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    path: profileBackupPath(config, fileName),
    contentB64,
    message,
  });
}

/**
 * Pulls a backed-up profile into the project's profiles/ folder.
 * Resolves false when the repo has no backup for that player.
 */
export async function restoreProfile(
  config: GithubConfig,
  dir: string,
  fileName: string,
): Promise<boolean> {
  const contentB64 = await ipc<string | null>("github_get_file_b64", {
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    path: profileBackupPath(config, fileName),
  });
  if (!contentB64) return false;
  await ipc<number>("write_player_profile_b64", { dir, fileName, contentB64 });
  return true;
}

/** Stable content hash (FNV-1a) used to detect unpublished draft changes. */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
