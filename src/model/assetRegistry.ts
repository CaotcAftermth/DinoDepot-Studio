import { z } from "zod";

export const ASSET_REGISTRY_SCHEMA_VERSION = 1;
export const ASSET_SERVICE_ORIGIN = "https://assets.dinodepot-studio.app";

export const RightsStatusSchema = z.enum([
  "not-reviewed",
  "requested",
  "author-approved",
  "license-approved",
  "declined",
  "revoked",
  "ownership-unclear",
]);
export type RightsStatus = z.infer<typeof RightsStatusSchema>;

export const ModAssetScopeSchema = z.enum(["creature-icons", "item-icons"]);
export type ModAssetScope = z.infer<typeof ModAssetScopeSchema>;

export const AssetStateSchema = z.enum(["active", "replaced", "withdrawn", "disabled"]);
export type AssetState = z.infer<typeof AssetStateSchema>;

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RegistryPathSchema = z
  .string()
  .regex(/^\/(?:official|mods)\/[a-z0-9/_.-]+\.webp$/)
  .refine((value) => !value.includes("//") && !value.includes(".."), "Unsafe asset path");
const ManifestPathSchema = z
  .string()
  .regex(/^\/registry\/(?:official\.json|mods\/[0-9]+\.json)$/);

export const RegistryAssetSchema = z.object({
  status: AssetStateSchema,
  path: RegistryPathSchema,
  version: z.number().int().positive(),
  sha256: HashSchema,
}).strict();
export type RegistryAsset = z.infer<typeof RegistryAssetSchema>;

export const RegistryIndexSchema = z.object({
  schemaVersion: z.literal(ASSET_REGISTRY_SCHEMA_VERSION),
  registryVersion: z.number().int().nonnegative(),
  generatedAt: z.string().datetime({ offset: true }),
  official: z.object({
    manifest: z.literal("/registry/official.json"),
    version: z.number().int().nonnegative(),
  }).optional(),
  mods: z.record(
    z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    z.object({
      manifest: ManifestPathSchema,
      version: z.number().int().nonnegative(),
    }).strict(),
  ).default({}),
}).strict();
export type AssetRegistryIndex = z.infer<typeof RegistryIndexSchema>;

export const PublicAttributionSchema = z.object({
  creator: z.string().default(""),
  projectUrl: z.string().url().or(z.literal("")).default(""),
}).strict();

export const ModRightsSchema = z.object({
  status: RightsStatusSchema,
  permissionId: z.string().regex(/^[A-Z0-9][A-Z0-9._-]*$/).optional(),
  permissionVersion: z.string().regex(/^DDS-ICON-PERMISSION-v[0-9]+\.[0-9]+$/).optional(),
  approvedAt: z.string().date().optional(),
  scope: z.array(ModAssetScopeSchema).default([]),
  attribution: PublicAttributionSchema.default({ creator: "", projectUrl: "" }),
}).strict().superRefine((rights, context) => {
  if (
    ["author-approved", "license-approved"].includes(rights.status) &&
    (!rights.permissionId || !rights.permissionVersion || !rights.approvedAt)
  ) {
    context.addIssue({
      code: "custom",
      message: "Approved rights require permission id, terms version, and approval date",
    });
  }
});
export type ModRights = z.infer<typeof ModRightsSchema>;

export const ModAssetManifestSchema = z.object({
  schemaVersion: z.literal(ASSET_REGISTRY_SCHEMA_VERSION),
  modId: z.number().int().nonnegative(),
  modName: z.string(),
  rights: ModRightsSchema,
  assets: z.record(
    z.string().regex(/^(?:creature|item):[a-z0-9]+(?:-[a-z0-9]+)*$/),
    RegistryAssetSchema,
  ).default({}),
}).strict().superRefine((manifest, context) => {
  for (const [key, asset] of Object.entries(manifest.assets)) {
    const [type] = key.split(":");
    const expected = `/mods/${manifest.modId}/${type === "creature" ? "creatures" : "items"}/`;
    if (!asset.path.startsWith(expected)) {
      context.addIssue({ code: "custom", path: ["assets", key, "path"], message: "Asset path does not match mod and type" });
    }
  }
});
export type ModAssetManifest = z.infer<typeof ModAssetManifestSchema>;

export const OfficialReferencePolicySchema = z.object({
  status: z.literal("official-reference-policy"),
  policyId: z.string().min(1),
  reviewedAt: z.string().date(),
  reviewState: z.enum(["not-reviewed", "approved", "declined"]).default("not-reviewed"),
  distributionEligible: z.boolean().default(false),
  scope: z.array(z.enum(["creature-icons", "item-icons", "map-icons"])).default([]),
}).strict();

export const OfficialAssetManifestSchema = z.object({
  schemaVersion: z.literal(ASSET_REGISTRY_SCHEMA_VERSION),
  rights: OfficialReferencePolicySchema,
  assets: z.record(
    z.string().regex(/^(?:creature|item|map):[a-z0-9]+(?:-[a-z0-9]+)*$/),
    RegistryAssetSchema,
  ).default({}),
}).strict().superRefine((manifest, context) => {
  for (const [key, asset] of Object.entries(manifest.assets)) {
    const [type] = key.split(":");
    const folder = type === "creature" ? "creatures" : type === "item" ? "items" : "maps";
    if (!asset.path.startsWith(`/official/${folder}/`)) {
      context.addIssue({ code: "custom", path: ["assets", key, "path"], message: "Official asset path does not match type" });
    }
  }
});
export type OfficialAssetManifest = z.infer<typeof OfficialAssetManifestSchema>;

export const PublicAssetManifestSchema = z.union([
  ModAssetManifestSchema,
  OfficialAssetManifestSchema,
]);
export type PublicAssetManifest = z.infer<typeof PublicAssetManifestSchema>;

export function modRightsAllowDistribution(rights: ModRights): boolean {
  return rights.status === "author-approved" || rights.status === "license-approved";
}

export function rightsScopeFor(type: "creature" | "item" | "map"): string {
  return `${type}-icons`;
}

export function absoluteAssetUrl(path: string): string | null {
  if (!RegistryPathSchema.safeParse(path).success) return null;
  return `${ASSET_SERVICE_ORIGIN}${path}`;
}
