import { z } from "zod";
import {
  CatalogEntrySchema,
  IniSettingSchema,
  ItemInfoSchema,
  normalizeBpPath,
} from "./catalog";
import { CreatureInfoSchema } from "./creatureInfo";
import {
  ModpackMetaSchema,
  ModpackSchema,
  iconBaseName,
  type Modpack,
} from "./modpack";
import { normalizeAssetPath } from "./assetRef";

export const PACKAGE_FORMAT = "dinodepot.package";
export const PACKAGE_FORMAT_VERSION = 2;
export const PACKAGE_CONTENT_FORMAT = "dinodepot.package-content";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const PackagePathSchema = z.string().refine(
  (path) => normalizeAssetPath(path) !== null,
  "Package file paths must be safe relative paths",
);

export const PackageFileSchema = z.object({
  path: PackagePathSchema,
  sha256: Sha256Schema,
  size: z.number().int().min(0),
  mediaType: z.string().default("application/octet-stream"),
});
export type PackageFile = z.infer<typeof PackageFileSchema>;

export const PackageManifestMetaSchema = ModpackMetaSchema.omit({
  id: true,
  version: true,
  curseforgeId: true,
});

export const PackageManifestSchema = z
  .object({
    format: z.literal(PACKAGE_FORMAT),
    formatVersion: z.literal(PACKAGE_FORMAT_VERSION),
    kind: z.enum(["modpack", "official"]),
    packageId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
    curseforgeId: z.string().default(""),
    publishedAt: z.string().default(""),
    meta: PackageManifestMetaSchema,
    content: PackageFileSchema,
    assets: z.array(PackageFileSchema).default([]),
  })
  .superRefine((manifest, context) => {
    if (manifest.kind === "official" && manifest.packageId !== "official-asa") {
      context.addIssue({
        code: "custom",
        path: ["packageId"],
        message: "Official packages must use the official-asa identity",
      });
    }
    if (manifest.content.path !== "content.json") {
      context.addIssue({
        code: "custom",
        path: ["content", "path"],
        message: "Package content must be content.json",
      });
    }
    const seen = new Set<string>([manifest.content.path.toLowerCase()]);
    for (let i = 0; i < manifest.assets.length; i++) {
      const asset = manifest.assets[i];
      if (!asset.path.startsWith("assets/")) {
        context.addIssue({
          code: "custom",
          path: ["assets", i, "path"],
          message: "Package assets must live below assets/",
        });
      }
      const expectedMedia = /\.webp$/i.test(asset.path)
        ? "image/webp"
        : /\.png$/i.test(asset.path)
          ? "image/png"
          : null;
      if (!expectedMedia || asset.mediaType !== expectedMedia) {
        context.addIssue({
          code: "custom",
          path: ["assets", i],
          message: "Package icons must be WebP (preferred) or PNG with the matching media type",
        });
      }
      const key = asset.path.toLowerCase();
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["assets", i, "path"],
          message: "Package file paths must be unique by case",
        });
      }
      seen.add(key);
    }
  });
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

export const PackageContentSchema = z
  .object({
    format: z.literal(PACKAGE_CONTENT_FORMAT),
    schemaVersion: z.literal(1),
    iniNotes: z.string().default(""),
    iniSettings: z.array(IniSettingSchema).default([]),
    creatures: z.array(CatalogEntrySchema).default([]),
    items: z.array(CatalogEntrySchema).default([]),
    icons: z.record(z.string(), z.string()).default({}),
    notes: z.record(z.string(), z.string()).default({}),
    maps: z.record(z.string(), z.string()).default({}),
    variantParents: z.record(z.string(), z.string()).default({}),
    itemInfo: z.record(z.string(), ItemInfoSchema).default({}),
    creatureInfo: z.record(z.string(), CreatureInfoSchema).default({}),
  })
  .superRefine((content, context) => {
    const paths = new Set<string>();
    const ids = new Set<string>();
    for (const [kind, entries] of [
      ["creatures", content.creatures],
      ["items", content.items],
    ] as const) {
      entries.forEach((entry, index) => {
        const path = normalizeBpPath(entry.bpPath);
        if (paths.has(path)) {
          context.addIssue({
            code: "custom",
            path: [kind, index, "bpPath"],
            message: "Package blueprint paths must be unique",
          });
        }
        paths.add(path);
        if (ids.has(entry.id)) {
          context.addIssue({
            code: "custom",
            path: [kind, index, "id"],
            message: "Package entry IDs must be unique",
          });
        }
        ids.add(entry.id);
      });
    }
    for (const [path, value] of Object.entries(content.icons)) {
      if (!value.startsWith("file:")) continue;
      const assetPath = normalizeAssetPath(value.slice(5));
      if (!assetPath?.startsWith("assets/")) {
        context.addIssue({
          code: "custom",
          path: ["icons", path],
          message: "Package file icons must use a safe assets/ path",
        });
      }
      if (assetPath && !/\.(?:webp|png)$/i.test(assetPath)) {
        context.addIssue({
          code: "custom",
          path: ["icons", path],
          message: "Package icon references must use WebP or PNG",
        });
      }
    }
  });
export type PackageContent = z.infer<typeof PackageContentSchema>;

/** Every package-owned asset referenced by content, normalized for comparison. */
export function packageContentAssetPaths(content: PackageContent): Set<string> {
  return new Set(
    Object.values(content.icons)
      .filter((value) => value.startsWith("file:"))
      .map((value) => normalizeAssetPath(value.slice(5)))
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase()),
  );
}

/**
 * Rejects a flattening that would silently merge two distinct icons.
 *
 * Both the v1 pack format and the legacy install view address icons by bare
 * file name, so `a/Rex.png` and `b/Rex.png` would become one file. Losing an
 * icon quietly is worse than refusing to build the package.
 */
export function assertDistinctIconBaseNames(
  icons: Record<string, string>,
  label: string,
): void {
  const sources = new Map<string, string>();
  for (const value of Object.values(icons)) {
    if (!value.startsWith("file:")) continue;
    const path = value.slice(5);
    const base = iconBaseName(path).toLowerCase();
    const previous = sources.get(base);
    if (previous && previous !== path) {
      throw new Error(
        `${label} has two different icons named "${iconBaseName(path)}" ("${previous}" and "${path}"); rename one before packaging`,
      );
    }
    sources.set(base, path);
  }
}

export function packageContentFromModpack(pack: Modpack): PackageContent {
  assertDistinctIconBaseNames(pack.icons, `Modpack ${pack.meta.id}`);
  return PackageContentSchema.parse({
    format: PACKAGE_CONTENT_FORMAT,
    schemaVersion: 1,
    iniNotes: pack.iniNotes,
    iniSettings: pack.iniSettings,
    creatures: pack.creatures,
    items: pack.items,
    icons: Object.fromEntries(
      Object.entries(pack.icons).map(([path, value]) => [
        path,
        value.startsWith("file:")
          ? `file:assets/${iconBaseName(value.slice(5))}`
          : value,
      ]),
    ),
    notes: pack.notes,
    maps: pack.maps,
    variantParents: pack.variantParents,
    itemInfo: pack.itemInfo,
    creatureInfo: pack.creatureInfo,
  });
}

export function modpackFromPackage(
  manifest: PackageManifest,
  content: PackageContent,
): Modpack {
  if (manifest.kind !== "modpack") {
    throw new Error(`${manifest.packageId} is an official package, not a modpack`);
  }
  assertDistinctIconBaseNames(
    content.icons,
    `Package ${manifest.packageId}@${manifest.version}`,
  );
  return ModpackSchema.parse({
    formatVersion: 2,
    meta: {
      id: manifest.packageId,
      version: manifest.version,
      curseforgeId: manifest.curseforgeId,
      ...manifest.meta,
    },
    iniNotes: content.iniNotes,
    iniSettings: content.iniSettings,
    creatures: content.creatures,
    items: content.items,
    icons: Object.fromEntries(
      Object.entries(content.icons).map(([path, value]) => [
        path,
        value.startsWith("file:")
          ? `file:${iconBaseName(value.slice(5))}`
          : value,
      ]),
    ),
    notes: content.notes,
    maps: content.maps,
    variantParents: content.variantParents,
    itemInfo: content.itemInfo,
    creatureInfo: content.creatureInfo,
  });
}

export function packageJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function packageFile(
  path: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<PackageFile> {
  return PackageFileSchema.parse({
    path,
    sha256: await sha256Hex(bytes),
    size: bytes.length,
    mediaType,
  });
}
