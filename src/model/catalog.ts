import { z } from "zod";
import { CreatureInfoSchema } from "./creatureInfo";
import { IconKeySchema, type IconKey } from "./iconKey";

/**
 * Content sources: the creatures/items/mods available to this project.
 * Drives the pickers in the Production Rules and Remaps editors and the
 * "references removed content" validation warnings.
 */

export const CatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  bpPath: z.string(),
  /** Stable content-image identity. Optional only while legacy data is read. */
  iconKey: IconKeySchema.optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const SourceKindSchema = z.enum(["official", "mod", "imported"]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/**
 * The handful of facts worth recording about an item. Deliberately small -
 * anything longer belongs in the viewer notes.
 */
export const ItemInfoSchema = z.object({
  /** Item type/category, e.g. Resources, Consumables, Structures. */
  type: z.string().default(""),
  /** Cluster-defined rarity tier. */
  rarity: z.string().default(""),
  /** Max stack size. Null = unknown / use the bundled default. */
  stackSize: z.number().int().min(0).nullable().default(null),
  /**
   * Items/hour above which the simulator flags this item specifically -
   * 500 Element/hr is not the same problem as 500 Fiber/hr. Null = use the
   * project-wide simulator default.
   */
  highOutputPerHour: z.number().min(0).nullable().default(null),
});
export type ItemInfo = z.infer<typeof ItemInfoSchema>;

export function emptyItemInfo(): ItemInfo {
  return { type: "", rarity: "", stackSize: null, highOutputPerHour: null };
}

/** One `Key=Value` line of mod server config, with admin explanation. */
export const IniSettingSchema = z.object({
  id: z.string(),
  /** INI section header without brackets, e.g. `ServerSettings`. */
  section: z.string().default(""),
  key: z.string(),
  value: z.string().default(""),
  /**
   * Documented value type (bool, int, float, string, url, struct) used for
   * validation hints. Blank means unspecified - INI values are always text
   * on disk, so this is documentation rather than storage.
   */
  type: z.string().default(""),
  /** Target file - GameUserSettings.ini, Game.ini, or blank if unknown. */
  file: z.string().default(""),
  /** One-line summary shown in the settings list. */
  description: z.string().default(""),
  /** Long-form explanation shown in the per-setting detail view. */
  details: z.string().default(""),
  /** Flagged as required for this mod to work correctly. */
  required: z.boolean().default(false),
  /** Included in the Build INI composer - the persistent working selection. */
  added: z.boolean().default(false),
});
export type IniSetting = z.infer<typeof IniSettingSchema>;

/**
 * The Build INI composer's working state for one setting. Stored with the mod
 * rather than held in the modal, so a composed block survives closing it -
 * picking values across a dozen settings is real work to redo.
 */
export const IniBuildStateSchema = z.object({
  /** Working value; empty means "use the setting's default". */
  value: z.string().default(""),
  /** Placeholder name (lowercased) -> chosen options. */
  choices: z.record(z.string(), z.array(z.string())).default({}),
  /** Placeholder name (lowercased) -> option -> that option's own value. */
  optionValues: z
    .record(z.string(), z.record(z.string(), z.string()))
    .default({}),
});
export type IniBuildState = z.infer<typeof IniBuildStateSchema>;

export const DiscoverySnapshotSchema = z.object({
  /** CurseForge file ID from `<projectId>_<fileId>`, when available. */
  fileId: z.string().default(""),
  /** Unreal plugin/mount name used to reproduce blueprint paths. */
  shortName: z.string().default(""),
  creatures: z.array(CatalogEntrySchema).default([]),
  items: z.array(CatalogEntrySchema).default([]),
});

export const StructuralOverridesSchema = z.object({
  creatures: z.array(CatalogEntrySchema).default([]),
  items: z.array(CatalogEntrySchema).default([]),
});

export const ContentSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: SourceKindSchema,
  curseforgeId: z.string(),
  /** CurseForge mod page URL (also used by the Mod Update Watcher). */
  url: z.string().default(""),
  /** Secondary reference link: documentation, spawn-code sheet, etc. */
  docsUrl: z.string().default(""),
  /** The mod's Discord - invite link or a channel/thread deep link. */
  discordUrl: z.string().default(""),
  /**
   * A folder of this mod's own icon art, searched by the icon picker alongside
   * the project-wide images folder from Settings.
   *
   * Mod icons arrive as a folder per mod - extracted from the mod, or the
   * `icons/` of a modpack - and copying every one of them into the images
   * folder to assign a handful is work nobody should have to do. Picking from
   * here copies just the chosen file across, because a `file:` icon is
   * relative to the images folder and only what lives there is published.
   */
  /** @deprecated Schema-4 moves this machine-local hint out of shared data. */
  iconsDir: z.string().default(""),
  /** Freeform config notes that don't fit the Key=Value shape. */
  iniNotes: z.string().default(""),
  /** Structured mod-specific INI settings. */
  iniSettings: z.array(IniSettingSchema).default([]),
  /** Build INI composer state, keyed by setting id. */
  iniBuild: z.record(z.string(), IniBuildStateSchema).default({}),
  /**
   * Token this mod puts on its variant creatures (ARKOLOGY, Tek, Tameable…),
   * stripped when grouping variants. Auto-detectable from the entries.
   */
  variantTag: z.string().default(""),
  /**
   * The community modpack this source was installed from, and which version.
   *
   * Empty means it was catalogued by hand here: that source is nobody else's
   * to update, so it never reports a registry update however closely the
   * registry happens to match it.
   */
  modpackId: z.string().default(""),
  modpackVersion: z.string().default(""),
  /** Local-first structural truth captured from ShooterGame Discovery. */
  discovery: DiscoverySnapshotSchema.nullable().optional(),
  /** Hand-added structural rows retained above Discovery and package layers. */
  structuralOverrides: StructuralOverridesSchema.optional(),
  /**
   * Normalized blueprint paths this project has decided are not content.
   *
   * Discovery classifies by naming convention, so some of what it reads is an
   * internal base class or a test asset rather than anything an admin wants in
   * a picker. Unticking those during review has to mean something durable:
   * package enrichment and every later dependency refresh rebuild the entry
   * lists from the package, and without a record of the decision they would
   * quietly put back exactly what was dropped.
   *
   * Project-owned, so it survives a package update and travels with the
   * project rather than with the pack.
   */
  excludedPaths: z.array(z.string()).optional(),
  /** Whether this content is currently enabled on the server. */
  enabled: z.boolean(),
  /** Marked when the mod is being removed from the server (triggers remap warnings). */
  removed: z.boolean(),
  notes: z.string(),
  creatures: z.array(CatalogEntrySchema),
  items: z.array(CatalogEntrySchema),
});
export type ContentSource = z.infer<typeof ContentSourceSchema>;

/**
 * Whether the Mod Update Watcher tracks this mod.
 *
 * Derived rather than stored: watching used to be its own switch, which meant
 * two controls saying almost the same thing and a standing chance of running a
 * mod nobody was watching. A mod you have enabled is a mod whose updates
 * matter; a disabled one is not. It still needs a CurseForge id or URL,
 * because there is nothing to check without one.
 */
export function isWatched(source: ContentSource): boolean {
  return (
    source.kind !== "official" &&
    source.enabled &&
    Boolean(source.curseforgeId || source.url)
  );
}

/**
 * Project-owned additions to the bundled Official ASA source. Kept separate
 * so bundled dataset updates do not discard hand-added content.
 */
export const OfficialOverlaySchema = z.object({
  docsUrl: z.string().default(""),
  discordUrl: z.string().default(""),
  iniNotes: z.string().default(""),
  iniSettings: z.array(IniSettingSchema).default([]),
  creatures: z.array(CatalogEntrySchema).default([]),
  items: z.array(CatalogEntrySchema).default([]),
  /**
   * ASA availability review of the bundled dataset: normalized blueprint path
   * to verdict.
   * `absent` entries are hidden from the catalog everywhere but stay
   * recoverable, and the verdicts survive regenerating the bundled file.
   */
  asaReview: z.record(z.string(), z.enum(["confirmed", "absent"])).default({}),
});
export type OfficialOverlay = z.infer<typeof OfficialOverlaySchema>;
export type AsaVerdict = "confirmed" | "absent";

export function emptyOfficialOverlay(): OfficialOverlay {
  return {
    docsUrl: "",
    discordUrl: "",
    iniNotes: "",
    iniSettings: [],
    creatures: [],
    items: [],
    asaReview: {},
  };
}

const CatalogSharedSchema = z.object({
  sources: z.array(ContentSourceSchema),
  official: OfficialOverlaySchema.default(emptyOfficialOverlay()),
  /**
   * Manual variant relationships: normalized child blueprint path -> parent
   * blueprint path. Overrides the name-based variant grouping heuristic and
   * works for official content too.
   */
  variantParents: z.record(z.string(), z.string()).default({}),
  /**
   * Admin-written info (taming/utility notes, simple markdown) per entry:
   * normalized blueprint path -> text. Published to the cluster viewer.
   */
  notes: z.record(z.string(), z.string()).default({}),
  /**
   * Manual map-of-origin overrides: normalized blueprint path -> map name.
   * Complements the automatic path-based derivation in model/maps.ts.
   */
  maps: z.record(z.string(), z.string()).default({}),
  /**
   * Structured per-item facts (type, rarity, stack size, its own high-output
   * threshold): normalized blueprint path -> info. Only values the admin set
   * live here; official items fall back to bundled defaults.
   */
  itemInfo: z.record(z.string(), ItemInfoSchema).default({}),
  /**
   * Structured taming/ability data per creature: normalized blueprint path ->
   * info. Kept beside `notes` rather than replacing it - notes stays the
   * free-text field published to the cluster viewer.
   */
  creatureInfo: z.record(z.string(), CreatureInfoSchema).default({}),
});

export const LegacyIconRefSchema = z.object({
  kind: z.enum(["glyph", "remote", "file", "package", "unknown"]),
  value: z.string(),
}).strict();
export type LegacyIconRef = z.infer<typeof LegacyIconRefSchema>;

const ProjectAssetPathSchema = z.string().refine((value) => {
  const normalized = value.replace(/\\/g, "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[a-z]:/i.test(normalized) &&
    !normalized.split("/").some((part) => part === ".." || part === "." || !part)
  );
}, "Project asset paths must be safe relative paths");

/** Schema-1 remains a read-only compatibility boundary. */
export const CatalogFileV1Schema = CatalogSharedSchema.extend({
  schemaVersion: z.literal(1),
  icons: z.record(z.string(), z.string()).default({}),
});

/** Every new catalog write uses identities; loose refs exist only in quarantine. */
export const CatalogFileV2Schema = CatalogSharedSchema.extend({
  schemaVersion: z.literal(2),
  /** @deprecated In-memory compatibility shadow. Schema-4 writers remove it. */
  icons: z.record(z.string(), z.string()).default({}),
  iconOverrides: z.record(z.string(), IconKeySchema).default({}),
  projectAssets: z.record(z.string(), ProjectAssetPathSchema).default({}),
  legacyIconRefs: z.record(z.string(), LegacyIconRefSchema).default({}),
});

export const CatalogFileSchema = z.discriminatedUnion("schemaVersion", [
  CatalogFileV2Schema,
  CatalogFileV1Schema,
]);
export type CatalogFile = z.infer<typeof CatalogFileSchema>;

export function emptyCatalog(): CatalogFile {
  return {
    schemaVersion: 2,
    sources: [],
    official: emptyOfficialOverlay(),
    icons: {},
    iconOverrides: {},
    projectAssets: {},
    legacyIconRefs: {},
    variantParents: {},
    notes: {},
    maps: {},
    itemInfo: {},
    creatureInfo: {},
  };
}

export function catalogIconOverrides(catalog: CatalogFile): Record<string, IconKey> {
  return catalog.schemaVersion === 2 ? catalog.iconOverrides : {};
}

export function catalogLegacyIconRefs(catalog: CatalogFile): Record<string, LegacyIconRef> {
  if (catalog.schemaVersion === 2) return catalog.legacyIconRefs;
  return Object.fromEntries(
    Object.entries(catalog.icons).map(([path, value]) => [
      path,
      { kind: legacyIconKind(value), value },
    ]),
  );
}

export function catalogLegacyIconValues(catalog: CatalogFile): Record<string, string> {
  if (catalog.schemaVersion === 1) return catalog.icons;
  return Object.fromEntries(
    Object.entries(catalog.legacyIconRefs).map(([path, ref]) => [path, ref.value]),
  );
}

export function catalogProjectAssets(catalog: CatalogFile): Record<string, string> {
  return catalog.schemaVersion === 2 ? catalog.projectAssets : {};
}

/** Portable schema-2 representation. Compatibility shadows never reach disk. */
export function catalogForWrite(catalog: CatalogFile): unknown {
  if (catalog.schemaVersion === 1) return catalog;
  const { icons: _icons, ...rest } = catalog;
  return {
    ...rest,
    sources: rest.sources.map(({ iconsDir: _iconsDir, ...source }) => source),
  };
}

export function assignedIconKey(catalog: CatalogFile, bpPath: string): IconKey | undefined {
  return catalogIconOverrides(catalog)[normalizeBpPath(bpPath)];
}

export function legacyIconKind(value: string): LegacyIconRef["kind"] {
  if (value.startsWith("file:")) return "file";
  if (/^https?:\/\//i.test(value)) return "remote";
  if (/^(?:official|package):/i.test(value)) return "package";
  if (!value.includes(":") && [...value].length <= 8) return "glyph";
  return "unknown";
}

/**
 * The canonical link for a project ID. CurseForge redirects it to the mod's
 * real slug page, which is why a project ID alone is enough to link a source
 * and no page URL has to be stored to get there.
 */
export function curseforgeProjectUrl(curseforgeId: string): string {
  return `https://www.curseforge.com/projects/${curseforgeId.trim()}`;
}

/** Best-known CurseForge page URL for a source (explicit URL, else project-id link). */
export function sourceCurseforgeUrl(source: ContentSource): string | null {
  if (source.url) return source.url;
  if (source.curseforgeId) return curseforgeProjectUrl(source.curseforgeId);
  return null;
}

/** Normalizes a blueprint path for comparisons (trailing _C and case differences). */
export function normalizeBpPath(path: string): string {
  return path.trim().replace(/_C$/i, "").toLowerCase();
}

export interface CatalogIndex {
  /** normalized bp path -> { entry, source } */
  creatures: Map<string, { entry: CatalogEntry; source: ContentSource }>;
  items: Map<string, { entry: CatalogEntry; source: ContentSource }>;
}

export function buildCatalogIndex(catalog: {
  sources: ContentSource[];
}): CatalogIndex {
  const creatures = new Map<string, { entry: CatalogEntry; source: ContentSource }>();
  const items = new Map<string, { entry: CatalogEntry; source: ContentSource }>();
  for (const source of catalog.sources) {
    for (const entry of source.creatures) {
      creatures.set(normalizeBpPath(entry.bpPath), { entry, source });
    }
    for (const entry of source.items) {
      items.set(normalizeBpPath(entry.bpPath), { entry, source });
    }
  }
  return { creatures, items };
}

/**
 * Every blueprint path a set of sources catalogues, normalized.
 *
 * Membership, not identity: the same class may appear under two sources, so a
 * path is only gone once no source claims it.
 */
export function pathsOf(sources: readonly ContentSource[]): Set<string> {
  const paths = new Set<string>();
  for (const source of sources) {
    // Tolerant of a source missing its lists: validation runs over whatever is
    // on disk, and a hand-edited catalog must produce findings rather than an
    // exception that takes the whole report with it.
    for (const entry of source?.creatures ?? []) {
      paths.add(normalizeBpPath(entry.bpPath));
    }
    for (const entry of source?.items ?? []) {
      paths.add(normalizeBpPath(entry.bpPath));
    }
  }
  return paths;
}

/**
 * Removes the per-entry data held for paths that are no longer catalogued.
 *
 * Icons, notes, maps, variant parents and the two info maps are keyed by
 * blueprint path rather than by source, so deleting a mod used to leave all six
 * behind. The rows are invisible - nothing lists them - but publishing
 * validates every icon assignment, so a deleted mod went on producing "not in
 * the images folder" warnings for artwork no entry could ever ask for.
 *
 * Pure: takes a catalog, returns a new one.
 */
export function forgetPaths(
  catalog: CatalogFile,
  paths: ReadonlySet<string>,
): CatalogFile {
  if (paths.size === 0) return catalog;
  const without = <T,>(map: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(map).filter(([key]) => !paths.has(normalizeBpPath(key))),
    );
  const records = {
    notes: without(catalog.notes),
    maps: without(catalog.maps),
    variantParents: without(catalog.variantParents),
    itemInfo: without(catalog.itemInfo),
    creatureInfo: without(catalog.creatureInfo),
  };
  if (catalog.schemaVersion === 1) {
    return { ...catalog, ...records, icons: without(catalog.icons) };
  }
  return {
    ...catalog,
    ...records,
    icons: without(catalog.icons),
    iconOverrides: without(catalog.iconOverrides),
    legacyIconRefs: without(catalog.legacyIconRefs),
  };
}
