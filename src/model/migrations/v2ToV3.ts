import { dependencyKey, PackageDependencySchema } from "../dependency";
import {
  MINIMUM_STUDIO_VERSION,
  PROJECT_FORMAT,
} from "../manifest";
import { PROJECT_FILE } from "../project";
import type { MigrationOutcome, MigrationStep, ProjectFiles } from "./types";

/** Schema 2 -> 3: record exact package requirements explicitly. */
export const v2ToV3: MigrationStep = {
  from: 2,
  to: 3,
  describe: "Record exact package dependencies without changing installed content",

  run(files: ProjectFiles): MigrationOutcome {
    const next = { ...files };
    const settings = JSON.parse(files[PROJECT_FILE.settings]) as Record<
      string,
      unknown
    >;
    const dependencies = mergeDependencies(
      settings.packageDependencies,
      legacyDependencies(files[PROJECT_FILE.catalog]),
    );
    next[PROJECT_FILE.settings] = `${JSON.stringify(
      {
        ...settings,
        format: PROJECT_FORMAT,
        schemaVersion: 3,
        minimumStudioVersion: MINIMUM_STUDIO_VERSION,
        packageDependencies: dependencies,
      },
      null,
      2,
    )}\n`;

    return {
      files: next,
      localHints: {},
      notes:
        dependencies.length > 0
          ? [
              `Recorded ${dependencies.length} installed modpack version${dependencies.length === 1 ? "" : "s"} as materialized compatibility dependencies`,
            ]
          : ["Enabled exact package dependency tracking"],
    };
  },
};

function legacyDependencies(catalogText: string | undefined) {
  if (!catalogText) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(catalogText) as unknown;
  } catch {
    // Catalog validation/quarantine owns a damaged catalog. The manifest
    // migration must not fabricate dependencies from unreadable data.
    return [];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const sources = (raw as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];

  const seen = new Set<string>();
  return sources.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const source = value as Record<string, unknown>;
    const packageId = stringOf(source.modpackId);
    const version = stringOf(source.modpackVersion);
    if (!packageId || !version) return [];
    const parsed = PackageDependencySchema.safeParse({
      kind: "modpack",
      packageId,
      version,
      curseforgeId: stringOf(source.curseforgeId),
      sourceId: stringOf(source.id),
      mode: "materialized",
      addedAt: "",
    });
    if (!parsed.success) return [];
    const key = dependencyKey(parsed.data);
    if (seen.has(key)) return [];
    seen.add(key);
    return [parsed.data];
  });
}

function mergeDependencies(
  existing: unknown,
  migrated: ReturnType<typeof legacyDependencies>,
) {
  const parsed = PackageDependencySchema.array().safeParse(existing);
  if (!parsed.success) return migrated;
  const next = [...parsed.data];
  for (const dependency of migrated) {
    if (
      !next.some(
        (candidate) => dependencyKey(candidate) === dependencyKey(dependency),
      )
    ) {
      next.push(dependency);
    }
  }
  return next;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
