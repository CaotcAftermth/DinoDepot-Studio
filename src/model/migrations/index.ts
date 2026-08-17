import { StudioError } from "../errors";
import { CURRENT_PROJECT_SCHEMA, readProjectHeader } from "../manifest";
import { PROJECT_FILE, ProjectSettingsSchema } from "../project";
import type { LocalProjectState } from "../localState";
import type { MigrationContext, MigrationStep, ProjectFiles } from "./types";
import { v1ToV2 } from "./v1ToV2";
import { v2ToV3 } from "./v2ToV3";

export type { MigrationContext, MigrationStep, ProjectFiles } from "./types";

/**
 * Every migration this build knows, in order.
 *
 * Append only. A step that has shipped is permanent — somebody, somewhere, has
 * a project that still needs it — and its fixture test is permanent with it.
 */
export const MIGRATION_STEPS: MigrationStep[] = [v1ToV2, v2ToV3];

/** The steps needed to bring `fromSchema` up to date, oldest first. */
export function migrationPath(fromSchema: number): MigrationStep[] {
  const path: MigrationStep[] = [];
  let at = fromSchema;
  while (at < CURRENT_PROJECT_SCHEMA) {
    const step = MIGRATION_STEPS.find((s) => s.from === at);
    if (!step) return [];
    path.push(step);
    at = step.to;
  }
  return path;
}

export interface MigrationPlan {
  fromSchema: number;
  toSchema: number;
  steps: MigrationStep[];
}

/**
 * Works out how to get a project to the current schema.
 *
 * Refuses rather than improvises when the chain has a hole in it: a project at
 * schema 3 with only a 1→2 step available is not something to guess at.
 */
export function planMigration(fromSchema: number): MigrationPlan {
  if (fromSchema === CURRENT_PROJECT_SCHEMA) {
    return { fromSchema, toSchema: CURRENT_PROJECT_SCHEMA, steps: [] };
  }
  if (fromSchema > CURRENT_PROJECT_SCHEMA) {
    throw new StudioError(
      "project.schemaTooNew",
      "This project was made with a newer DinoDepot Studio.",
      { detail: `schema ${fromSchema} > ${CURRENT_PROJECT_SCHEMA}` },
    );
  }
  const steps = migrationPath(fromSchema);
  if (steps.length === 0) {
    throw new StudioError(
      "migration.failed",
      "This project uses a format this version of Studio cannot update.",
      { detail: `no migration step starts at schema ${fromSchema}` },
    );
  }
  return { fromSchema, toSchema: CURRENT_PROJECT_SCHEMA, steps };
}

export interface MigrationReport {
  fromSchema: number;
  toSchema: number;
  /** What each step did, in order, for the admin and for the commit body. */
  notes: string[];
  stepsRun: { from: number; to: number; describe: string }[];
}

export interface MigrationResult {
  files: ProjectFiles;
  localHints: Partial<LocalProjectState>;
  report: MigrationReport;
}

/**
 * Runs every step from the project's schema up to the current one, in order.
 *
 * Pure: it takes the project's files and returns new ones. Nothing is written
 * here. Staging, backup and the atomic swap are the caller's job — see
 * `migrate_project` in Rust — precisely so that a step throwing halfway leaves
 * the real project untouched by construction rather than by care.
 */
export function migrateProject(
  files: ProjectFiles,
  context: MigrationContext,
): MigrationResult {
  const settingsText = files[PROJECT_FILE.settings];
  if (!settingsText) {
    throw new StudioError(
      "migration.failed",
      "This folder has no project file to update.",
      { detail: `${PROJECT_FILE.settings} is missing` },
    );
  }

  const header = readProjectHeader(settingsText);
  if (header.schemaVersion === null) {
    throw new StudioError(
      "migration.failed",
      "This project does not say which version of the format it uses.",
      { detail: header.reason },
    );
  }

  const plan = planMigration(header.schemaVersion);
  let current = files;
  let localHints: Partial<LocalProjectState> = {};
  const notes: string[] = [];
  const stepsRun: MigrationReport["stepsRun"] = [];

  for (const step of plan.steps) {
    let outcome;
    try {
      outcome = step.run(current, context);
    } catch (e) {
      throw new StudioError(
        "migration.failed",
        "This project could not be updated. Nothing was changed — your original is untouched.",
        {
          detail: `step ${step.from}→${step.to}: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        },
      );
    }
    current = outcome.files;
    // Later steps win on a key they both set, which is the only ordering that
    // makes sense: a step closer to the current schema knows more.
    localHints = { ...localHints, ...outcome.localHints };
    notes.push(...outcome.notes);
    stepsRun.push({ from: step.from, to: step.to, describe: step.describe });

    // Every step has to land on a project that reads as its own target
    // version, not just at the end. Checking only the final result would let a
    // broken middle step hide behind a later one that happened to repair it.
    const stepHeader = readProjectHeader(current[PROJECT_FILE.settings] ?? "");
    if (stepHeader.schemaVersion !== step.to) {
      throw new StudioError(
        "migration.failed",
        "This project could not be updated. Nothing was changed — your original is untouched.",
        {
          detail: `step ${step.from}→${step.to} produced schema ${stepHeader.schemaVersion}`,
        },
      );
    }
  }

  validateMigrated(current);

  return {
    files: current,
    localHints,
    report: {
      fromSchema: plan.fromSchema,
      toSchema: plan.toSchema,
      notes,
      stepsRun,
    },
  };
}

/**
 * The gate the migrated project must pass before it may replace the original.
 *
 * Full schema parse, not a shape check: a migration that produces something
 * the app cannot hydrate has failed, however plausible the JSON looks.
 */
export function validateMigrated(files: ProjectFiles): void {
  const text = files[PROJECT_FILE.settings];
  if (!text) {
    throw new StudioError("migration.failed", "The updated project is missing its project file.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new StudioError(
      "migration.failed",
      "The updated project could not be read back. Your original is untouched.",
      { detail: e instanceof Error ? e.message : String(e) },
    );
  }
  const result = ProjectSettingsSchema.safeParse(parsed);
  if (!result.success) {
    throw new StudioError(
      "migration.failed",
      "The updated project did not come out in the expected shape. Your original is untouched.",
      { detail: result.error.message },
    );
  }
}
