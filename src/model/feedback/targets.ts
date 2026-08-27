/**
 * The registry of parts of the interface a report can point at.
 *
 * A report that says "the dropdown doesn't work" costs a maintainer an
 * afternoon. A report that says `content-source-creature-editor` costs them a
 * grep. That difference is the whole reason this file exists, and it is why
 * ids are declared here once rather than typed at each call site: a registry
 * can be checked, sorted and searched, and a string literal scattered through
 * forty components cannot.
 *
 * Ids never describe where something sits on screen. `div:nth-child(4) > input`
 * identifies a position in a layout, which is exactly the thing that changes
 * when somebody fixes the bug being reported. An id names *what the control
 * is*, so it survives the redesign that follows the report.
 *
 * ## Naming rules
 *
 * - lowercase kebab-case, ASCII only
 * - prefixed with its area, so an id sorts next to its neighbours
 * - singular for a control, plural only for a whole collection
 * - no indices, no ordinals, no ids of project entities — a rule's own id is
 *   volatile context, not part of the component's identity
 *
 * ## Adding one
 *
 * Add an entry to {@link FEEDBACK_TARGETS}, then spread `feedbackTarget("...")`
 * onto the element. TypeScript will not accept an id that is not registered,
 * and `targets.test.ts` checks the naming rules for every entry.
 */

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/**
 * The DOM attributes a target carries.
 *
 * Data attributes rather than a React context, because the inspector resolves
 * whatever is under the pointer — including elements rendered by a portal into
 * a completely different part of the tree, where a context provider above the
 * hovered node says nothing about what is visually under the cursor.
 */
export const FEEDBACK_ATTR = {
  id: "data-feedback-id",
  name: "data-feedback-name",
  area: "data-feedback-area",
  context: "data-feedback-context",
  /** Stable visible label supplied by the shared Field wrapper. */
  fieldName: "data-feedback-field-name",
  /** Marks a subtree the inspector must never offer, e.g. its own chrome. */
  ignore: "data-feedback-ignore",
} as const;

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

/**
 * A section of the application, as an administrator would name it.
 *
 * The area is what becomes the `area:` label on the issue and what the
 * duplicate search narrows by, so the list is deliberately coarse — one entry
 * per place somebody would say they were when it went wrong.
 */
export interface FeedbackArea {
  slug: string;
  label: string;
  /** Where the area lives, for a maintainer reading the issue. */
  route: string;
}

export const FEEDBACK_AREAS = {
  app: { slug: "app", label: "Application", route: "" },
  overview: { slug: "overview", label: "Overview", route: "/overview" },
  "production-rules": {
    slug: "production-rules",
    label: "Production Rules",
    route: "/production",
  },
  "passive-production": {
    slug: "passive-production",
    label: "Passive Production Simulator",
    route: "/simulator",
  },
  "content-sources": {
    slug: "content-sources",
    label: "Content Sources",
    route: "/content",
  },
  "spawn-commands": {
    slug: "spawn-commands",
    label: "Spawn Commands",
    route: "/content",
  },
  "creature-remaps": {
    slug: "creature-remaps",
    label: "Creature Remaps",
    route: "/remaps",
  },
  curseforge: { slug: "curseforge", label: "CurseForge", route: "/curseforge" },
  publishing: { slug: "publishing", label: "Publishing", route: "/publish" },
  settings: { slug: "settings", label: "Settings", route: "/settings" },
  github: { slug: "github", label: "GitHub", route: "/settings/github" },
  "player-data": {
    slug: "player-data",
    label: "Player Data",
    route: "/players",
  },
  "project-home": {
    slug: "project-home",
    label: "Welcome Screen",
    route: "/",
  },
  feedback: { slug: "feedback", label: "Feedback", route: "" },
} as const satisfies Record<string, FeedbackArea>;

export type FeedbackAreaSlug = keyof typeof FEEDBACK_AREAS;

export const FEEDBACK_AREA_SLUGS = Object.keys(
  FEEDBACK_AREAS,
) as FeedbackAreaSlug[];

export function areaLabel(slug: string): string {
  return (FEEDBACK_AREAS as Record<string, FeedbackArea>)[slug]?.label ?? "";
}

export function isKnownArea(slug: string): slug is FeedbackAreaSlug {
  return Object.prototype.hasOwnProperty.call(FEEDBACK_AREAS, slug);
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface FeedbackTargetDefinition {
  /** What an administrator would call it out loud. */
  name: string;
  area: FeedbackAreaSlug;
}

/**
 * Every component a report can name.
 *
 * Not every element in the app — an inspector that highlights `<span>`s is a
 * developer tool, not a reporting aid. What is registered is the set of places
 * a bug actually gets noticed: the editors, the pickers, the things with state.
 */
export const FEEDBACK_TARGETS = {
  // --- Application shell -------------------------------------------------
  "app-shell": { name: "Application Shell", area: "app" },
  // --- Overview ----------------------------------------------------------
  overview: { name: "Overview", area: "overview" },
  "overview-health-summary": { name: "Project Health", area: "overview" },
  "overview-production-summary": {
    name: "Production Rules Summary",
    area: "overview",
  },
  "overview-remaps-summary": { name: "Creature Remaps Summary", area: "overview" },
  "overview-cosmetics-summary": { name: "Cosmetics Summary", area: "overview" },
  "overview-watched-mods-summary": { name: "Watched Mods Summary", area: "overview" },
  "overview-content-sources-summary": {
    name: "Content Sources Summary",
    area: "overview",
  },
  "overview-publishing-summary": { name: "Publishing Summary", area: "overview" },
  "overview-publishing-destination": {
    name: "Publishing Destination",
    area: "overview",
  },
  "overview-output-production": { name: "Passive Production Output", area: "overview" },
  "overview-output-remaps": { name: "Creature Type Remaps Output", area: "overview" },
  "overview-output-cosmetics": { name: "Custom Cosmetics Output", area: "overview" },
  "overview-output-viewer-data": { name: "Cluster Viewer Data Output", area: "overview" },
  "overview-output-viewer-page": { name: "Cluster Viewer Page Output", area: "overview" },
  "overview-output-players": { name: "Player Data Output", area: "overview" },
  "overview-attention-card": { name: "Needs Attention", area: "overview" },
  "overview-next-actions": { name: "Overview Actions", area: "overview" },
  "overview-recent-activity": { name: "Recent Activity", area: "overview" },
  // --- Production Rules --------------------------------------------------
  "production-rules": { name: "Production Rules", area: "production-rules" },
  "production-rule-card": { name: "Creature Rule", area: "production-rules" },
  "production-rule-cycle-editor": {
    name: "Production Cycle Editor",
    area: "production-rules",
  },
  "production-rule-cycle-quantity": {
    name: "Production Cycle Quantity",
    area: "production-rules",
  },
  "production-rule-cycle-interval": {
    name: "Production Cycle Interval",
    area: "production-rules",
  },
  // --- Simulator ---------------------------------------------------------
  "passive-production-simulator": {
    name: "Passive Production Simulator",
    area: "passive-production",
  },
  "passive-production-simulator-count": {
    name: "Creature Count",
    area: "passive-production",
  },
  // --- Content Sources ---------------------------------------------------
  "content-sources": { name: "Content Sources", area: "content-sources" },
  "content-source-creature-editor": {
    name: "Creature Editor",
    area: "content-sources",
  },
  "content-source-item-editor": {
    name: "Item Editor",
    area: "content-sources",
  },
  // --- Spawn commands ----------------------------------------------------
  "spawn-command-color-selector": {
    name: "Spawn Command Color Selector",
    area: "spawn-commands",
  },
  // --- Creature Remaps ---------------------------------------------------
  "creature-remaps": { name: "Creature Remaps", area: "creature-remaps" },
  // --- CurseForge --------------------------------------------------------
  curseforge: { name: "CurseForge", area: "curseforge" },
  // --- Publishing --------------------------------------------------------
  publishing: { name: "Publish", area: "publishing" },
  "publish-site-card": { name: "Public Site", area: "publishing" },
  // --- Settings ----------------------------------------------------------
  "settings-nav": { name: "Settings Categories", area: "settings" },
  "settings-project": { name: "Project Settings", area: "settings" },
  "settings-maps": { name: "Cluster Maps", area: "settings" },
  "settings-modules": { name: "Optional Pages", area: "settings" },
  "settings-publishing": { name: "Publishing Settings", area: "settings" },
  "settings-defaults": { name: "Rule Defaults", area: "settings" },
  "settings-simulator": { name: "Simulator Defaults", area: "settings" },
  "settings-discord": { name: "Discord Settings", area: "settings" },
  "settings-feedback": { name: "Feedback Settings", area: "settings" },

  // --- GitHub ------------------------------------------------------------
  "github-setup": { name: "GitHub Setup", area: "github" },
  "github-account": { name: "GitHub Account", area: "github" },
  "project-access": { name: "Project Access", area: "github" },
  "github-repository": { name: "Project Repository", area: "github" },
  "player-data": { name: "Player Data", area: "player-data" },
  "project-home": { name: "Welcome Screen", area: "project-home" },
  "feedback-center": { name: "Feedback Center", area: "feedback" },
} as const satisfies Record<string, FeedbackTargetDefinition>;

export type FeedbackTargetId = keyof typeof FEEDBACK_TARGETS;

export const FEEDBACK_TARGET_IDS = Object.keys(
  FEEDBACK_TARGETS,
) as FeedbackTargetId[];

/** The registered definition for an id, or null when it is not one of ours. */
export function targetDefinition(id: string): FeedbackTargetDefinition | null {
  return (
    (FEEDBACK_TARGETS as Record<string, FeedbackTargetDefinition>)[id] ?? null
  );
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * What a component may attach beyond its identity.
 *
 * Values are scalars, and they go through {@link sanitizeTargetContext} before
 * they reach the DOM. The alternative — an arbitrary object, serialized on the
 * way out — is how a creature's whole record, or an administrator's cluster
 * name, ends up in a public issue because somebody passed the wrong variable.
 */
export type TargetContextInput = Record<
  string,
  string | number | boolean | null | undefined
>;

/** How many context entries one target may carry. */
export const MAX_CONTEXT_ENTRIES = 4;
/** How long one context value may be, in characters. */
export const MAX_CONTEXT_VALUE = 60;
/** How long one context key may be. */
export const MAX_CONTEXT_KEY = 24;

/**
 * Context keys a target is allowed to use.
 *
 * An allowlist rather than a length check, because the risk is not a long
 * value — it is a well-meaning key like `path` or `webhook` whose value is
 * never safe to publish. A key that is not here is dropped, and
 * `targets.test.ts` asserts the obvious dangerous ones stay out.
 */
export const ALLOWED_CONTEXT_KEYS = [
  // Entity names are deliberately absent. A creature, item, rule, source or
  // map name is project content, even when it happens to be useful context.
  "category",
  "field",
  "tab",
  "kind",
  "count",
  "index",
  "state",
] as const;

export type AllowedContextKey = (typeof ALLOWED_CONTEXT_KEYS)[number];

const ALLOWED_CONTEXT_SET: ReadonlySet<string> = new Set(ALLOWED_CONTEXT_KEYS);

export function isAllowedContextKey(key: string): key is AllowedContextKey {
  return ALLOWED_CONTEXT_SET.has(key);
}

// ---------------------------------------------------------------------------
// The helper components use
// ---------------------------------------------------------------------------

/** The props {@link feedbackTarget} produces, ready to spread onto an element. */
export interface FeedbackTargetProps {
  "data-feedback-id": string;
  "data-feedback-name": string;
  "data-feedback-area": string;
  "data-feedback-context"?: string;
}

/**
 * Marks an element as reportable.
 *
 * ```tsx
 * <div {...feedbackTarget("production-rule-cycle-quantity", { index })}>
 * ```
 *
 * The name and area come from the registry rather than the call site, so the
 * two can never disagree, and renaming a component is a one-line change here
 * rather than a search for every place that spelled it out.
 */
export function feedbackTarget(
  id: FeedbackTargetId,
  context?: TargetContextInput,
): FeedbackTargetProps {
  const definition = FEEDBACK_TARGETS[id] as FeedbackTargetDefinition;
  const props: FeedbackTargetProps = {
    "data-feedback-id": id,
    "data-feedback-name": definition.name,
    "data-feedback-area": definition.area,
  };
  const safe = context ? sanitizeTargetContext(context) : {};
  if (Object.keys(safe).length > 0) {
    props["data-feedback-context"] = JSON.stringify(safe);
  }
  return props;
}

/** Marks a subtree the inspector must skip — the Feedback Center's own UI. */
export const FEEDBACK_IGNORE = { "data-feedback-ignore": "true" } as const;

// ---------------------------------------------------------------------------
// Context sanitization
// ---------------------------------------------------------------------------

/**
 * Reduces a component's context to something safe to publish.
 *
 * Four rules, in order: the key must be on the allowlist, the value must be a
 * scalar, the value is trimmed to a short string, and anything credential- or
 * path-shaped is dropped entirely rather than truncated. Dropped rather than
 * masked, because a masked path still says how somebody's drive is laid out.
 */
export function sanitizeTargetContext(
  context: TargetContextInput,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(context)) {
    if (Object.keys(out).length >= MAX_CONTEXT_ENTRIES) break;
    const key = rawKey.trim();
    if (key.length === 0 || key.length > MAX_CONTEXT_KEY) continue;
    if (!isAllowedContextKey(key)) continue;
    if (rawValue === null || rawValue === undefined) continue;
    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      continue;
    }
    const value = String(rawValue).replace(/\s+/g, " ").trim();
    if (value.length === 0) continue;
    if (looksUnsafeToPublish(value)) continue;
    out[key] = value.slice(0, MAX_CONTEXT_VALUE);
  }
  return out;
}

/**
 * Whether a value is one this system refuses to carry at all.
 *
 * Deliberately blunt. A creature's name never contains a drive letter or a
 * URL, so a value that does is a variable somebody passed by mistake, and
 * dropping it costs a maintainer one line of context rather than costing an
 * administrator their webhook.
 */
export function looksUnsafeToPublish(value: string): boolean {
  const text = value.toLowerCase();
  if (text.includes("://")) return true;
  if (text.includes("github_pat_") || /\bgh[pousr]_/.test(text)) return true;
  if (/^[a-z]:[/\\]/.test(text)) return true;
  if (text.startsWith("\\\\")) return true;
  if (text.includes("/users/") || text.includes("\\users\\")) return true;
  if (/(token|secret|password|apikey|api_key|webhook|bearer)/.test(text)) {
    return true;
  }
  return false;
}

/**
 * Reads a context attribute back off the DOM.
 *
 * Re-sanitized on the way in as well as on the way out: the attribute is a
 * string in a document, and by the time the inspector reads it there is no
 * guarantee it is the one `feedbackTarget` wrote.
 */
export function parseTargetContext(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return sanitizeTargetContext(parsed as TargetContextInput);
  } catch {
    return {};
  }
}
