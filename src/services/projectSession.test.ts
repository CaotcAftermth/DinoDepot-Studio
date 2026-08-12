import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStudioError } from "../model/errors";
import { CURRENT_PROJECT_SCHEMA, PROJECT_FORMAT } from "../model/manifest";
import { PROJECT_FILE } from "../model/project";
import { SCHEMA_V1_PROJECT, FIXTURE_IP } from "../model/migrations/__fixtures__/schema-v1";

/**
 * The session layer, against a scripted backend.
 *
 * What is being pinned down here is the *order* of the open sequence, because
 * the order is the design: read the header before hydrating, so a newer project
 * is not mistaken for a corrupt one; take the lock before migrating, because a
 * migration is the one operation two instances would destroy outright.
 */

/** Commands the fake backend saw, in order. */
let calls: { cmd: string; args: Record<string, unknown> }[] = [];
/** Project folder contents the fake backend serves. */
let folder: Record<string, string> = {};
/** What `project_lock_acquire` should do. */
let lockBehaviour: "free" | "contended" = "free";
let localRecords: Record<string, string> = {};

vi.mock("./ipc", () => ({
  isTauri: false,
  ipc: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "load_project":
        if (!folder[PROJECT_FILE.settings]) {
          throw new Error("No project.json found in that folder");
        }
        return { ...folder };
      case "project_lock_status":
        return {
          held: lockBehaviour === "contended",
          owned: false,
          stale: false,
          machine: "DESKTOP-OTHER",
          instanceId: "other",
          heartbeatAt: Date.now(),
        };
      case "project_lock_acquire":
        if (lockBehaviour === "contended" && args.force !== true) {
          throw new Error(
            "This project is already open in DinoDepot Studio on DESKTOP-OTHER.",
          );
        }
        return {
          held: true,
          owned: true,
          stale: false,
          machine: "DESKTOP-MINE",
          instanceId: "mine",
          heartbeatAt: Date.now(),
        };
      case "commit_migrated_project": {
        Object.assign(folder, args.files as Record<string, string>);
        return { path: "C:\\proj\\backups\\snapshots\\20260809-pre-migration", fileCount: 3 };
      }
      case "local_state_get":
        return localRecords[args.projectId as string] ?? null;
      case "local_state_set":
        localRecords[args.projectId as string] = args.content as string;
        return undefined;
      case "local_state_list":
        return Object.values(localRecords);
      case "quarantine_project_file":
        return `C:\\proj\\recovery\\${args.fileName}`;
      case "snapshot_project":
        return { path: "C:\\proj\\backups\\snapshots\\20260809-manual", fileCount: 3 };
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  },
}));

const {
  inspectProject,
  openInspectedProject,
  loadLocalState,
  listLocalProjects,
  quarantineFile,
} = await import("./projectSession");

function currentManifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: PROJECT_FORMAT,
    projectId: "project-uuid",
    schemaVersion: CURRENT_PROJECT_SCHEMA,
    minimumStudioVersion: "0.2.0",
    createdAt: "2026-08-01T00:00:00.000Z",
    capabilities: {},
    name: "GG Fizz",
    cluster: "GG Fizz Cluster",
    outputPaths: {},
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
    ...over,
  });
}

const cmds = () => calls.map((c) => c.cmd);

beforeEach(() => {
  calls = [];
  folder = { [PROJECT_FILE.settings]: currentManifest() };
  lockBehaviour = "free";
  localRecords = {};
});

describe("inspecting a project", () => {
  it("reports a current project as ready to open, changing nothing", () => {
    return inspectProject("C:\\proj").then((inspection) => {
      expect(inspection.compatibility.compatibility).toBe("open");
      expect(cmds()).toEqual(["load_project", "project_lock_status"]);
    });
  });

  it("reports a schema-1 project as needing migration", async () => {
    folder = { ...SCHEMA_V1_PROJECT };
    const inspection = await inspectProject("C:\\proj");
    expect(inspection.compatibility.compatibility).toBe("migrate");
    // Nothing has been written: inspection is a read.
    expect(cmds()).not.toContain("commit_migrated_project");
  });

  it("reports a lock another instance holds", async () => {
    lockBehaviour = "contended";
    const inspection = await inspectProject("C:\\proj");
    expect(inspection.lock.held).toBe(true);
    expect(inspection.lock.owned).toBe(false);
    expect(inspection.lock.machine).toBe("DESKTOP-OTHER");
  });

  it("surfaces a folder with no project as a typed failure", async () => {
    folder = {};
    await expect(inspectProject("C:\\proj")).rejects.toMatchObject({
      code: "project.corrupt",
    });
  });
});

describe("opening a project", () => {
  it("takes the lock and hydrates", async () => {
    const opened = await openInspectedProject(await inspectProject("C:\\proj"));
    expect(opened.mode).toBe("editable");
    expect(opened.settings.projectId).toBe("project-uuid");
    expect(cmds()).toContain("project_lock_acquire");
  });

  it("creates this machine's record on first open", async () => {
    await openInspectedProject(await inspectProject("C:\\proj"));
    const record = JSON.parse(localRecords["project-uuid"]);
    expect(record.projectId).toBe("project-uuid");
    expect(record.localPath).toBe("C:\\proj");
    expect(record.source).toBeNull();
  });

  it("refuses when another instance holds the lock", async () => {
    lockBehaviour = "contended";
    const inspection = await inspectProject("C:\\proj");
    await expect(openInspectedProject(inspection)).rejects.toMatchObject({
      code: "project.locked",
    });
  });

  it("takes the lock over when the admin says so", async () => {
    lockBehaviour = "contended";
    const inspection = await inspectProject("C:\\proj");
    const opened = await openInspectedProject(inspection, { force: true });
    expect(opened.mode).toBe("editable");
  });
});

describe("opening a newer project", () => {
  beforeEach(() => {
    folder = {
      [PROJECT_FILE.settings]: currentManifest({
        schemaVersion: CURRENT_PROJECT_SCHEMA + 1,
        somethingThisBuildHasNeverHeardOf: { nested: true },
      }),
    };
  });

  it("opens read-only rather than refusing", async () => {
    const opened = await openInspectedProject(await inspectProject("C:\\proj"));
    expect(opened.mode).toBe("read-only");
    expect(opened.readOnlyReason).toContain("newer");
  });

  /** The unknown field survives, because nothing writes the project back. */
  it("preserves the data it does not understand", async () => {
    await openInspectedProject(await inspectProject("C:\\proj"));
    expect(folder[PROJECT_FILE.settings]).toContain(
      "somethingThisBuildHasNeverHeardOf",
    );
  });

  /**
   * Holding the lock would keep the administrator whose Studio *can* open the
   * project out of it, and a read-only session cannot collide with anything.
   */
  it("does not take the lock", async () => {
    await openInspectedProject(await inspectProject("C:\\proj"));
    expect(cmds()).not.toContain("project_lock_acquire");
  });

  it("does not migrate it", async () => {
    await openInspectedProject(await inspectProject("C:\\proj"));
    expect(cmds()).not.toContain("commit_migrated_project");
  });

  it("does not write this machine's record either", async () => {
    await openInspectedProject(await inspectProject("C:\\proj"));
    expect(localRecords).toEqual({});
  });
});

describe("opening a schema-1 project", () => {
  beforeEach(() => {
    folder = { ...SCHEMA_V1_PROJECT };
  });

  it("locks before it migrates", async () => {
    await openInspectedProject(await inspectProject("C:\\proj"));
    const order = cmds();
    expect(order.indexOf("project_lock_acquire")).toBeLessThan(
      order.indexOf("commit_migrated_project"),
    );
  });

  it("migrates, then opens editable", async () => {
    const opened = await openInspectedProject(await inspectProject("C:\\proj"));
    expect(opened.mode).toBe("editable");
    expect(opened.migration?.fromSchema).toBe(1);
    expect(opened.settings.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA);
    expect(opened.settings.projectId).not.toBe("");
  });

  it("hands back the snapshot path, so recovery has somewhere to point", async () => {
    const opened = await openInspectedProject(await inspectProject("C:\\proj"));
    expect(opened.migrationSnapshot).toContain("snapshots");
  });

  it("writes only the files the migration actually changed", async () => {
    await openInspectedProject(await inspectProject("C:\\proj"));
    const commit = calls.find((c) => c.cmd === "commit_migrated_project");
    const written = Object.keys(commit!.args.files as Record<string, string>);
    expect(written).toContain(PROJECT_FILE.settings);
    expect(written).toContain(PROJECT_FILE.players);
    // Untouched by this migration — rewriting it would churn its backups.
    expect(written).not.toContain(PROJECT_FILE.production);
  });

  it("moves the repository and local folders into this machine's record", async () => {
    const opened = await openInspectedProject(await inspectProject("C:\\proj"));
    expect(opened.local.source?.owner).toBe("ggfizz");
    expect(opened.local.source?.name).toBe("cluster-config");
    expect(opened.local.imagesDir).toContain("dino-icons");
    expect(opened.local.modsDir).toContain("Mods");
  });

  it("leaves no IP address anywhere in the migrated project", async () => {
    await openInspectedProject(await inspectProject("C:\\proj"));
    expect(JSON.stringify(folder)).not.toContain(FIXTURE_IP);
    expect(JSON.stringify(localRecords)).not.toContain(FIXTURE_IP);
  });
});

describe("this machine's records", () => {
  it("follows a project folder that has been moved", async () => {
    localRecords["project-uuid"] = JSON.stringify({
      schemaVersion: 1,
      projectId: "project-uuid",
      localPath: "D:\\Old\\Location",
      name: "Old name",
    });
    const state = await loadLocalState("project-uuid", "C:\\New\\Location", "GG Fizz");
    expect(state.localPath).toBe("C:\\New\\Location");
    expect(state.name).toBe("GG Fizz");
  });

  /** Nothing in the record is the admin's work, so a bad one is rebuilt. */
  it("rebuilds a corrupt record instead of failing to open", async () => {
    localRecords["project-uuid"] = "{ not json";
    const state = await loadLocalState("project-uuid", "C:\\proj", "GG Fizz");
    expect(state.projectId).toBe("project-uuid");
    expect(state.source).toBeNull();
  });

  it("lists known projects newest first", async () => {
    localRecords.a = JSON.stringify({
      projectId: "a",
      localPath: "C:\\a",
      openedAt: "2026-08-01T00:00:00.000Z",
    });
    localRecords.b = JSON.stringify({
      projectId: "b",
      localPath: "C:\\b",
      openedAt: "2026-08-09T00:00:00.000Z",
    });
    const listed = await listLocalProjects();
    expect(listed.map((r) => r.projectId)).toEqual(["b", "a"]);
  });

  it("skips a record it cannot read rather than losing the rest", async () => {
    localRecords.good = JSON.stringify({ projectId: "good", localPath: "C:\\g" });
    localRecords.bad = "{ broken";
    expect((await listLocalProjects()).map((r) => r.projectId)).toEqual(["good"]);
  });
});

describe("quarantine", () => {
  it("reports where the damaged file went", async () => {
    const result = await quarantineFile("C:\\proj", "players.json");
    expect(result.fileName).toBe("players.json");
    expect(result.movedTo).toContain("recovery");
  });
});

describe("typed failures", () => {
  it("wraps a rejected backend call as a StudioError", async () => {
    folder = {};
    try {
      await inspectProject("C:\\proj");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isStudioError(e)).toBe(true);
    }
  });
});
