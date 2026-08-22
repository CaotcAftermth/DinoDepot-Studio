import { plural } from "./text";
import { activeEntries, deprecatedEntries, type CosmeticsDraft } from "./cosmetics";
import type { CatalogFile, ContentSource } from "./catalog";
import type { ProductionDraft } from "./production";
import type { RemapsDraft } from "./remaps";
import type { Watchlist, WatchedMod } from "./watchlist";
import type { GithubReadiness } from "./githubReadiness";
import { summarizeOutputs, type OutputState } from "./outputs";
import type { IssueLevel } from "../validation/types";
import type { OutputFamily } from "./history";

/**
 * Everything Overview states about the project, worked out in one place.
 *
 * Overview's job is to be trustworthy: if it says the project is healthy, that
 * has to hold without opening Publish, CurseForge and Settings to check. It
 * previously judged health on three of six outputs, counted parked watchlist
 * entries as active, counted deprecated cosmetics as publishable, and treated
 * a filled-in repository field as proof publishing would work. All of that is
 * decided here now, from the shared output model.
 */

export type HealthLevel = "healthy" | "changes" | "attention" | "blocked";

export const HEALTH_LABELS: Record<HealthLevel, string> = {
  healthy: "Project healthy",
  changes: "Changes pending",
  attention: "Attention recommended",
  blocked: "Action required",
};

export type AttentionTone = "error" | "warn" | "info";

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  label: string;
  /** What to do about it, when that is not obvious from the label. */
  detail?: string;
  to: string;
  /** Lower sorts first. See {@link ATTENTION_RANK}. */
  rank: number;
}

/**
 * Severity order for the attention list: fix what blocks publishing, then what
 * stops it succeeding, then judgement calls, then routine work.
 */
export const ATTENTION_RANK = {
  blocking: 0,
  readiness: 1,
  warning: 2,
  review: 3,
  unpublished: 4,
  info: 5,
} as const;

export interface InventoryCard {
  id: string;
  label: string;
  value: string;
  /** Second line — the "is it okay?" half. */
  sub: string;
  to: string;
  /** Draws the amber border. Reserved for things a person should act on. */
  alert: boolean;
}

export interface NextAction {
  id: string;
  label: string;
  to: string;
  /** Contextual actions lead; common tasks fill the space when idle. */
  primary: boolean;
}

export interface OverviewModel {
  health: HealthLevel;
  headline: string;
  outputs: OutputState[];
  inventory: InventoryCard[];
  attention: AttentionItem[];
  actions: NextAction[];
  github: GithubReadiness;
  /** `n of m` applicable outputs published and up to date. */
  synchronized: { count: number; total: number };
  /** Whether any output has anything worth publishing at all. */
  hasPublishableContent: boolean;
}

export interface OverviewInput {
  production: ProductionDraft;
  remaps: RemapsDraft;
  cosmetics: CosmeticsDraft;
  catalog: CatalogFile;
  watchlist: Watchlist;
  outputs: OutputState[];
  github: GithubReadiness;
}

/**
 * Mods checks actually run for.
 *
 * A parked entry is history — the acknowledged version is kept so re-enabling
 * resumes correctly — and counting those inflated the watched total and, worse,
 * raised review warnings for mods the cluster no longer runs.
 */
export function activeWatched(watchlist: Watchlist): WatchedMod[] {
  return watchlist.mods.filter((m) => m.watching);
}

export function watchedNeedingReview(watchlist: Watchlist): WatchedMod[] {
  return activeWatched(watchlist).filter((m) => m.needsReview);
}

/** Sources that are switched off or on their way out. */
export function troubledSources(catalog: CatalogFile): ContentSource[] {
  return catalog.sources.filter((s) => !s.enabled || s.removed);
}

// ---------------------------------------------------------------------------

/**
 * How many individual validation problems Overview lists before summarizing.
 *
 * Enough that the usual handful are all actionable from here, few enough that
 * a project with forty broken rules does not bury everything else on the page.
 */
const ISSUE_ROWS = 6;

/** Where an output's problems are actually fixed. */
const FAMILY_PAGE: Record<OutputFamily, string> = {
  production: "/production",
  remaps: "/remaps",
  cosmetics: "/curseforge",
  viewerData: "/publish",
  viewerPage: "/publish",
  players: "/players",
};

/**
 * One attention row per validation problem, linked to the thing that has it.
 *
 * These used to be a single row reading "7 validation errors blocking
 * publishing", which navigated to Publish, where the errors were behind a
 * "Show 7 validation issues" disclosure, listed by rule id. Three steps and a
 * lookup to reach something the overview already knew. Each row now names the
 * problem and goes straight to the rule.
 */
function issueItems(
  outputs: OutputState[],
  level: IssueLevel,
): AttentionItem[] {
  const rows: AttentionItem[] = [];
  const blocking = level === "error";
  // One rule feeds several outputs — a broken production rule is reported by
  // Passive Production and again by Cluster Viewer Data — and it is still one
  // thing to go and fix. The first output to report it wins, which is the one
  // that owns the rule.
  const seen = new Set<string>();

  for (const output of outputs) {
    for (const issue of output.issues) {
      if (issue.level !== level) continue;
      const fingerprint = `${issue.entityId} :: ${issue.where} :: ${issue.message}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      const page = FAMILY_PAGE[output.family] ?? "/publish";
      rows.push({
        // Stable across renders, and unique even when one rule has several.
        id: `issue:${output.family}:${issue.entityId}:${rows.length}`,
        tone: blocking ? "error" : "warn",
        rank: blocking ? ATTENTION_RANK.blocking : ATTENTION_RANK.warning,
        label: issue.message,
        detail: [output.label, issue.where].filter(Boolean).join(" › "),
        // An issue with no entity belongs to the output as a whole, so it
        // links to the page rather than to a rule that cannot be selected.
        to: issue.entityId ? `${page}/${issue.entityId}` : page,
      });
    }
  }

  if (rows.length <= ISSUE_ROWS) return rows;
  const shown = rows.slice(0, ISSUE_ROWS);
  shown.push({
    id: `issue-overflow:${level}`,
    tone: blocking ? "error" : "warn",
    rank: blocking ? ATTENTION_RANK.blocking : ATTENTION_RANK.warning,
    label: `${plural(rows.length - ISSUE_ROWS, `further validation ${level}`)}`,
    detail: "Listed in full on the Publish page",
    to: "/publish",
  });
  return shown;
}

export function buildOverview(input: OverviewInput): OverviewModel {
  const { production, remaps, cosmetics, catalog, watchlist, outputs, github } =
    input;
  const totals = summarizeOutputs(outputs);
  const needReview = watchedNeedingReview(watchlist);
  const troubled = troubledSources(catalog);
  const removingSources = troubled.filter((s) => s.removed);

  // Publishing prerequisites only block once there is something to publish.
  // An empty new project is not "action required" for lacking a repository it
  // has nothing to send to yet.
  const publishingBlocked = totals.withContent.length > 0 && !github.ready;

  const attention: AttentionItem[] = [];

  const errorRows = issueItems(outputs, "error");
  attention.push(...errorRows);

  if (publishingBlocked) {
    attention.push({
      id: "github-not-ready",
      tone: "error",
      rank: ATTENTION_RANK.readiness,
      label: github.destinationConfigured
        ? "Publishing is not ready"
        : "GitHub publishing is not configured",
      detail: github.blockers.join(" · "),
      to: "/settings/github",
    });
  }

  attention.push(...issueItems(outputs, "warning"));

  if (removingSources.length > 0) {
    attention.push({
      id: "sources-removing",
      tone: "warn",
      rank: ATTENTION_RANK.warning,
      label: `${plural(removingSources.length, "content source")} being removed`,
      detail: "Check remaps cover their creatures before the mod goes",
      to: "/content",
    });
  }

  if (needReview.length > 0) {
    // One row, not one per mod: seven near-identical lines pushed everything
    // else off the card without saying more than the count does.
    attention.push({
      id: "mods-need-review",
      tone: "warn",
      rank: ATTENTION_RANK.review,
      label: `${plural(needReview.length, "watched mod")} ${needReview.length === 1 ? "needs" : "need"} review`,
      detail: needReview
        .slice(0, 3)
        .map((m) => m.name)
        .join(", ") + (needReview.length > 3 ? `, +${needReview.length - 3} more` : ""),
      to: "/curseforge",
    });
  }

  // Only outputs that could actually be published. A blocked one is already
  // named in the errors row above, and listing it twice says nothing new.
  const publishable = totals.dirty.filter((o) => o.errors === 0);
  if (publishable.length > 0) {
    attention.push({
      id: "unpublished",
      tone: "warn",
      rank: ATTENTION_RANK.unpublished,
      label: `${plural(publishable.length, "output")} ${publishable.length === 1 ? "has" : "have"} unpublished changes`,
      detail: publishable.map((o) => o.label).join(", "),
      to: "/publish",
    });
  }

  const disabledOnly = troubled.filter((s) => !s.removed);
  if (disabledOnly.length > 0) {
    attention.push({
      id: "sources-disabled",
      tone: "info",
      rank: ATTENTION_RANK.info,
      label: `${plural(disabledOnly.length, "content source")} disabled`,
      detail: "Their creatures and items stay catalogued but are not on the cluster",
      to: "/content",
    });
  }

  // Deliberately no attention item for "ready but not verified this session".
  // Not having clicked Test Connection is not a defect, and raising it here
  // would put every healthy project permanently in amber — which is exactly
  // how a health signal stops meaning anything. The distinction is shown on
  // the publishing card's target chip instead, as ready vs verified.

  attention.sort((a, b) => a.rank - b.rank);

  const health = healthOf({
    errors: totals.errors,
    publishingBlocked,
    warnings: totals.warnings,
    needReview: needReview.length,
    troubled: troubled.length,
    dirty: publishable.length,
  });

  const applicable = outputs.filter((o) => o.applicable);
  const synchronized = {
    count: totals.synchronized.length,
    total: applicable.length,
  };

  return {
    health,
    headline: headlineFor(health, {
      errors: totals.errors,
      dirty: publishable.length,
      attention: attention.length,
      synchronized,
      configured: totals.withContent.length > 0,
    }),
    outputs,
    inventory: buildInventory({
      production,
      remaps,
      cosmetics,
      catalog,
      watchlist,
      outputs,
    }),
    attention,
    actions: buildActions({
      dirty: publishable.length,
      // Distinct problems, not occurrences: one broken rule is reported by
      // every output that embeds it, and "Resolve 2 validation errors" for a
      // single empty blueprint path sends somebody looking for a second one.
      errors: errorRows.length,
      firstError: errorRows[0]?.to ?? "/publish",
      needReview: needReview.length,
      // Nagging about a repository is only useful once there is something to
      // send to it — otherwise a brand-new project greets you with a chore.
      needsGithub: totals.withContent.length > 0 && !github.ready,
    }),
    github,
    synchronized,
    hasPublishableContent: totals.withContent.length > 0,
  };
}

function healthOf(x: {
  errors: number;
  publishingBlocked: boolean;
  warnings: number;
  needReview: number;
  troubled: number;
  dirty: number;
}): HealthLevel {
  // Severity order, most serious first. Unpublished changes rank below
  // warnings on purpose: pending work is normal, a warning is a judgement the
  // admin has not made yet.
  if (x.errors > 0 || x.publishingBlocked) return "blocked";
  if (x.warnings > 0 || x.needReview > 0 || x.troubled > 0) return "attention";
  if (x.dirty > 0) return "changes";
  return "healthy";
}

function headlineFor(
  health: HealthLevel,
  x: {
    errors: number;
    dirty: number;
    attention: number;
    synchronized: { count: number; total: number };
    /** Whether any output has anything to publish at all. */
    configured: boolean;
  },
): string {
  switch (health) {
    case "blocked":
      return x.errors > 0
        ? `${plural(x.errors, "validation error")} must be fixed before publishing.`
        : "Publishing cannot run until its prerequisites are met.";
    case "attention":
      return `${plural(x.attention, "item")} worth a look — nothing is blocking publishing.`;
    case "changes":
      return `${plural(x.dirty, "output")} ready to publish. Everything else is in sync.`;
    case "healthy":
      // "5 outputs synchronized" on a project where nothing has ever been
      // published would be true only in the emptiest sense.
      return x.configured
        ? `All ${x.synchronized.total} outputs valid and synchronized.`
        : "Nothing configured yet — add production rules to get started.";
  }
}

// ---------------------------------------------------------------------------

function buildInventory(x: {
  production: ProductionDraft;
  remaps: RemapsDraft;
  cosmetics: CosmeticsDraft;
  catalog: CatalogFile;
  watchlist: Watchlist;
  outputs: OutputState[];
}): InventoryCard[] {
  const byFamily = (family: OutputState["family"]) =>
    x.outputs.find((o) => o.family === family);

  const enabledRules = x.production.rules.filter((r) => r.enabled).length;
  const disabledRules = x.production.rules.length - enabledRules;
  const productionOut = byFamily("production");

  const activeRemaps = x.remaps.entries.filter((e) => e.active).length;
  const inactiveRemaps = x.remaps.entries.length - activeRemaps;
  const remapsOut = byFamily("remaps");

  // The publishable set, not the catalogue: a deprecated mod is held back
  // from the file however it is flagged, so leading with the catalogue total
  // would overstate what players actually receive.
  const publishableCosmetics = activeEntries(x.cosmetics).filter(
    (e) => e.included,
  ).length;
  const deprecated = deprecatedEntries(x.cosmetics).length;

  const watching = activeWatched(x.watchlist).length;
  const needReview = watchedNeedingReview(x.watchlist).length;

  const sources = x.catalog.sources;
  const troubled = troubledSources(x.catalog);

  return [
    {
      id: "production",
      label: "Production rules",
      value: String(enabledRules),
      sub: [
        disabledRules > 0 ? `${disabledRules} disabled` : null,
        productionOut?.errors
          ? `${plural(productionOut.errors, "error")}`
          : x.production.rules.length === 0
            ? "None yet"
            : "All valid",
      ]
        .filter(Boolean)
        .join(" · "),
      to: "/production",
      alert: (productionOut?.errors ?? 0) > 0,
    },
    {
      id: "remaps",
      label: "Creature remaps",
      value: String(activeRemaps),
      sub: [
        inactiveRemaps > 0 ? `${inactiveRemaps} inactive` : null,
        remapsOut?.errors
          ? `${plural(remapsOut.errors, "error")}`
          : remapsOut?.warnings
            ? `${plural(remapsOut.warnings, "warning")}`
            : x.remaps.entries.length === 0
              ? "None yet"
              : "No conflicts",
      ]
        .filter(Boolean)
        .join(" · "),
      to: "/remaps",
      alert: (remapsOut?.errors ?? 0) > 0,
    },
    {
      id: "cosmetics",
      label: "Cosmetics",
      value: String(publishableCosmetics),
      sub: [
        `${x.cosmetics.entries.length} cataloged`,
        deprecated > 0 ? `${deprecated} deprecated` : null,
        x.cosmetics.lastScrapeAt
          ? `scraped ${new Date(x.cosmetics.lastScrapeAt).toLocaleDateString()}`
          : "never scraped",
      ]
        .filter(Boolean)
        .join(" · "),
      to: "/curseforge",
      alert: false,
    },
    {
      id: "watched",
      label: "Watched mods",
      value: String(watching),
      sub:
        needReview > 0
          ? `${needReview} need review`
          : watching === 0
            ? "None watched"
            : "All reviewed",
      to: "/curseforge",
      alert: needReview > 0,
    },
    {
      id: "sources",
      label: "Content sources",
      value: String(sources.length),
      sub:
        sources.length === 0
          ? "Official ASA only"
          : troubled.length > 0
            ? `${troubled.length} disabled or removing`
            : "All active",
      to: "/content",
      alert: troubled.length > 0,
    },
  ];
}

// ---------------------------------------------------------------------------

/**
 * What to do next.
 *
 * Every entry navigates, and every label says so — the old Quick Actions
 * offered "Run cosmetics collector" on a button that only opened a page.
 */
function buildActions(x: {
  dirty: number;
  errors: number;
  /** Where the first blocking problem actually is. */
  firstError: string;
  needReview: number;
  needsGithub: boolean;
}): NextAction[] {
  const actions: NextAction[] = [];

  if (x.errors > 0) {
    actions.push({
      id: "fix-errors",
      label: `Resolve ${plural(x.errors, "validation error")}`,
      // Straight at the first one. Publish lists them all behind a
      // disclosure, which is where this used to send people.
      to: x.firstError,
      primary: true,
    });
  }
  if (x.needsGithub) {
    actions.push({
      id: "configure-github",
      label: "Configure GitHub publishing",
      to: "/settings/github",
      primary: true,
    });
  }
  if (x.needReview > 0) {
    actions.push({
      id: "review-mods",
      label: `Review ${plural(x.needReview, "watched mod")}`,
      to: "/curseforge",
      primary: true,
    });
  }
  if (x.dirty > 0 && x.errors === 0) {
    actions.push({
      id: "publish",
      label: `Publish ${plural(x.dirty, "change")}`,
      to: "/publish",
      primary: true,
    });
  }

  if (actions.length > 0) return actions;

  // Nothing outstanding — offer the work someone actually comes here to do.
  return [
    { id: "new-rule", label: "New production rule", to: "/production", primary: false },
    { id: "new-remap", label: "Add creature remap", to: "/remaps", primary: false },
    { id: "simulate", label: "Run a simulation", to: "/simulator", primary: false },
    { id: "content", label: "Manage content sources", to: "/content", primary: false },
    { id: "cosmetics", label: "Open cosmetics collector", to: "/curseforge", primary: false },
  ];
}
