import { z } from "zod";
import type { PackageManifest } from "./package";
import type {
  ModpackRegistry,
  RegistryEntry,
  RegistryVersion,
} from "./modpack";

const Sha256OrBlankSchema = z.union([
  z.literal(""),
  z.string().regex(/^[a-f0-9]{64}$/i),
]);

/** Portable coordinates for resolving one immutable package again. */
export const PackageLocatorSchema = z.object({
  owner: z.string().default(""),
  repo: z.string().default(""),
  branch: z.string().default(""),
  path: z.string().default(""),
  manifest: z.string().default(""),
  /** Direct immutable manifest URL for linked packages outside an index. */
  manifestUrl: z
    .union([
      z.literal(""),
      z.url().refine((url) => url.startsWith("https://"), {
        message: "Package manifest URLs require HTTPS",
      }),
    ])
    .default(""),
  /** How a machine reconstructs this pin when its managed cache is absent. */
  sourceFormat: z.enum(["package", "legacy"]).default("package"),
  /** Original compatibility `modpack.json` URL; its bytes remain hash-pinned. */
  legacyUrl: z
    .union([
      z.literal(""),
      z.url().refine((url) => url.startsWith("https://"), {
        message: "Legacy modpack URLs require HTTPS",
      }),
    ])
    .default(""),
});
export type PackageLocator = z.infer<typeof PackageLocatorSchema>;

/**
 * One exact project dependency.
 *
 * `materialized` is the compatibility state for projects that installed a v1
 * modpack before immutable packages existed. `linked` makes the package the
 * source layer and keeps catalog data as project-owned overrides/snapshots.
 */
export const PackageDependencySchema = z
  .object({
    kind: z.enum(["modpack", "official"]),
    // V1 packs accepted arbitrary non-empty IDs and versions. A materialized
    // compatibility record preserves those bytes; only linked identities are
    // ever used to address the managed package library.
    packageId: z.string().min(1),
    version: z.string().min(1),
    integrity: Sha256OrBlankSchema.default(""),
    curseforgeId: z.string().default(""),
    sourceId: z.string().default(""),
    mode: z.enum(["linked", "materialized"]).default("linked"),
    locator: PackageLocatorSchema.default(() => PackageLocatorSchema.parse({})),
    addedAt: z.string().default(""),
  })
  .superRefine((dependency, context) => {
    if (dependency.mode !== "linked") return;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(dependency.packageId)) {
      context.addIssue({
        code: "custom",
        path: ["packageId"],
        message: "Linked package IDs must be safe lowercase slugs",
      });
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(dependency.version)) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: "Linked package versions must be safe exact identifiers",
      });
    }
  });
export type PackageDependency = z.infer<typeof PackageDependencySchema>;

export function dependencyKey(
  dependency: Pick<
    PackageDependency,
    "kind" | "packageId" | "curseforgeId"
  >,
): string {
  if (dependency.kind === "modpack" && dependency.curseforgeId.trim()) {
    return `modpack:curseforge:${dependency.curseforgeId.trim()}`;
  }
  return `${dependency.kind}:${dependency.packageId}`;
}

export function dependencyForRegistryPackage(
  registry: ModpackRegistry,
  entry: RegistryEntry,
  exact: RegistryVersion,
  manifest: PackageManifest,
  manifestIntegrity: string,
  sourceId: string,
  now = new Date(),
): PackageDependency {
  return PackageDependencySchema.parse({
    kind: manifest.kind,
    packageId: manifest.packageId,
    version: manifest.version,
    integrity: manifestIntegrity || exact.integrity,
    curseforgeId: manifest.curseforgeId || entry.curseforgeId,
    sourceId,
    mode: "linked",
    locator: {
      owner: registry.owner,
      repo: registry.repo,
      branch: registry.branch,
      path: registry.path,
      manifest: exact.manifest,
    },
    addedAt: now.toISOString(),
  });
}

export function upsertDependency(
  dependencies: PackageDependency[],
  incoming: PackageDependency,
): PackageDependency[] {
  const key = dependencyKey(incoming);
  const next = dependencies.filter(
    (dependency) => dependencyKey(dependency) !== key,
  );
  next.push(incoming);
  return next;
}

/**
 * Merges by package identity rather than replacing the whole array.
 *
 * Two operations can be in flight at once — a project opening adds the managed
 * official pin while an administrator installs a modpack. Writing back a list
 * captured before the other one landed used to drop it. Merging means the last
 * writer only decides its *own* rows.
 *
 * `defaults` never displace a pin the project already has: an existing exact
 * official version stays exactly where the administrator left it.
 */
export function mergeDependencies(
  existing: PackageDependency[],
  incoming: PackageDependency[],
  options: { asDefaults?: boolean } = {},
): PackageDependency[] {
  const next = [...existing];
  const index = new Map(
    next.map((dependency, at) => [dependencyKey(dependency), at]),
  );
  for (const dependency of incoming) {
    const key = dependencyKey(dependency);
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, next.length);
      next.push(dependency);
    } else if (!options.asDefaults) {
      next[at] = dependency;
    }
  }
  return next;
}
