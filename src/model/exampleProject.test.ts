import { describe, expect, it } from "vitest";
import { ActivityFileSchema } from "./activity";
import { CatalogFileSchema, ContentSourceSchema, buildCatalogIndex, emptyCatalog } from "./catalog";
import { CosmeticsDraftSchema } from "./cosmetics";
import {
  EXAMPLE_PROJECT_CAPABILITY,
  EXAMPLE_TOUR_STEPS,
  completeExampleTourStep,
  emptyExampleTourProgress,
  exampleProjectFiles,
  exampleTourSelectionKeys,
  firstIncompleteExampleTourStep,
  isExampleProject,
  isExampleProjectName,
  markExampleProject,
  markExampleOfficialCatalog,
  needsExampleOfficialCatalogUpgrade,
  normalizeExampleTourDocument,
  normalizeExampleTourProgress,
  upgradeExampleProjectFiles,
} from "./exampleProject";
import { PlayersFileSchema } from "./players";
import { PROJECT_FILE, defaultProjectSettings } from "./project";
import { ProductionDraftSchema } from "./production";
import { RemapsDraftSchema } from "./remaps";
import { validateProject } from "../validation/project";
import { effectiveOfficialSource } from "./officialCatalog";

describe("example project seed", () => {
  it("reserves the one example name and recognizes legacy numbered copies", () => {
    expect(isExampleProjectName("DinoDepot Example")).toBe(true);
    expect(isExampleProjectName("DinoDepot Example 2")).toBe(true);
    expect(isExampleProjectName("My Example")).toBe(false);
  });

  it("marks the project and enables the Player Data example", () => {
    const settings = markExampleProject(
      defaultProjectSettings("DinoDepot Example", "Example Cluster", "example-id"),
    );
    expect(settings.capabilities[EXAMPLE_PROJECT_CAPABILITY]).toBe(true);
    expect(settings.modules["player-data"]).toBe(true);
    expect(isExampleProject(settings)).toBe(true);
    expect(needsExampleOfficialCatalogUpgrade(settings)).toBe(false);
  });

  it("upgrades the original fictional seed without replacing unrelated edits", () => {
    const old = markExampleProject(
      defaultProjectSettings("DinoDepot Example", "Example Cluster", "old-example"),
    );
    const legacySettings = {
      ...old,
      capabilities: { "studio.exampleProject.v1": true },
    };
    expect(needsExampleOfficialCatalogUpgrade(legacySettings)).toBe(true);
    expect(needsExampleOfficialCatalogUpgrade(markExampleOfficialCatalog(legacySettings))).toBe(false);

    const catalog = emptyCatalog();
    catalog.sources = [ContentSourceSchema.parse({
      id: "example-source",
      name: "Example Creature Pack",
      kind: "mod",
      curseforgeId: "",
      enabled: true,
      removed: false,
      notes: "Keep my note",
      creatures: [],
      items: [],
    })];
    const upgraded = upgradeExampleProjectFiles({
      [PROJECT_FILE.catalog]: `${JSON.stringify(catalog)}\n`,
      [PROJECT_FILE.production]: '{"dinoType":"/Game/DinoDepotExample/Creatures/Collector/ExampleCollector_Character_BP.ExampleCollector_Character_BP","notes":"Keep this edit"}\n',
    });
    expect(CatalogFileSchema.parse(JSON.parse(upgraded[PROJECT_FILE.catalog] ?? "null")).sources).toEqual([]);
    expect(upgraded[PROJECT_FILE.production]).toContain("/Game/PrimalEarth/Dinos/Ankylo/");
    expect(upgraded[PROJECT_FILE.production]).toContain("Keep this edit");
  });

  it("builds files accepted by every owning schema", () => {
    const files = exampleProjectFiles(new Date("2026-08-25T12:00:00.000Z"));
    const parse = <T>(name: keyof typeof files, schema: { parse(value: unknown): T }) =>
      schema.parse(JSON.parse(files[name] ?? "null"));

    expect(parse(PROJECT_FILE.production, ProductionDraftSchema).rules).toHaveLength(2);
    expect(parse(PROJECT_FILE.remaps, RemapsDraftSchema).entries).toHaveLength(1);
    expect(parse(PROJECT_FILE.cosmetics, CosmeticsDraftSchema).entries).toHaveLength(1);
    expect(parse(PROJECT_FILE.catalog, CatalogFileSchema).sources).toHaveLength(0);
    expect(parse(PROJECT_FILE.players, PlayersFileSchema).players).toHaveLength(2);
    const activity = parse(PROJECT_FILE.activity, ActivityFileSchema);
    expect(activity.events).toHaveLength(6);
    expect(activity.events.map((event) => event.title).join(" ")).toContain("RexOps");
    expect(Object.values(files).join("\n")).not.toContain("/Game/DinoDepotExample/");
    const production = parse(PROJECT_FILE.production, ProductionDraftSchema);
    expect(production.rules.map((rule) => rule.dinoType)).toEqual([
      "/Game/PrimalEarth/Dinos/Ankylo/Ankylo_Character_BP.Ankylo_Character_BP",
      "/Game/PrimalEarth/Dinos/Doedicurus/Doed_Character_BP.Doed_Character_BP",
    ]);
  });

  it("is publishable before any external destination is configured", () => {
    const files = exampleProjectFiles(new Date("2026-08-25T12:00:00.000Z"));
    const read = <T>(name: keyof typeof files, schema: { parse(value: unknown): T }) =>
      schema.parse(JSON.parse(files[name] ?? "null"));
    const catalog = read(PROJECT_FILE.catalog, CatalogFileSchema);
    const report = validateProject({
      settings: markExampleProject(
        defaultProjectSettings("DinoDepot Example", "Example Cluster", "example-id"),
      ),
      production: read(PROJECT_FILE.production, ProductionDraftSchema),
      remaps: read(PROJECT_FILE.remaps, RemapsDraftSchema),
      cosmetics: read(PROJECT_FILE.cosmetics, CosmeticsDraftSchema),
      catalog,
      players: read(PROJECT_FILE.players, PlayersFileSchema),
      index: buildCatalogIndex({
        sources: [effectiveOfficialSource(catalog), ...catalog.sources],
      }),
      imageFiles: [],
    });

    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(1);
  });
});

describe("example walkthrough progress", () => {
  it("accepts versioned authoring documents and clamps presentation values", () => {
    const document = normalizeExampleTourDocument({
      version: 1,
      steps: [
        {
          ...EXAMPLE_TOUR_STEPS[0],
          id: "authored-overview",
          padding: 99,
          placement: { mode: "custom", x: -2, y: 4 },
          visual: "hotspot",
          focusWidthPercent: 5,
          focusHeightPercent: 55,
          focusRect: { x: -1, y: 0.95, width: 2, height: 0.8 },
          annotationPosition: { x: 4, y: -2 },
          arrowDirection: "down-left",
          expansions: [{ key: "production-rule-1", label: "Rule 1", index: 120 }],
          selections: [" rule:doedicurus ", "rule:doedicurus", ""],
          control: { label: "Save", index: 120, state: "disabled", scope: "example" },
        },
      ],
    });
    expect(document?.steps[0]).toMatchObject({
      id: "authored-overview",
      padding: 40,
      placement: { mode: "custom", x: 0, y: 1 },
      visual: "hotspot",
      focusWidthPercent: 10,
      focusHeightPercent: 55,
      focusRect: { x: 0, y: 0.95, width: 1, height: 0.05 },
      annotationPosition: { x: 1, y: 0 },
      arrowDirection: "down-left",
      expansions: [{ key: "production-rule-1", label: "Rule 1", index: 99 }],
      selections: ["rule:doedicurus"],
    });
    expect(document?.controls).toMatchObject([{
      route: EXAMPLE_TOUR_STEPS[0].route,
      targetId: EXAMPLE_TOUR_STEPS[0].targetId,
      label: "Save",
      index: 99,
      state: "disabled",
      scope: "example",
    }]);
  });

  it("restores explicit selections and migrates expansion-only drafts", () => {
    const step = {
      ...EXAMPLE_TOUR_STEPS[0],
      selections: ["rule:doedicurus"],
      expansions: [
        { key: "rule:doedicurus", label: "Doedicurus", index: 0 },
        { key: "cycle:garden", label: "Garden harvest", index: 0 },
      ],
    };

    expect(exampleTourSelectionKeys(step)).toEqual([
      "rule:doedicurus",
      "cycle:garden",
    ]);
    expect(exampleTourSelectionKeys({ ...step, selections: undefined })).toEqual([
      "rule:doedicurus",
      "cycle:garden",
    ]);
  });

  it("rejects imported selectors and unknown target ids", () => {
    expect(
      normalizeExampleTourDocument({
        version: 1,
        steps: [{
          ...EXAMPLE_TOUR_STEPS[0],
          targetId: "not-registered",
          selector: "body > div:nth-child(1)",
        }],
      }),
    ).toBeNull();
  });

  it("keeps annotation ownership stable across ordering and normalizes view timing", () => {
    const overview = { ...EXAMPLE_TOUR_STEPS[0], id: "overview-focus", viewDurationSeconds: 120 };
    const content = { ...EXAMPLE_TOUR_STEPS[1], id: "content-focus" };
    const dot = {
      ...EXAMPLE_TOUR_STEPS[0],
      id: "overview-dot",
      visual: "hotspot" as const,
      parentStepId: overview.id,
      title: "Overview note",
    };
    const document = normalizeExampleTourDocument({
      version: 1,
      steps: [overview, content, dot],
    });

    expect(document?.steps.find((step) => step.id === overview.id)?.viewDurationSeconds).toBe(60);
    expect(document?.steps.find((step) => step.id === dot.id)?.parentStepId).toBe(overview.id);
  });

  it("keeps annotations on their page and falls back to its last walkthrough step", () => {
    const firstOverview = { ...EXAMPLE_TOUR_STEPS[0], id: "overview-first" };
    const lastOverview = { ...EXAMPLE_TOUR_STEPS[0], id: "overview-last" };
    const content = { ...EXAMPLE_TOUR_STEPS[1], id: "content-focus" };
    const dot = {
      ...EXAMPLE_TOUR_STEPS[0],
      id: "overview-dot",
      visual: "hotspot" as const,
      parentStepId: content.id,
      title: "Overview note",
    };
    const document = normalizeExampleTourDocument({
      version: 1,
      steps: [firstOverview, dot, content, lastOverview],
    });

    expect(document?.steps.find((step) => step.id === dot.id)?.parentStepId).toBe(lastOverview.id);
  });

  it("keeps only known completed steps from the current version", () => {
    expect(
      normalizeExampleTourProgress({
        version: 1,
        completed: ["overview", "unknown", "overview"],
        dismissed: true,
      }),
    ).toEqual({ version: 1, completed: ["overview"], dismissed: true });
  });

  it("resets progress from another seed version", () => {
    expect(
      normalizeExampleTourProgress({ version: 0, completed: ["overview"], dismissed: true }),
    ).toEqual(emptyExampleTourProgress());
  });

  it("tracks completion and finds the next unfinished step", () => {
    const first = completeExampleTourStep(emptyExampleTourProgress(), "overview");
    expect(first.completed).toEqual(["overview"]);
    expect(firstIncompleteExampleTourStep(first)).toBe(1);
    expect(EXAMPLE_TOUR_STEPS[firstIncompleteExampleTourStep(first)].id).toBe("content");
  });

  it("tracks authored step ids against the active walkthrough", () => {
    const authored = [{ ...EXAMPLE_TOUR_STEPS[0], id: "authored" }];
    const progress = completeExampleTourStep(emptyExampleTourProgress(), "authored", authored);
    expect(progress.completed).toEqual(["authored"]);
    expect(firstIncompleteExampleTourStep(progress, authored)).toBe(0);
  });
});
