import { z } from "zod";
import officialIndex from "../../Public_Content/Official_Icons/index.json";
import {
  PackageDependencySchema,
  type PackageDependency,
} from "../model/dependency";
import { DEFAULT_REGISTRY } from "../model/modpack";

const OfficialIndexSchema = z.object({
  formatVersion: z.literal(1),
  package: z.object({
    id: z.literal("official-asa"),
    version: z.string().min(1),
    manifest: z.string().min(1),
    integrity: z.string().regex(/^[a-f0-9]{64}$/i),
    publishedAt: z.string().default(""),
  }),
});

const release = OfficialIndexSchema.parse(officialIndex).package;

/** The one immutable identity every official asset resolves through. */
export const OFFICIAL_PACKAGE_ID = "official-asa";

/**
 * The built-in exact Core Content requirement.
 *
 * Its bytes remain in Public_Content/Official_Icons and are installed into
 * the managed application library. Projects never need a machine-specific
 * folder setting to resolve them.
 */
export function managedOfficialDependency(): PackageDependency {
  return PackageDependencySchema.parse({
    kind: "official",
    packageId: release.id,
    version: release.version,
    integrity: release.integrity,
    sourceId: "",
    mode: "linked",
    locator: {
      owner: DEFAULT_REGISTRY.owner,
      repo: DEFAULT_REGISTRY.repo,
      branch: DEFAULT_REGISTRY.branch,
      path: "Public_Content/Official_Icons",
      manifest: release.manifest,
    },
    addedAt: release.publishedAt,
  });
}

/** Keeps an existing project pin; otherwise adds the managed release first. */
export function withManagedOfficialDependency(
  dependencies: PackageDependency[],
): PackageDependency[] {
  return dependencies.some(
    (dependency) =>
      dependency.kind === "official" && dependency.packageId === release.id,
  )
    ? dependencies
    : [managedOfficialDependency(), ...dependencies];
}

/** The same guarantee applied to a whole settings object, for new projects. */
export function withManagedOfficialSettings<
  T extends { packageDependencies: PackageDependency[] },
>(settings: T): T {
  const packageDependencies = withManagedOfficialDependency(
    settings.packageDependencies,
  );
  return packageDependencies === settings.packageDependencies
    ? settings
    : { ...settings, packageDependencies };
}
