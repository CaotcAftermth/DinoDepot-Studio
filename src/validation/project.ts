import { validateProduction } from "./production";
import { validateRemaps } from "./remaps";
import { countIssues, type ValidationIssue } from "./types";
import { validateCosmeticsText, serializeCosmetics } from "../serializers/cosmetics";
import { activeEntries } from "../model/cosmetics";
import { CURRENT_PROJECT_SCHEMA } from "../model/manifest";
import { normalizeBpPath } from "../model/catalog";
import type { CatalogFile, CatalogIndex } from "../model/catalog";
import { knownPaths } from "../model/officialCatalog";
import type { CosmeticsDraft } from "../model/cosmetics";
import type { PlayersFile } from "../model/players";
import type { ProductionDraft } from "../model/production";
import type { ProjectSettings } from "../model/project";
import type { RemapsDraft } from "../model/remaps";
import type { DependencyDiagnostic } from "../services/dependencyManager";

/**
 * One place that says whether a project is fit to publish.
 *
 * The individual validators already existed and are good; what did not exist
 * was anything that ran all of them and gave a single answer. Publish used to
 * decide per output, which meant a project could publish its production rules
 * while its catalog was broken — and the viewer reads both.
 *
 * Errors block. Warnings can be acknowledged, because plenty of them are
 * "this looks unusual" rather than "this is wrong", and a cluster with an
 * unusual setup should not be unable to publish.
 */

/** Where an issue came from, so the UI can send the admin to the right page. */
export type ValidationArea =
  | "schema"
  | "manifest"
  | "production"
  | "remaps"
  | "cosmetics"
  | "catalog"
  | "dependencies"
  | "players"
  | "assets";

export interface ProjectIssue extends ValidationIssue {
  area: ValidationArea;
}

export interface ValidationInput {
  settings: ProjectSettings | null;
  production: ProductionDraft;
  remaps: RemapsDraft;
  cosmetics: CosmeticsDraft;
  catalog: CatalogFile;
  players: PlayersFile;
  index: CatalogIndex | null;
  /** File names found in the images folder, for the icon checks. */
  imageFiles: string[];
  dependencyDiagnostics?: DependencyDiagnostic[];
  dependenciesLoading?: boolean;
}

export interface ValidationReport {
  issues: ProjectIssue[];
  errors: number;
  warnings: number;
  /** True when nothing blocks. Warnings may still need acknowledging. */
  publishable: boolean;
  /** Areas carrying at least one blocking error. */
  blockedAreas: ValidationArea[];
}

function issue(
  area: ValidationArea,
  level: "error" | "warning",
  where: string,
  message: string,
  entityId = "",
): ProjectIssue {
  return { area, level, where, message, entityId };
}

/**
 * Runs everything.
 *
 * Deliberately does not stop at the first error: an administrator fixing a
 * project wants the whole list, not one item at a time.
 */
export function validateProject(input: ValidationInput): ValidationReport {
  const issues: ProjectIssue[] = [
    ...schemaIssues(input),
    ...manifestIssues(input),
    ...withArea("production", validateProduction(input.production, input.index)),
    ...withArea("remaps", validateRemaps(input.remaps, input.index)),
    ...cosmeticIssues(input),
    ...catalogIssues(input),
    ...(input.dependenciesLoading
      ? [
          issue(
            "dependencies",
            "error",
            "Exact packages",
            "Package dependencies are still resolving. Try again when they finish.",
          ),
        ]
      : []),
    ...(input.dependencyDiagnostics ?? []).map((diagnostic) =>
      issue(
        "dependencies",
        diagnostic.severity,
        diagnostic.dependency,
        diagnostic.message,
        diagnostic.dependency,
      ),
    ),
    ...playerIssues(input),
    ...assetIssues(input),
  ];

  const { errors, warnings } = countIssues(issues);
  const blockedAreas: ValidationArea[] = [];
  for (const item of issues) {
    if (item.level === "error" && !blockedAreas.includes(item.area)) {
      blockedAreas.push(item.area);
    }
  }

  return { issues, errors, warnings, publishable: errors === 0, blockedAreas };
}

function withArea(area: ValidationArea, issues: ValidationIssue[]): ProjectIssue[] {
  return issues.map((i) => ({ ...i, area }));
}

// ---------------------------------------------------------------------------

function schemaIssues(input: ValidationInput): ProjectIssue[] {
  const settings = input.settings;
  if (!settings) {
    return [issue("schema", "error", "Project", "No project is open.")];
  }
  if (settings.schemaVersion !== CURRENT_PROJECT_SCHEMA) {
    // A project this build cannot fully read must not have its contents
    // regenerated into a public site by it.
    return [
      issue(
        "schema",
        "error",
        "Project",
        "This project uses a format this version of DinoDepot Studio cannot publish from.",
      ),
    ];
  }
  return [];
}

function manifestIssues(input: ValidationInput): ProjectIssue[] {
  const settings = input.settings;
  if (!settings) return [];
  const issues: ProjectIssue[] = [];

  if (!settings.projectId.trim()) {
    issues.push(issue("manifest", "error", "Project", "The project has no permanent id."));
  }
  if (!settings.name.trim()) {
    issues.push(issue("manifest", "error", "Project", "The project has no name."));
  }

  // A path that escapes the repository would write outside the published tree.
  for (const [key, value] of Object.entries(settings.outputPaths)) {
    if (!value.trim()) {
      issues.push(
        issue("manifest", "error", `Published files › ${key}`, "This location is empty."),
      );
      continue;
    }
    if (value.startsWith("/") || value.includes("..") || value.includes("\\")) {
      issues.push(
        issue(
          "manifest",
          "error",
          `Published files › ${key}`,
          "This location has to be a plain path inside the repository.",
        ),
      );
    }
  }
  return issues;
}

function cosmeticIssues(input: ValidationInput): ProjectIssue[] {
  const text = serializeCosmetics(input.cosmetics);
  const issues = validateCosmeticsText(text).map((message) =>
    issue("cosmetics", "error", "Custom cosmetics list", message),
  );

  // Two entries for one mod would publish it twice, and the game reads the
  // list top to bottom.
  const seen = new Map<string, number>();
  for (const entry of activeEntries(input.cosmetics)) {
    if (!entry.included) continue;
    seen.set(entry.modId, (seen.get(entry.modId) ?? 0) + 1);
  }
  for (const [modId, count] of seen) {
    if (count > 1) {
      issues.push(
        issue(
          "cosmetics",
          "error",
          "Custom cosmetics list",
          `Mod ${modId} is in the list ${count} times.`,
          modId,
        ),
      );
    }
  }
  return issues;
}

function catalogIssues(input: ValidationInput): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  const ids = new Set<string>();
  for (const source of input.catalog.sources) {
    if (ids.has(source.id)) {
      issues.push(
        issue("catalog", "error", `Content source › ${source.name}`, "Two sources share an id.", source.id),
      );
    }
    ids.add(source.id);
    if (!source.name.trim()) {
      issues.push(
        issue("catalog", "warning", "Content sources", "A source has no name.", source.id),
      );
    }
  }
  return issues;
}

function playerIssues(input: ValidationInput): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  const ids = new Set<string>();

  for (const player of input.players.players) {
    if (ids.has(player.id)) {
      issues.push(issue("players", "error", "Player roster", "Two players share an id.", player.id));
    }
    ids.add(player.id);

    // A reference with no file behind it cannot be backed up or restored.
    if (player.profile && !player.profile.fileName.trim()) {
      issues.push(
        issue(
          "players",
          "warning",
          "Player roster",
          "A stored profile has lost its file — it needs uploading again.",
          player.id,
        ),
      );
    }
  }
  return issues;
}

/**
 * Icons the viewer will ask for.
 *
 * A missing icon is a warning: the viewer falls back to a category emoji, so
 * the site is still correct, just plainer. WebP is preferred and PNG is the
 * accepted fallback format.
 */
function assetIssues(input: ValidationInput): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  const available = new Set(input.imageFiles.map((f) => f.toLowerCase()));
  // Icon rows outlived their entries in builds before deletion pruned them, so
  // a mod removed from the project could go on reporting missing artwork for
  // classes nothing catalogues. An assignment no entry can ask for is not a
  // problem to fix — it is a row to ignore.
  const known = knownPaths(input.catalog);

  for (const [path, icon] of Object.entries(input.catalog.icons ?? {})) {
    if (!icon.startsWith("file:")) continue;
    if (!known.has(normalizeBpPath(path))) continue;
    const file = icon.slice(5);
    if (!available.has(file.toLowerCase())) {
      issues.push(
        issue("assets", "warning", "Icons", `The image ${file} is not in the images folder.`, path),
      );
      continue;
    }
    if (!/\.(?:webp|png)$/i.test(file)) {
      issues.push(
        issue(
          "assets",
          "warning",
          "Icons",
          `${file} is not an accepted WebP or PNG icon.`,
          path,
        ),
      );
    }
  }
  return issues;
}

/** Issues for one area, for a per-page summary. */
export function issuesFor(report: ValidationReport, area: ValidationArea): ProjectIssue[] {
  return report.issues.filter((i) => i.area === area);
}
