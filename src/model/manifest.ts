import { z } from "zod";
import { compareVersions, STUDIO_NAME, STUDIO_VERSION } from "./studio";

/**
 * The header of `project.json`, read before anything else knows the project
 * exists.
 *
 * Hydrating a project means running it through a schema built for one exact
 * shape. Doing that first would mean a project written by a *newer* Studio
 * fails to parse and looks corrupt - when in fact it is fine and this build is
 * simply behind. So the header is read as raw JSON, on its own, and it decides
 * what happens next: open, migrate, or open read-only.
 *
 * There is deliberately no second manifest file. `project.json` is the root
 * manifest; the header is a few fields at the top of it.
 */

/** Identifies the file as a DinoDepot project rather than any other JSON. */
export const PROJECT_FORMAT = "dinodepot.project";

/** The schema this build reads and writes. Bumped by adding a migration. */
export const CURRENT_PROJECT_SCHEMA = 4;

/**
 * The oldest Studio that can safely open a project this build writes.
 *
 * Stamped into every project so an older install refuses rather than quietly
 * dropping the fields it does not know about.
 */
export const MINIMUM_STUDIO_VERSION = "0.3.0";

/**
 * Optional feature flags a project may declare.
 *
 * A capability is a promise about the project's *contents*, not about the
 * Studio that wrote it - "this project's roster has been sanitized", say. An
 * unknown capability is preserved and ignored, never an error.
 */
export const ProjectCapabilitiesSchema = z.record(z.string(), z.boolean()).default({});
export type ProjectCapabilities = z.infer<typeof ProjectCapabilitiesSchema>;

export const ProjectHeaderSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  /**
   * Immutable identity. Repository names and folder paths both change; this
   * does not, which is why it - and never a path - is what local state,
   * delivery manifests and repository bindings are keyed by.
   */
  projectId: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  minimumStudioVersion: z.string().default("0.0.0"),
  createdAt: z.string().default(""),
  capabilities: ProjectCapabilitiesSchema,
});
export type ProjectHeader = z.infer<typeof ProjectHeaderSchema>;

// ---------------------------------------------------------------------------
// Reading the header out of raw JSON
// ---------------------------------------------------------------------------

/** What a project file turned out to be, before any schema ran over it. */
export type ProjectHeaderKind =
  /** A v2-or-later manifest with a full header. */
  | "manifest"
  /** A schema-1 project: `schemaVersion: 1`, no format, no projectId. */
  | "legacy-v1"
  /** Valid JSON, but not a DinoDepot project at all. */
  | "not-a-project"
  /** Not parseable as JSON. */
  | "unreadable";

export interface ReadHeaderResult {
  kind: ProjectHeaderKind;
  /** Present for `manifest`; synthesised for `legacy-v1` where it can be. */
  schemaVersion: number | null;
  projectId: string | null;
  minimumStudioVersion: string;
  /** Why the file was rejected, for Advanced Details. Empty when it was not. */
  reason: string;
  /** The parsed JSON, so a caller can migrate or quarantine without re-reading. */
  raw: unknown;
}

/**
 * Reads the header from the raw text of `project.json`.
 *
 * Tolerant on purpose: this runs against files written by versions that do not
 * exist yet, so anything it does not recognise has to come back as a fact
 * rather than as a throw.
 */
export function readProjectHeader(text: string): ReadHeaderResult {
  const empty: ReadHeaderResult = {
    kind: "unreadable",
    schemaVersion: null,
    projectId: null,
    minimumStudioVersion: "0.0.0",
    reason: "",
    raw: undefined,
  };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ...empty, reason: e instanceof Error ? e.message : String(e) };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    // Parsed fine, so the file is not damaged - it is simply not a project.
    return {
      ...empty,
      kind: "not-a-project",
      raw,
      reason: "project.json does not contain a JSON object",
    };
  }

  const record = raw as Record<string, unknown>;
  const schemaVersion =
    typeof record.schemaVersion === "number" && Number.isInteger(record.schemaVersion)
      ? record.schemaVersion
      : null;

  if (record.format === PROJECT_FORMAT) {
    return {
      kind: "manifest",
      schemaVersion,
      projectId: typeof record.projectId === "string" ? record.projectId : null,
      minimumStudioVersion:
        typeof record.minimumStudioVersion === "string"
          ? record.minimumStudioVersion
          : "0.0.0",
      reason: "",
      raw,
    };
  }

  // Schema 1 predates the format marker. It is recognised by the combination
  // of `schemaVersion: 1` and the two fields every v1 project had - matching on
  // `schemaVersion` alone would claim any JSON file that happens to carry one.
  const looksLegacy =
    schemaVersion === 1 && typeof record.name === "string" && "defaults" in record;
  if (looksLegacy) {
    return {
      kind: "legacy-v1",
      schemaVersion: 1,
      projectId: null,
      minimumStudioVersion: "0.0.0",
      reason: "",
      raw,
    };
  }

  return {
    ...empty,
    kind: "not-a-project",
    schemaVersion,
    raw,
    reason: "project.json is missing the DinoDepot project marker",
  };
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

export type ProjectCompatibility =
  /** Open normally. */
  | "open"
  /** Older schema - run migrations, then open. */
  | "migrate"
  /** Newer schema, or a Studio requirement this build fails. Open read-only. */
  | "read-only"
  /** Not a project this build can do anything with. */
  | "reject";

export interface CompatibilityResult {
  compatibility: ProjectCompatibility;
  /** Steps that must run, oldest first, when `compatibility` is "migrate". */
  fromSchema: number | null;
  toSchema: number;
  /** One sentence for the admin. Empty when the project just opens. */
  message: string;
  detail: string;
}

/**
 * Decides what may be done with a project, given its header.
 *
 * The rule that matters most is the read-only one: an older Studio must never
 * write to a newer schema. It cannot know what it would be dropping, and the
 * project is shared - the damage lands on somebody else's machine.
 */
export function assessCompatibility(
  header: ReadHeaderResult,
  studioVersion = STUDIO_VERSION,
): CompatibilityResult {
  const base = { fromSchema: header.schemaVersion, toSchema: CURRENT_PROJECT_SCHEMA };

  if (header.kind === "unreadable" || header.kind === "not-a-project") {
    return {
      ...base,
      compatibility: "reject",
      message: "This folder does not contain a DinoDepot project that can be opened.",
      detail: header.reason,
    };
  }

  if (header.schemaVersion === null) {
    return {
      ...base,
      compatibility: "reject",
      message: "This project does not say which version of the format it uses.",
      detail: "project.json has no integer schemaVersion",
    };
  }

  if (header.schemaVersion > CURRENT_PROJECT_SCHEMA) {
    return {
      ...base,
      compatibility: "read-only",
      message: `This project was made with a newer ${STUDIO_NAME}. You can look through it, but update Studio before making changes.`,
      detail: `project schema ${header.schemaVersion}, this build reads ${CURRENT_PROJECT_SCHEMA}`,
    };
  }

  // A project may demand a newer Studio even at a schema this build knows -
  // that is the escape hatch for a change that is compatible on paper but not
  // in practice.
  if (compareVersions(studioVersion, header.minimumStudioVersion) < 0) {
    return {
      ...base,
      compatibility: "read-only",
      message: `This project needs ${STUDIO_NAME} ${header.minimumStudioVersion} or newer. You can look through it, but update Studio before making changes.`,
      detail: `minimumStudioVersion ${header.minimumStudioVersion}, running ${studioVersion}`,
    };
  }

  if (header.schemaVersion < CURRENT_PROJECT_SCHEMA) {
    return {
      ...base,
      compatibility: "migrate",
      message: "This project needs a quick update before it can be opened.",
      detail: `schema ${header.schemaVersion} → ${CURRENT_PROJECT_SCHEMA}`,
    };
  }

  return { ...base, compatibility: "open", message: "", detail: "" };
}

/** A fresh header for a project being created now. */
export function newProjectHeader(projectId: string, now = new Date()): ProjectHeader {
  return {
    format: PROJECT_FORMAT,
    projectId,
    schemaVersion: CURRENT_PROJECT_SCHEMA,
    minimumStudioVersion: MINIMUM_STUDIO_VERSION,
    createdAt: now.toISOString(),
    capabilities: {},
  };
}
