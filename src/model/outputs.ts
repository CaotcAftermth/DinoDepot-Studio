import { productionToText } from "../serializers/production";
import { remapsToText } from "../serializers/remaps";
import { serializeCosmetics, validateCosmeticsText } from "../serializers/cosmetics";
import { serializeViewerData } from "../serializers/viewer";
import { playersToText } from "../serializers/players";
import { buildViewerHtml } from "../viewer/template";
import { validateProduction } from "../validation/production";
import { validateRemaps } from "../validation/remaps";
import { countIssues, type ValidationIssue } from "../validation/types";
import { contentHash, rawImagesUrl, rawUrl } from "../services/publish";
import {
  lastPublish,
  OUTPUT_FAMILY_LABELS,
  type HistoryFile,
  type OutputFamily,
  type PublishRecord,
} from "./history";
import { activeEntries } from "./cosmetics";
import type { CatalogIndex, CatalogFile } from "./catalog";
import type { ProductionDraft } from "./production";
import type { RemapsDraft } from "./remaps";
import type { CosmeticsDraft } from "./cosmetics";
import type { PlayersFile } from "./players";
import type { GithubConfig, ProjectSettings } from "./project";
import type { LocalProjectState } from "./localState";

/**
 * The one place that decides what is publishable and what state it is in.
 *
 * Overview and Publish both read from here. They used to work this out
 * separately, and drifted: Overview knew about three of the six outputs, and
 * called an output "unpublished" whenever its serialized text was non-empty —
 * which an empty remap file is, because `{"dinoMappings": []}` is 21
 * characters. A brand-new project therefore opened claiming unpublished work.
 *
 * Adding a seventh output should mean adding one entry to `buildOutputStates`
 * and nothing else.
 */

export type OutputStatus =
  /** The feature this output belongs to is switched off for the project. */
  | "disabled"
  /** Nothing worth publishing yet, and never published. */
  | "empty"
  /** Validation errors — publishing is refused. */
  | "blocked"
  /** Has content, has never been published. */
  | "unpublished"
  /** Published before, and the draft has moved on since. */
  | "changed"
  /** Published, and the draft still matches what was published. */
  | "published";

export const OUTPUT_STATUS_LABELS: Record<OutputStatus, string> = {
  disabled: "Disabled",
  empty: "No content",
  blocked: "Publish blocked",
  unpublished: "Never published",
  changed: "Changes pending",
  published: "Published",
};

export interface OutputState {
  family: OutputFamily;
  label: string;
  /**
   * False when the project has this output switched off. Distinct from
   * "empty": a disabled output is not a gap in the project's health.
   */
  applicable: boolean;
  /** The exact text that would be published. */
  content: string;
  /**
   * Hash used for change detection. Usually the hash of `content`, but an
   * output that stamps a generation time into itself is hashed with that
   * stamp held fixed — otherwise it would report changes on every render.
   */
  hash: string;
  issues: ValidationIssue[];
  errors: number;
  warnings: number;
  /**
   * Whether there is anything meaningful to publish, judged on the draft
   * rather than on the length of the serialized string.
   */
  hasContent: boolean;
  lastPublishedAt: string | null;
  publishedHash: string | null;
  /** The full record, for callers that want the commit sha or message. */
  lastRecord: PublishRecord | null;
  /** Content differs from what was last published (or was never published). */
  dirty: boolean;
  status: OutputStatus;
  /** Repository path this output publishes to. */
  path: string;
}

export interface OutputBuildInput {
  production: ProductionDraft;
  remaps: RemapsDraft;
  cosmetics: CosmeticsDraft;
  catalog: CatalogFile;
  players: PlayersFile;
  history: HistoryFile;
  imageFiles: string[];
  settings: ProjectSettings | null;
  /**
   * The repository the outputs are published to, assembled from the portable
   * layout and this machine's binding. Passed in rather than read off
   * `settings`: which repository a project publishes to is a fact about the
   * machine, not about the project.
   */
  github: GithubConfig;
  index: CatalogIndex | null;
}

/**
 * Fixed timestamp used when hashing an output that dates itself. Any constant
 * works; the point is that it never moves, so the hash tracks the data.
 */
const HASH_EPOCH = new Date(0);

function statusOf(
  applicable: boolean,
  errors: number,
  hasContent: boolean,
  publishedHash: string | null,
  hash: string,
): OutputStatus {
  if (!applicable) return "disabled";
  if (errors > 0) return "blocked";
  // Never published and nothing to publish — the state of every output in a
  // new project, and not a problem.
  if (!publishedHash && !hasContent) return "empty";
  if (!publishedHash) return "unpublished";
  // Deliberately still compared when the draft is now empty: emptying an
  // output is a real change, and the remote still holds the old content.
  return publishedHash === hash ? "published" : "changed";
}

function state(
  family: OutputFamily,
  input: OutputBuildInput,
  content: string,
  hasContent: boolean,
  issues: ValidationIssue[],
  options: { applicable?: boolean; hash?: string } = {},
): OutputState {
  const applicable = options.applicable ?? true;
  const hash = options.hash ?? contentHash(content);
  const record = lastPublish(input.history, family);
  const { errors, warnings } = countIssues(issues);
  const publishedHash = record?.contentHash ?? null;
  return {
    family,
    label: OUTPUT_FAMILY_LABELS[family],
    applicable,
    content,
    hash,
    issues,
    errors,
    warnings,
    hasContent,
    lastPublishedAt: record?.publishedAt ?? null,
    publishedHash,
    lastRecord: record,
    dirty: publishedHash ? publishedHash !== hash : hasContent,
    status: statusOf(applicable, errors, hasContent, publishedHash, hash),
    path: input.settings?.outputPaths[family] ?? "",
  };
}

/**
 * Every publishable output, in the order they are presented.
 *
 * `hasContent` mirrors what each serializer actually emits — disabled rules,
 * inactive remaps and deprecated cosmetics are all filtered out on the way to
 * the published file, so none of them count as content here either.
 */
export function buildOutputStates(input: OutputBuildInput): OutputState[] {
  const { production, remaps, cosmetics, catalog, players, settings } = input;
  const clusterName = settings?.cluster || settings?.name || "ASA Cluster";
  const productionIssues = validateProduction(production, input.index);
  const cosmeticsText = serializeCosmetics(cosmetics);

  const viewerData = serializeViewerData(
    production,
    catalog,
    clusterName,
    input.imageFiles,
    settings,
  );
  const viewerHasData =
    viewerData.creatures.length > 0 || viewerData.items.length > 0;

  return [
    state(
      "production",
      input,
      productionToText(production),
      production.rules.some((r) => r.enabled),
      productionIssues,
    ),
    state(
      "remaps",
      input,
      remapsToText(remaps),
      remaps.entries.some((e) => e.active),
      validateRemaps(remaps, input.index),
    ),
    state(
      "cosmetics",
      input,
      cosmeticsText,
      // Both flags matter: a deprecated mod is held back from the file even
      // when it is still marked included.
      activeEntries(cosmetics).some((e) => e.included),
      validateCosmeticsText(cosmeticsText).map((message) => ({
        level: "error" as const,
        entityId: "cosmetics",
        where: "CCM list",
        message,
      })),
    ),
    state(
      "viewerData",
      input,
      JSON.stringify(viewerData, null, 2),
      viewerHasData,
      // Derived from production — reuse its errors so broken data never
      // reaches the public page.
      productionIssues.filter((i) => i.level === "error"),
    ),
    state(
      "viewerPage",
      input,
      settings
        ? buildViewerHtml({
            clusterName,
            dataUrl: rawUrl(input.github, "viewerData"),
            imagesUrl: rawImagesUrl(input.github),
          })
        : "",
      // The page is a shell that fetches the data file, so it is only worth
      // publishing once there is data for it to show — otherwise a brand-new
      // project opens with an atlas of nothing already queued to publish.
      Boolean(settings) && viewerHasData,
      [],
    ),
    state(
      "players",
      input,
      playersToText(players),
      players.players.length > 0,
      [],
      {
        // Publishing a roster nobody maintains would be surprising, so this
        // one follows the Player Data module.
        applicable: settings?.modules["player-data"] === true,
        // The roster stamps its own generation time, which moves on every
        // render. Hashed at a fixed instant so the flag tracks the roster.
        hash: contentHash(playersToText(players, HASH_EPOCH)),
      },
    ),
  ];
}

/** The outputs that count towards project health. */
export function applicableOutputs(states: OutputState[]): OutputState[] {
  return states.filter((s) => s.applicable);
}

/**
 * Outputs that still have their own publish destination.
 *
 * Viewer page and viewer data are parts of the public site artifact. They are
 * generated and committed together by the site pipeline, never published as
 * independent files.
 */
export function standaloneOutputs(states: OutputState[]): OutputState[] {
  return states.filter(
    (state) =>
      state.applicable &&
      state.family !== "viewerData" &&
      state.family !== "viewerPage",
  );
}

/**
 * Publishing rows shown on Overview.
 *
 * Viewer page and data are one public-site artifact now. Their old per-file
 * history cannot describe an atomic site publish, so machine-local publish
 * checkpoints own the grouped row. Legacy per-file history remains a fallback
 * for projects published by an older Studio build.
 */
export function overviewPublishingOutputs(
  states: OutputState[],
  local: LocalProjectState | null = null,
): OutputState[] {
  // Overview keeps disabled outputs visible; Publish hides them. Only viewer
  // rows are replaced here.
  const standalone = states.filter(
    (state) => state.family !== "viewerData" && state.family !== "viewerPage",
  );
  const viewer = states.filter(
    (state) => state.family === "viewerData" || state.family === "viewerPage",
  );
  if (viewer.length === 0 || !viewer.some((state) => state.applicable)) {
    return standalone;
  }

  const issues = viewer.flatMap((state) => state.issues);
  const errors = issues.filter((issue) => issue.level === "error").length;
  const warnings = issues.filter((issue) => issue.level === "warning").length;
  const hasContent = viewer.some((state) => state.hasContent);
  const atomicPublished = Boolean(local?.lastPublishedCommit);
  const legacyPublished = viewer
    .filter((state) => state.applicable)
    .every((state) => Boolean(state.publishedHash));
  const published = atomicPublished || legacyPublished;
  const sourceChanged = Boolean(
    atomicPublished &&
      local?.lastSyncedCommit &&
      local.lastPublishedSourceCommit !== local.lastSyncedCommit,
  );
  const draftChanged = Boolean(atomicPublished && local?.pendingActions.length);
  const legacyChanged = !atomicPublished && viewer.some((state) => state.dirty);
  const dirty = published
    ? sourceChanged || draftChanged || legacyChanged
    : hasContent;
  const status: OutputStatus =
    errors > 0
      ? "blocked"
      : !published && !hasContent
        ? "empty"
        : !published
          ? "unpublished"
          : dirty
            ? "changed"
            : "published";
  const hash = contentHash(viewer.map((state) => state.hash).join("\n"));
  const lastPublishedAt = atomicPublished
    ? local?.lastPublishedAt || null
    : viewer
        .map((state) => state.lastPublishedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
  const site: OutputState = {
    family: "viewerPage",
    label: "Public Site",
    applicable: true,
    content: viewer.map((state) => state.content).join("\n"),
    hash,
    issues,
    errors,
    warnings,
    hasContent,
    lastPublishedAt,
    publishedHash: published && !dirty ? hash : null,
    lastRecord: null,
    dirty,
    status,
    path: "docs/",
  };

  const players = standalone.findIndex((state) => state.family === "players");
  if (players < 0) return [...standalone, site];
  return [...standalone.slice(0, players), site, ...standalone.slice(players)];
}

export interface OutputTotals {
  errors: number;
  warnings: number;
  /** Applicable outputs whose draft differs from what was published. */
  dirty: OutputState[];
  /** Applicable outputs that are published and up to date. */
  synchronized: OutputState[];
  /** Applicable outputs with anything worth publishing. */
  withContent: OutputState[];
  blocked: OutputState[];
}

export function summarizeOutputs(states: OutputState[]): OutputTotals {
  const applicable = applicableOutputs(states);
  return {
    errors: applicable.reduce((n, s) => n + s.errors, 0),
    warnings: applicable.reduce((n, s) => n + s.warnings, 0),
    dirty: applicable.filter((s) => s.dirty),
    synchronized: applicable.filter((s) => s.status === "published"),
    withContent: applicable.filter((s) => s.hasContent),
    blocked: applicable.filter((s) => s.status === "blocked"),
  };
}
