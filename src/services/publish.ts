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
  return Boolean(config.accountId && config.owner && config.repo && config.branch);
}

export async function testConnection(config: GithubConfig): Promise<GithubStatus> {
  return ipc<GithubStatus>("github_test", {
    accountId: config.accountId,
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
    accountId: config.accountId,
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
    accountId: config.accountId,
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    path: outputPath(config, family),
    content,
    message,
  });
}

// ---------------------------------------------------------------------------
// Player .arkprofile backup - binary files, published one per player
// ---------------------------------------------------------------------------

/** Repo path a player's profile backup lives at. */
export function profileBackupPath(
  config: GithubConfig,
  fileName: string,
): string {
  return `${config.paths.profiles.replace(/\/+$/, "")}/${fileName}`;
}

/*
 * Profile upload and restore deliberately do NOT live here.
 *
 * They are in `profileBackup.ts`, behind the sanitizer. This module is the
 * generic "put a file in the repository" layer, and a profile-shaped function
 * next to it would eventually be the one somebody called - uploading the
 * original bytes, IP address and all.
 */

/** Stable content hash (FNV-1a) used to detect unpublished draft changes. */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
