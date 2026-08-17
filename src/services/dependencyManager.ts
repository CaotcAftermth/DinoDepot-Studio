import {
  ContentSourceSchema,
  emptyCatalog,
  normalizeBpPath,
  type CatalogFile,
  type ContentSource,
} from "../model/catalog";
import {
  dependencyKey,
  type PackageDependency,
} from "../model/dependency";
import type { AssetRef } from "../model/assetRef";
import { RegistryEntrySchema } from "../model/modpack";
import { enrichSourceStructure } from "../model/modpack";
import {
  modpackFromPackage,
  type PackageContent,
  type PackageManifest,
} from "../model/package";
import {
  downloadPackageFromManifestUrl,
  downloadRegistryPackage,
  installBundledOfficialPackage,
  installDownloadedPackage,
  installLocalPackageManifest,
  readInstalledPackage,
  type InstalledPackage,
} from "./packageManager";

/**
 * Machine-local manifest paths, keyed by `<packageId>@<version>`.
 *
 * A locally built development package has no URL. Its folder is this
 * machine's business only, so it travels in local state and never in the
 * shared project JSON.
 */
export type LocalPackageSources = Record<string, string>;

export function localPackageSourceKey(
  packageId: string,
  version: string,
): string {
  return `${packageId}@${version}`;
}

export interface DependencyDiagnostic {
  dependency: string;
  severity: "warning" | "error";
  message: string;
}

/** Exact-version storage key. A root is never shared between two versions. */
export function packageRootKey(
  kind: "modpack" | "official",
  packageId: string,
  version: string,
): string {
  return `${kind}:${packageId}@${version}`;
}

export interface ResolvedDependencyLayers {
  catalog: CatalogFile;
  /** Package-owned image refs, used only when no project icon overrides them. */
  packageAssets: Record<string, AssetRef>;
  /** Exact local package roots, keyed by `packageRootKey`. */
  packageRoots: Record<string, string>;
  /** The pinned Core Content version, so managed art resolves exactly. */
  officialVersion: string;
  /** Package defaults kept separate so setters persist only project overrides. */
  defaults: CatalogFile;
  diagnostics: DependencyDiagnostic[];
}

interface AvailableDependency {
  dependency: PackageDependency;
  installed: InstalledPackage;
}

function locatorComplete(dependency: PackageDependency): boolean {
  const locator = dependency.locator;
  return Boolean(
    locator.manifestUrl ||
      (locator.owner &&
        locator.repo &&
        locator.branch &&
        locator.manifest),
  );
}

/**
 * Resolves one exact requirement, preferring everything local to the network.
 *
 * Order is installed library, then the bundled official package, then a
 * machine-local manifest folder, and only then GitHub. Local development and
 * first use must not need a successful request; GitHub is how a *new* version
 * is distributed, not how an already-pinned one is found.
 */
async function ensureDependency(
  dependency: PackageDependency,
  localSources: LocalPackageSources = {},
): Promise<InstalledPackage | null> {
  let installed: InstalledPackage | null = null;
  let localError: unknown = null;
  const reread = () =>
    readInstalledPackage(
      dependency.kind,
      dependency.packageId,
      dependency.version,
    );
  const matchesPin = (candidate: InstalledPackage) =>
    !dependency.integrity ||
    candidate.manifestIntegrity === dependency.integrity;

  try {
    installed = await reread();
  } catch (error) {
    // A corrupt cache is reconstructable. Keep the reason in case nothing else
    // resolves; the verified installs below repair the exact target.
    localError = error;
  }
  if (installed) {
    if (!matchesPin(installed)) {
      localError = new Error(
        "the installed manifest does not match the project integrity pin",
      );
      installed = null;
    } else {
      return installed;
    }
  }
  if (dependency.mode === "materialized") {
    if (localError) throw localError;
    return null;
  }

  if (dependency.kind === "official") {
    try {
      const bundled = await installBundledOfficialPackage(dependency.version);
      if (bundled && matchesPin(bundled)) return bundled;
    } catch (error) {
      // A build shipped without the resource, or with a damaged one, still has
      // the library, a local folder and GitHub left to try.
      localError ??= error;
    }
  }

  const localManifest =
    localSources[
      localPackageSourceKey(dependency.packageId, dependency.version)
    ];
  if (localManifest) {
    try {
      const { downloaded } = await installLocalPackageManifest(localManifest);
      if (
        downloaded.manifest.kind === dependency.kind &&
        downloaded.manifest.packageId === dependency.packageId &&
        downloaded.manifest.version === dependency.version
      ) {
        const local = await reread();
        if (local && matchesPin(local)) return local;
      }
    } catch (error) {
      localError ??= error;
    }
  }

  if (!locatorComplete(dependency)) {
    if (localError) throw localError;
    return null;
  }

  const locator = dependency.locator;
  const downloaded = locator.manifestUrl
    ? await downloadPackageFromManifestUrl(locator.manifestUrl)
    : await downloadRegistryPackage(
        {
          owner: locator.owner,
          repo: locator.repo,
          branch: locator.branch,
          path: locator.path,
        },
        RegistryEntrySchema.parse({
          id: dependency.packageId,
          name: dependency.packageId,
          version: dependency.version,
          curseforgeId: dependency.curseforgeId,
          versions: [
            {
              version: dependency.version,
              manifest: locator.manifest,
              integrity: dependency.integrity,
            },
          ],
        }),
        dependency.version,
      );
  if (
    downloaded.manifest.kind !== dependency.kind ||
    downloaded.manifest.packageId !== dependency.packageId ||
    downloaded.manifest.version !== dependency.version ||
    (dependency.integrity &&
      downloaded.manifestIntegrity !== dependency.integrity)
  ) {
    throw new Error("downloaded package does not match the project dependency");
  }
  await installDownloadedPackage(downloaded);
  installed = await readInstalledPackage(
    dependency.kind,
    dependency.packageId,
    dependency.version,
  );
  return installed;
}

/** Ensures linked dependencies are available without substituting "latest". */
export async function ensureProjectDependencies(
  dependencies: PackageDependency[],
  localSources: LocalPackageSources = {},
): Promise<{
  available: AvailableDependency[];
  diagnostics: DependencyDiagnostic[];
}> {
  const available: AvailableDependency[] = [];
  const diagnostics: DependencyDiagnostic[] = [];
  for (const dependency of dependencies) {
    if (dependency.mode === "materialized") continue;
    try {
      const installed = await ensureDependency(dependency, localSources);
      if (!installed) {
        diagnostics.push({
          dependency: dependencyKey(dependency),
          severity: dependency.kind === "official" ? "warning" : "error",
          message:
            dependency.kind === "official"
              ? `${dependency.packageId}@${dependency.version} is unavailable; official entries will use default icons`
              : `${dependency.packageId}@${dependency.version} is unavailable and has no immutable download locator`,
        });
      } else {
        available.push({ dependency, installed });
      }
    } catch (error) {
      diagnostics.push({
        dependency: dependencyKey(dependency),
        severity: dependency.kind === "official" ? "warning" : "error",
        message:
          dependency.kind === "official"
            ? `${dependency.packageId}@${dependency.version} is unavailable; official entries will use default icons`
            : `${dependency.packageId}@${dependency.version}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { available, diagnostics };
}

function sourceFromPackage(
  dependency: PackageDependency,
  manifest: PackageManifest,
  content: PackageContent,
  current: ContentSource | undefined,
): ContentSource {
  const pack = modpackFromPackage(manifest, content);
  return ContentSourceSchema.parse({
    ...current,
    id: dependency.sourceId || current?.id || `package-${manifest.packageId}`,
    name: current?.name || pack.meta.name,
    kind: "mod",
    curseforgeId: pack.meta.curseforgeId,
    url: current?.url || pack.meta.url,
    docsUrl: current?.docsUrl || pack.meta.docsUrl,
    discordUrl: current?.discordUrl || pack.meta.discordUrl,
    variantTag: current?.variantTag || pack.meta.variantTag,
    iniNotes: pack.iniNotes,
    iniSettings: pack.iniSettings,
    iniBuild: current?.iniBuild ?? {},
    creatures: enrichSourceStructure(current, pack.creatures, "creatures"),
    items: enrichSourceStructure(current, pack.items, "items"),
    enabled: current?.enabled ?? true,
    removed: current?.removed ?? false,
    notes: current?.notes ?? "",
    modpackId: pack.meta.id,
    modpackVersion: pack.meta.version,
  });
}

type LayerRecord = CatalogFile[
  | "icons"
  | "notes"
  | "maps"
  | "variantParents"
  | "itemInfo"
  | "creatureInfo"
];

function addCollision(
  diagnostics: DependencyDiagnostic[],
  owners: Map<string, string>,
  domain: string,
  path: string,
  owner: string,
) {
  // Keyed per domain: two packages supplying the same path in *different*
  // domains do not overwrite each other and must not be reported as a clash.
  const key = `${domain}\u0000${path}`;
  const previous = owners.get(key);
  if (previous && previous !== owner) {
    diagnostics.push({
      dependency: owner,
      severity: "warning",
      message: `${domain} ${path} is supplied by both ${previous} and ${owner}; the later project dependency wins`,
    });
  }
  owners.set(key, owner);
}

/**
 * Resolves dependency layers deterministically. Package order is precedence;
 * project records win over every package and remain the only persisted edits.
 */
export function resolveDependencyLayers(
  project: CatalogFile,
  available: AvailableDependency[],
  initialDiagnostics: DependencyDiagnostic[] = [],
): ResolvedDependencyLayers {
  const defaults = emptyCatalog();
  const diagnostics = [...initialDiagnostics];
  const packageAssets: Record<string, AssetRef> = {};
  const packageRoots: Record<string, string> = {};
  const owners = new Map<string, string>();
  const sources = [...project.sources];
  let officialVersion = "";

  const copyRecord = (
    domain: "notes" | "maps" | "variantParents" | "itemInfo" | "creatureInfo",
    record: LayerRecord,
    owner: string,
  ) => {
    const target = defaults[domain] as Record<string, unknown>;
    for (const [rawPath, value] of Object.entries(record)) {
      const path = normalizeBpPath(rawPath);
      addCollision(diagnostics, owners, domain, path, owner);
      target[path] = value;
    }
  };

  for (const { dependency, installed } of available) {
    const owner = `${dependencyKey(dependency)} (${dependency.packageId})`;
    packageRoots[
      packageRootKey(dependency.kind, dependency.packageId, dependency.version)
    ] = installed.info.path;
    if (dependency.kind === "official") officialVersion = dependency.version;
    if (dependency.kind === "modpack") {
      const existingIndex = sources.findIndex(
        (source) =>
          source.id === dependency.sourceId ||
          source.modpackId === dependency.packageId,
      );
      const source = sourceFromPackage(
        dependency,
        installed.manifest,
        installed.content,
        existingIndex >= 0 ? sources[existingIndex] : undefined,
      );
      if (existingIndex >= 0) sources[existingIndex] = source;
      else sources.push(source);
    }

    for (const [rawPath, value] of Object.entries(installed.content.icons)) {
      const path = normalizeBpPath(rawPath);
      addCollision(diagnostics, owners, "icon", path, owner);
      if (value.startsWith("file:")) {
        packageAssets[path] =
          dependency.kind === "official"
            ? {
                origin: "official",
                packageVersion: dependency.version,
                path: value.slice(5),
              }
            : {
                origin: "package",
                packageId: dependency.packageId,
                version: dependency.version,
                path: value.slice(5),
              };
        delete defaults.icons[path];
      } else {
        defaults.icons[path] = value;
        delete packageAssets[path];
      }
    }
    copyRecord("notes", installed.content.notes, owner);
    copyRecord("maps", installed.content.maps, owner);
    copyRecord("variantParents", installed.content.variantParents, owner);
    copyRecord("itemInfo", installed.content.itemInfo, owner);
    copyRecord("creatureInfo", installed.content.creatureInfo, owner);
  }

  // `defaults.sources` is deliberately left empty. A linked package's source
  // row is merged with project-owned cluster policy, notes and structural
  // overrides, so it cannot be subtracted field-by-field the way the flat
  // record domains can. Persisting it whole is what makes the project readable
  // offline when its exact package is unavailable on another machine.
  return {
    catalog: {
      ...project,
      sources,
      icons: { ...defaults.icons, ...project.icons },
      notes: { ...defaults.notes, ...project.notes },
      maps: { ...defaults.maps, ...project.maps },
      variantParents: { ...defaults.variantParents, ...project.variantParents },
      itemInfo: { ...defaults.itemInfo, ...project.itemInfo },
      creatureInfo: { ...defaults.creatureInfo, ...project.creatureInfo },
    },
    packageAssets,
    packageRoots,
    officialVersion,
    defaults,
    diagnostics,
  };
}

function differentEntries<T>(
  resolved: Record<string, T>,
  defaults: Record<string, T>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(resolved).filter(
      ([path, value]) =>
        defaults[path] === undefined ||
        JSON.stringify(defaults[path]) !== JSON.stringify(value),
    ),
  );
}

/** Converts the resolved editing view back to project-owned override records. */
export function projectOverridesFromResolved(
  resolved: CatalogFile,
  defaults: CatalogFile,
): CatalogFile {
  return {
    ...resolved,
    icons: differentEntries(resolved.icons, defaults.icons),
    notes: differentEntries(resolved.notes, defaults.notes),
    maps: differentEntries(resolved.maps, defaults.maps),
    variantParents: differentEntries(
      resolved.variantParents,
      defaults.variantParents,
    ),
    itemInfo: differentEntries(resolved.itemInfo, defaults.itemInfo),
    creatureInfo: differentEntries(resolved.creatureInfo, defaults.creatureInfo),
  };
}
