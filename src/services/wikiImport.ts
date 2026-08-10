import { ipc } from "./ipc";
import {
  CatalogIndex,
  CatalogEntry,
  ContentSource,
  normalizeBpPath,
} from "../model/catalog";
import {
  CreatureInfo,
  CreatureInfoSchema,
  INFO_SECTIONS,
  MethodOutcome,
  MethodTag,
  emptyCreatureInfo,
  emptyMethod,
  emptyPhase,
} from "../model/creatureInfo";
import {
  ImportGame,
  ImportRecord,
  ImportRecordSchema,
  UnresolvedRef,
} from "../model/creatureImport";
import { CREATURE_FIXTURES, CreatureFixture } from "../model/creatureInfoFixtures";

/**
 * Wiki import.
 *
 * Reads a creature's page from the ARK Official Community Wiki through the
 * documented MediaWiki `action=parse` endpoint and proposes an acquisition
 * record from it. Everything it produces is a *proposal* — see
 * model/creatureImport.ts for the staging model and the review rules.
 *
 * The importer deliberately does very little inference. Wikitext prose is not
 * a schema, and a plausible-looking guess that a reviewer waves through is
 * worse than an explicit "I couldn't tell". So: anything read directly is
 * mapped, anything inferred is recorded as an ambiguity, and any name that
 * doesn't resolve against the catalog is reported rather than dropped.
 */

export const WIKI_HOST = "ark.wiki.gg";

/** Index page used to classify creatures before opening their own pages. */
export const TAMING_INDEX_PAGE = "Taming";

export interface WikiPage {
  page: string;
  wikitext: string;
  revisionId: number;
  url: string;
}

export async function fetchWikiPage(
  page: string,
  host = WIKI_HOST,
): Promise<WikiPage> {
  return ipc<WikiPage>("wiki_fetch_page", { host, page });
}

// ---------------------------------------------------------------------------
// Wikitext handling
// ---------------------------------------------------------------------------

/** Section headings whose content is worth extracting, in priority order. */
const WANTED_SECTIONS = [
  "Taming",
  "Taming Strategy",
  "Strategy",
  "Domesticated",
  "Utility",
  "Combat",
  "Notes",
  "Notes/Trivia",
];

/**
 * Splits wikitext into `heading -> body`. MediaWiki headings are `== Name ==`
 * at any level; sub-sections are folded into their parent so a reviewer sees
 * the whole "Taming" block rather than three fragments.
 */
export function extractSections(wikitext: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = wikitext.split(/\r?\n/);

  let current = "Lead";
  let currentLevel = 1;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) out[current] = out[current] ? `${out[current]}\n\n${body}` : body;
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (!heading) {
      buffer.push(line);
      continue;
    }
    const level = heading[1].length;
    const name = heading[2].trim();
    // A deeper heading stays inside the section it belongs to.
    if (level > currentLevel && current !== "Lead") {
      buffer.push(`\n${name}:`);
      continue;
    }
    flush();
    current = name;
    currentLevel = level;
  }
  flush();
  return out;
}

/** The section a creature's acquisition information lives in, if present. */
export function pickAcquisitionSection(
  sections: Record<string, string>,
): { name: string; text: string } | null {
  for (const wanted of WANTED_SECTIONS) {
    const key = Object.keys(sections).find(
      (k) => k.toLowerCase() === wanted.toLowerCase(),
    );
    if (key && sections[key].trim()) return { name: key, text: sections[key] };
  }
  return null;
}

/** A name the wiki linked to, with the markup it came from. */
export interface WikiRef {
  name: string;
  /** `item` when the markup names it as one, `creature` likewise, else unknown. */
  kind: "item" | "creature" | "unknown";
}

const REF_PATTERNS: { re: RegExp; kind: WikiRef["kind"]; group: number }[] = [
  // {{ItemLink|Raw Meat}} / {{Item|Narcotic|30}}
  { re: /\{\{\s*Item(?:Link)?\s*\|\s*([^|}]+)/gi, kind: "item", group: 1 },
  // {{DinoLink|Rex}} / {{Creature|Rex}}
  { re: /\{\{\s*(?:Dino|Creature)Link\s*\|\s*([^|}]+)/gi, kind: "creature", group: 1 },
  // [[Raw Meat]] and [[Raw Meat|meat]]
  { re: /\[\[\s*([^\]|#]+)/g, kind: "unknown", group: 1 },
];

/** Every linked name in a block of wikitext, de-duplicated, order preserved. */
export function collectRefs(wikitext: string): WikiRef[] {
  const seen = new Map<string, WikiRef>();
  for (const { re, kind, group } of REF_PATTERNS) {
    // Fresh lastIndex per call — these are module-level /g regexes.
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(wikitext))) {
      const name = m[group].trim();
      if (!name || name.includes(":")) continue; // File:, Category:, etc.
      const key = name.toLowerCase();
      const prior = seen.get(key);
      // A typed link beats an untyped [[…]] for the same name.
      if (!prior || (prior.kind === "unknown" && kind !== "unknown")) {
        seen.set(key, { name, kind });
      }
    }
  }
  return [...seen.values()];
}

/**
 * Wikitext to readable prose. Not a full parser — enough that a reviewer can
 * read the original text beside the proposal without markup in the way.
 */
export function stripMarkup(wikitext: string): string {
  return wikitext
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{\s*(?:Item|Dino|Creature)(?:Link)?\s*\|\s*([^|}]+)[^}]*\}\}/gi, "$1")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/'''''|'''|''/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Wikitext split into the sentences/bullets a reviewer would call steps. */
export function toSteps(wikitext: string): string[] {
  return stripMarkup(wikitext)
    .split(/\n+/)
    .map((line) => line.replace(/^[*#:;]+\s*/, "").trim())
    .filter((line) => line.length > 2 && !line.startsWith("|") && !line.endsWith("|"))
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Phrases that identify a method, strongest signal first. Only the wiki's own
 * vocabulary — these are the words the Taming index and creature pages
 * actually use, not synonyms someone might have written.
 */
const TAG_SIGNALS: { tag: MethodTag; patterns: RegExp[] }[] = [
  { tag: "knockout", patterns: [/\bknock(?:ed|ing|s)? ?out\b/i, /\btorpor\b/i, /\btranquiliz/i] },
  { tag: "passive", patterns: [/\bpassive(?:ly)? tam/i, /\bfeed it\b/i, /\bhand ?feed/i] },
  { tag: "trust", patterns: [/\btrust\b/i] },
  { tag: "mounted", patterns: [/\bwhile mounted\b/i, /\bfrom (?:the back of|atop)\b/i] },
  { tag: "minigame", patterns: [/\bmini-?game\b/i] },
  {
    tag: "combat-assist",
    patterns: [/\bassist(?:ing)? it\b/i, /\bhelp(?:ing)? it fight\b/i, /\bfight(?:ing)? alongside\b/i],
  },
  { tag: "egg-theft", patterns: [/\bsteal(?:ing)? (?:an? )?egg/i, /\bnest\b.*\begg\b/i] },
  { tag: "wild-baby", patterns: [/\bwild bab(?:y|ies)\b/i, /\bclaim(?:ing)? (?:the |a )?bab/i] },
  { tag: "impregnation", patterns: [/\bimpregnat/i, /\bgestat/i, /\bhost creature\b/i] },
  { tag: "environmental", patterns: [/\bmust be (?:in|near)\b/i, /\bonly (?:in|during)\b/i] },
  { tag: "temporary", patterns: [/\btemporar(?:y|ily)\b/i, /\breverts? to wild\b/i] },
];

/** Outcome phrases. Same rule: only what the wiki states outright. */
const OUTCOME_SIGNALS: { outcome: MethodOutcome; patterns: RegExp[] }[] = [
  { outcome: "claim", patterns: [/\bclaim(?:ed|ing)?\b/i] },
  { outcome: "hatch-and-raise", patterns: [/\bhatch/i, /\bincubat/i, /\braise(?:d)? from a bab/i] },
  { outcome: "birth-from-host", patterns: [/\bborn from\b/i, /\bimpregnat/i] },
  { outcome: "temporary-control", patterns: [/\btemporar(?:y|ily) tam/i, /\breverts? to wild\b/i] },
  { outcome: "craft-and-assemble", patterns: [/\bcrafted\b/i, /\bassembled\b/i, /\bfabricator\b/i] },
  { outcome: "reward", patterns: [/\bdefeating the\b.*\bboss\b/i, /\bmission reward\b/i] },
  { outcome: "direct-tame", patterns: [/\btaming effectiveness\b/i, /\btaming bar\b/i, /\bknock(?:ed|ing|s)? ?out\b/i] },
];

const UNAVAILABLE_SIGNALS = [
  /\bcannot be tamed\b/i,
  /\bnot tam(?:e)?able\b/i,
  /\buntam(?:e)?able\b/i,
  /\bcannot be (?:tamed|claimed|acquired)\b/i,
];

export interface Classification {
  availability: CreatureInfo["availability"];
  outcome: MethodOutcome | "";
  tags: MethodTag[];
  ambiguities: string[];
}

/** Reads what the text states; records what it had to infer or couldn't tell. */
export function classify(text: string): Classification {
  const ambiguities: string[] = [];

  if (UNAVAILABLE_SIGNALS.some((re) => re.test(text))) {
    return { availability: "unavailable", outcome: "", tags: [], ambiguities };
  }

  const tags = TAG_SIGNALS.filter((s) => s.patterns.some((re) => re.test(text))).map(
    (s) => s.tag,
  );
  const outcomes = OUTCOME_SIGNALS.filter((s) =>
    s.patterns.some((re) => re.test(text)),
  ).map((s) => s.outcome);

  if (tags.length === 0) {
    ambiguities.push("No taming method could be identified from the text — set the tags by hand.");
  }
  if (tags.length > 2) {
    ambiguities.push(
      `Text matches several methods (${tags.join(", ")}) — this may be more than one route, which the importer will not split on its own.`,
    );
  }
  if (outcomes.length === 0) {
    ambiguities.push("The text does not state what the route leaves you with — set the outcome by hand.");
  } else if (outcomes.length > 1) {
    ambiguities.push(
      `Conflicting outcomes in the text (${outcomes.join(", ")}) — the first was proposed, confirm it.`,
    );
  }

  return {
    availability: "acquirable",
    outcome: outcomes[0] ?? "",
    tags,
    ambiguities,
  };
}

/**
 * Which game the page's information applies to. The wiki covers ASE and ASA
 * together, so an ASE-only creature must never be proposed as ASA content
 * without saying so.
 */
export function detectGame(wikitext: string): ImportGame {
  const asa = /\{\{\s*ASA\s*[|}]/i.test(wikitext) || /Survival Ascended/i.test(wikitext);
  const ase = /\{\{\s*ASE\s*[|}]/i.test(wikitext) || /Survival Evolved/i.test(wikitext);
  if (/\bnot (?:yet )?(?:available|released) in\b.*Ascended/i.test(wikitext)) return "ASE";
  if (asa && ase) return "both";
  if (asa) return "ASA";
  if (ase) return "ASE";
  return "unknown";
}

/** The mod a page belongs to, from a `Mod:<Name>/<Creature>` title. */
export function detectMod(page: string): string {
  const m = /^Mod:([^/]+)/.exec(page);
  return m ? m[1].trim() : "";
}

// ---------------------------------------------------------------------------
// Catalog resolution
// ---------------------------------------------------------------------------

export interface NameIndex {
  creatures: Map<string, CatalogEntry>;
  items: Map<string, CatalogEntry>;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Name -> catalog entry, for resolving what the wiki links to. */
export function buildNameIndex(sources: ContentSource[]): NameIndex {
  const creatures = new Map<string, CatalogEntry>();
  const items = new Map<string, CatalogEntry>();
  for (const source of sources) {
    for (const entry of source.creatures) {
      const key = normalizeName(entry.name);
      if (!creatures.has(key)) creatures.set(key, entry);
    }
    for (const entry of source.items) {
      const key = normalizeName(entry.name);
      if (!items.has(key)) items.set(key, entry);
    }
  }
  return { creatures, items };
}

export interface ResolvedRef {
  /** Empty when nothing matched — the caller keeps the name as free text. */
  bpPath: string;
  referenceType: "item" | "creature" | "text";
}

/**
 * Resolves a linked name against the catalogs.
 *
 * An untyped `[[…]]` is looked up in both; a name that exists in both is left
 * unresolved rather than guessed at, because picking the wrong catalog silently
 * produces a record that looks right and isn't.
 */
export function resolveRef(ref: WikiRef, index: NameIndex): ResolvedRef {
  const key = normalizeName(ref.name);
  const asItem = index.items.get(key);
  const asCreature = index.creatures.get(key);

  if (ref.kind === "item") {
    return asItem
      ? { bpPath: asItem.bpPath, referenceType: "item" }
      : { bpPath: "", referenceType: "text" };
  }
  if (ref.kind === "creature") {
    return asCreature
      ? { bpPath: asCreature.bpPath, referenceType: "creature" }
      : { bpPath: "", referenceType: "text" };
  }
  if (asItem && asCreature) return { bpPath: "", referenceType: "text" };
  if (asItem) return { bpPath: asItem.bpPath, referenceType: "item" };
  if (asCreature) return { bpPath: asCreature.bpPath, referenceType: "creature" };
  return { bpPath: "", referenceType: "text" };
}

/** Catalog-backed references in an already-built record that no longer resolve. */
export function findStaleRefs(info: CreatureInfo, index: CatalogIndex): UnresolvedRef[] {
  const out: UnresolvedRef[] = [];
  for (const method of info.methods) {
    for (const input of method.inputs) {
      if (input.referenceType === "text" || !input.bpPath) continue;
      const kind = input.referenceType === "creature" ? "creatures" : "items";
      if (!index[kind].has(normalizeBpPath(input.bpPath))) {
        out.push({
          kind: input.referenceType,
          name: input.label || input.bpPath,
          where: `${method.name || "method"} → inputs`,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Record construction
// ---------------------------------------------------------------------------

let idSeq = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${++idSeq}`;
}

export interface BuildOptions {
  /** Catalogs the references are resolved against. */
  nameIndex: NameIndex;
  /** Creature catalog, for matching the page title to a blueprint path. */
  creatureIndex: NameIndex["creatures"];
  /**
   * Variant parent lookup: normalized child path -> parent path, plus the info
   * already recorded for the parent. Used to avoid proposing a record for a
   * variant that would only duplicate what it already inherits.
   */
  variantParents?: Record<string, string>;
  creatureInfo?: Record<string, CreatureInfo>;
}

/** Turns one fetched page into a staged proposal. */
export function buildImportRecord(page: WikiPage, opts: BuildOptions): ImportRecord {
  const sections = extractSections(page.wikitext);
  const picked = pickAcquisitionSection(sections);
  const sourceText = picked?.text ?? "";
  const plain = stripMarkup(sourceText);

  const creatureName = page.page.split("/").pop() ?? page.page;
  const catalogEntry = opts.creatureIndex.get(normalizeName(creatureName));
  const bpPath = catalogEntry?.bpPath ?? "";

  const ambiguities: string[] = [];
  const unresolved: UnresolvedRef[] = [];

  if (!picked) {
    ambiguities.push(
      `No taming or acquisition section found on "${page.page}" — nothing was proposed for acquisition.`,
    );
  }
  if (!catalogEntry) {
    ambiguities.push(
      `"${creatureName}" does not match any creature in the catalog — set the target before accepting.`,
    );
  }

  const classification = classify(plain);
  ambiguities.push(...classification.ambiguities);

  const info: CreatureInfo = emptyCreatureInfo();

  if (picked && classification.availability !== "unavailable") {
    info.availability = "acquirable";
    const method = emptyMethod(nextId("m"), methodNameFor(classification));
    method.outcome = classification.outcome;
    method.tags = classification.tags;

    const steps = toSteps(sourceText);
    if (steps.length > 0) {
      method.phases = [
        { ...emptyPhase(nextId("ph"), "From the wiki"), steps: steps.map((text) => ({ id: nextId("st"), text })) },
      ];
    }

    for (const ref of collectRefs(sourceText)) {
      const resolved = resolveRef(ref, opts.nameIndex);
      if (resolved.referenceType === "text") {
        // Only report names that were *meant* to be catalog content.
        if (ref.kind !== "unknown") {
          unresolved.push({ kind: ref.kind, name: ref.name, where: `${picked.name} section` });
        }
        continue;
      }
      method.inputs.push({
        id: nextId("in"),
        referenceType: resolved.referenceType,
        bpPath: resolved.bpPath,
        label: ref.name,
        // Role is never inferred — "it appears in the taming section" does not
        // make something taming food.
        role: "taming-food",
        qty: "",
        note: "",
      });
    }
    if (method.inputs.length > 0) {
      ambiguities.push(
        `${method.inputs.length} input(s) were read from links and all defaulted to "Taming food" — set each role before accepting.`,
      );
    }
    info.methods = [method];
  } else if (classification.availability === "unavailable") {
    info.availability = "unavailable";
  }

  // A variant that inherits everything gets flagged rather than duplicated.
  const parentPath = bpPath
    ? opts.variantParents?.[normalizeBpPath(bpPath)]
    : undefined;
  const parentInfo = parentPath
    ? opts.creatureInfo?.[normalizeBpPath(parentPath)]
    : undefined;
  const duplicatesParent = Boolean(parentInfo && sameAcquisition(parentInfo, info));
  if (duplicatesParent) {
    ambiguities.push(
      "This creature already inherits an identical acquisition record from its parent — accepting would duplicate it.",
    );
  }

  return ImportRecordSchema.parse({
    id: nextId("imp"),
    bpPath,
    creatureName,
    status: "pending",
    source: {
      page: page.page,
      section: picked?.name ?? "",
      url: page.url,
      revisionId: page.revisionId,
      revisionTimestamp: "",
      importedAt: new Date().toISOString(),
      game: detectGame(page.wikitext),
      mod: detectMod(page.page),
    },
    rawText: picked ? { [picked.name]: sourceText } : {},
    proposed: info,
    unresolved,
    ambiguities,
    // Everything the importer produces is inferred to some degree; only a
    // record with no ambiguities and no unresolved names skips the warning.
    confidence: ambiguities.length === 0 && unresolved.length === 0 ? "high" : "needs-review",
    duplicatesParent,
    reviewNote: "",
    reviewedAt: null,
  });
}

function methodNameFor(c: Classification): string {
  if (c.tags.length === 0) return "Acquisition (from wiki)";
  const first = c.tags[0];
  return first.charAt(0).toUpperCase() + first.slice(1).replace(/-/g, " ");
}

/** Whether two records describe the same acquisition, ignoring ids. */
function sameAcquisition(a: CreatureInfo, b: CreatureInfo): boolean {
  if (a.availability !== b.availability) return false;
  if (a.methods.length !== b.methods.length) return false;
  return a.methods.every((m, i) => {
    const other = b.methods[i];
    return (
      m.name === other.name &&
      m.outcome === other.outcome &&
      m.tags.join() === other.tags.join() &&
      m.phases.flatMap((p) => p.steps.map((s) => s.text)).join("|") ===
        other.phases.flatMap((p) => p.steps.map((s) => s.text)).join("|")
    );
  });
}

// ---------------------------------------------------------------------------
// Fixture import
// ---------------------------------------------------------------------------

/**
 * Stages the verified fixture set instead of fetching.
 *
 * This is the validation path: the fixtures were written from real pages at
 * recorded revisions and already cover every availability, outcome, tag, input
 * type and the inheritance case, so running them through the same staging,
 * review and persistence code proves the pipeline without importing hundreds
 * of creatures. It is also offline and deterministic, which live fetching
 * never is.
 */
export function importFixtures(
  fixtures: CreatureFixture[] = CREATURE_FIXTURES,
  opts?: Partial<BuildOptions> & { catalogIndex?: CatalogIndex },
): ImportRecord[] {
  const now = new Date().toISOString();
  return fixtures.map((fixture) => {
    const proposed = CreatureInfoSchema.parse(fixture.info) as CreatureInfo;

    const unresolved = opts?.catalogIndex
      ? findStaleRefs(proposed, opts.catalogIndex)
      : [];

    const ambiguities: string[] = [];
    if (fixture.bpPath && opts?.catalogIndex) {
      if (!opts.catalogIndex.creatures.has(normalizeBpPath(fixture.bpPath))) {
        ambiguities.push(
          `${fixture.name} is not in the catalog — the record has nowhere to attach.`,
        );
      }
    }

    // A fixture that overrides nothing is the inheritance case: it is meant to
    // stay empty, so staging it as a proposal would be exactly the duplication
    // the importer is supposed to avoid.
    const inheritsEverything =
      proposed.overrides.length === 0 &&
      proposed.methods.length === 0 &&
      !proposed.availability;

    return ImportRecordSchema.parse({
      id: nextId("imp"),
      bpPath: fixture.bpPath,
      creatureName: fixture.name,
      status: "pending",
      source: {
        page: fixture.source.page,
        section: "Taming",
        url: `https://${WIKI_HOST}/wiki/${fixture.source.page.replace(/ /g, "_")}`,
        revisionId: fixture.source.revisionId,
        revisionTimestamp: "",
        importedAt: now,
        game: fixture.source.game,
        mod: fixture.source.mod ?? "",
      },
      rawText: { Taming: `Verified fixture — covers: ${fixture.covers}` },
      proposed,
      unresolved,
      ambiguities,
      // Fixtures were transcribed by hand from a recorded revision, so unlike
      // parsed pages they start trustworthy — but still not applied unreviewed.
      confidence: unresolved.length === 0 && ambiguities.length === 0 ? "high" : "needs-review",
      duplicatesParent: inheritsEverything,
      reviewNote: "",
      reviewedAt: null,
    });
  });
}

/** Sections a record actually proposes anything for — drives the review list. */
export function proposedSections(record: ImportRecord): string[] {
  const info = record.proposed;
  return INFO_SECTIONS.filter((section) => {
    switch (section) {
      case "acquisition":
        return Boolean(info.availability || info.methods.length);
      case "abilities":
        return info.abilities.length > 0;
      case "technical":
        return info.technical.dragWeight !== null;
      case "notes":
        return Boolean(info.notes.trim());
    }
  });
}
