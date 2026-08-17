import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyCatalog, normalizeBpPath } from "../model/catalog";
import { PackageDependencySchema } from "../model/dependency";
import { PROJECT_FILE } from "../model/project";

/**
 * Installing a package is one commit, not three writes that each might fail.
 *
 * The failure this guards is an install reporting success with its dependency
 * recorded and its catalog content still sitting on a debounce timer, or with
 * a settings write that quietly erased a dependency another operation added.
 */

const saved = new Map<string, string>();
const local = { localPackageSources: {} as Record<string, string> };
let settings = {
  name: "Cluster",
  packageDependencies: [] as unknown[],
};
let settingsWriteFails = false;

const projectState = {
  dir: "C:\\projects\\cluster",
  get settings() {
    return settings;
  },
  get local() {
    return local;
  },
  get files() {
    return Object.fromEntries(saved);
  },
  async saveFile(fileName: string, content: string) {
    saved.set(fileName, content);
  },
  async updateSettings(update: (current: typeof settings) => typeof settings) {
    if (settingsWriteFails) throw new Error("disk is full");
    settings = update(settings);
  },
  async updateLocal(patch: Partial<typeof local>) {
    Object.assign(local, patch);
  },
};

const draftsState = {
  catalog: emptyCatalog(),
  projectCatalog: emptyCatalog(),
  async setCatalogDurable(catalog: ReturnType<typeof emptyCatalog>) {
    draftsState.catalog = catalog;
    draftsState.projectCatalog = catalog;
    saved.set(PROJECT_FILE.catalog, JSON.stringify(catalog));
  },
};

vi.mock("../stores/projectStore", () => ({
  useProjectStore: Object.assign(() => projectState, {
    getState: () => projectState,
  }),
}));

vi.mock("../stores/draftsStore", () => ({
  useDraftsStore: Object.assign(() => draftsState, {
    getState: () => draftsState,
    setState: (patch: Partial<typeof draftsState>) =>
      Object.assign(draftsState, patch),
  }),
}));

const { commitPackageActivation } = await import("./projectActivation");

const dependency = PackageDependencySchema.parse({
  kind: "modpack",
  packageId: "additions-ascended-anomalocaris",
  version: "1.0.1-dev.1",
  curseforgeId: "987274",
  mode: "linked",
});

function catalogWithIcon() {
  const catalog = emptyCatalog();
  catalog.icons[normalizeBpPath("/aa_anomalo/dinos/anomalo.anomalo")] = "🦐";
  return catalog;
}

describe("transactional package activation", () => {
  beforeEach(() => {
    saved.clear();
    saved.set(PROJECT_FILE.catalog, JSON.stringify(emptyCatalog()));
    local.localPackageSources = {};
    settings = { name: "Cluster", packageDependencies: [] };
    settingsWriteFails = false;
    draftsState.catalog = emptyCatalog();
    draftsState.projectCatalog = emptyCatalog();
  });

  it("persists both the catalog and the exact pin before reporting success", async () => {
    await commitPackageActivation({
      dependency,
      catalog: catalogWithIcon(),
    });

    expect(settings.packageDependencies).toMatchObject([
      { packageId: "additions-ascended-anomalocaris", version: "1.0.1-dev.1" },
    ]);
    expect(saved.get(PROJECT_FILE.catalog)).toContain("aa_anomalo");
  });

  it("does not report success, and rolls the catalog back, when settings fail", async () => {
    const before = saved.get(PROJECT_FILE.catalog);
    settingsWriteFails = true;

    await expect(
      commitPackageActivation({ dependency, catalog: catalogWithIcon() }),
    ).rejects.toThrow(/disk is full/);

    expect(saved.get(PROJECT_FILE.catalog)).toBe(before);
    expect(draftsState.catalog.icons).toEqual({});
    expect(settings.packageDependencies).toEqual([]);
  });

  it("merges rather than replacing a dependency added while it was installing", async () => {
    const officialPin = PackageDependencySchema.parse({
      kind: "official",
      packageId: "official-asa",
      version: "1.0.0",
      mode: "linked",
    });
    settings = {
      name: "Cluster",
      packageDependencies: [officialPin],
    };

    await commitPackageActivation({ dependency, catalog: catalogWithIcon() });

    expect(settings.packageDependencies).toHaveLength(2);
    expect(
      (settings.packageDependencies as { kind: string }[]).map((d) => d.kind).sort(),
    ).toEqual(["modpack", "official"]);
  });

  it("keeps a local manifest folder in machine-local state, never in project JSON", async () => {
    await commitPackageActivation({
      dependency,
      catalog: catalogWithIcon(),
      localManifestPath: "C:\\dev-packages\\pack\\1.0.1-dev.1\\manifest.json",
    });

    expect(local.localPackageSources).toEqual({
      "additions-ascended-anomalocaris@1.0.1-dev.1":
        "C:\\dev-packages\\pack\\1.0.1-dev.1\\manifest.json",
    });
    expect(JSON.stringify(settings)).not.toContain("dev-packages");
    expect(saved.get(PROJECT_FILE.catalog)).not.toContain("dev-packages");
  });
});
