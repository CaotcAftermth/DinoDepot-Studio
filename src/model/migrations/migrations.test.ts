import { describe, expect, it } from "vitest";
import { isStudioError } from "../errors";
import { CURRENT_PROJECT_SCHEMA, readProjectHeader } from "../manifest";
import { PROJECT_FILE, ProjectSettingsSchema } from "../project";
import {
  canSync,
  LocalProjectStateSchema,
  newLocalProjectState,
} from "../localState";
import { MIGRATION_STEPS, migrateProject, migrationPath, planMigration } from "./index";
import { FIXTURE_IP, SCHEMA_V1_PROJECT } from "./__fixtures__/schema-v1";

const CONTEXT = {
  projectId: "11111111-2222-4333-8444-555555555555",
  now: new Date("2026-08-09T12:00:00.000Z"),
};

describe("migration chain", () => {
  /**
   * The chain has to be unbroken and adjacent. A gap means some released
   * project has no route forward; a jump means the step that carried the data
   * repair gets skipped.
   */
  it("covers every schema from 1 to the current one, one step at a time", () => {
    for (let from = 1; from < CURRENT_PROJECT_SCHEMA; from++) {
      const path = migrationPath(from);
      expect(path.length, `no path from schema ${from}`).toBeGreaterThan(0);
      expect(path[0].from).toBe(from);
      expect(path[path.length - 1].to).toBe(CURRENT_PROJECT_SCHEMA);
      for (const step of path) {
        expect(step.to, `step ${step.from}→${step.to} is not adjacent`).toBe(step.from + 1);
      }
    }
  });

  it("has no duplicate or overlapping steps", () => {
    const starts = MIGRATION_STEPS.map((s) => s.from);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it("plans nothing for a project already current", () => {
    expect(planMigration(CURRENT_PROJECT_SCHEMA).steps).toEqual([]);
  });

  it("refuses to downgrade a newer project", () => {
    try {
      planMigration(CURRENT_PROJECT_SCHEMA + 1);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isStudioError(e) && e.code).toBe("project.schemaTooNew");
    }
  });

  it("refuses when the chain has a hole in it", () => {
    try {
      planMigration(0);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isStudioError(e) && e.code).toBe("migration.failed");
    }
  });
});

describe("schema 1 to current, against the released v1 fixture", () => {
  const result = () => migrateProject(SCHEMA_V1_PROJECT, CONTEXT);

  it("produces a project the current schema accepts", () => {
    const manifest = JSON.parse(result().files[PROJECT_FILE.settings]);
    expect(ProjectSettingsSchema.safeParse(manifest).success).toBe(true);
  });

  it("stamps the format marker, the id and the schema version", () => {
    const header = readProjectHeader(result().files[PROJECT_FILE.settings]);
    expect(header.kind).toBe("manifest");
    expect(header.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA);
    expect(header.projectId).toBe(CONTEXT.projectId);
  });

  it("records when the migration happened as the project's creation time", () => {
    const manifest = JSON.parse(result().files[PROJECT_FILE.settings]);
    expect(manifest.createdAt).toBe(CONTEXT.now.toISOString());
  });

  it("keeps the shared settings exactly as they were", () => {
    const before = JSON.parse(SCHEMA_V1_PROJECT[PROJECT_FILE.settings]);
    const after = JSON.parse(result().files[PROJECT_FILE.settings]);
    expect(after.name).toBe(before.name);
    expect(after.cluster).toBe(before.cluster);
    expect(after.defaults).toEqual(before.defaults);
    expect(after.simulator).toEqual(before.simulator);
    expect(after.maps).toEqual(before.maps);
    expect(after.discord).toEqual(before.discord);
    expect(after.modules).toEqual(before.modules);
  });

  it("renames github.paths to outputPaths without losing an entry", () => {
    const before = JSON.parse(SCHEMA_V1_PROJECT[PROJECT_FILE.settings]);
    const after = JSON.parse(result().files[PROJECT_FILE.settings]);
    expect(after.outputPaths).toEqual(before.github.paths);
    expect(after.github).toBeUndefined();
  });

  /**
   * The whole reason for the split: one administrator's drive letters must
   * stop travelling to everybody else.
   */
  it("lifts the repository and both local folders out of the shared project", () => {
    const after = JSON.parse(result().files[PROJECT_FILE.settings]);
    expect(after.imagesDir).toBeUndefined();
    expect(after.modsDir).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("C:\\\\Users");
    expect(JSON.stringify(after)).not.toContain("cluster-config");
  });

  it("hands those values to this machine's local state instead", () => {
    const { localHints } = result();
    expect(localHints.imagesDir).toBe("C:\\Users\\admin\\Pictures\\dino-icons");
    expect(localHints.modsDir).toContain("Mods");
    expect(localHints.source?.owner).toBe("ggfizz");
    expect(localHints.source?.name).toBe("cluster-config");
    expect(localHints.source?.branch).toBe("main");
    expect(localHints.source?.remoteUrl).toBe(
      "https://github.com/ggfizz/cluster-config.git",
    );
  });

  /**
   * Schema 1 had no way to know GitHub's numeric id, so the binding starts
   * incomplete and is finished the first time the repository is reached.
   * Inventing an id here would create a binding that verifies against nothing.
   */
  it("leaves the repository id blank rather than guessing one", () => {
    expect(result().localHints.source?.githubId).toBe("");
  });

  /**
   * The hints have to survive being written to this machine's record. They did
   * not once: the binding schema demanded an id, the record failed to parse,
   * and `loadLocalState` rebuilt it from nothing - so a migrated project came
   * back with no repository at all, silently.
   */
  it("produces hints that parse as machine-local state", () => {
    const record = {
      ...newLocalProjectState(CONTEXT.projectId, "C:\\proj", "GG Fizz"),
      ...result().localHints,
    };
    const parsed = LocalProjectStateSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.source?.name).toBe("cluster-config");
    expect(parsed.success && parsed.data.imagesDir).toContain("dino-icons");
  });

  /** Unverified, so nothing may act on it until the repository is reached. */
  it("leaves the migrated project unable to sync until it is verified", () => {
    const record = LocalProjectStateSchema.parse({
      ...newLocalProjectState(CONTEXT.projectId, "C:\\proj", "GG Fizz"),
      ...result().localHints,
      githubAccountId: "9",
    });
    expect(canSync(record)).toBe(false);
  });

  it("strips the recorded IP from every stored profile summary", () => {
    const players = result().files[PROJECT_FILE.players];
    expect(SCHEMA_V1_PROJECT[PROJECT_FILE.players]).toContain(FIXTURE_IP);
    expect(players).not.toContain(FIXTURE_IP);
    expect(players).not.toContain("lastKnownIp");
  });

  it("strips it from clean-slate summaries too, not only the roster", () => {
    const players = JSON.parse(result().files[PROJECT_FILE.players]);
    expect(players.cleanSlates[0].summary.lastKnownIp).toBeUndefined();
    // The rest of the summary survives - this is a redaction, not a reset.
    expect(players.players[0].profile.summary.characterName).toBe("Rex Wrangler");
    expect(players.players[0].profile.summary.level).toBe(105);
  });

  it("leaves files it has nothing to say about byte-identical", () => {
    expect(result().files[PROJECT_FILE.production]).toBe(
      SCHEMA_V1_PROJECT[PROJECT_FILE.production],
    );
  });

  it("reports what it did, for the migration commit", () => {
    const { report } = result();
    expect(report.fromSchema).toBe(1);
    expect(report.toSchema).toBe(CURRENT_PROJECT_SCHEMA);
    expect(report.stepsRun).toHaveLength(CURRENT_PROJECT_SCHEMA - 1);
    expect(report.notes.join("\n")).toContain(CONTEXT.projectId);
  });

  it("is deterministic - the same inputs give the same bytes", () => {
    expect(result().files).toEqual(result().files);
  });

  /** No step may be skipped, so migrating twice must be refused, not repeated. */
  it("does nothing the second time", () => {
    const once = migrateProject(SCHEMA_V1_PROJECT, CONTEXT);
    const twice = migrateProject(once.files, {
      ...CONTEXT,
      projectId: "different-id-entirely",
    });
    expect(twice.report.stepsRun).toEqual([]);
    expect(JSON.parse(twice.files[PROJECT_FILE.settings]).projectId).toBe(
      CONTEXT.projectId,
    );
  });
});

describe("schema 2 -> 3 package dependency migration", () => {
  it("preserves a legacy installed pack as an exact materialized dependency", () => {
    const current = migrateProject(
      {
        [PROJECT_FILE.settings]: JSON.stringify({
          format: "dinodepot.project",
          projectId: CONTEXT.projectId,
          schemaVersion: 2,
          minimumStudioVersion: "0.2.0",
          createdAt: CONTEXT.now.toISOString(),
          capabilities: {},
          name: "Test",
          cluster: "Test",
          defaults: {
            intervalSeconds: 300,
            chanceToProduce: 1,
            quantityPerDino: 1,
            maxQuantityPerCycle: 0,
            maxQuantityInTerminal: 0,
          },
          simulator: {
            defaultHours: 24,
            defaultCreatureCount: 10,
            highOutputPerHour: 500,
            lowOutputPerHour: 1,
          },
        }),
        [PROJECT_FILE.catalog]: JSON.stringify({
          schemaVersion: 1,
          sources: [
            {
              id: "source-1",
              modpackId: "test-pack",
              modpackVersion: "1.2.3",
              curseforgeId: "123456",
            },
          ],
        }),
      },
      CONTEXT,
    );
    const settings = ProjectSettingsSchema.parse(
      JSON.parse(current.files[PROJECT_FILE.settings]),
    );

    expect(settings.packageDependencies).toMatchObject([
      {
        packageId: "test-pack",
        version: "1.2.3",
        sourceId: "source-1",
        mode: "materialized",
      },
    ]);
  });

  it("preserves v1 package identities that are not safe library slugs", () => {
    const settings = JSON.parse(
      migrateProject(
        {
          [PROJECT_FILE.settings]: JSON.stringify({
            format: "dinodepot.project",
            projectId: CONTEXT.projectId,
            schemaVersion: 2,
            minimumStudioVersion: "0.2.0",
            createdAt: CONTEXT.now.toISOString(),
            name: "Test",
            cluster: "Test",
            defaults: {
              intervalSeconds: 300,
              chanceToProduce: 1,
              quantityPerDino: 1,
              maxQuantityPerCycle: 0,
              maxQuantityInTerminal: 0,
            },
            simulator: {
              defaultHours: 24,
              defaultCreatureCount: 10,
              highOutputPerHour: 500,
              lowOutputPerHour: 1,
            },
          }),
          [PROJECT_FILE.catalog]: JSON.stringify({
            schemaVersion: 1,
            sources: [
              {
                id: "source-1",
                modpackId: "Old Pack Name",
                modpackVersion: "release one",
                curseforgeId: "123456",
              },
            ],
          }),
        },
        CONTEXT,
      ).files[PROJECT_FILE.settings],
    );

    expect(settings.packageDependencies).toMatchObject([
      {
        packageId: "Old Pack Name",
        version: "release one",
        mode: "materialized",
      },
    ]);
  });
});

describe("migration failure", () => {
  it("refuses a folder with no project file", () => {
    try {
      migrateProject({ "players.json": "{}" }, CONTEXT);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isStudioError(e) && e.code).toBe("migration.failed");
    }
  });

  it("refuses a project file that is not JSON", () => {
    try {
      migrateProject({ [PROJECT_FILE.settings]: "{ not json" }, CONTEXT);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isStudioError(e) && e.code).toBe("migration.failed");
    }
  });

  /**
   * A step that throws must surface as a migration failure with the original
   * untouched, never as a half-migrated project - which is why the caller
   * stages the result and only swaps it in after this returns.
   */
  it("reports a step that throws without returning partial files", () => {
    const broken = {
      ...SCHEMA_V1_PROJECT,
      [PROJECT_FILE.players]: "{ truncated",
    };
    try {
      migrateProject(broken, CONTEXT);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isStudioError(e) && e.code).toBe("migration.failed");
      expect(isStudioError(e) && e.message).toContain("original is untouched");
    }
  });

  it("refuses a project whose schema is newer than this build", () => {
    const future = {
      [PROJECT_FILE.settings]: JSON.stringify({
        format: "dinodepot.project",
        projectId: "x",
        schemaVersion: CURRENT_PROJECT_SCHEMA + 5,
      }),
    };
    try {
      migrateProject(future, CONTEXT);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isStudioError(e) && e.code).toBe("project.schemaTooNew");
    }
  });
});
