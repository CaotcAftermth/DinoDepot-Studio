import { ActivityFileSchema, type ActivityEvent } from "./activity";
import { CatalogFileSchema, emptyCatalog } from "./catalog";
import { CosmeticsDraftSchema } from "./cosmetics";
import { PlayersFileSchema } from "./players";
import {
  PROJECT_FILE,
  type ProjectFileName,
  type ProjectSettings,
} from "./project";
import { ProductionDraftSchema } from "./production";
import { RemapsDraftSchema } from "./remaps";
import { sanitizeTargetContext, targetDefinition } from "./feedback/targets";

/** Folder and project name used by the welcome-screen example. */
export const EXAMPLE_PROJECT_NAME = "DinoDepot Example";
export const EXAMPLE_PROJECT_CLUSTER = "Example Cluster";

/** Reserved example name, including numbered copies created by older builds. */
export function isExampleProjectName(value: string): boolean {
  const name = value.trim().toLowerCase();
  const base = EXAMPLE_PROJECT_NAME.toLowerCase();
  if (name === base) return true;
  return name.startsWith(`${base} `) && /^\d+$/.test(name.slice(base.length + 1));
}

/** Portable marker. A copied example remains recognisable and safely protected. */
export const EXAMPLE_PROJECT_CAPABILITY = "studio.exampleProject.v1";
export const EXAMPLE_OFFICIAL_CATALOG_CAPABILITY =
  "studio.exampleProject.officialCatalog.v1";
export const EXAMPLE_PROJECT_SEED_VERSION = 1;

export function isExampleProject(
  settings: Pick<ProjectSettings, "capabilities"> | null,
): boolean {
  return settings?.capabilities[EXAMPLE_PROJECT_CAPABILITY] === true;
}

export function markExampleProject(settings: ProjectSettings): ProjectSettings {
  return {
    ...settings,
    capabilities: {
      ...settings.capabilities,
      [EXAMPLE_PROJECT_CAPABILITY]: true,
      [EXAMPLE_OFFICIAL_CATALOG_CAPABILITY]: true,
    },
    modules: { ...settings.modules, "player-data": true },
  };
}

export function needsExampleOfficialCatalogUpgrade(
  settings: Pick<ProjectSettings, "capabilities"> | null,
): boolean {
  return isExampleProject(settings) &&
    settings?.capabilities[EXAMPLE_OFFICIAL_CATALOG_CAPABILITY] !== true;
}

export function markExampleOfficialCatalog(
  settings: ProjectSettings,
): ProjectSettings {
  return {
    ...settings,
    capabilities: {
      ...settings.capabilities,
      [EXAMPLE_OFFICIAL_CATALOG_CAPABILITY]: true,
    },
  };
}

const ANKYLOSAURUS =
  "/Game/PrimalEarth/Dinos/Ankylo/Ankylo_Character_BP.Ankylo_Character_BP";
const ABERRANT_ANKYLOSAURUS =
  "/Game/PrimalEarth/Dinos/Ankylo/Ankylo_Character_BP_Aberrant.Ankylo_Character_BP_Aberrant";
const DOEDICURUS =
  "/Game/PrimalEarth/Dinos/Doedicurus/Doed_Character_BP.Doed_Character_BP";
const CRYSTAL =
  "/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Crystal.PrimalItemResource_Crystal";
const METAL =
  "/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Metal.PrimalItemResource_Metal";
const GASOLINE =
  "/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Gasoline.PrimalItemResource_Gasoline";
const STONE =
  "/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Stone.PrimalItemResource_Stone";
// Same stable id as officialCatalog.ts, kept local so importing the lightweight
// example marker does not eagerly pull the 400 KB Official ASA dataset.
const OFFICIAL_SOURCE_ID = "official-asa";

const LEGACY_EXAMPLE_REPLACEMENTS: readonly [string, string][] = [
  [
    "/Game/DinoDepotExample/Creatures/Collector/ExampleCollector_Character_BP.ExampleCollector_Character_BP",
    ANKYLOSAURUS,
  ],
  [
    "/Game/DinoDepotExample/Creatures/Collector/LegacyCollector_Character_BP.LegacyCollector_Character_BP",
    ABERRANT_ANKYLOSAURUS,
  ],
  [
    "/Game/DinoDepotExample/Creatures/Gardener/ExampleGardener_Character_BP.ExampleGardener_Character_BP",
    DOEDICURUS,
  ],
  [
    "/Game/DinoDepotExample/Items/Resources/PrimalItemResource_ExampleCrystal.PrimalItemResource_ExampleCrystal",
    CRYSTAL,
  ],
  [
    "/Game/DinoDepotExample/Items/Resources/PrimalItemResource_ExampleRareCrystal.PrimalItemResource_ExampleRareCrystal",
    METAL,
  ],
  [
    "/Game/DinoDepotExample/Items/Resources/PrimalItemResource_ExampleFuel.PrimalItemResource_ExampleFuel",
    GASOLINE,
  ],
  [
    "/Game/DinoDepotExample/Items/Consumables/PrimalItemConsumable_ExampleBerry.PrimalItemConsumable_ExampleBerry",
    STONE,
  ],
  ["Crystal Collector", "Ankylosaurus"],
  ["Legacy Collector", "Aberrant Ankylosaurus"],
  ["Garden Tender", "Doedicurus"],
  ["Rare Example Crystal", "Metal"],
  ["Example Crystal", "Crystal"],
  ["Example Fuel", "Gasoline"],
  ["Example Berry", "Stone"],
  ["example-source", OFFICIAL_SOURCE_ID],
];

/** Upgrades only original generated identifiers; other DEV edits stay intact. */
export function upgradeExampleProjectFiles(
  files: Record<string, string>,
): Partial<Record<ProjectFileName, string>> {
  const upgraded: Partial<Record<ProjectFileName, string>> = {};
  for (const fileName of [
    PROJECT_FILE.production,
    PROJECT_FILE.remaps,
    PROJECT_FILE.catalog,
    PROJECT_FILE.activity,
  ] as const) {
    const current = files[fileName];
    if (!current) continue;
    let next = current;
    for (const [legacy, official] of LEGACY_EXAMPLE_REPLACEMENTS) {
      next = next.split(legacy).join(official);
    }
    if (fileName === PROJECT_FILE.catalog) {
      try {
        const catalog = CatalogFileSchema.parse(JSON.parse(next));
        catalog.sources = catalog.sources.filter(
          (source) => source.id !== OFFICIAL_SOURCE_ID,
        );
        next = json(catalog);
      } catch {
        // Existing project opens with its own schema handling; leave malformed
        // content untouched instead of turning this upgrade into data loss.
      }
    }
    if (next !== current) upgraded[fileName] = next;
  }
  return upgraded;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Stable mock collaboration feed; missing rows can also be added at runtime. */
export function exampleProjectActivityEvents(now = new Date()): ActivityEvent[] {
  const at = (minutesAgo: number) =>
    new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  return [
    {
      id: "example-activity-publish",
      at: at(5),
      kind: "publish",
      title: "ExampleOwner published the public viewer",
      detail: "Production, remaps, and viewer data synchronized",
      to: "/publish",
    },
    {
      id: "example-activity-production",
      at: at(18),
      kind: "production",
      title: "RexOps updated Ankylosaurus production",
      detail: "Adjusted cycle interval and alternate chance",
      to: "/production/example-rule-collector",
    },
    {
      id: "example-activity-remap",
      at: at(35),
      kind: "remap",
      title: "ExampleOwner added a creature remap",
      detail: "Aberrant Ankylosaurus to Ankylosaurus",
      to: "/remaps",
    },
    {
      id: "example-activity-source",
      at: at(55),
      kind: "source",
      title: "RexOps reviewed Official ASA content",
      detail: "Added notes and map assignments to official catalog entries",
      to: "/content",
    },
    {
      id: "example-activity-player",
      at: at(80),
      kind: "players",
      title: "ExampleOwner updated the player roster",
      detail: "Added Example Ranger and Example Builder",
      to: "/players",
    },
    {
      id: "example-activity-settings",
      at: at(115),
      kind: "settings",
      title: "RexOps reviewed project settings",
      detail: "Confirmed example modules and publishing arrangement",
      to: "/settings",
    },
  ];
}

/**
 * Coherent project files using entries from the bundled Official ASA catalog.
 *
 * Every object passes the same schema as user-authored data. URLs and real
 * service ids stay empty so exploring the example never contacts a third party.
 */
export function exampleProjectFiles(
  now = new Date(),
): Partial<Record<ProjectFileName, string>> {
  const catalog = CatalogFileSchema.parse({
    ...emptyCatalog(),
    icons: {
      [ANKYLOSAURUS.toLowerCase()]: "🦕",
      [DOEDICURUS.toLowerCase()]: "🦔",
      [CRYSTAL.toLowerCase()]: "🔷",
      [METAL.toLowerCase()]: "⛏️",
      [GASOLINE.toLowerCase()]: "🔥",
      [STONE.toLowerCase()]: "🪨",
    },
    notes: {
      [ANKYLOSAURUS.toLowerCase()]:
        "Official ASA creature used for the advanced production example.",
      [DOEDICURUS.toLowerCase()]:
        "Official ASA creature used for the simple production example.",
    },
    maps: {
      [ANKYLOSAURUS.toLowerCase()]: "The Island",
      [DOEDICURUS.toLowerCase()]: "The Island",
    },
    itemInfo: {
      [CRYSTAL.toLowerCase()]: {
        type: "Resource",
        rarity: "Common",
        stackSize: 100,
        highOutputPerHour: 150,
      },
      [METAL.toLowerCase()]: {
        type: "Resource",
        rarity: "Common",
        stackSize: 200,
        highOutputPerHour: 120,
      },
    },
  });

  const production = ProductionDraftSchema.parse({
    schemaVersion: 1,
    rules: [
      {
        id: "example-rule-collector",
        enabled: true,
        notes: "Shows alternate outputs, consumed inputs, chances, and quantity caps.",
        dinoType: ANKYLOSAURUS,
        chanceToProduce: 0.75,
        cycles: [
          {
            id: "example-cycle-crystals",
            name: "Crystal collection",
            intervalSeconds: 120,
            itemSelectMode: 0,
            items: [
              {
                id: "example-primary-crystal",
                bpPath: CRYSTAL,
                quantityPerDino: 2,
                maxQuantityPerCycle: 50,
                maxQuantityInTerminal: 500,
                alternateSelectMode: 1,
                alternateItemsChance: 0.1,
                alternateItems: [
                  {
                    id: "example-alt-rare-crystal",
                    bpPath: METAL,
                    quantityPerItem: 1,
                    maxQuantityPerCycle: 2,
                    maxQuantityInTerminal: 20,
                  },
                ],
                consumesSelectMode: 0,
                consumesItemsChance: 1,
                consumesItems: [
                  {
                    id: "example-consumed-fuel",
                    bpPath: GASOLINE,
                    quantityPerItem: 1,
                    maxQuantityPerCycle: 0,
                    maxQuantityInTerminal: 0,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "example-rule-gardener",
        enabled: true,
        notes: "A small rule for comparing simple and advanced production.",
        dinoType: DOEDICURUS,
        chanceToProduce: 1,
        cycles: [
          {
            id: "example-cycle-berries",
            name: "Stone gathering",
            intervalSeconds: 300,
            itemSelectMode: 0,
            items: [
              {
                id: "example-primary-berry",
                bpPath: STONE,
                quantityPerDino: 8,
                maxQuantityPerCycle: 80,
                maxQuantityInTerminal: 800,
                alternateSelectMode: 0,
                alternateItemsChance: 0,
                alternateItems: [],
                consumesSelectMode: 0,
                consumesItemsChance: 0,
                consumesItems: [],
              },
            ],
          },
        ],
      },
    ],
  });

  const remaps = RemapsDraftSchema.parse({
    schemaVersion: 1,
    entries: [
      {
        id: "example-remap-collector",
        active: true,
        fromClass: `${ABERRANT_ANKYLOSAURUS}_C`,
        toClass: `${ANKYLOSAURUS}_C`,
        fromSourceId: OFFICIAL_SOURCE_ID,
        toSourceId: OFFICIAL_SOURCE_ID,
        intentional: false,
        notes:
          "Intentional teaching warning: DEV editing can mark this remap as deliberate.",
      },
    ],
  });

  const cosmetics = CosmeticsDraftSchema.parse({
    schemaVersion: 1,
    entries: [
      {
        id: "example-cosmetic",
        modId: "999999",
        enableDynamicDownload: true,
        allowNonDataOnlyBlueprints: false,
        included: true,
        name: "Example Survivor Skins",
        url: "",
        updated: "",
        notes: "Fictional entry included for layout and publishing previews.",
        deprecatedAt: null,
      },
    ],
    lastScrapeAt: null,
    lastScrape: null,
  });

  const players = PlayersFileSchema.parse({
    schemaVersion: 1,
    players: [
      {
        id: "example-player-ranger",
        discordName: "ExampleRanger",
        discordId: "100000000000000001",
        steamName: "Example Ranger",
        steamId: "76561198000000001",
        accountName: "ExampleRangerASA",
        gameName: "Ranger",
        playerId: "100000001",
        eosId: "example-eos-ranger",
        notes: "Fictional player record. No real account or profile data.",
        profile: null,
      },
      {
        id: "example-player-builder",
        discordName: "ExampleBuilder",
        discordId: "100000000000000002",
        steamName: "Example Builder",
        steamId: "76561198000000002",
        accountName: "ExampleBuilderASA",
        gameName: "Builder",
        playerId: "100000002",
        eosId: "example-eos-builder",
        notes: "Second fictional record for search and roster examples.",
        profile: null,
      },
    ],
    cleanSlates: [],
  });

  const activity = ActivityFileSchema.parse({
    schemaVersion: 1,
    events: exampleProjectActivityEvents(now),
  });

  return {
    [PROJECT_FILE.production]: json(production),
    [PROJECT_FILE.remaps]: json(remaps),
    [PROJECT_FILE.cosmetics]: json(cosmetics),
    [PROJECT_FILE.catalog]: json(catalog),
    [PROJECT_FILE.players]: json(players),
    [PROJECT_FILE.activity]: json(activity),
  };
}

export interface ExampleTourStep {
  id: string;
  route: string;
  /** Stable registry id. Runtime resolution never depends on visible text. */
  targetId: string;
  /** Optional safe context distinguishes repeated registered targets. */
  targetContext?: Record<string, string>;
  targetName: string;
  eyebrow: string;
  title: string;
  body: string;
  completion: ExampleTourCompletion;
  /** Seconds a view-completed spotlight remains visible before advancing. */
  viewDurationSeconds?: number;
  padding: number;
  placement: ExampleTourPlacement;
  /** Spotlight, titled pointer, or persistent hover note. */
  visual?: ExampleTourVisual;
  /** Centered percentage of the selected target covered by the focus box. */
  focusWidthPercent?: number;
  focusHeightPercent?: number;
  /** Target-relative custom focus geometry, authored by dragging/resizing the box. */
  focusRect?: ExampleTourRelativeRect;
  /** Target-relative point where a cursor-authored arrow or dot is anchored. */
  annotationPosition?: ExampleTourPoint;
  /** Direction the arrow points toward its anchor. */
  arrowDirection?: ExampleTourArrowDirection;
  /** Expanded toggles captured when this focus area was authored. */
  expansions?: ExampleTourExpansion[];
  /** Active page selections needed to mount the authored focus area. */
  selections?: string[];
  /** Spotlight step that owns this arrow or hover note. */
  parentStepId?: string;
  /** Legacy imported shape. Normalization migrates this into document controls. */
  control?: ExampleTourControl;
}

export type ExampleTourCompletion = "view" | "click" | "page" | "manual";
export type ExampleTourVisual = "spotlight" | "arrow" | "hotspot";
export type ExampleTourArrowDirection =
  | "up"
  | "up-right"
  | "right"
  | "down-right"
  | "down"
  | "down-left"
  | "left"
  | "up-left";

export interface ExampleTourPoint {
  x: number;
  y: number;
}

export interface ExampleTourRelativeRect extends ExampleTourPoint {
  width: number;
  height: number;
}

export interface ExampleTourControl {
  label: string;
  index: number;
  state: "enabled" | "disabled";
  /** Whole example project, or legacy behavior limited to active tour step. */
  scope?: "example" | "step";
}

export interface ExampleTourExpansion {
  /** Stable CollapsibleCard preference key when available. */
  key?: string;
  label: string;
  index: number;
}

/** Local-only marker for page controls that reveal walkthrough targets. */
export const EXAMPLE_TOUR_SELECTION_ATTR = "data-example-tour-selection";

/**
 * Selection state needed before expansion replay.
 *
 * Older drafts predate explicit selection capture. Their stable expansion
 * keys still identify the selected entity, so include them as a migration
 * fallback; pages without a matching selection control ignore them.
 */
export function exampleTourSelectionKeys(step: ExampleTourStep): string[] {
  return [...new Set([
    ...(step.selections ?? []),
    ...(step.expansions ?? []).flatMap((expansion) => expansion.key ? [expansion.key] : []),
  ])];
}

export interface ExampleButtonControl extends ExampleTourControl {
  id: string;
  route: string;
  targetId: string;
  targetContext?: Record<string, string>;
  targetName: string;
}

export type ExampleTourPlacementMode =
  | "auto"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "custom";

export interface ExampleTourPlacement {
  mode: ExampleTourPlacementMode;
  /** Viewport-relative coordinates, used only by custom placement. */
  x?: number;
  y?: number;
}

export interface ExampleTourDocument {
  version: 1;
  steps: ExampleTourStep[];
  controls: ExampleButtonControl[];
}

/** Stable routes and targets used by both automatic progress and spotlight UI. */
export const EXAMPLE_TOUR_STEPS: readonly ExampleTourStep[] = [
  {
    id: "overview",
    route: "/overview",
    targetId: "overview-health-summary",
    targetName: "Project Health",
    eyebrow: "Start here",
    title: "Read project health at a glance",
    body: "Overview combines validation, output readiness, recent activity, and next actions. One deliberate warning gives Needs Attention something useful to demonstrate.",
    completion: "view",
    padding: 8,
    placement: { mode: "auto" },
  },
  {
    id: "content",
    route: "/content",
    targetId: "content-sources",
    targetName: "Content Sources",
    eyebrow: "Content",
    title: "Explore the Official ASA catalog",
    body: "The bundled catalog supplies real Ankylosaurus, Doedicurus, Crystal, Metal, Stone, and Gasoline entries. Project notes and map assignments demonstrate safe local customization.",
    completion: "view",
    padding: 8,
    placement: { mode: "auto" },
  },
  {
    id: "production",
    route: "/production",
    targetId: "production-rules",
    targetName: "Production Rules",
    eyebrow: "Rules",
    title: "Compare simple and advanced production",
    body: "Ankylosaurus demonstrates chances, caps, alternate outputs, and consumed Gasoline. Doedicurus shows the smallest useful Stone-production rule.",
    completion: "view",
    padding: 8,
    placement: { mode: "auto" },
  },
  {
    id: "simulator",
    route: "/simulator",
    targetId: "passive-production-simulator",
    targetName: "Passive Production Simulator",
    eyebrow: "Simulator",
    title: "Preview output before publishing",
    body: "Review creature counts and time windows to see expected, minimum, and maximum production without writing any files. DEV editing unlocks the controls.",
    completion: "view",
    padding: 8,
    placement: { mode: "auto" },
  },
  {
    id: "remaps",
    route: "/remaps",
    targetId: "creature-remaps",
    targetName: "Creature Remaps",
    eyebrow: "Migration",
    title: "Review a deliberate creature remap",
    body: "The example remaps official Aberrant Ankylosaurus to Ankylosaurus. Enable DEV editing and mark it Intentional to resolve its teaching warning.",
    completion: "view",
    padding: 8,
    placement: { mode: "auto" },
  },
  {
    id: "cosmetics",
    route: "/curseforge",
    targetId: "curseforge",
    targetName: "CurseForge",
    eyebrow: "Cosmetics",
    title: "Inspect Custom Cosmetic Mod output",
    body: "The fictional cosmetic entry demonstrates inclusion, dynamic download, and generated-list behavior without contacting CurseForge.",
    completion: "view",
    padding: 8,
    placement: { mode: "auto" },
  },
  {
    id: "publish",
    route: "/publish",
    targetId: "publishing",
    targetName: "Publish",
    eyebrow: "Finish",
    title: "Preview every generated destination",
    body: "Publishing stays disconnected in the example. You can inspect readiness and output families without sending anything to GitHub.",
    completion: "view",
    padding: 8,
    placement: { mode: "auto" },
  },
] as const;

const COMPLETION_RULES = new Set<ExampleTourCompletion>([
  "view",
  "click",
  "page",
  "manual",
]);
const VISUAL_TYPES = new Set<ExampleTourVisual>([
  "spotlight",
  "arrow",
  "hotspot",
]);
const ARROW_DIRECTIONS = new Set<ExampleTourArrowDirection>([
  "up",
  "up-right",
  "right",
  "down-right",
  "down",
  "down-left",
  "left",
  "up-left",
]);
const PLACEMENT_MODES = new Set<ExampleTourPlacementMode>([
  "auto",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "custom",
]);

function cleanText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** Validates a locally-authored or imported walkthrough without trusting selectors. */
export function normalizeExampleTourDocument(value: unknown): ExampleTourDocument | null {
  if (!value || typeof value !== "object") return null;
  const document = value as Partial<ExampleTourDocument>;
  if (document.version !== 1 || !Array.isArray(document.steps)) return null;
  const ids = new Set<string>();
  const steps: ExampleTourStep[] = [];
  const legacyControls: ExampleButtonControl[] = [];

  for (const raw of document.steps) {
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Partial<ExampleTourStep>;
    const id = cleanText(record.id, 80);
    const route = cleanText(record.route, 160);
    const targetId = cleanText(record.targetId, 100);
    const definition = targetDefinition(targetId);
    const title = cleanText(record.title, 160);
    const body = cleanText(record.body, 6000);
    if (!id || ids.has(id) || !route.startsWith("/") || !definition || !title || !body) {
      return null;
    }
    ids.add(id);
    const context = record.targetContext && typeof record.targetContext === "object"
      ? sanitizeTargetContext(record.targetContext)
      : undefined;
    const completion = COMPLETION_RULES.has(record.completion as ExampleTourCompletion)
      ? (record.completion as ExampleTourCompletion)
      : "view";
    const requestedViewDuration = Number(record.viewDurationSeconds);
    const viewDurationSeconds = Number.isFinite(requestedViewDuration)
      ? Math.round(Math.max(0.5, Math.min(60, requestedViewDuration)) * 10) / 10
      : 3;
    const requestedMode = record.placement?.mode;
    const mode = PLACEMENT_MODES.has(requestedMode as ExampleTourPlacementMode)
      ? (requestedMode as ExampleTourPlacementMode)
      : "auto";
    const placement: ExampleTourPlacement = { mode };
    if (mode === "custom") {
      placement.x = Math.max(0, Math.min(1, Number(record.placement?.x) || 0));
      placement.y = Math.max(0, Math.min(1, Number(record.placement?.y) || 0));
    }
    const visual = VISUAL_TYPES.has(record.visual as ExampleTourVisual)
      ? (record.visual as ExampleTourVisual)
      : "spotlight";
    const percent = (value: unknown) =>
      Math.max(10, Math.min(100, Math.round(Number(value) || 100)));
    const unit = (value: unknown, fallback = 0) =>
      Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : fallback));
    const rawFocusRect = record.focusRect;
    const focusRect = rawFocusRect && typeof rawFocusRect === "object"
      ? {
          x: Math.min(0.98, unit(rawFocusRect.x)),
          y: Math.min(0.98, unit(rawFocusRect.y)),
          width: unit(rawFocusRect.width, 1),
          height: unit(rawFocusRect.height, 1),
        }
      : undefined;
    if (focusRect) {
      focusRect.width = Math.round(Math.max(0.02, Math.min(focusRect.width, 1 - focusRect.x)) * 1_000_000) / 1_000_000;
      focusRect.height = Math.round(Math.max(0.02, Math.min(focusRect.height, 1 - focusRect.y)) * 1_000_000) / 1_000_000;
    }
    const rawPoint = record.annotationPosition;
    const annotationPosition = rawPoint && typeof rawPoint === "object"
      ? { x: unit(rawPoint.x, 1), y: unit(rawPoint.y) }
      : undefined;
    const arrowDirection = ARROW_DIRECTIONS.has(record.arrowDirection as ExampleTourArrowDirection)
      ? (record.arrowDirection as ExampleTourArrowDirection)
      : undefined;
    const rawControl = record.control;
    const controlLabel = cleanText(rawControl?.label, 160);
    const controlState = rawControl?.state;
    const controlScope: NonNullable<ExampleTourControl["scope"]> =
      rawControl?.scope === "example" ? "example" : "step";
    const control =
      controlLabel && (controlState === "enabled" || controlState === "disabled")
        ? {
            label: controlLabel,
            index: Math.max(0, Math.min(99, Math.round(Number(rawControl?.index) || 0))),
            state: controlState,
            scope: controlScope,
          }
        : undefined;
    const expansions = Array.isArray(record.expansions)
      ? record.expansions.slice(0, 20).flatMap((rawExpansion) => {
          const label = cleanText(rawExpansion?.label, 160);
          if (!label) return [];
          return [{
            key: cleanText(rawExpansion?.key, 200) || undefined,
            label,
            index: Math.max(0, Math.min(99, Math.round(Number(rawExpansion?.index) || 0))),
          }];
        })
      : undefined;
    const selections = Array.isArray(record.selections)
      ? [...new Set(record.selections.flatMap((rawSelection) => {
          const selection = cleanText(rawSelection, 200);
          return selection ? [selection] : [];
        }))].slice(0, 12)
      : undefined;
    if (control) {
      legacyControls.push({
        id: `control-${id}`,
        route,
        targetId,
        targetContext: context && Object.keys(context).length > 0 ? context : undefined,
        targetName: definition.name,
        ...control,
        scope: "example",
      });
    }
    steps.push({
      id,
      route,
      targetId,
      targetContext: context && Object.keys(context).length > 0 ? context : undefined,
      targetName: definition.name,
      eyebrow: cleanText(record.eyebrow, 80) || "Walkthrough",
      title,
      body,
      completion,
      viewDurationSeconds,
      padding: Math.max(0, Math.min(40, Math.round(Number(record.padding) || 0))),
      placement,
      visual,
      focusWidthPercent: percent(record.focusWidthPercent),
      focusHeightPercent: percent(record.focusHeightPercent),
      focusRect,
      annotationPosition,
      arrowDirection,
      expansions,
      selections: selections && selections.length > 0 ? selections : undefined,
      parentStepId: cleanText(record.parentStepId, 80) || undefined,
    });
  }

  const walkthroughById = new Map(
    steps
      .filter((step) => (step.visual ?? "spotlight") === "spotlight")
      .map((step) => [step.id, step] as const),
  );
  const walkthroughByRoute = new Map<string, ExampleTourStep[]>();
  for (const walkthrough of walkthroughById.values()) {
    const routeSteps = walkthroughByRoute.get(walkthrough.route) ?? [];
    routeSteps.push(walkthrough);
    walkthroughByRoute.set(walkthrough.route, routeSteps);
  }
  const normalizedSteps = steps.map((step) => {
    if ((step.visual ?? "spotlight") === "spotlight") {
      return { ...step, parentStepId: undefined };
    }
    const requestedParent = step.parentStepId ? walkthroughById.get(step.parentStepId) : undefined;
    const parentStepId = requestedParent?.route === step.route
      ? step.parentStepId
      : walkthroughByRoute.get(step.route)?.at(-1)?.id;
    return { ...step, parentStepId };
  });

  const controls: ExampleButtonControl[] = [];
  const controlIds = new Set<string>();
  const rawControls = Array.isArray(document.controls) ? document.controls : [];
  for (const raw of [...rawControls, ...legacyControls]) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Partial<ExampleButtonControl>;
    let id = cleanText(record.id, 80);
    const route = cleanText(record.route, 160);
    const targetId = cleanText(record.targetId, 100);
    const definition = targetDefinition(targetId);
    const label = cleanText(record.label, 160);
    if (!id || !route.startsWith("/") || !definition || !label) continue;
    while (controlIds.has(id)) id = `${id}-copy`;
    controlIds.add(id);
    const targetContext = record.targetContext && typeof record.targetContext === "object"
      ? sanitizeTargetContext(record.targetContext)
      : undefined;
    controls.push({
      id,
      route,
      targetId,
      targetContext: targetContext && Object.keys(targetContext).length > 0 ? targetContext : undefined,
      targetName: definition.name,
      label,
      index: Math.max(0, Math.min(99, Math.round(Number(record.index) || 0))),
      state: record.state === "enabled" ? "enabled" : "disabled",
      scope: "example",
    });
  }
  return { version: 1, steps: normalizedSteps, controls };
}

export function defaultExampleTourDocument(): ExampleTourDocument {
  return { version: 1, steps: EXAMPLE_TOUR_STEPS.map((step) => ({ ...step })), controls: [] };
}

export interface ExampleTourProgress {
  version: number;
  completed: string[];
  dismissed: boolean;
}

export function emptyExampleTourProgress(): ExampleTourProgress {
  return { version: EXAMPLE_PROJECT_SEED_VERSION, completed: [], dismissed: false };
}

export function normalizeExampleTourProgress(
  value: unknown,
  steps: readonly ExampleTourStep[] = EXAMPLE_TOUR_STEPS,
): ExampleTourProgress {
  if (!value || typeof value !== "object") return emptyExampleTourProgress();
  const record = value as Partial<ExampleTourProgress>;
  if (record.version !== EXAMPLE_PROJECT_SEED_VERSION) {
    return emptyExampleTourProgress();
  }
  const known = new Set(steps.map((step) => step.id));
  const completed = Array.isArray(record.completed)
    ? [...new Set(record.completed.filter((id): id is string => typeof id === "string" && known.has(id)))]
    : [];
  return { version: EXAMPLE_PROJECT_SEED_VERSION, completed, dismissed: record.dismissed === true };
}

export function completeExampleTourStep(
  progress: ExampleTourProgress,
  stepId: string,
  steps: readonly ExampleTourStep[] = EXAMPLE_TOUR_STEPS,
): ExampleTourProgress {
  if (progress.completed.includes(stepId)) return progress;
  if (!steps.some((step) => step.id === stepId)) return progress;
  return { ...progress, completed: [...progress.completed, stepId] };
}

export function firstIncompleteExampleTourStep(
  progress: ExampleTourProgress,
  steps: readonly ExampleTourStep[] = EXAMPLE_TOUR_STEPS,
): number {
  const completed = new Set(progress.completed);
  const index = steps.findIndex((step) => !completed.has(step.id));
  return index < 0 ? 0 : index;
}
