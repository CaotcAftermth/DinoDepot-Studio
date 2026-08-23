import {
  FEEDBACK_ATTR,
  areaLabel,
  looksUnsafeToPublish,
  parseTargetContext,
  sanitizeTargetContext,
  targetDefinition,
} from "./targets";
import type { FeedbackTargetSnapshot } from "./types";

/**
 * Turning "the thing under the pointer" into "the thing the report is about".
 *
 * The element the mouse is actually over is almost never the answer: it is a
 * `<span>` holding a number, or the SVG inside a button. What the reporter
 * means is the nearest enclosing thing that has a name — so the search walks
 * *up*, and stops at the first registered target.
 *
 * ## Why this does not take an HTMLElement
 *
 * The walk is described against {@link TargetNode}, which is the two members
 * it actually uses. A real `HTMLElement` satisfies it, so nothing changes at
 * the call site — but the algorithm can then be exercised with plain objects,
 * which matters because this project's test runner has no DOM. Resolution
 * order is the part of the Feedback Center most likely to be wrong and least
 * likely to be noticed, so it is the part that most needs tests.
 */

/** The slice of an element this module needs. `HTMLElement` satisfies it. */
export interface TargetNode {
  getAttribute(name: string): string | null;
  readonly parentElement: TargetNode | null;
  /** Present on real DOM elements; optional so the resolver stays unit-testable. */
  readonly tagName?: string;
  readonly textContent?: string | null;
}

export interface ResolvedTarget<N extends TargetNode = TargetNode> {
  /** The element the highlight should be drawn around. */
  node: N;
  snapshot: FeedbackTargetSnapshot;
}

/** How far up the tree the walk will go before giving up. */
const MAX_DEPTH = 200;

/** Native controls and meaningful regions worth highlighting on their own. */
const SEMANTIC_TAGS = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "SUMMARY",
  "SECTION",
  "ARTICLE",
  "NAV",
]);

const SEMANTIC_ROLES = new Set([
  "alert",
  "button",
  "checkbox",
  "combobox",
  "dialog",
  "link",
  "listitem",
  "menuitem",
  "navigation",
  "option",
  "radio",
  "region",
  "row",
  "status",
  "switch",
  "tab",
  "textbox",
]);

function isSemanticNode(node: TargetNode): boolean {
  const tag = (node.tagName ?? "").toUpperCase();
  const role = (node.getAttribute("role") ?? "").toLowerCase();
  return SEMANTIC_TAGS.has(tag) || SEMANTIC_ROLES.has(role);
}

function fallbackName(node: TargetNode): string {
  const tag = (node.tagName ?? "").toUpperCase();
  const role = (node.getAttribute("role") ?? "").toLowerCase();
  if (role === "status") return "Status";
  if (role === "navigation" || tag === "NAV") return "Navigation";
  if (tag === "A" || role === "link") return "Link";
  if (tag === "INPUT" || tag === "TEXTAREA" || role === "textbox") return "Field";
  if (tag === "SELECT" || role === "combobox") return "Selection";
  if (tag === "SECTION" || tag === "ARTICLE" || role === "region") return "Section";
  return "Control";
}

/**
 * A stable, visible name for an unregistered semantic control.
 *
 * Input values are intentionally never read. Labels, titles, placeholders and
 * rendered button text describe the interface; a field value is project data.
 */
function semanticName(node: TargetNode): string {
  const candidates = [
    node.getAttribute("aria-label"),
    node.getAttribute("title"),
    node.getAttribute("placeholder"),
    node.textContent,
  ];
  for (const candidate of candidates) {
    const clean = String(candidate ?? "").replace(/\s+/g, " ").trim();
    if (!clean || looksUnsafeToPublish(clean)) continue;
    return clean.slice(0, 80);
  }
  return fallbackName(node);
}

function semanticSnapshot(
  node: TargetNode,
  base: FeedbackTargetSnapshot,
): FeedbackTargetSnapshot {
  const name = semanticName(node);
  const hierarchy = [...base.hierarchy];
  if (hierarchy[hierarchy.length - 1] !== name) hierarchy.push(name);
  return {
    ...base,
    name,
    hierarchy: hierarchy.slice(-6),
    context: sanitizeTargetContext({ ...base.context, field: name }),
  };
}

/**
 * Whether this node, or anything above it, is inside a subtree the inspector
 * must not offer.
 *
 * Checked upward rather than only on the node itself: the Feedback Center
 * marks its own root, and every control inside it inherits that by being under
 * it. Without this the inspector would happily let somebody file a bug against
 * the Cancel button of the form they are filing it from.
 */
export function isIgnored(node: TargetNode | null): boolean {
  let current = node;
  for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
    if (current.getAttribute(FEEDBACK_ATTR.ignore) !== null) return true;
    current = current.parentElement;
  }
  return false;
}

/**
 * The registered id on a node itself, if it carries one this build knows.
 *
 * An unregistered id is treated as absent rather than as a target with a
 * missing name: an id that is not in the registry came from an older build, a
 * hand-edited DOM, or a typo, and none of those should produce an issue
 * labelled with an area nobody can search for.
 */
function idOf(node: TargetNode): string | null {
  const id = node.getAttribute(FEEDBACK_ATTR.id);
  if (!id) return null;
  return targetDefinition(id) ? id : null;
}

/**
 * The friendly name for a node's target.
 *
 * The registry wins over the attribute. The attribute is what the running
 * build wrote and is normally identical, but a stale attribute — a portal
 * rendered before a hot reload, say — must not be able to put a name into an
 * issue that no longer matches the id beside it.
 */
function nameOf(node: TargetNode, id: string): string {
  return (
    targetDefinition(id)?.name ??
    node.getAttribute(FEEDBACK_ATTR.name) ??
    id
  );
}

function areaOf(node: TargetNode, id: string): string {
  return (
    targetDefinition(id)?.area ?? node.getAttribute(FEEDBACK_ATTR.area) ?? ""
  );
}

/**
 * The nearest reportable ancestor of `start`, with the trail of targets above
 * it.
 *
 * Returns null when there is nothing registered above the node, which is the
 * honest answer for the gap between two cards — the inspector shows no
 * highlight rather than snapping to whatever large container happens to be
 * nearby.
 */
export function findFeedbackTarget<N extends TargetNode>(
  start: N | null,
): ResolvedTarget<N> | null {
  if (!start || isIgnored(start)) return null;

  let node: TargetNode | null = start;
  let matched: TargetNode | null = null;
  let matchedId = "";
  let semantic: TargetNode | null = null;

  for (let depth = 0; node && depth < MAX_DEPTH; depth++) {
    if (!semantic && isSemanticNode(node)) semantic = node;
    const id = idOf(node);
    if (id) {
      matched = node;
      matchedId = id;
      break;
    }
    node = node.parentElement;
  }
  if (!matched) return null;

  const snapshot = snapshotFor(matched, matchedId);

  // Explicit instrumentation wins when it is on the semantic element itself.
  // Otherwise the registered ancestor supplies stable identity and area while
  // the actual control supplies the precise highlight and visible name.
  if (semantic && semantic !== matched) {
    return {
      node: semantic as N,
      snapshot: semanticSnapshot(semantic, snapshot),
    };
  }

  return {
    node: matched as N,
    snapshot,
  };
}

/**
 * Builds the report-ready record for a node already known to be a target.
 *
 * The hierarchy is collected from the match upward and then reversed, so it
 * reads the way somebody would describe where they were: the page first, the
 * control last.
 */
export function snapshotFor(
  node: TargetNode,
  id = idOf(node) ?? "",
): FeedbackTargetSnapshot {
  const name = nameOf(node, id);
  const area = areaOf(node, id);

  const trail: string[] = [];
  let current: TargetNode | null = node;
  for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
    const currentId = idOf(current);
    if (currentId) {
      const currentName = nameOf(current, currentId);
      // A wrapper that repeats its child's name adds a line and no
      // information; the page target and its own page card often collide
      // this way.
      if (trail[trail.length - 1] !== currentName) trail.push(currentName);
    }
    current = current.parentElement;
  }
  trail.reverse();

  // An area label at the front so the trail reads as a location even when the
  // page itself was never given a target of its own.
  const label = areaLabel(area);
  if (label && trail[0] !== label) trail.unshift(label);

  return {
    id,
    name,
    area,
    // Capped so a deeply nested editor cannot turn the issue's Affected Area
    // section into a paragraph. The innermost entries are the informative
    // ones, so an over-long trail loses its head, not its tail.
    hierarchy: trail.slice(-6),
    context: parseTargetContext(node.getAttribute(FEEDBACK_ATTR.context)),
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** The separator used everywhere a hierarchy is shown or written. */
export const TRAIL_SEPARATOR = " › ";

/**
 * The one-line form: `Production Rules › Creature Rule › Quantity`.
 *
 * Falls back to the component's own name when there is no trail, so this never
 * returns an empty string for a target that exists.
 */
export function targetBreadcrumb(
  target: FeedbackTargetSnapshot | null,
): string {
  if (!target) return "";
  if (target.hierarchy.length > 0) return target.hierarchy.join(TRAIL_SEPARATOR);
  return target.name;
}

/** Whether two resolutions point at the same component with the same context. */
export function sameTarget(
  a: FeedbackTargetSnapshot | null,
  b: FeedbackTargetSnapshot | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id) return false;
  return JSON.stringify(a.context) === JSON.stringify(b.context);
}
