import { z } from "zod";
import { STUDIO_VERSION } from "./studio";
import { findIpAddresses } from "./profileSanitizer";

/**
 * The public artifact: everything that goes to the delivery repository, and
 * nothing else.
 *
 * Built into a staging map first, scanned, and only then committed. The scan is
 * the part that matters — the project this is generated from holds a player
 * roster and profile backups, and the site is world-readable forever once it is
 * pushed.
 *
 * ```
 * docs/
 *   .nojekyll
 *   index.html
 *   dinodepot-build.json
 *   data/
 *   assets/icons/
 * ```
 */

/** Root of the published tree. GitHub Pages serves `main:/docs`. */
export const PUBLIC_ROOT = "docs";

/**
 * Version of the *published output* contract — what a viewer can expect to
 * find. Independent of the project schema and of the Studio version, because a
 * viewer cached in somebody's browser has to keep working across both.
 */
export const PUBLIC_OUTPUT_VERSION = 1;

export const BuildManifestSchema = z.object({
  projectId: z.string().min(1),
  /** Source commit this was generated from. The link back to the private side. */
  sourceRevision: z.string().min(1),
  /** Unique per Publish, so a deployment can be recognised as live. */
  publishOperationId: z.string().min(1),
  outputVersion: z.number().int().positive(),
  generatedAt: z.string().min(1),
  studioVersion: z.string().min(1),
});
export type BuildManifest = z.infer<typeof BuildManifestSchema>;

/** Files to publish, keyed by path relative to {@link PUBLIC_ROOT}. */
export type PublicFiles = Record<string, string>;

export interface ArtifactInput {
  projectId: string;
  sourceRevision: string;
  publishOperationId: string;
  /** The viewer page. */
  indexHtml: string;
  /** Data files, keyed by name under `data/`. */
  data: Record<string, string>;
  now?: Date;
  studioVersion?: string;
}

/**
 * Assembles the staged tree.
 *
 * `.nojekyll` is not optional: without it GitHub Pages runs the output through
 * Jekyll, which silently drops any file or folder beginning with an underscore.
 */
export function buildArtifact(input: ArtifactInput): {
  files: PublicFiles;
  manifest: BuildManifest;
} {
  const manifest: BuildManifest = BuildManifestSchema.parse({
    projectId: input.projectId,
    sourceRevision: input.sourceRevision,
    publishOperationId: input.publishOperationId,
    outputVersion: PUBLIC_OUTPUT_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    studioVersion: input.studioVersion ?? STUDIO_VERSION,
  });

  const files: PublicFiles = {
    ".nojekyll": "",
    "index.html": input.indexHtml,
    "dinodepot-build.json": `${JSON.stringify(manifest, null, 2)}\n`,
  };
  for (const [name, content] of Object.entries(input.data)) {
    files[`data/${name}`] = content;
  }
  return { files, manifest };
}

/** Staged paths, as they sit in the delivery repository. */
export function artifactPaths(files: PublicFiles): string[] {
  return Object.keys(files)
    .map((name) => `${PUBLIC_ROOT}/${name}`)
    .sort();
}

// ---------------------------------------------------------------------------
// The public boundary
// ---------------------------------------------------------------------------

export type BoundaryViolationKind =
  | "profile"
  | "roster"
  | "ip-address"
  | "local-path"
  | "credential"
  | "temporary";

export interface BoundaryViolation {
  kind: BoundaryViolationKind;
  path: string;
  /** What was found, already trimmed. Never the whole file. */
  evidence: string;
}

/** File names that must never appear in the public tree, whatever their content. */
const FORBIDDEN_NAMES = [
  { pattern: /\.arkprofile$/i, kind: "profile" as const },
  { pattern: /(^|\/)players\.json$/i, kind: "roster" as const },
  { pattern: /(^|\/)profiles\//i, kind: "profile" as const },
  { pattern: /\.(tmp|bak|orig|swp)$/i, kind: "temporary" as const },
  { pattern: /(^|\/)\.git(\/|$)/i, kind: "temporary" as const },
];

/** Roster fields that identify a real person. None belong on a public site. */
const PRIVATE_FIELDS = [
  "discordId",
  "discordName",
  "steamId",
  "steamName",
  "eosId",
  "accountName",
  "playerDataId",
  "lastKnownIp",
  "SavedNetworkAddress",
];

/** Windows and UNC absolute paths — somebody's folder layout is not public data. */
const LOCAL_PATH_PATTERNS = [
  /\b[A-Za-z]:\\\\?[^"'\s]{2,}/g,
  /\\\\\\\\[^"'\s]{2,}/g,
  /\/(?:Users|home)\/[^"'\s/]+\//g,
];

const CREDENTIAL_PATTERNS = [
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{10,}/g,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/g,
];

/**
 * The last check before anything is committed to a public repository.
 *
 * Deliberately paranoid and content-based rather than trusting the generator:
 * the generator is what would have the bug. Runs over the staged files, so
 * nothing has been pushed when it finds something.
 */
export function scanPublicBoundary(files: PublicFiles): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  for (const [path, content] of Object.entries(files)) {
    for (const { pattern, kind } of FORBIDDEN_NAMES) {
      if (pattern.test(path)) {
        violations.push({ kind, path, evidence: path });
      }
    }

    for (const field of PRIVATE_FIELDS) {
      // Matched as a JSON key, so a creature called "accountName" in prose does
      // not trip it but a serialized roster does.
      if (new RegExp(`"${field}"\\s*:`).test(content)) {
        violations.push({ kind: "roster", path, evidence: `"${field}":` });
      }
    }

    for (const address of findIpAddresses(content)) {
      violations.push({ kind: "ip-address", path, evidence: address });
    }

    for (const pattern of LOCAL_PATH_PATTERNS) {
      for (const match of content.matchAll(pattern)) {
        violations.push({ kind: "local-path", path, evidence: trim(match[0]) });
      }
    }

    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(content)) {
        // The evidence is the kind, never the value.
        violations.push({ kind: "credential", path, evidence: "a credential" });
      }
    }
  }

  return dedupe(violations);
}

function trim(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value;
}

function dedupe(violations: BoundaryViolation[]): BoundaryViolation[] {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.kind}:${v.path}:${v.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One sentence per violation, for the blocking message. */
export function describeViolation(violation: BoundaryViolation): string {
  switch (violation.kind) {
    case "profile":
      return `${violation.path} is a player save file.`;
    case "roster":
      return `${violation.path} contains private roster data (${violation.evidence}).`;
    case "ip-address":
      return `${violation.path} contains an IP address (${violation.evidence}).`;
    case "local-path":
      return `${violation.path} contains a folder path from this computer (${violation.evidence}).`;
    case "credential":
      return `${violation.path} appears to contain ${violation.evidence}.`;
    case "temporary":
      return `${violation.path} is a temporary or internal file.`;
  }
}

/**
 * Whether the published site is the one this Publish produced.
 *
 * Compared by operation id rather than by commit: the delivery commit is known
 * as soon as it is pushed, but "is it *live*" is a question only the served
 * manifest can answer, and Pages takes its time.
 */
export function isDeployed(
  served: unknown,
  expected: Pick<BuildManifest, "publishOperationId">,
): boolean {
  const parsed = BuildManifestSchema.safeParse(served);
  return parsed.success && parsed.data.publishOperationId === expected.publishOperationId;
}
