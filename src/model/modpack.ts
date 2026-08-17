import { z } from "zod";
import {
  CatalogEntrySchema,
  ContentSourceSchema,
  IniSettingSchema,
  ItemInfoSchema,
  normalizeBpPath,
  type CatalogEntry,
  type CatalogFile,
  type ContentSource,
} from "./catalog";
import { CreatureInfoSchema, type CreatureInfo } from "./creatureInfo";
import { normalizeCurseforgeId } from "./catalogDuplicates";
import { STUDIO_REPO } from "./studio";

/**
 * Modpacks: one mod's catalogued content as a single shareable file.
 *
 * The point is that cataloguing a mod is real work — every creature and item
 * path, the INI settings, the taming write-ups — and it is the same work for
 * every cluster running that mod. A modpack is that work, done once, reviewed,
 * and published so the next admin adds the mod in one click instead of a
 * weekend.
 *
 * A pack is deliberately close to a `ContentSource` plus the slice of
 * catalog-level data belonging to its blueprint paths. Project storage does
 * not change to accommodate this — a pack is an import/export format, not a
 * new home for the data.
 */

export const MODPACK_FORMAT = 1;

/**
 * The registry the app reads published packs from. Overridable in Settings so
 * a team can point at a fork or a staging branch while reviewing submissions.
 */
export const DEFAULT_REGISTRY = {
  owner: STUDIO_REPO.owner,
  repo: STUDIO_REPO.repo,
  branch: STUDIO_REPO.branch,
  path: "Public_Content/ModPacks",
} as const;

export const ModpackRegistrySchema = z.object({
  owner: z.string().default(DEFAULT_REGISTRY.owner),
  repo: z.string().default(DEFAULT_REGISTRY.repo),
  branch: z.string().default(DEFAULT_REGISTRY.branch),
  /** Folder inside the repo holding the pack files and their index. */
  path: z.string().default(DEFAULT_REGISTRY.path),
});
export type ModpackRegistry = z.infer<typeof ModpackRegistrySchema>;

export function defaultModpackRegistry(): ModpackRegistry {
  return ModpackRegistrySchema.parse({});
}

// ---------------------------------------------------------------------------
// The pack itself
// ---------------------------------------------------------------------------

export const ModpackMetaSchema = z.object({
  /**
   * Stable slug identifying the pack across versions — this is what an
   * installed source remembers, so renaming the mod never orphans it.
   */
  id: z.string().min(1),
  name: z.string().min(1),
  /** Dotted numbers. Bumped by whoever submits an update. */
  version: z.string().default("1.0.0"),
  /** ISO date the pack was last edited, for display only. */
  updatedAt: z.string().default(""),
  /** Who catalogued it — credit for the work, and someone to ask. */
  author: z.string().default(""),
  description: z.string().default(""),
  curseforgeId: z.string().default(""),
  /** CurseForge mod page. */
  url: z.string().default(""),
  docsUrl: z.string().default(""),
  discordUrl: z.string().default(""),
  variantTag: z.string().default(""),
});
export type ModpackMeta = z.infer<typeof ModpackMetaSchema>;

export const ModpackSchema = z.object({
  formatVersion: z.number().int().min(1).default(MODPACK_FORMAT),
  meta: ModpackMetaSchema,
  iniNotes: z.string().default(""),
  iniSettings: z.array(IniSettingSchema).default([]),
  creatures: z.array(CatalogEntrySchema).default([]),
  items: z.array(CatalogEntrySchema).default([]),
  /**
   * Per-blueprint-path data, all keyed by normalized path. These live at the
   * catalog level in a project rather than on the source, so a pack carries
   * its own slice and merging is a key-by-key union.
   */
  icons: z.record(z.string(), z.string()).default({}),
  notes: z.record(z.string(), z.string()).default({}),
  maps: z.record(z.string(), z.string()).default({}),
  variantParents: z.record(z.string(), z.string()).default({}),
  itemInfo: z.record(z.string(), ItemInfoSchema).default({}),
  creatureInfo: z.record(z.string(), CreatureInfoSchema).default({}),
});
export type Modpack = z.infer<typeof ModpackSchema>;

// ---------------------------------------------------------------------------
// Registry index
// ---------------------------------------------------------------------------

/**
 * One row of the registry's `index.json`. Enough to search and compare
 * versions without downloading every pack.
 */
export const RegistryEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().default("1.0.0"),
  updatedAt: z.string().default(""),
  author: z.string().default(""),
  description: z.string().default(""),
  curseforgeId: z.string().default(""),
  /**
   * Folder inside the registry holding `modpack.json` and `icons/`. Preferred
   * layout — a pack with icons cannot be a single file.
   */
  dir: z.string().default(""),
  /**
   * Legacy single-file layout, for packs published before icons travelled.
   * Only consulted when `dir` is empty.
   */
  file: z.string().default(""),
  creatureCount: z.number().int().min(0).default(0),
  itemCount: z.number().int().min(0).default(0),
  /** Immutable historical versions. Absent on version-1 registry indexes. */
  versions: z
    .array(
      z.object({
        version: z.string().min(1),
        /** Relative path to the immutable package manifest in this registry. */
        manifest: z.string().min(1),
        /** SHA-256 of the manifest bytes, when the publisher supplied it. */
        integrity: z.string().regex(/^[a-f0-9]{64}$/i).default(""),
        publishedAt: z.string().default(""),
        /** Storage format of this exact version; absent historical rows are v2. */
        packageFormat: z.union([z.literal(2), z.literal(3)]).optional(),
        /** Earliest Studio release that understands this package format. */
        minStudioVersion: z.string().optional(),
      }),
    )
    .optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
export type RegistryVersion = NonNullable<RegistryEntry["versions"]>[number];

export const RegistryIndexSchema = z.object({
  formatVersion: z.number().int().min(1).default(MODPACK_FORMAT),
  packs: z.array(RegistryEntrySchema).default([]),
});
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;

/** The file a registry entry lives in, falling back to `<id>.json`. */
export function packFileName(entry: { id: string; file?: string }): string {
  return entry.file?.trim() || `${entry.id}.json`;
}

/**
 * The folder a pack occupies in the registry, and the name an export writes.
 *
 * `<curseforgeId>-<Mod_Name>` — the id makes it unambiguous which mod this is
 * (names collide and get rebranded; project IDs do not), and the readable name
 * means a directory listing is browsable without opening anything.
 */
export function packDirName(meta: Pick<ModpackMeta, "curseforgeId" | "name" | "id">): string {
  const name =
    meta.name
      .trim()
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "Modpack";
  const cf = meta.curseforgeId.trim();
  return cf ? `${cf}-${name}` : name;
}

/** File name inside a pack folder. */
export const PACK_FILE = "modpack.json";
/** Subfolder holding the pack's icon images. */
export const PACK_ICONS_DIR = "icons";

/**
 * Icon image files a pack carries, derived from its icon assignments.
 *
 * Derived rather than stored so the list can never drift from the icons that
 * actually reference it. Emoji and remote URLs need no file and are skipped.
 */
export function packIconFiles(pack: Modpack): string[] {
  const files = new Set<string>();
  for (const value of Object.values(pack.icons)) {
    if (value.startsWith("file:")) files.add(value.slice(5));
  }
  return [...files].sort();
}

/** The last path segment of a `file:` icon, so packs stay flat. */
export function iconBaseName(relPath: string): string {
  return relPath.split(/[/\\]/).pop() || relPath;
}

/** The index row a pack would contribute, for generating/refreshing index.json. */
export function registryEntryFor(pack: Modpack): RegistryEntry {
  return {
    id: pack.meta.id,
    name: pack.meta.name,
    version: pack.meta.version,
    updatedAt: pack.meta.updatedAt,
    author: pack.meta.author,
    description: pack.meta.description,
    curseforgeId: pack.meta.curseforgeId,
    dir: packDirName(pack.meta),
    file: "",
    creatureCount: pack.creatures.length,
    itemCount: pack.items.length,
  };
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * Compares dotted numeric versions. Unparsable segments sort as 0 rather than
 * throwing — a malformed version in community data should not break the list.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      // A leading "v" is a near-universal habit in community data, and
      // treating "v2.0.0" as older than "1.0.0" would hide real updates.
      .replace(/^v/i, "")
      .split(".")
      .map((n) => {
        const parsed = Number.parseInt(n, 10);
        return Number.isFinite(parsed) ? parsed : 0;
      });
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether the registry has something newer than what this source installed.
 *
 * A source with no `modpackId` was added by hand and is nobody's business to
 * update — it never reports an update, whatever the registry happens to hold.
 */
export function updateAvailable(
  source: Pick<ContentSource, "modpackId" | "modpackVersion">,
  entry: RegistryEntry | undefined,
): boolean {
  if (!source.modpackId || !entry) return false;
  if (entry.id !== source.modpackId) return false;
  return compareVersions(entry.version, source.modpackVersion) > 0;
}

/** Registry entries matched against a search box, by name or CurseForge id. */
export function searchRegistry(
  packs: RegistryEntry[],
  query: string,
): RegistryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return packs;
  return packs.filter((p) =>
    [p.name, p.id, p.curseforgeId, p.author, p.description].some((field) =>
      field.toLowerCase().includes(q),
    ),
  );
}

// ---------------------------------------------------------------------------
// Export: project source -> pack
// ---------------------------------------------------------------------------

/** Every normalized blueprint path a source contributes. */
export function sourcePaths(source: ContentSource): Set<string> {
  return new Set(
    [...source.creatures, ...source.items].map((e) => normalizeBpPath(e.bpPath)),
  );
}

/** Narrows a path-keyed record to the keys a pack owns. */
function slice<T>(
  record: Record<string, T>,
  paths: Set<string>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (paths.has(normalizeBpPath(key))) out[key] = value;
  }
  return out;
}

/**
 * Turns one of the project's mods into a shareable pack.
 *
 * Only data belonging to this mod's own blueprint paths travels — a pack must
 * never carry the exporting cluster's notes on official creatures, which are
 * that cluster's opinions rather than facts about the mod.
 */
export function sourceToModpack(
  source: ContentSource,
  catalog: CatalogFile,
  meta: Partial<ModpackMeta> = {},
): Modpack {
  const paths = sourcePaths(source);
  return ModpackSchema.parse({
    formatVersion: MODPACK_FORMAT,
    meta: {
      id: meta.id?.trim() || slugify(source.name),
      name: meta.name?.trim() || source.name,
      version: meta.version?.trim() || "1.0.0",
      updatedAt: meta.updatedAt ?? new Date().toISOString().slice(0, 10),
      author: meta.author ?? "",
      description: meta.description ?? "",
      curseforgeId: source.curseforgeId,
      url: source.url,
      docsUrl: source.docsUrl,
      discordUrl: source.discordUrl,
      variantTag: source.variantTag,
    },
    iniNotes: source.iniNotes,
    // The Build INI composer's working state is this cluster's in-progress
    // choices, not documentation of the mod — it stays behind.
    iniSettings: source.iniSettings.map((s) => ({ ...s, added: false })),
    creatures: source.creatures,
    items: source.items,
    // Local icons are rewritten to bare file names: the exporting project may
    // keep them in nested folders, but the v1 compatibility alias carries them
    // flat in icons/. V2 keeps the same bytes inside its managed package root.
    icons: Object.fromEntries(
      Object.entries(slice(catalog.icons, paths)).map(([key, value]) => [
        key,
        value.startsWith("file:") ? `file:${iconBaseName(value.slice(5))}` : value,
      ]),
    ),
    notes: slice(catalog.notes, paths),
    maps: slice(catalog.maps, paths),
    variantParents: slice(catalog.variantParents, paths),
    itemInfo: slice(catalog.itemInfo, paths),
    creatureInfo: slice(catalog.creatureInfo, paths),
  });
}

/** A URL-safe id derived from a mod name. */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "modpack"
  );
}

// ---------------------------------------------------------------------------
// Import: pack -> project
// ---------------------------------------------------------------------------

export interface ApplyModpackResult {
  catalog: CatalogFile;
  sourceId: string;
  /** True when an existing source was updated rather than a new one added. */
  updated: boolean;
  /** Per-path records kept because the project had already written its own. */
  keptLocal: number;
  /** How this install found the source it updated. */
  matchedBy: "modpackId" | "curseforgeId" | null;
}

/**
 * Combines local structural discovery with curated package membership.
 *
 * Blueprint path is identity. A package may improve the display name or add
 * content the filename heuristic missed, but installing enrichment must not
 * erase a class that ShooterGame actually exposed or change its stable local
 * row id.
 */
export function mergeStructuralEntries(
  local: CatalogEntry[],
  packaged: CatalogEntry[],
): CatalogEntry[] {
  const packageByPath = new Map(
    packaged.map((entry) => [normalizeBpPath(entry.bpPath), entry]),
  );
  const seen = new Set<string>();
  const merged = local.map((entry) => {
    const key = normalizeBpPath(entry.bpPath);
    seen.add(key);
    const enrichment = packageByPath.get(key);
    return enrichment
      ? { ...enrichment, id: entry.id, bpPath: entry.bpPath }
      : entry;
  });
  for (const entry of packaged) {
    const key = normalizeBpPath(entry.bpPath);
    if (!seen.has(key)) merged.push(entry);
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolves Discovery, package enrichment, then hand-added structural rows. */
export function enrichSourceStructure(
  current: ContentSource | undefined,
  packaged: CatalogEntry[],
  kind: "creatures" | "items",
): CatalogEntry[] {
  if (!current?.discovery) {
    if (current?.modpackId) return [...packaged];
    return mergeStructuralEntries(current?.[kind] ?? [], packaged);
  }
  const enriched = mergeStructuralEntries(current.discovery[kind], packaged);
  return mergeStructuralEntries(
    enriched,
    current.structuralOverrides?.[kind] ?? [],
  );
}

/** Exact immutable version record, never a latest-version substitution. */
export function registryVersion(
  entry: RegistryEntry,
  version: string,
): RegistryVersion | null {
  return (
    entry.versions?.find((candidate) => candidate.version === version) ?? null
  );
}

export interface ModpackSourceMatch {
  source: ContentSource | null;
  matchedBy: "modpackId" | "curseforgeId" | null;
  /** More than one source claimed the identity, so adopting either is unsafe. */
  ambiguous: ContentSource[];
}

/**
 * Finds the one source a pack may safely update.
 *
 * A pack binding is strongest. A unique CurseForge ID lets a reviewed
 * Discovery source be adopted without duplication. Names are never identity,
 * and duplicate claims stop the install for an explicit cleanup decision.
 */
export function matchModpackSource(
  catalog: Pick<CatalogFile, "sources">,
  pack: Pick<Modpack, "meta">,
): ModpackSourceMatch {
  const byPack = catalog.sources.filter(
    (source) => source.modpackId && source.modpackId === pack.meta.id,
  );
  if (byPack.length === 1) {
    return { source: byPack[0], matchedBy: "modpackId", ambiguous: [] };
  }
  if (byPack.length > 1) {
    return { source: null, matchedBy: null, ambiguous: byPack };
  }

  const curseforgeId = normalizeCurseforgeId(pack.meta.curseforgeId);
  if (!curseforgeId) return { source: null, matchedBy: null, ambiguous: [] };
  const byCurseforge = catalog.sources.filter(
    (source) =>
      source.kind === "mod" &&
      normalizeCurseforgeId(source.curseforgeId) === curseforgeId,
  );
  if (byCurseforge.length === 1) {
    return {
      source: byCurseforge[0],
      matchedBy: "curseforgeId",
      ambiguous: [],
    };
  }
  if (byCurseforge.length > 1) {
    return { source: null, matchedBy: null, ambiguous: byCurseforge };
  }
  return { source: null, matchedBy: null, ambiguous: [] };
}

/**
 * Adds or updates a pack in the project.
 *
 * `keepLocalEdits` decides the one genuinely contested case: per-entry records
 * the admin has written themselves. Defaulting to keeping them means an update
 * can never silently discard a cluster's own taming write-ups — the incoming
 * data only fills gaps. Turning it off takes the pack's version wholesale.
 */
export function applyModpack(
  catalog: CatalogFile,
  pack: Modpack,
  newId: () => string,
  opts: { keepLocalEdits?: boolean } = {},
): ApplyModpackResult {
  const keepLocal = opts.keepLocalEdits ?? true;
  const match = matchModpackSource(catalog, pack);
  if (match.ambiguous.length > 0) {
    throw new Error(
      `Cannot install ${pack.meta.name}: ${match.ambiguous.length} content sources claim the same package identity. Resolve the duplicate sources first.`,
    );
  }
  const existing = match.source ?? undefined;

  const source: ContentSource = ContentSourceSchema.parse({
    ...(existing ?? {}),
    id: existing?.id ?? newId(),
    name: pack.meta.name,
    kind: "mod",
    curseforgeId: pack.meta.curseforgeId,
    url: pack.meta.url,
    docsUrl: pack.meta.docsUrl,
    discordUrl: pack.meta.discordUrl,
    variantTag: pack.meta.variantTag,
    iniNotes: pack.iniNotes,
    iniSettings: pack.iniSettings,
    // The composer's working state belongs to this cluster; an update to the
    // mod's documentation has no business resetting it.
    iniBuild: existing?.iniBuild ?? {},
    creatures: enrichSourceStructure(existing, pack.creatures, "creatures"),
    items: enrichSourceStructure(existing, pack.items, "items"),
    // Whether the mod is running here is a cluster decision, not the pack's.
    enabled: existing?.enabled ?? true,
    removed: existing?.removed ?? false,
    notes: existing?.notes ?? "",
    modpackId: pack.meta.id,
    modpackVersion: pack.meta.version,
  });

  let keptLocal = 0;
  /** Union of incoming and existing, with the local copy winning when asked. */
  const merge = <T>(
    current: Record<string, T>,
    incoming: Record<string, T>,
  ): Record<string, T> => {
    const out = { ...current };
    for (const [key, value] of Object.entries(incoming)) {
      if (keepLocal && out[key] !== undefined) {
        keptLocal++;
        continue;
      }
      out[key] = value;
    }
    return out;
  };

  return {
    catalog: {
      ...catalog,
      sources: existing
        ? catalog.sources.map((s) => (s.id === existing.id ? source : s))
        : [...catalog.sources, source],
      icons: merge(catalog.icons, pack.icons),
      notes: merge(catalog.notes, pack.notes),
      maps: merge(catalog.maps, pack.maps),
      variantParents: merge(catalog.variantParents, pack.variantParents),
      itemInfo: merge(catalog.itemInfo, pack.itemInfo),
      creatureInfo: merge(
        catalog.creatureInfo,
        pack.creatureInfo as Record<string, CreatureInfo>,
      ),
    },
    sourceId: source.id,
    updated: Boolean(existing),
    keptLocal,
    matchedBy: match.matchedBy,
  };
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/**
 * A worked example rather than an empty shell — the fastest way to learn the
 * format is to see one real creature, one real item and one INI setting with
 * every field filled in.
 */
export function templateModpack(): Modpack {
  const creaturePath =
    "/Game/Mods/YourMod/Dinos/Example/Example_Character_BP.Example_Character_BP_C";
  const itemPath =
    "/Game/Mods/YourMod/Items/PrimalItemResource_Example.PrimalItemResource_Example";
  return ModpackSchema.parse({
    formatVersion: MODPACK_FORMAT,
    meta: {
      id: "your-mod-slug",
      name: "Your Mod Name",
      version: "1.0.0",
      updatedAt: new Date().toISOString().slice(0, 10),
      author: "Your name or Discord handle",
      description: "One or two lines on what this mod adds.",
      curseforgeId: "000000",
      url: "https://www.curseforge.com/ark-survival-ascended/mods/your-mod",
      docsUrl: "https://docs.example.com/your-mod",
      discordUrl: "https://discord.gg/yourinvite",
      variantTag: "",
    },
    iniNotes: "Anything about configuring this mod that isn't a Key=Value line.",
    iniSettings: [
      {
        id: "example-setting",
        section: "YourMod",
        key: "ExampleSetting",
        value: "true",
        type: "bool",
        file: "GameUserSettings.ini",
        description: "One line explaining what this does.",
        details: "Longer explanation, edge cases, recommended values.",
        required: false,
        added: false,
      },
    ],
    creatures: [
      { id: "example-creature", name: "Example Creature", bpPath: creaturePath },
    ],
    items: [{ id: "example-item", name: "Example Item", bpPath: itemPath }],
    icons: { [normalizeBpPath(creaturePath)]: "🦖" },
    notes: {},
    maps: {},
    variantParents: {},
    itemInfo: {
      [normalizeBpPath(itemPath)]: {
        type: "Resources",
        rarity: "",
        stackSize: 100,
        highOutputPerHour: null,
      },
    },
    creatureInfo: {
      [normalizeBpPath(creaturePath)]: {
        availability: "acquirable",
        spawnMaps: ["The Island"],
        methods: [
          {
            id: "example-method",
            name: "Knockout tame",
            outcome: "direct-tame",
            tags: ["knockout"],
            requirements: "Tranq arrows and a trap",
            inputs: [
              {
                id: "example-input",
                referenceType: "item",
                bpPath: itemPath,
                label: "",
                role: "taming-food",
                qty: "",
                note: "Its preferred food",
              },
            ],
            phases: [
              {
                id: "example-phase",
                name: "Knock out",
                steps: [
                  { id: "example-step-1", text: "Trap it" },
                  { id: "example-step-2", text: "Tranq it" },
                ],
                note: "",
                repeatUntil: "",
                completedWhen: "",
                failureOrReset: "",
                transitionNote: "",
              },
            ],
            repeatUntil: "",
            completion: "It wakes up tamed",
            failure: "It wakes up early",
            effectiveness: "",
            strategy: "",
          },
        ],
        abilities: [],
        drops: { harvest: [], guaranteed: [], random: [], production: [] },
        technical: { dragWeight: null },
        notes: "",
        overrides: [],
      },
    },
  });
}

/** The README that ships beside a template, so the format explains itself. */
export function templateReadme(): string {
  return `# Dino Depot modpack

One mod's catalogued content — creatures, items, icons, INI settings and the
taming write-ups — as a folder other clusters can install in one click.

## Layout

    <curseforgeId>-<Mod_Name>/
      modpack.json                 latest-version compatibility alias
      icons/                       compatibility icon images
      versions/<exact-version>/
        manifest.json              identity, hashes, sizes, asset list
        content.json               canonical package content
        assets/                    immutable package-owned images

An icon in \`modpack.json\` is written \`"file:Rex.webp"\` and normally has a
matching \`icons/Rex.webp\`. WebP is preferred and PNG is accepted. Emoji
(\`"🦖"\`) and full URLs need no file. A missing or unsupported optional image
is omitted during packaging, and that entry uses DinoDepot's default icon.

Studio generates the immutable \`versions/\` files and updates the registry
index when it exports or submits a pack. Existing clients continue to
read \`modpack.json\` and \`icons/\`; new clients pin the exact manifest.

## Building one

The quickest route is to catalogue the mod inside Dino Depot Production Studio
as you normally would, then use **Content Sources → the mod → Export modpack…**.
That writes this whole folder, icons included, and can open the pull request
for you.

Editing by hand works too. The example entries show the shape of each section —
replace them rather than adding alongside.

## Fields worth getting right

- \`meta.id\` — a stable slug. Installed projects remember it, so changing it
  later orphans every install. Pick it once.
- \`meta.version\` — dotted numbers. Bump it on every submission; that is what
  tells an existing install an update exists.
- \`meta.curseforgeId\` — also decides the folder name, and lets the app match
  your pack to a mod someone already added by hand.
- Blueprint paths — must match what the mod actually ships, including the
  trailing \`_C\` on creature classes. Everything else keys off these.

## Submitting

Open a pull request adding the folder to \`Public_Content/ModPacks/\` on the
Dino Depot Production Studio repository. A maintainer reviews it before it
appears in the in-app search.
`;
}
