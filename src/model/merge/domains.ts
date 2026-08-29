import { PROJECT_FILE, type ProjectFileName } from "../project";
import type { Conflict } from "./conflicts";
import {
  deepEqual,
  mergeList,
  mergeMap,
  mergeObject,
  type MergeContext,
  type MergeResult,
} from "./core";

/**
 * How each of the project's files merges.
 *
 * The generic engine knows how to merge an object and a list keyed by id. What
 * it cannot know is *which* key identifies a thing, what a field should be
 * called when an administrator is asked about it, and which fields are not
 * disagreements at all. That is what lives here, one entry per file.
 *
 * The rule behind every choice below: identity is whatever survives a rename.
 * A creature rule is identified by its id, not its position and not the
 * creature's name; a mod by its CurseForge id; a player by their record id. Get
 * that wrong and a merge quietly pairs two unrelated things together.
 */

/** A merge for one project file, over already-parsed JSON. */
export interface FileMerger {
  file: ProjectFileName;
  /** Human name for the file, used when something goes wrong with it. */
  label: string;
  merge(base: unknown, mine: unknown, theirs: unknown): MergeResult<unknown>;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Merges a file that is `{ schemaVersion, <one list> }`.
 *
 * `schemaVersion` is deliberately not merged: two administrators can only ever
 * disagree about it if one has migrated and the other has not, and that is
 * caught long before here by the compatibility gate.
 */
function listFileMerger(
  key: string,
  options: Parameters<typeof mergeList>[3],
): (base: unknown, mine: unknown, theirs: unknown) => MergeResult<unknown> {
  return (base, mine, theirs) => {
    const mineObj = asObject(mine);
    const theirsObj = asObject(theirs);
    const result = mergeList(
      base === undefined ? undefined : asArray(asObject(base)[key]),
      asArray(mineObj[key]),
      asArray(theirsObj[key]),
      options,
    );
    return {
      value: { ...theirsObj, ...mineObj, [key]: result.value },
      conflicts: result.conflicts,
    };
  };
}

// ---------------------------------------------------------------------------
// Production rules
// ---------------------------------------------------------------------------

const PRODUCTION_LABELS: Record<string, string> = {
  enabled: "Enabled",
  notes: "Notes",
  dinoType: "Creature",
  chanceToProduce: "Chance to produce",
  cycles: "Production cycles",
  intervalSeconds: "Interval",
  name: "Name",
  quantityPerDino: "Quantity per creature",
  maxQuantityPerCycle: "Maximum per cycle",
  maxQuantityInTerminal: "Maximum in terminal",
};

/**
 * A creature rule.
 *
 * Cycles nest two levels deep and each level carries its own id, so the same
 * by-id rule applies all the way down: two administrators editing different
 * cycles of the same creature do not conflict.
 */
function mergeRule(
  base: Json | undefined,
  mine: Json,
  theirs: Json,
  context: MergeContext,
): MergeResult<Json> {
  const conflicts: Conflict[] = [];

  const scalars = mergeObject(
    base,
    { ...mine, cycles: undefined },
    { ...theirs, cycles: undefined },
    { ...context, labels: PRODUCTION_LABELS },
  );
  conflicts.push(...scalars.conflicts);

  const cycles = mergeList(
    base ? asArray(base.cycles) : undefined,
    asArray(mine.cycles),
    asArray(theirs.cycles),
    {
      keyOf: (c) => str(c.id),
      labelOf: (c) => str(c.name) || context.itemLabel,
      domain: context.domain,
      labels: PRODUCTION_LABELS,
      mergeItem: mergeCycle,
    },
  );
  conflicts.push(...cycles.conflicts);

  return { value: { ...scalars.value, cycles: cycles.value }, conflicts };
}

function mergeCycle(
  base: Json | undefined,
  mine: Json,
  theirs: Json,
  context: MergeContext,
): MergeResult<Json> {
  const conflicts: Conflict[] = [];
  const scalars = mergeObject(
    base,
    { ...mine, items: undefined },
    { ...theirs, items: undefined },
    { ...context, labels: PRODUCTION_LABELS },
  );
  conflicts.push(...scalars.conflicts);

  const items = mergeList(
    base ? asArray(base.items) : undefined,
    asArray(mine.items),
    asArray(theirs.items),
    {
      keyOf: (i) => str(i.id),
      // An item is known by its blueprint path, which is what an admin reads.
      labelOf: (i) => leafOf(str(i.bpPath)),
      domain: context.domain,
      labels: PRODUCTION_LABELS,
    },
  );
  conflicts.push(...items.conflicts);

  return { value: { ...scalars.value, items: items.value }, conflicts };
}

/** The readable tail of a blueprint path, for a label. */
function leafOf(bpPath: string): string {
  return bpPath.split(/[./]/).filter(Boolean).pop() ?? bpPath;
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

const CATALOG_LABELS: Record<string, string> = {
  name: "Name",
  kind: "Kind",
  curseforgeId: "CurseForge ID",
  url: "Mod page",
  docsUrl: "Docs link",
  discordUrl: "Discord link",
  iconsDir: "Icons folder",
  iniNotes: "INI notes",
  iniSettings: "INI settings",
  enabled: "Enabled",
};

/**
 * Merges `catalog.mods.json`.
 *
 * Four shapes in one file: the source list (by id), and three plain maps -
 * icon assignments, per-path notes and maps of origin - all keyed by blueprint
 * path. The maps are where two administrators are most likely to touch the
 * same file without touching the same entry, which is exactly the case a
 * by-key merge handles invisibly.
 *
 * `iconsDir` is a machine-local path that should never have been in a shared
 * file; until it moves out, it is left to this computer rather than fought over.
 */
function mergeCatalog(base: unknown, mine: unknown, theirs: unknown): MergeResult<unknown> {
  const baseObj = base === undefined ? undefined : asObject(base);
  const mineObj = asObject(mine);
  const theirsObj = asObject(theirs);
  const conflicts: Conflict[] = [];

  const sources = mergeList(
    baseObj ? asArray(baseObj.sources) : undefined,
    asArray(mineObj.sources),
    asArray(theirsObj.sources),
    {
      keyOf: (s) => str(s.id),
      labelOf: (s) => str(s.name) || str(s.id),
      domain: "mod",
      labels: CATALOG_LABELS,
      ignore: ["iconsDir"],
    },
  );
  conflicts.push(...sources.conflicts);

  const out: Json = { ...theirsObj, ...mineObj, sources: sources.value };

  for (const [key, domain] of [
    ["icons", "icon"],
    ["notes", "note"],
    ["maps", "map of origin"],
    ["variantParents", "variant"],
  ] as const) {
    const merged = mergeMap(
      baseObj ? (asObject(baseObj[key]) as Record<string, string>) : undefined,
      asObject(mineObj[key]) as Record<string, string>,
      asObject(theirsObj[key]) as Record<string, string>,
      { domain, itemId: "", itemLabel: domain },
    );
    out[key] = merged.value;
    conflicts.push(...merged.conflicts);
  }

  return { value: out, conflicts };
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

const PLAYER_LABELS: Record<string, string> = {
  discordName: "Discord name",
  discordId: "Discord ID",
  steamName: "Steam name",
  steamId: "Steam ID",
  accountName: "Account name",
  gameName: "Game name",
  playerId: "Player ID",
  eosId: "EOS ID",
  notes: "Notes",
  profile: "Stored profile",
  map: "Map",
};

/**
 * Merges the roster.
 *
 * A player's stored profile is a reference to a binary file, and two different
 * profiles filed under one player is not something to merge field-wise - the
 * file names would agree while the saves behind them differ. It is raised as a
 * whole-value conflict so the administrator picks a save rather than a set of
 * fields describing one.
 */
function mergePlayers(base: unknown, mine: unknown, theirs: unknown): MergeResult<unknown> {
  const baseObj = base === undefined ? undefined : asObject(base);
  const mineObj = asObject(mine);
  const theirsObj = asObject(theirs);
  const conflicts: Conflict[] = [];

  const players = mergeList(
    baseObj ? asArray(baseObj.players) : undefined,
    asArray(mineObj.players),
    asArray(theirsObj.players),
    {
      keyOf: (p) => str(p.id),
      labelOf: (p) =>
        str(p.discordName) || str(p.gameName) || str(p.steamName) || str(p.id),
      domain: "player",
      labels: PLAYER_LABELS,
      mergeItem: mergePlayer,
    },
  );
  conflicts.push(...players.conflicts);

  const cleanSlates = mergeList(
    baseObj ? asArray(baseObj.cleanSlates) : undefined,
    asArray(mineObj.cleanSlates),
    asArray(theirsObj.cleanSlates),
    {
      // One clean slate per map, so the map *is* the identity.
      keyOf: (s) => str(s.map).trim().toLowerCase(),
      labelOf: (s) => `${str(s.map)} starting profile`,
      domain: "profile",
      labels: PLAYER_LABELS,
    },
  );
  conflicts.push(...cleanSlates.conflicts);

  return {
    value: {
      ...theirsObj,
      ...mineObj,
      players: players.value,
      cleanSlates: cleanSlates.value,
    },
    conflicts,
  };
}

function mergePlayer(
  base: Json | undefined,
  mine: Json,
  theirs: Json,
  context: MergeContext,
): MergeResult<Json> {
  const result = mergeObject(
    base,
    { ...mine, profile: undefined },
    { ...theirs, profile: undefined },
    { ...context, labels: PLAYER_LABELS },
  );

  const conflicts = [...result.conflicts];
  const mineProfile = mine.profile ?? null;
  const theirsProfile = theirs.profile ?? null;
  const baseProfile = base?.profile ?? null;

  let profile = mineProfile;
  if (deepEqual(mineProfile, theirsProfile)) {
    profile = mineProfile;
  } else if (deepEqual(mineProfile, baseProfile)) {
    profile = theirsProfile;
  } else if (deepEqual(theirsProfile, baseProfile)) {
    profile = mineProfile;
  } else {
    // Two different saves for one survivor. Merging the *references* would
    // produce a record pointing at one file while describing another.
    conflicts.push({
      id: `player:${context.itemId}:profile`,
      domain: "player",
      itemId: context.itemId,
      itemLabel: context.itemLabel,
      field: "profile",
      fieldLabel: "Stored profile",
      kind: "binary",
      base: baseProfile,
      mine: mineProfile,
      theirs: theirsProfile,
      canKeepBoth: true,
    });
  }

  return { value: { ...result.value, profile }, conflicts };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Every file the merge knows how to handle.
 *
 * A project file absent from here is not merged - see `reconcile.ts`, which
 * treats an unknown file as something only a person can settle rather than
 * silently keeping one side. Adding a project file therefore means adding an
 * entry here, and a test enforces that.
 */
export const FILE_MERGERS: FileMerger[] = [
  {
    file: PROJECT_FILE.production,
    label: "production rules",
    merge: listFileMerger("rules", {
      keyOf: (r) => str(r.id),
      labelOf: (r) => leafOf(str(r.dinoType)),
      domain: "creature",
      labels: PRODUCTION_LABELS,
      mergeItem: mergeRule,
    }),
  },
  {
    file: PROJECT_FILE.remaps,
    label: "creature remaps",
    merge: listFileMerger("entries", {
      keyOf: (e) => str(e.id),
      labelOf: (e) => `${leafOf(str(e.fromClass))} → ${leafOf(str(e.toClass))}`,
      domain: "remap",
      labels: {
        active: "Active",
        fromClass: "From creature",
        toClass: "To creature",
        notes: "Notes",
        intentional: "Marked deliberate",
      },
    }),
  },
  {
    file: PROJECT_FILE.cosmetics,
    label: "custom cosmetics",
    merge: (base, mine, theirs) => {
      const mineObj = asObject(mine);
      const theirsObj = asObject(theirs);
      const entries = mergeList(
        base === undefined ? undefined : asArray(asObject(base).entries),
        asArray(mineObj.entries),
        asArray(theirsObj.entries),
        {
          // The CurseForge id is the real identity here: the same mod added on
          // two machines gets two record ids but is one mod.
          keyOf: (e) => str(e.modId) || str(e.id),
          labelOf: (e) => str(e.name) || str(e.modId),
          domain: "cosmetic",
          labels: {
            included: "Included in the list",
            enableDynamicDownload: "Dynamic download",
            allowNonDataOnlyBlueprints: "Allow non-data-only blueprints",
            name: "Name",
            notes: "Notes",
            deprecatedAt: "Delisted",
          },
        },
      );
      return {
        // The last scrape is a cache of what CurseForge said, not a decision
        // anybody made - the newer one simply wins.
        value: {
          ...theirsObj,
          ...mineObj,
          entries: entries.value,
          ...newerScrape(mineObj, theirsObj),
        },
        conflicts: entries.conflicts,
      };
    },
  },
  {
    file: PROJECT_FILE.catalog,
    label: "mod catalog",
    merge: mergeCatalog,
  },
  {
    file: PROJECT_FILE.watchlist,
    label: "watched mods",
    merge: listFileMerger("mods", {
      keyOf: (m) => str(m.modId) || str(m.id),
      labelOf: (m) => str(m.name) || str(m.modId),
      domain: "watched mod",
      labels: {
        watching: "Watching",
        knownUpdated: "Reviewed version",
        notes: "Notes",
        name: "Name",
      },
      // Results of a check either machine happened to run, not decisions.
      ignore: ["lastCheckedAt", "latestUpdated", "needsReview"],
    }),
  },
  {
    file: PROJECT_FILE.players,
    label: "player roster",
    merge: mergePlayers,
  },
  {
    file: PROJECT_FILE.creatureImports,
    label: "creature imports",
    merge: listFileMerger("records", {
      keyOf: (r) => str(r.id),
      labelOf: (r) => leafOf(str(r.bpPath)) || str(r.id),
      domain: "imported creature",
    }),
  },
];

/** The scrape cache: whichever side ran one more recently. */
function newerScrape(mine: Json, theirs: Json): Json {
  const mineAt = str(mine.lastScrapeAt);
  const theirsAt = str(theirs.lastScrapeAt);
  return theirsAt > mineAt
    ? { lastScrapeAt: theirs.lastScrapeAt, lastScrape: theirs.lastScrape }
    : { lastScrapeAt: mine.lastScrapeAt, lastScrape: mine.lastScrape };
}

export function mergerFor(file: string): FileMerger | undefined {
  return FILE_MERGERS.find((m) => m.file === file);
}

// ---------------------------------------------------------------------------
// The project manifest
// ---------------------------------------------------------------------------

const SETTINGS_LABELS: Record<string, string> = {
  name: "Project name",
  cluster: "Cluster name",
  outputPaths: "Published file locations",
  defaults: "Default production values",
  simulator: "Simulator defaults",
  maps: "Maps",
  discord: "Discord announcement format",
  modules: "Enabled pages",
  playerData: "Player Data settings",
  modpackRegistry: "Modpack registry",
  packageDependencies: "Exact package dependencies",
};

/**
 * Merges `project.json`.
 *
 * Field-wise, with the identity fields held out entirely: `projectId`,
 * `format`, `schemaVersion` and `createdAt` are facts about the project rather
 * than settings, and a disagreement about any of them means something has gone
 * wrong that a merge must not paper over.
 */
export function mergeSettings(
  base: unknown,
  mine: unknown,
  theirs: unknown,
): MergeResult<unknown> {
  const mineObj = asObject(mine);
  const theirsObj = asObject(theirs);
  const identity = ["projectId", "format", "schemaVersion", "createdAt"];
  const baseObj = base === undefined ? undefined : asObject(base);

  const dependencies = mergeList(
    baseObj ? asArray(baseObj.packageDependencies) : undefined,
    asArray(mineObj.packageDependencies),
    asArray(theirsObj.packageDependencies),
    {
      keyOf: (dependency) =>
        str(dependency.kind) === "modpack" && str(dependency.curseforgeId)
          ? `modpack:curseforge:${str(dependency.curseforgeId)}`
          : `${str(dependency.kind)}:${str(dependency.packageId)}`,
      labelOf: (dependency) =>
        `${str(dependency.packageId)}@${str(dependency.version)}`,
      domain: "package dependency",
      labels: {
        version: "Exact version",
        integrity: "Manifest integrity",
        sourceId: "Content source",
        mode: "Dependency mode",
        locator: "Package registry location",
      },
    },
  );

  const result = mergeObject(
    baseObj ? { ...baseObj, packageDependencies: undefined } : undefined,
    { ...mineObj, packageDependencies: undefined },
    { ...theirsObj, packageDependencies: undefined },
    {
      domain: "project",
      itemId: str(mineObj.projectId),
      itemLabel: str(mineObj.name) || "this project",
      labels: SETTINGS_LABELS,
      ignore: identity,
    },
  );

  // The identity fields are carried across from this computer untouched.
  const value = {
    ...result.value,
    packageDependencies: dependencies.value,
  } as Json;
  for (const key of identity) value[key] = mineObj[key];
  return { value, conflicts: [...result.conflicts, ...dependencies.conflicts] };
}
