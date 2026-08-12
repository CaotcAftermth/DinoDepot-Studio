import { emptyCatalog, type CatalogFile, type ContentSource } from "./catalog";
import { emptyCosmeticsDraft, type CosmeticEntry, type CosmeticsDraft } from "./cosmetics";
import { emptyHistory, type HistoryFile, type OutputFamily } from "./history";
import { emptyPlayers, newPlayer, type PlayersFile } from "./players";
import { emptyProductionDraft, type CreatureRule, type ProductionDraft } from "./production";
import {
  defaultProjectSettings,
  defaultOutputPaths,
  type GithubConfig,
  type ProjectSettings,
} from "./project";
import { emptyRemapsDraft, type RemapEntry, type RemapsDraft } from "./remaps";
import { emptyWatchlist, type WatchedMod, type Watchlist } from "./watchlist";
import { buildOutputStates, type OutputBuildInput } from "./outputs";
import { githubReadiness } from "./githubReadiness";
import { buildOverview, type OverviewModel } from "./projectOverview";
import { contentHash } from "../services/publish";

/**
 * Project fixtures for the Overview and output-status tests.
 *
 * Shared because those tests are mostly "take a working project, break one
 * thing, check what Overview says" — building a whole project inline for each
 * would bury the one line that matters.
 */

export const REX = "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP";
export const HIDE =
  "/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Hide.PrimalItemResource_Hide";

export function settings(over: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    ...defaultProjectSettings("Test Project", "Test Cluster", "fixture-project-id"),
    ...over,
  };
}

/**
 * The repository a fixture publishes to. Separate from `settings` because the
 * binding is machine-local now — the split these fixtures exist to exercise.
 */
export function githubConfig(over: Partial<GithubConfig> = {}): GithubConfig {
  return {
    owner: "ggfizz",
    repo: "cluster",
    branch: "main",
    paths: defaultOutputPaths(),
    ...over,
  };
}

export function rule(over: Partial<CreatureRule> = {}): CreatureRule {
  return {
    id: "r1",
    enabled: true,
    notes: "",
    dinoType: REX,
    chanceToProduce: 1,
    cycles: [
      {
        id: "c1",
        name: "",
        intervalSeconds: 300,
        itemSelectMode: 0,
        items: [
          {
            id: "i1",
            bpPath: HIDE,
            quantityPerDino: 1,
            maxQuantityPerCycle: 0,
            maxQuantityInTerminal: 0,
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
    ...over,
  };
}

export function production(...rules: CreatureRule[]): ProductionDraft {
  return { ...emptyProductionDraft(), rules };
}

export function remapEntry(over: Partial<RemapEntry> = {}): RemapEntry {
  return {
    id: "rm1",
    active: true,
    fromClass: "/OldMod/Old_Character_BP.Old_Character_BP_C",
    toClass: `${REX}_C`,
    fromSourceId: null,
    toSourceId: null,
    intentional: true,
    notes: "",
    ...over,
  };
}

export function remaps(...entries: RemapEntry[]): RemapsDraft {
  return { ...emptyRemapsDraft(), entries };
}

export function cosmetic(over: Partial<CosmeticEntry> = {}): CosmeticEntry {
  return {
    id: "cm1",
    modId: "111222",
    enableDynamicDownload: true,
    allowNonDataOnlyBlueprints: true,
    included: true,
    name: "Skins",
    url: "",
    updated: "",
    notes: "",
    deprecatedAt: null,
    ...over,
  };
}

export function cosmetics(...entries: CosmeticEntry[]): CosmeticsDraft {
  return { ...emptyCosmeticsDraft(), entries };
}

export function watched(over: Partial<WatchedMod> = {}): WatchedMod {
  return {
    id: "w1",
    modId: "999",
    name: "Some Mod",
    url: "https://cf/x",
    knownUpdated: "Jan 1, 2026",
    latestUpdated: "Jan 1, 2026",
    lastCheckedAt: null,
    needsReview: false,
    notes: "",
    watching: true,
    ...over,
  };
}

export function watchlist(...mods: WatchedMod[]): Watchlist {
  return { ...emptyWatchlist(), mods };
}

export function source(over: Partial<ContentSource> = {}): ContentSource {
  return {
    id: "s1",
    name: "Some Mod",
    kind: "mod",
    curseforgeId: "999",
    url: "",
    docsUrl: "",
    discordUrl: "",
    iconsDir: "",
    iniNotes: "",
    iniSettings: [],
    iniBuild: {},
    variantTag: "",
    modpackId: "",
    modpackVersion: "",
    enabled: true,
    removed: false,
    notes: "",
    creatures: [],
    items: [],
    ...over,
  };
}

export function catalog(...sources: ContentSource[]): CatalogFile {
  return { ...emptyCatalog(), sources };
}

export function players(count: number): PlayersFile {
  return {
    ...emptyPlayers(),
    players: Array.from({ length: count }, (_, i) => newPlayer(`p${i}`)),
  };
}

/** A history where the given families were published with the given content. */
export function publishedHistory(
  entries: { family: OutputFamily; hash: string }[],
): HistoryFile {
  return {
    ...emptyHistory(),
    records: entries.map((e, i) => ({
      id: `h${i}`,
      family: e.family,
      publishedAt: "2026-08-01T10:00:00.000Z",
      commitSha: "abc1234",
      commitMessage: "Published",
      path: `dinodepot/${e.family}.json`,
      rawUrl: "https://raw/x",
      contentHash: e.hash,
    })),
  };
}

// ---------------------------------------------------------------------------

export interface ProjectFixture extends Partial<OutputBuildInput> {
  watchlist?: Watchlist;
  tokenPresent?: boolean | null;
  desktop?: boolean;
  connection?: "unknown" | "ok" | "failed";
}

function buildInput(fixture: ProjectFixture): OutputBuildInput {
  return {
    production: fixture.production ?? emptyProductionDraft(),
    remaps: fixture.remaps ?? emptyRemapsDraft(),
    cosmetics: fixture.cosmetics ?? emptyCosmeticsDraft(),
    catalog: fixture.catalog ?? emptyCatalog(),
    players: fixture.players ?? emptyPlayers(),
    history: fixture.history ?? emptyHistory(),
    imageFiles: fixture.imageFiles ?? [],
    settings: fixture.settings === undefined ? settings() : fixture.settings,
    github: fixture.github ?? githubConfig(),
    index: fixture.index ?? null,
  };
}

export function outputsFor(fixture: ProjectFixture = {}) {
  return buildOutputStates(buildInput(fixture));
}

/** The full Overview model for a fixture, with publishing ready by default. */
export function overviewFor(fixture: ProjectFixture = {}): OverviewModel {
  const input = buildInput(fixture);
  const outputs = buildOutputStates(input);
  const github = githubReadiness({
    github: input.github,
    outputs,
    tokenPresent: fixture.tokenPresent === undefined ? true : fixture.tokenPresent,
    desktop: fixture.desktop ?? true,
    connection: fixture.connection ?? "ok",
  });
  return buildOverview({
    production: input.production,
    remaps: input.remaps,
    cosmetics: input.cosmetics,
    catalog: input.catalog,
    watchlist: fixture.watchlist ?? emptyWatchlist(),
    outputs,
    github,
  });
}

/**
 * A history that marks every applicable output of a fixture as published,
 * so a test can start from "fully synchronized" and change one thing.
 */
export function historyMatching(fixture: ProjectFixture): HistoryFile {
  const outputs = buildOutputStates(buildInput({ ...fixture, history: emptyHistory() }));
  return publishedHistory(
    outputs
      .filter((o) => o.applicable)
      .map((o) => ({ family: o.family, hash: o.hash })),
  );
}

export { contentHash };
