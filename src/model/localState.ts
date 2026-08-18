import { z } from "zod";
import { StructuredActionSchema } from "./commitActions";

/**
 * Everything about a project that is true of *this machine* rather than of the
 * project.
 *
 * Where the folder is, which GitHub account is signed in, which repositories
 * it is bound to, how far each has been synchronized — none of that travels
 * with the project, and putting it in `project.json` (as v1 did) meant two
 * administrators fought over each other's local paths on every sync.
 *
 * Keyed by the project's immutable `projectId`. Never by a path or a
 * repository name: both of those change, and a rename must not orphan a
 * binding.
 *
 * No credential ever appears here. The token lives in Windows Credential
 * Manager, and this record only names the account it is filed under.
 */

/**
 * A repository this project is bound to.
 *
 * `githubId` is the one field that establishes identity. Owner and name are
 * cached for display and for building URLs, and are re-read from the API when
 * the id says the repository has been renamed or transferred.
 */
export const RepoBindingSchema = z.object({
  /**
   * GitHub's immutable numeric repository id, as a string.
   *
   * Empty until the repository has actually been reached once. A schema-1
   * project arrives bound by name only — that version never knew the id — and
   * a binding is also half-built while setup is in progress. Requiring an id
   * here would make both of those fail to parse, and a local record that fails
   * to parse is rebuilt from nothing, which is how a migrated project would
   * quietly lose the repository it was pointing at.
   *
   * Operations that must not act on an unverified binding check for it
   * explicitly — see `canSync` and `identityMatches`.
   */
  githubId: z.string().default(""),
  owner: z.string().default(""),
  name: z.string().default(""),
  /** HTTPS remote. Stored without credentials — always. */
  remoteUrl: z.string().default(""),
  branch: z.string().default("main"),
  /** Whether GitHub reports this repository as private. */
  isPrivate: z.boolean().default(true),
});
export type RepoBinding = z.infer<typeof RepoBindingSchema>;

/** `owner/name` for a binding, for display and API paths. */
export function bindingSlug(binding: RepoBinding): string {
  return `${binding.owner}/${binding.name}`;
}

/**
 * How this project publishes.
 *
 * `source-and-delivery` is the recommended default and the only one that works
 * on GitHub Free: the source stays private, and a second public repository
 * carries the viewer. `single-private` needs a paid plan, because Pages from a
 * private repository does.
 */
export const PublishTopologySchema = z
  .enum(["source-and-delivery", "single-private"])
  .default("source-and-delivery");
export type PublishTopology = z.infer<typeof PublishTopologySchema>;

/**
 * An operation that started and has not been seen to finish.
 *
 * Written before the network call and cleared after the local state catches
 * up, so a crash in between leaves a record to reconcile against rather than a
 * question. The operation id is what makes reconciliation possible: it is in
 * the commit we may or may not have pushed, so the remote can be asked whether
 * the work already landed instead of the write being repeated blindly.
 */
export const PendingOperationSchema = z.object({
  operationId: z.string().min(1),
  kind: z.enum(["sync", "publish", "migration"]),
  startedAt: z.string().default(""),
  /** Where it got to, for the recovery message. */
  stage: z.string().default(""),
  /** Local ref holding the work, so an interrupted sync is not lost. */
  recoveryRef: z.string().default(""),
});
export type PendingOperation = z.infer<typeof PendingOperationSchema>;

export const LocalProjectStateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  projectId: z.string().min(1),
  /** Absolute path of the project folder on this machine. */
  localPath: z.string().default(""),
  /** Display name, cached so the recents list needs no disk read. */
  name: z.string().default(""),
  openedAt: z.string().default(""),

  /** Folder scanned for icon images. Empty = `<project>/images`. */
  imagesDir: z.string().default(""),
  /**
   * Per-content-source icon-art folders on this machine.
   *
   * These used to live as `ContentSource.iconsDir` in shared catalog JSON,
   * making two administrators synchronize each other's drive letters. The
   * source id is portable identity; the folder is deliberately not.
   */
  sourceIconDirs: z.record(z.string(), z.string()).default({}),
  /**
   * Package manifests or compatibility JSON installed from this machine, keyed by
   * `<packageId>@<version>`.
   *
   * A locally built development package has no published URL to re-resolve
   * from. This lets the library be rebuilt after a cache wipe without ever
   * putting a drive letter into shared project JSON.
   */
  localPackageSources: z.record(z.string(), z.string()).default({}),
  /** Resolved ASA `Mods/<gameId>` folder for Mod Discovery. */
  modsDir: z.string().default(""),

  /**
   * GitHub account id this project's operations authenticate as. The token is
   * filed under this id in Credential Manager; it is not stored here.
   */
  githubAccountId: z.string().default(""),
  githubLogin: z.string().default(""),

  source: RepoBindingSchema.nullable().default(null),
  delivery: RepoBindingSchema.nullable().default(null),
  topology: PublishTopologySchema,

  /** Source commit the local project was last reconciled with. */
  lastSyncedCommit: z.string().default(""),
  lastSyncedAt: z.string().default(""),
  /** Delivery commit the public site was last published from. */
  lastPublishedCommit: z.string().default(""),
  lastPublishedAt: z.string().default(""),
  /** Source revision that published commit was generated from. */
  lastPublishedSourceCommit: z.string().default(""),

  pending: PendingOperationSchema.nullable().default(null),

  /**
   * What has been done here since the last successful Sync, in the order it
   * happened.
   *
   * Lives in machine-local state for two reasons. It describes *this*
   * administrator's unsynchronized work, so it has no business travelling; and
   * it must survive a crash, because the alternative is a commit that can only
   * say "files changed" about an afternoon's work. It is emptied the moment a
   * Sync commit lands.
   */
  pendingActions: z.array(StructuredActionSchema).default([]),
});
export type LocalProjectState = z.infer<typeof LocalProjectStateSchema>;

export function newLocalProjectState(
  projectId: string,
  localPath: string,
  name: string,
  now = new Date(),
): LocalProjectState {
  return LocalProjectStateSchema.parse({
    projectId,
    localPath,
    name,
    openedAt: now.toISOString(),
  });
}

/** Local folder with a shared-schema fallback for projects not migrated yet. */
export function sourceIconDir(
  state: LocalProjectState | null,
  sourceId: string,
  legacy = "",
): string {
  return state?.sourceIconDirs[sourceId]?.trim() || legacy.trim();
}

export function withSourceIconDir(
  state: LocalProjectState,
  sourceId: string,
  dir: string,
): LocalProjectState {
  const sourceIconDirs = { ...state.sourceIconDirs };
  if (dir.trim()) sourceIconDirs[sourceId] = dir.trim();
  else delete sourceIconDirs[sourceId];
  return { ...state, sourceIconDirs };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * A remote URL safe to write to disk: HTTPS, github.com, no credentials.
 *
 * A token in a remote URL is the classic way one ends up committed inside
 * `.git/config`, so the check is on the way in rather than on the way out.
 */
export function isSafeRemoteUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return parsed.hostname === "github.com" || parsed.hostname.endsWith(".github.com");
}

/** The canonical remote for a repository, built rather than remembered. */
export function remoteUrlFor(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

/**
 * Whether the two repositories this project uses are distinct.
 *
 * Publishing generated output into the source repository under the delivery
 * topology would put the private roster one directory away from a public
 * Pages site, so the two bindings are required to differ by id.
 */
export function bindingsAreDistinct(state: LocalProjectState): boolean {
  if (!state.source || !state.delivery) return true;
  return state.source.githubId !== state.delivery.githubId;
}

/** Whether Sync has everything it needs. Publish additionally needs delivery. */
export function canSync(state: LocalProjectState | null): boolean {
  return Boolean(state?.source?.githubId && state.githubAccountId);
}

export function canPublish(state: LocalProjectState | null): boolean {
  if (!canSync(state) || !state) return false;
  if (state.topology === "single-private") return true;
  return Boolean(state.delivery?.githubId) && bindingsAreDistinct(state);
}

/**
 * Applies a rename or transfer detected by id.
 *
 * The id is the identity, so a changed owner or name is news about the same
 * repository — not a reason to disconnect. The remote URL is rebuilt from the
 * new names rather than kept, because the old one only works while GitHub's
 * redirect lasts.
 */
export function applyRepoRename(
  binding: RepoBinding,
  owner: string,
  name: string,
): RepoBinding {
  if (binding.owner === owner && binding.name === name) return binding;
  return { ...binding, owner, name, remoteUrl: remoteUrlFor(owner, name) };
}
