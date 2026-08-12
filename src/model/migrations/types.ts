import type { LocalProjectState } from "../localState";

/**
 * A project mid-migration: every file in the project folder, as raw text.
 *
 * Raw text rather than parsed models on purpose. A migration's whole job is to
 * turn a shape this build no longer has a schema for into one it does, so it
 * cannot start by running the current schema over the old file.
 */
export type ProjectFiles = Record<string, string>;

export interface MigrationContext {
  /**
   * The id to give a project that has none. Supplied rather than generated so
   * a migration is a pure function of its inputs, which is what makes the
   * fixture tests reproducible.
   */
  projectId: string;
  now: Date;
}

export interface MigrationOutcome {
  files: ProjectFiles;
  /**
   * Values lifted out of the portable project and into this machine's local
   * state — repository binding, image folder, mods folder. The caller writes
   * them; the migration only says what they are.
   */
  localHints: Partial<LocalProjectState>;
  /** One line per meaningful change, for the migration's activity entry. */
  notes: string[];
}

/**
 * One step from one schema to the next.
 *
 * Steps are always adjacent — 1→2, 2→3 — and never skip. A "jump" migration
 * looks like a shortcut until the intermediate step is the one that carried
 * the data-repair logic, at which point the skipped project is quietly wrong.
 */
export interface MigrationStep {
  from: number;
  to: number;
  /** Shown in the migration report and in the resulting commit. */
  describe: string;
  run(files: ProjectFiles, context: MigrationContext): MigrationOutcome;
}
