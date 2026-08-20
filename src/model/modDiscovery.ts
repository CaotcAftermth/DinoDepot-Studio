import type { CatalogEntry, CatalogFile, ContentSource } from "./catalog";
import { currentCurseforgeUrl } from "./catalogDuplicates";
import { ContentSourceSchema, normalizeBpPath } from "./catalog";

/**
 * Mod Discovery: reading a mod's catalogue out of the files it already ships.
 *
 * An installed ASA mod carries a plain-text listing of everything it cooked —
 * `Manifest_UFSFiles_Win64.txt` — beside a `.uplugin` describing the mod. Between
 * them there is enough to populate a content source without opening a single
 * packed asset, which is the whole reason this path exists: cataloguing a mod by
 * hand is hours of clicking through FModel, and the answer was sitting in a text
 * file the entire time.
 *
 * What this cannot do is equally important. The manifest lists paths, not types:
 * every asset is a `.uasset` whether it is a creature, a texture or a material,
 * so classification here is a naming convention and nothing more. Treat the
 * output as a strong first draft an admin reviews, never as fact. The real
 * classes live in each mod's `AssetRegistry.bin` inside the pak, which is where
 * this would go next if the guesswork ever stops being good enough.
 *
 * Verified against 245 installed mods (113,112 assets): every content asset sat
 * under `ShooterGame/Mods/<Short>/Content/`, and the paths this produces match
 * the ones already in use in live cluster config.
 */

/** Folder name ASA installs a mod under: `<curseforgeProjectId>_<fileId>`. */
export interface ModFolderId {
  projectId: string;
  /** CurseForge file id — the version marker, and what update checks compare. */
  fileId: string;
}

/**
 * Splits an installed mod's folder name.
 *
 * Both halves matter: the project id identifies the mod for the rest of the app,
 * and the file id is the only version marker available offline — no API call, no
 * page scrape, just a directory listing.
 */
export function parseModFolderName(name: string): ModFolderId | null {
  const m = /^(\d+)_(\d+)$/.exec(name.trim());
  return m ? { projectId: m[1], fileId: m[2] } : null;
}

export interface ManifestRow {
  cookedPath: string;
  /** ISO timestamp the file was cooked. Blank when the line carried no tab. */
  mtime: string;
}

/**
 * Parses `Manifest_UFSFiles_Win64.txt`: one `path<TAB>ISO8601` per line.
 *
 * Lines without a tab are kept rather than dropped — a path with no timestamp is
 * still a path, and silently losing content because a line was formatted
 * unusually is the kind of bug that shows up as "the mod is missing a creature"
 * months later.
 */
export function parseManifest(text: string): ManifestRow[] {
  const rows: ManifestRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = trimmed.indexOf("\t");
    if (tab === -1) {
      rows.push({ cookedPath: trimmed, mtime: "" });
    } else {
      rows.push({
        cookedPath: trimmed.slice(0, tab).trim(),
        mtime: trimmed.slice(tab + 1).trim(),
      });
    }
  }
  return rows;
}

/** Asset extensions that represent a package. Everything else is payload. */
const PACKAGE_EXT = [".uasset", ".umap"] as const;

export interface ResolvedAsset {
  /** Leaf asset name, e.g. `Rex_Character_BP`. */
  leaf: string;
  /**
   * Blueprint path in the form the catalog stores: `/<Short>/<dirs>/<Leaf>.<Leaf>`.
   *
   * No trailing `_C`. The bundled official catalog carries none on either
   * creatures or items, and `normalizeBpPath` strips it for comparison anyway —
   * matching the existing data keeps hand-inspection of the JSON sane.
   */
  bpPath: string;
  /** Whether this came from a `.umap` rather than a `.uasset`. */
  isMap: boolean;
}

/**
 * Turns a cooked manifest path into a mounted blueprint path.
 *
 * An ASA mod is an Unreal plugin, so its `Content/` mounts at `/<PluginName>/`
 * rather than under `/Game/`. That is why mod paths in cluster config look like
 * `/PortsOfAtlas/Creatures/...` while official content is `/Game/PrimalEarth/...`.
 *
 * Returns null for anything that is not a mountable package, which includes the
 * `.uexp`/`.ubulk` payload files that accompany every asset — counting those
 * would double every total.
 */
export function toBlueprintPath(
  cookedPath: string,
  shortName: string,
): ResolvedAsset | null {
  const prefix = `ShooterGame/Mods/${shortName}/Content/`;
  if (!cookedPath.startsWith(prefix)) return null;

  const rel = cookedPath.slice(prefix.length);
  const dot = rel.lastIndexOf(".");
  if (dot === -1) return null;

  const ext = rel.slice(dot).toLowerCase();
  if (!PACKAGE_EXT.includes(ext as (typeof PACKAGE_EXT)[number])) return null;

  const withoutExt = rel.slice(0, dot);
  const leaf = withoutExt.split("/").pop() ?? "";
  if (!leaf) return null;

  return {
    leaf,
    bpPath: `/${shortName}/${withoutExt}.${leaf}`,
    isMap: ext === ".umap",
  };
}

export type DiscoveredKind = "creature" | "item" | "engram" | "other";

/**
 * Best guess at what an asset is, from its name alone.
 *
 * Only `creature` and `item` reach a content source; `engram` is recognised
 * purely so it can be counted and excluded, because engram entries are the most
 * common thing to mistake for an item.
 */
export function classifyAsset(leaf: string): DiscoveredKind {
  if (/_Character_BP(_C)?$/i.test(leaf)) return "creature";
  if (/^EngramEntry/i.test(leaf)) return "engram";
  // PrimalItemSkin/Structure/Resource/Consumable/... all share the prefix.
  if (/^PrimalItem/i.test(leaf)) return "item";
  return "other";
}

/**
 * The token a mod stamps on its variant creatures, or "" when there isn't one.
 *
 * Mods that re-skin the official roster prefix every creature the same way
 * (`ARKOLOGY_Rex_Character_BP`), and the catalog uses that token to group a
 * variant under the creature it derives from. Detecting it here means the admin
 * does not have to notice and type it.
 *
 * Requires a clear majority rather than a bare plurality: a mod with three
 * unrelated creatures that happen to share a first word should not have that
 * word treated as a brand.
 */
export function detectVariantTag(creatureLeaves: string[]): string {
  if (creatureLeaves.length < 3) return "";

  const counts = new Map<string, { count: number; display: string }>();
  for (const leaf of creatureLeaves) {
    const stripped = leaf.replace(/_Character_BP(_C)?$/i, "");
    const first = stripped.split("_")[0];
    // A token that IS the whole name carries no grouping information.
    if (!first || first === stripped) continue;
    const key = first.toLowerCase();
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { count: 1, display: first });
  }

  let best: { count: number; display: string } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  if (!best) return "";
  return best.count / creatureLeaves.length >= 0.6 ? best.display : "";
}

/**
 * A readable label derived from a class name.
 *
 * The mod's real display name lives in the packed asset's properties, which this
 * path deliberately never opens, so this is a best effort the admin is expected
 * to correct. It is still far better than showing raw class names in a picker.
 */
export function humanizeName(leaf: string, variantTag = ""): string {
  let s = leaf
    .replace(/_Character_BP(_C)?$/i, "")
    .replace(/^PrimalItem[A-Za-z]*?_/i, "")
    .replace(/^EngramEntry_?/i, "");

  if (variantTag) {
    const tag = variantTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`^${tag}[_ ]?`, "i"), "");
    s = s.replace(new RegExp(`[_ ]?${tag}$`, "i"), "");
  }

  s = s.replace(/_+/g, " ");
  // Split camel case, keeping acronyms together: "ApexDropTSW" -> "Apex Drop TSW".
  s = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  s = s.replace(/\s+/g, " ").trim();

  return s || leaf;
}

/** The two text files a mod must supply for discovery to run. */
export interface RawModFiles {
  /** Installed folder name, `<projectId>_<fileId>`. */
  folderName: string;
  /** The mod's plugin (and mount point) name. */
  shortName: string;
  /** Raw `<Short>.uplugin` text. May be blank if the file was unreadable. */
  uplugin: string;
  /** Raw `Manifest_UFSFiles_Win64.txt` text. */
  manifest: string;
}

export interface ModPluginMeta {
  friendlyName: string;
  description: string;
  category: string;
  versionName: string;
  createdBy: string;
  marketplaceUrl: string;
  /** CurseForge id embedded in the description as `&cf_ugcID=<n>`. */
  cfUgcId: string;
}

/**
 * Reads the `.uplugin`. Never throws: a mod with an unparseable plugin file is
 * still worth cataloguing from its manifest, so this degrades to blanks.
 */
export function parseUplugin(text: string): ModPluginMeta {
  const empty: ModPluginMeta = {
    friendlyName: "",
    description: "",
    category: "",
    versionName: "",
    createdBy: "",
    marketplaceUrl: "",
    cfUgcId: "",
  };
  if (!text.trim()) return empty;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
  } catch {
    return empty;
  }

  const str = (key: string) =>
    typeof raw[key] === "string" ? (raw[key] as string) : "";
  const description = str("Description");
  const ugc = /[?&]cf_ugcID=(\d+)/.exec(description);

  return {
    friendlyName: str("FriendlyName"),
    // The id is machinery rather than prose; it does not belong in a description.
    description: description.replace(/[?&]cf_ugcID=\d+/, "").trim(),
    category: str("Category"),
    versionName: str("VersionName"),
    createdBy: str("CreatedBy"),
    // The cooked value always names the legacy site; the current one is the
    // same page and is where an administrator should land.
    marketplaceUrl: currentCurseforgeUrl(str("MarketplaceURL")),
    cfUgcId: ugc ? ugc[1] : "",
  };
}

export interface DiscoveredMod {
  projectId: string;
  fileId: string;
  shortName: string;
  /** Display name: the plugin's friendly name, falling back to the short name. */
  name: string;
  url: string;
  meta: ModPluginMeta;
  variantTag: string;
  creatures: CatalogEntry[];
  items: CatalogEntry[];
  counts: Record<DiscoveredKind | "map", number>;
  /** Things the admin should look at before trusting the result. */
  warnings: string[];
}

/**
 * Turns one mod's two text files into catalogue entries.
 *
 * `newId` is injected rather than generated here so the caller controls id
 * allocation — the app's ids come from a single place, and tests want them
 * deterministic.
 */
export function discoverMod(
  raw: RawModFiles,
  newId: () => string,
): DiscoveredMod {
  const warnings: string[] = [];
  const folder = parseModFolderName(raw.folderName);
  if (!folder) {
    warnings.push(
      `Folder "${raw.folderName}" is not the expected <projectId>_<fileId> shape, so no version can be tracked for this mod.`,
    );
  }

  const meta = parseUplugin(raw.uplugin);
  if (!raw.uplugin.trim()) {
    warnings.push("No .uplugin found — the mod's name and links are unknown.");
  }
  if (meta.cfUgcId && folder && meta.cfUgcId !== folder.projectId) {
    warnings.push(
      `The plugin reports CurseForge id ${meta.cfUgcId} but it is installed as ${folder.projectId}.`,
    );
  }

  const rows = parseManifest(raw.manifest);
  if (rows.length === 0) warnings.push("The manifest was empty.");

  const counts: Record<DiscoveredKind | "map", number> = {
    creature: 0,
    item: 0,
    engram: 0,
    other: 0,
    map: 0,
  };

  // Keyed by normalized path so the same asset appearing twice in the manifest
  // cannot produce two catalog entries pointing at one blueprint.
  const creatureAssets = new Map<string, ResolvedAsset>();
  const itemAssets = new Map<string, ResolvedAsset>();
  const seen = new Set<string>();

  for (const row of rows) {
    const asset = toBlueprintPath(row.cookedPath, raw.shortName);
    if (!asset) continue;

    const key = normalizeBpPath(asset.bpPath);
    if (seen.has(key)) continue;
    seen.add(key);

    if (asset.isMap) {
      counts.map++;
      continue;
    }

    const kind = classifyAsset(asset.leaf);
    counts[kind]++;
    if (kind === "creature") creatureAssets.set(key, asset);
    else if (kind === "item") itemAssets.set(key, asset);
  }

  const variantTag = detectVariantTag([...creatureAssets.values()].map((a) => a.leaf));

  const toEntries = (assets: Map<string, ResolvedAsset>): CatalogEntry[] =>
    [...assets.values()]
      .map((a) => ({
        id: newId(),
        name: humanizeName(a.leaf, variantTag),
        bpPath: a.bpPath,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

  if (counts.creature === 0 && counts.item === 0) {
    warnings.push(
      "No creatures or items were recognised. This mod may only add structures, skins or code, or it may use naming this cannot read.",
    );
  }

  return {
    // The listing path already falls back to cf_ugcID for installations that
    // do not use CurseForge's normal `<projectId>_<fileId>` directory name.
    // Preserve that identity through the full read as well, or review shows a
    // known mod that apply then persists with no ID.
    projectId: folder?.projectId ?? meta.cfUgcId,
    fileId: folder?.fileId ?? "",
    shortName: raw.shortName,
    name: meta.friendlyName.trim() || raw.shortName,
    url: meta.marketplaceUrl,
    meta,
    variantTag,
    creatures: toEntries(creatureAssets),
    items: toEntries(itemAssets),
    counts,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Re-discovery
// ---------------------------------------------------------------------------

export interface DiscoveryDiff {
  added: CatalogEntry[];
  removed: CatalogEntry[];
  /** Same leaf name, different path — the case that silently breaks config. */
  renamed: { from: CatalogEntry; to: CatalogEntry }[];
  unchanged: number;
}

/**
 * Compares a previous catalogue of a mod against a fresh one.
 *
 * Renames are separated from add/remove because they are the dangerous case. A
 * removed blueprint is loud — rules referencing it fail validation. A renamed
 * one looks like an unrelated removal plus an unrelated addition, and the
 * production rule pointing at the old path keeps validating right up until it
 * silently produces nothing in game.
 */
export function diffDiscovery(
  previous: CatalogEntry[],
  next: CatalogEntry[],
): DiscoveryDiff {
  const prevByPath = new Map(previous.map((e) => [normalizeBpPath(e.bpPath), e]));
  const nextByPath = new Map(next.map((e) => [normalizeBpPath(e.bpPath), e]));

  const added: CatalogEntry[] = [];
  const removed: CatalogEntry[] = [];
  let unchanged = 0;

  for (const [key, entry] of nextByPath) {
    if (prevByPath.has(key)) unchanged++;
    else added.push(entry);
  }
  for (const [key, entry] of prevByPath) {
    if (!nextByPath.has(key)) removed.push(entry);
  }

  // A leaf that disappeared from one path and appeared at another is one asset
  // that moved, not two unrelated changes.
  const leafOf = (e: CatalogEntry) => {
    const afterSlash = e.bpPath.split("/").pop() ?? "";
    return normalizeBpPath(afterSlash.split(".").pop() ?? afterSlash);
  };
  const renamed: { from: CatalogEntry; to: CatalogEntry }[] = [];
  const addedByLeaf = new Map(added.map((e) => [leafOf(e), e]));

  for (let i = removed.length - 1; i >= 0; i--) {
    const gone = removed[i];
    const match = addedByLeaf.get(leafOf(gone));
    if (!match) continue;
    renamed.push({ from: gone, to: match });
    removed.splice(i, 1);
    added.splice(added.indexOf(match), 1);
    addedByLeaf.delete(leafOf(gone));
  }

  return { added, removed, renamed, unchanged };
}

/** Paths a diff invalidates, and where each one went. */
function movedIndex(diffs: DiscoveryDiff[]) {
  const renamedFrom = new Map<string, string>();
  const removed = new Set<string>();
  for (const diff of diffs) {
    for (const r of diff.renamed) {
      renamedFrom.set(normalizeBpPath(r.from.bpPath), r.to.bpPath);
    }
    for (const e of diff.removed) removed.add(normalizeBpPath(e.bpPath));
  }
  return { renamedFrom, removed };
}

/**
 * Blueprint paths a project depends on that a re-discovery no longer contains.
 *
 * This is the point of re-running discovery at all: production rules and remaps
 * store paths as plain strings, so a mod update that moves a blueprint leaves
 * config that looks valid and does nothing.
 */
export function brokenReferences(
  referenced: string[],
  diff: DiscoveryDiff,
): { path: string; movedTo: string | null }[] {
  const { renamedFrom, removed } = movedIndex([diff]);
  const out: { path: string; movedTo: string | null }[] = [];
  for (const path of referenced) {
    const key = normalizeBpPath(path);
    if (renamedFrom.has(key)) out.push({ path, movedTo: renamedFrom.get(key)! });
    else if (removed.has(key)) out.push({ path, movedTo: null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a discovery would do to existing config
// ---------------------------------------------------------------------------

/** One place the project's config names a blueprint path. */
export interface ConfigReference {
  kind: "production" | "remap";
  /** Human-readable location, matching the validation screens' phrasing. */
  where: string;
  bpPath: string;
}

/** The leaf class name, as the validation screens label rules. */
function pathLabel(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.split(".")[0] || path;
}

/**
 * Every blueprint path the project's production rules and remaps name.
 *
 * Disabled rules and inactive remaps are included deliberately: they are not
 * published, but they are work an admin intends to switch on later, and finding
 * out then that the path died two updates ago is worse than being told now.
 */
export function referencedBlueprintPaths(
  production: { rules: ProductionRuleLike[] },
  remaps: { entries: RemapEntryLike[] },
): ConfigReference[] {
  const out: ConfigReference[] = [];

  for (const rule of production.rules) {
    const label = pathLabel(rule.dinoType);
    if (rule.dinoType.trim()) {
      out.push({ kind: "production", where: label, bpPath: rule.dinoType });
    }
    rule.cycles.forEach((cycle, ci) => {
      const cycleWhere = `${label} › Cycle ${ci + 1}`;
      cycle.items.forEach((item, ii) => {
        const itemWhere = `${cycleWhere} › Item ${ii + 1}`;
        if (item.bpPath.trim()) {
          out.push({ kind: "production", where: itemWhere, bpPath: item.bpPath });
        }
        for (const [subs, name] of [
          [item.alternateItems, "Alternate"],
          [item.consumesItems, "Consumes"],
        ] as const) {
          subs.forEach((sub, si) => {
            if (sub.bpPath.trim()) {
              out.push({
                kind: "production",
                where: `${itemWhere} › ${name} ${si + 1}`,
                bpPath: sub.bpPath,
              });
            }
          });
        }
      });
    });
  }

  remaps.entries.forEach((entry, i) => {
    const where = `Remap ${i + 1}`;
    if (entry.fromClass.trim()) {
      out.push({ kind: "remap", where: `${where} (from)`, bpPath: entry.fromClass });
    }
    if (entry.toClass.trim()) {
      out.push({ kind: "remap", where: `${where} (to)`, bpPath: entry.toClass });
    }
  });

  return out;
}

/** Structural minimums, so this model does not depend on the editor schemas. */
interface ProductionRuleLike {
  dinoType: string;
  cycles: {
    items: {
      bpPath: string;
      alternateItems: { bpPath: string }[];
      consumesItems: { bpPath: string }[];
    }[];
  }[];
}
interface RemapEntryLike {
  fromClass: string;
  toClass: string;
}

export interface ReferenceImpact {
  reference: ConfigReference;
  /** Where the blueprint moved to, or null when it is simply gone. */
  movedTo: string | null;
}

/**
 * Which parts of the project's config a pending discovery would invalidate.
 *
 * Shown before applying rather than after, because "this update orphans four of
 * your production rules" is a reason to stop and look, and the existing
 * validation can only say the path is unknown once the damage is done.
 */
export function impactedReferences(
  references: ConfigReference[],
  diffs: DiscoveryDiff[],
): ReferenceImpact[] {
  const { renamedFrom, removed } = movedIndex(diffs);
  const out: ReferenceImpact[] = [];
  for (const reference of references) {
    const key = normalizeBpPath(reference.bpPath);
    if (renamedFrom.has(key)) {
      out.push({ reference, movedTo: renamedFrom.get(key)! });
    } else if (removed.has(key)) {
      out.push({ reference, movedTo: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Review, then apply
// ---------------------------------------------------------------------------

export interface DiscoveryPlan {
  mod: DiscoveredMod;
  /** The source this would update, or null when it would add a new one. */
  existingSourceId: string | null;
  existingSourceName: string;
  creatures: DiscoveryDiff;
  items: DiscoveryDiff;
  /**
   * Entries the project has that discovery did not find. Almost always content
   * catalogued by hand, which is why applying keeps them by default.
   */
  unmatchedCreatures: CatalogEntry[];
  unmatchedItems: CatalogEntry[];
  /** True when applying would change nothing. */
  noChanges: boolean;
}

/** How many of an admin's own entries survived into the final list. */
function countKept(unmatched: CatalogEntry[], final: CatalogEntry[]): number {
  if (unmatched.length === 0) return 0;
  const keys = new Set(final.map((e) => normalizeBpPath(e.bpPath)));
  return unmatched.filter((e) => keys.has(normalizeBpPath(e.bpPath))).length;
}

/** Existing source for a discovered mod, matched on CurseForge id. */
function findExistingSource(
  catalog: Pick<CatalogFile, "sources">,
  mod: DiscoveredMod,
): ContentSource | null {
  if (!mod.projectId) return null;
  return (
    catalog.sources.find(
      (s) => s.kind === "mod" && s.curseforgeId.trim() === mod.projectId,
    ) ?? null
  );
}

/**
 * Works out what applying a discovery would do, without doing any of it.
 *
 * Discovery guesses from naming conventions, so an admin has to be able to see
 * what is about to land before it lands — particularly the removals, which are
 * as likely to mean "this heuristic missed something" as "the mod dropped it".
 */
export function planDiscovery(
  catalog: Pick<CatalogFile, "sources">,
  mod: DiscoveredMod,
): DiscoveryPlan {
  const existing = findExistingSource(catalog, mod);
  const creatures = diffDiscovery(
    existing?.discovery?.creatures ?? existing?.creatures ?? [],
    mod.creatures,
  );
  const items = diffDiscovery(
    existing?.discovery?.items ?? existing?.items ?? [],
    mod.items,
  );

  return {
    mod,
    existingSourceId: existing?.id ?? null,
    existingSourceName: existing?.name ?? "",
    creatures,
    items,
    // Removals are what an admin would lose; surfacing them separately from the
    // diff makes the "keep these" choice concrete rather than abstract.
    unmatchedCreatures: existing?.discovery
      ? (existing.structuralOverrides?.creatures ?? [])
      : creatures.removed,
    unmatchedItems: existing?.discovery
      ? (existing.structuralOverrides?.items ?? [])
      : items.removed,
    // A mod the project has never seen is always a change — everything about it
    // is new. Only an existing source that matches what was just read has
    // nothing to do.
    noChanges:
      Boolean(existing) &&
      creatures.added.length === 0 &&
      creatures.removed.length === 0 &&
      creatures.renamed.length === 0 &&
      items.added.length === 0 &&
      items.removed.length === 0 &&
      items.renamed.length === 0,
  };
}

export interface ApplyDiscoveryOptions {
  /**
   * Keep entries discovery did not find. On by default: the classifier reads
   * naming conventions, and a mod author who names something unusually should
   * not silently cost an admin the entry they added by hand for it.
   */
  keepUnmatched?: boolean;
  /**
   * Normalized blueprint paths the admin unticked during review.
   *
   * Classification is a guess from naming conventions, so some of what comes
   * back is not content anyone wants in a picker — an internal base class, a
   * test asset. Dropping those at review time is cheaper than deleting them
   * from the source afterwards.
   */
  exclude?: ReadonlySet<string>;
}

export interface ApplyDiscoveryResult {
  catalog: CatalogFile;
  sourceId: string;
  updated: boolean;
  keptUnmatched: number;
}

/**
 * Commits a reviewed plan to the catalog.
 *
 * Everything the admin owns survives: whether the mod is enabled, its notes,
 * its INI settings and composer state, its icons folder and reference links.
 * Discovery only ever replaces the creature and item lists, because those are
 * the only things it actually knows about.
 *
 * Per-path data — icons, notes, taming write-ups — lives at catalog level keyed
 * by blueprint path, so it survives untouched as long as the path does. Renamed
 * paths are re-keyed so that work follows the blueprint rather than being
 * orphaned by a mod update.
 */
export function applyDiscovery(
  catalog: CatalogFile,
  plan: DiscoveryPlan,
  newId: () => string,
  opts: ApplyDiscoveryOptions = {},
): ApplyDiscoveryResult {
  const keepUnmatched = opts.keepUnmatched ?? true;
  const exclude = opts.exclude ?? new Set<string>();
  const existing = catalog.sources.find((s) => s.id === plan.existingSourceId);
  const { mod } = plan;

  // What this review was actually able to decide about: the entries it put a
  // tick beside. A path the review never showed keeps whatever the project
  // already recorded, so enriching from a package cannot quietly widen the
  // list, and re-ticking an entry here genuinely un-excludes it.
  const reviewable = new Set(
    [...mod.creatures, ...mod.items].map((entry) =>
      normalizeBpPath(entry.bpPath),
    ),
  );
  const excluded = new Set(
    (existing?.excludedPaths ?? [])
      .map((path) => normalizeBpPath(path))
      .filter((path) => !reviewable.has(path)),
  );
  for (const path of exclude) {
    const key = normalizeBpPath(path);
    if (reviewable.has(key)) excluded.add(key);
  }

  const drop = (entries: CatalogEntry[]) =>
    entries.filter((entry) => !excluded.has(normalizeBpPath(entry.bpPath)));

  const merge = (discovered: CatalogEntry[], unmatched: CatalogEntry[]) => {
    const kept = drop(discovered);
    if (!keepUnmatched || unmatched.length === 0) return kept;
    const known = new Set(kept.map((e) => normalizeBpPath(e.bpPath)));
    return [
      ...kept,
      ...drop(unmatched).filter((e) => !known.has(normalizeBpPath(e.bpPath))),
    ].sort((a, b) => a.name.localeCompare(b.name));
  };

  const creatures = merge(mod.creatures, plan.unmatchedCreatures);
  const items = merge(mod.items, plan.unmatchedItems);
  const discoveredCreatures = drop(mod.creatures);
  const discoveredItems = drop(mod.items);
  const structuralOverrides = {
    creatures: keepUnmatched ? drop(plan.unmatchedCreatures) : [],
    items: keepUnmatched ? drop(plan.unmatchedItems) : [],
  };

  const source: ContentSource = ContentSourceSchema.parse({
    ...(existing ?? {}),
    id: existing?.id ?? newId(),
    // A mod that has been renamed upstream should show its new name, but an
    // admin who renamed it locally chose that on purpose.
    name: existing?.name?.trim() || mod.name,
    kind: "mod",
    curseforgeId: mod.projectId || (existing?.curseforgeId ?? ""),
    url: existing?.url?.trim() || mod.url,
    variantTag: existing?.variantTag?.trim() || mod.variantTag,
    discovery: {
      fileId: mod.fileId,
      shortName: mod.shortName,
      creatures: discoveredCreatures,
      items: discoveredItems,
    },
    structuralOverrides,
    // Durable, because the entry lists are rebuilt from the package on every
    // install and every dependency refresh — see `enrichSourceStructure`.
    excludedPaths: excluded.size > 0 ? [...excluded].sort() : undefined,
    enabled: existing?.enabled ?? true,
    removed: existing?.removed ?? false,
    // Required by the schema with no default, so a new source must supply it.
    notes: existing?.notes ?? "",
    creatures,
    items,
  });

  // Re-key per-path data onto the paths a rename moved content to, so notes and
  // icons follow the blueprint instead of being stranded on a dead path.
  const renames = new Map(
    [...plan.creatures.renamed, ...plan.items.renamed].map((r) => [
      normalizeBpPath(r.from.bpPath),
      normalizeBpPath(r.to.bpPath),
    ]),
  );
  const rekey = <T>(record: Record<string, T>): Record<string, T> => {
    if (renames.size === 0) return record;
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(record)) {
      out[renames.get(normalizeBpPath(key)) ?? key] = value;
    }
    return out;
  };

  return {
    catalog: {
      ...catalog,
      sources: existing
        ? catalog.sources.map((s) => (s.id === existing.id ? source : s))
        : [...catalog.sources, source],
      icons: rekey(catalog.icons),
      notes: rekey(catalog.notes),
      maps: rekey(catalog.maps),
      variantParents: rekey(catalog.variantParents),
      itemInfo: rekey(catalog.itemInfo),
      creatureInfo: rekey(catalog.creatureInfo),
    },
    sourceId: source.id,
    updated: Boolean(existing),
    // Counted against the final lists rather than inferred from a length
    // difference, which excluding entries would otherwise throw off.
    keptUnmatched:
      countKept(plan.unmatchedCreatures, creatures) +
      countKept(plan.unmatchedItems, items),
  };
}
