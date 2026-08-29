/**
 * Identity of the application itself: which repository it lives in, and what
 * version this build is.
 *
 * Everything that needs to name the DinoDepot repository goes through here.
 * The slug used to be written out at each call site, which is how a rename
 * turns into a hunt through the codebase - and GitHub's rename redirects are
 * not something to build on, because they stop working the moment somebody
 * else claims the old name.
 */

/** The DinoDepot-owned repository: Studio source, releases, public content. */
export const STUDIO_REPO = {
  owner: "CaotcAftermth",
  repo: "DinoDepot-Studio",
  branch: "main",
} as const;

/** Product display name. Distinct from the repository slug on purpose. */
export const STUDIO_NAME = "DinoDepot Studio";

/**
 * This build's version.
 *
 * Kept in step with package.json, Cargo.toml and tauri.conf.json by
 * `scripts/check-versions.mjs`, which the release workflow runs before it
 * builds anything - a version that disagrees with the installer is how an
 * updater ships a downgrade.
 */
export const STUDIO_VERSION = "0.8.0";

/** `owner/repo`, the form GitHub URLs and the API both take. */
export function studioRepoSlug(): string {
  return `${STUDIO_REPO.owner}/${STUDIO_REPO.repo}`;
}

export function studioRepoUrl(): string {
  return `https://github.com/${studioRepoSlug()}`;
}

/** A page inside the repository, e.g. `issues` or `releases/latest`. */
export function studioRepoPath(path: string): string {
  return `${studioRepoUrl()}/${path.replace(/^\/+/, "")}`;
}

/** The `latest.json` the Tauri updater polls. */
export function studioUpdaterEndpoint(): string {
  return studioRepoPath("releases/latest/download/latest.json");
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers, e.g. `["beta", 2]` for `1.2.0-beta.2`. */
  prerelease: (string | number)[];
}

/** Parses a SemVer string, or null when it is not one. Build metadata is ignored. */
export function parseSemVer(value: string): SemVer | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: (match[4] ?? "")
      .split(".")
      .filter(Boolean)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
  };
}

/**
 * Standard SemVer ordering: -1 when `a` is older, 1 when newer, 0 when equal.
 *
 * A pre-release sorts *before* the release it leads to (1.0.0-beta < 1.0.0),
 * which is the rule that stops an updater offering 1.0.0-beta to someone
 * already running 1.0.0.
 */
export function compareSemVer(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    // A shorter set of identifiers sorts first when all else is equal.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftIsNumber = typeof left === "number";
    const rightIsNumber = typeof right === "number";
    // Numeric identifiers always sort below alphanumeric ones.
    if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Compares two version strings. An unparseable version sorts as older than any
 * real one, so a project claiming `minimumStudioVersion: "banana"` opens rather
 * than locking the admin out over a typo somebody else made.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseSemVer(a);
  const right = parseSemVer(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return compareSemVer(left, right);
}

/** Whether this build is at least `required`. */
export function studioSatisfies(required: string, current = STUDIO_VERSION): boolean {
  return compareVersions(current, required) >= 0;
}
