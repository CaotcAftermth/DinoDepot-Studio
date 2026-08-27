import {
  assignCanonicalIconKeys,
  blueprintPathSuffix,
  iconSlug,
  parseIconKey,
  type IconKey,
} from "../iconKey";
import { MINIMUM_STUDIO_VERSION, PROJECT_FORMAT } from "../manifest";
import { PROJECT_FILE } from "../project";
import type { MigrationOutcome, MigrationStep, ProjectFiles } from "./types";

type JsonRecord = Record<string, unknown>;

/** Schema 3 -> 4: identities replace distributable image references. */
export const v3ToV4: MigrationStep = {
  from: 3,
  to: 4,
  describe: "Move content artwork to rights-aware identities and quarantine legacy references",

  run(files: ProjectFiles, context): MigrationOutcome {
    const next = { ...files };
    const settings = objectOf(JSON.parse(files[PROJECT_FILE.settings]));
    const projectId = stringOf(settings.projectId) || context.projectId;
    next[PROJECT_FILE.settings] = json({
      ...settings,
      format: PROJECT_FORMAT,
      schemaVersion: 4,
      minimumStudioVersion: MINIMUM_STUDIO_VERSION,
      capabilities: {
        ...objectOf(settings.capabilities),
        rightsAwareAssets: true,
      },
    });

    const sourceIconDirs: Record<string, string> = {};
    const rawCatalog = parseCatalog(files[PROJECT_FILE.catalog]);
    const sources = arrayOf(rawCatalog.sources).map((value) => {
      const source = objectOf(value);
      const sourceId = stringOf(source.id);
      const iconsDir = stringOf(source.iconsDir);
      if (sourceId && iconsDir) sourceIconDirs[sourceId] = iconsDir;
      const numericModId = /^\d+$/.test(stringOf(source.curseforgeId))
        ? stringOf(source.curseforgeId)
        : null;
      const kind = stringOf(source.kind);
      return {
        ...source,
        creatures: assignEntries(
          arrayOf(source.creatures),
          entryPrefix(kind, numericModId, projectId, "creature"),
          "creature",
        ),
        items: assignEntries(
          arrayOf(source.items),
          entryPrefix(kind, numericModId, projectId, "item"),
          "item",
        ),
        discovery: migrateDiscovery(source.discovery, kind, numericModId, projectId),
        structuralOverrides: migrateStructural(
          source.structuralOverrides,
          kind,
          numericModId,
          projectId,
        ),
        iconsDir: undefined,
      };
    });

    const official = objectOf(rawCatalog.official);
    const legacyIcons = objectOf(rawCatalog.icons);
    const iconOverrides: Record<string, IconKey> = {};
    const projectAssets: Record<string, string> = {};
    const legacyIconRefs: Record<string, { kind: string; value: string }> = {};
    const projectPrefix = `project:${iconSlug(projectId, "project")}`;
    for (const [path, raw] of Object.entries(legacyIcons)) {
      const value = stringOf(raw);
      const parsed = parseIconKey(value);
      if (parsed) {
        iconOverrides[normalizePath(path)] = parsed.value;
        continue;
      }
      if (value.startsWith("file:")) {
        const relative = safeRelative(value.slice(5));
        if (relative) {
          const base = iconSlug(relative.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "asset");
          const assetId = `${base}-${blueprintPathSuffix(path)}`;
          projectAssets[assetId] = relative;
          iconOverrides[normalizePath(path)] = `${projectPrefix}:${assetId}` as IconKey;
          continue;
        }
      }
      legacyIconRefs[normalizePath(path)] = {
        kind: legacyKind(value),
        value,
      };
    }

    next[PROJECT_FILE.catalog] = json({
      ...rawCatalog,
      schemaVersion: 2,
      sources,
      official: {
        ...official,
        creatures: assignEntries(
          arrayOf(official.creatures),
          "official:creature",
          "creature",
        ),
        items: assignEntries(arrayOf(official.items), "official:item", "item"),
      },
      icons: undefined,
      iconOverrides,
      projectAssets,
      legacyIconRefs,
    });

    return {
      files: next,
      localHints:
        Object.keys(sourceIconDirs).length > 0 ? { sourceIconDirs } : {},
      notes: [
        `Assigned rights-aware identities and quarantined ${Object.keys(legacyIconRefs).length} legacy icon reference${Object.keys(legacyIconRefs).length === 1 ? "" : "s"}`,
        `Preserved ${Object.keys(projectAssets).length} project image path${Object.keys(projectAssets).length === 1 ? "" : "s"} without moving files`,
      ],
    };
  },
};

function assignEntries(
  values: unknown[],
  prefix: string,
  type: "creature" | "item",
): JsonRecord[] {
  const entries = values.map(objectOf).map((entry) => ({
    ...entry,
    name: stringOf(entry.name),
    bpPath: stringOf(entry.bpPath),
    iconKey: parseIconKey(entry.iconKey)?.value,
  }));
  if (prefix.startsWith("official:") || prefix.startsWith("mod:")) {
    return assignCanonicalIconKeys(
      entries,
      prefix as `official:${"creature" | "item" | "map"}` | `mod:${string}:${"creature" | "item"}`,
    );
  }
  const used = new Set<string>(entries.flatMap((entry) => (entry.iconKey ? [entry.iconKey] : [])));
  return entries.map((entry) => {
    if (entry.iconKey) return entry;
    const base = `${type}-${iconSlug(entry.name || entry.bpPath)}`;
    let assetId = base;
    let value = `${prefix}:${assetId}`;
    if (used.has(value)) {
      assetId = `${base}-${blueprintPathSuffix(entry.bpPath)}`;
      value = `${prefix}:${assetId}`;
    }
    used.add(value);
    return { ...entry, iconKey: value as IconKey };
  });
}

function entryPrefix(
  kind: string,
  modId: string | null,
  projectId: string,
  type: "creature" | "item",
): string {
  if (kind === "official") return `official:${type}`;
  if (kind === "mod" && modId) return `mod:${modId}:${type}`;
  return `project:${iconSlug(projectId, "project")}`;
}

function migrateDiscovery(
  value: unknown,
  kind: string,
  modId: string | null,
  projectId: string,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const discovery = objectOf(value);
  return {
    ...discovery,
    creatures: assignEntries(
      arrayOf(discovery.creatures),
      entryPrefix(kind, modId, projectId, "creature"),
      "creature",
    ),
    items: assignEntries(
      arrayOf(discovery.items),
      entryPrefix(kind, modId, projectId, "item"),
      "item",
    ),
  };
}

function migrateStructural(
  value: unknown,
  kind: string,
  modId: string | null,
  projectId: string,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const structural = objectOf(value);
  return {
    ...structural,
    creatures: assignEntries(
      arrayOf(structural.creatures),
      entryPrefix(kind, modId, projectId, "creature"),
      "creature",
    ),
    items: assignEntries(
      arrayOf(structural.items),
      entryPrefix(kind, modId, projectId, "item"),
      "item",
    ),
  };
}

function parseCatalog(text: string | undefined): JsonRecord {
  if (!text) return { schemaVersion: 1, sources: [], official: {}, icons: {} };
  return objectOf(JSON.parse(text));
}

function safeRelative(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) return null;
  return normalized;
}

function normalizePath(value: string): string {
  return value.trim().replace(/_C$/i, "").toLowerCase();
}

function legacyKind(value: string): string {
  if (/^https?:\/\//i.test(value)) return "remote";
  if (/^(?:official|package):/i.test(value)) return "package";
  if (!value.includes(":") && [...value].length <= 8) return "glyph";
  if (value.startsWith("file:")) return "file";
  return "unknown";
}

function objectOf(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
