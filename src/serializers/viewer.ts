import { CreatureRule, ProductionDraft } from "../model/production";
import {
  buildCatalogIndex,
  CatalogFile,
  normalizeBpPath,
} from "../model/catalog";
import {
  effectiveOfficialSource,
  fallbackIcon,
  officialCategories,
} from "../model/officialCatalog";
import { resolveCreatureBase, variantParent } from "../model/creatureBase";
import {
  AbilityEffect,
  AbilityKind,
  AVAILABILITY_LABELS,
  DROP_LISTS,
  DropListKey,
  effectShape,
  formatRate,
  InputRole,
  MethodOutcome,
  MethodTag,
  OUTCOME_LABELS,
  ROLE_LABELS,
  TAG_LABELS,
  hasCreatureInfo,
  methodLabel,
  phaseHasOutcomes,
  resolveCreatureInfo,
} from "../model/creatureInfo";
import { itemInfoOf } from "../model/itemInfo";
import { mapIsDisabled, mapOf } from "../model/maps";
import { flattenReferences, hasReferences } from "../model/references";
import type { ProjectSettings } from "../model/project";
import { buildImageIndex, matchImage, nameKey } from "../model/imageMatch";

/**
 * Cluster viewer data: a single self-contained JSON the public viewer page
 * fetches. Contains display names, icons (emoji only — local image files are
 * not hosted), admin info notes, and the full production relationships in
 * both directions.
 */

export interface ViewerCycleItem {
  ref: string;
  qty: number;
  altChance: number;
  alternates: { ref: string; qty: number }[];
  consumeChance: number;
  consumes: { ref: string; qty: number }[];
}

export interface ViewerCycle {
  name: string;
  interval: number;
  mode: "All" | "Random" | "Cycle";
  items: ViewerCycleItem[];
}

/** One phase of an acquisition method, flattened for the public page. */
export interface ViewerPhase {
  name: string;
  steps: string[];
  note: string;
  /** Present only when the phase has its own loop/reset conditions. */
  repeatUntil?: string;
  completedWhen?: string;
  failureOrReset?: string;
  transitionNote?: string;
}

export interface ViewerMethod {
  name: string;
  /** What this route leaves you with. */
  outcome: string;
  tags: string[];
  requirements: string;
  /**
   * Taming quantities are not published: they depend on level and server
   * rates, so a fixed number read as a promise. Anything worth saying about
   * amounts belongs in the note.
   */
  inputs: { name: string; role: string; note: string }[];
  phases: ViewerPhase[];
  repeatUntil: string;
  completion: string;
  failure: string;
  effectiveness: string;
  strategy: string;
}

/** Structured acquisition, the primary published source for "how do I get one". */
export interface ViewerAcquisition {
  availability: string;
  methods: ViewerMethod[];
  /** Creature the record was inherited from, when this is a variant. */
  inheritedFrom: string;
}

export interface ViewerCreature {
  id: string;
  cls: string;
  name: string;
  category: string;
  icon: string;
  /** Relative image path under the published images/ folder, when available. */
  img: string | null;
  /** Base creature this is a variant of — drives "Related variants". */
  base: string;
  /** General notes (markdown). */
  info: string;
  acq: ViewerAcquisition | null;
  abilities: ViewerAbility[];
  /** Harvest yields and special loot, as three named lists. */
  drops: ViewerDrops;
  /**
   * Where the creature can be found. `origin` is the single map the content
   * came from; `spawns` is every map it actually appears on, which is what a
   * player wants. `caution` is set when none of those maps is one this cluster
   * runs — the creature might still be obtainable, but nobody should promise
   * it without checking.
   */
  maps: { origin: string; spawns: string[]; caution: boolean };
  dragWeight: number | null;
  chance: number;
  cycles: ViewerCycle[];
  /**
   * Whether this creature is on the cluster's passive production roster.
   *
   * The page publishes documented creatures too, so "is it a producer" can no
   * longer be assumed from being listed at all — and a rule with no outputs
   * yet is still a producer as far as the admin is concerned.
   */
  produces: boolean;
}

export interface ViewerDropEntry {
  /** Item blueprint path, when the drop resolves to a catalog item. */
  ref: string;
  name: string;
  img: string | null;
  icon: string;
  qty: string;
  /** Only meaningful for random loot; empty elsewhere. */
  chance: string;
  /** Pre-formatted "1 / 5 min". Production only; empty elsewhere. */
  rate: string;
  note: string;
}

/** An item slot inside a structured ability effect. */
export interface ViewerEffectItem {
  ref: string;
  name: string;
  img: string | null;
  icon: string;
}

export interface ViewerEffectRow {
  item: ViewerEffectItem;
  /** Weight reduction and preserver only. */
  percent: string;
  /** Conversion only — what it turns into, and the amounts either side. */
  to: ViewerEffectItem | null;
  rate: string;
  toRate: string;
  note: string;
}

export interface ViewerAbility {
  label: string;
  detail: string;
  kind: AbilityKind;
  /** "none" for a plain ability; otherwise `rows` carries its table. */
  effect: AbilityEffect;
  rows: ViewerEffectRow[];
}

export type ViewerDrops = Record<DropListKey, ViewerDropEntry[]>;

export interface ViewerItem {
  id: string;
  name: string;
  category: string;
  icon: string;
  img: string | null;
  info: string;
  /** Item type, as recorded or as the bundled wiki data has it. */
  type: string;
  /** The cluster's own rarity grading, when one was set. */
  rarity: string;
  /** Max stack size, when known. */
  stack: number | null;
  producedBy: string[];
  alternateFrom: string[];
  consumedBy: string[];
  /**
   * The other half of "where does this come from": creatures whose recorded
   * drops list this item, kept per list so harvesting a corpse is never
   * confused with loot that only drops sometimes.
   */
  from: Record<DropListKey, string[]>;
}

export interface ViewerData {
  cluster: string;
  /** Relative path of a logo image, when one exists in the images folder. */
  logo: string | null;
  creatures: ViewerCreature[];
  items: ViewerItem[];
}

const MODE_NAMES = ["All", "Random", "Cycle"] as const;

export function serializeViewerData(
  production: ProductionDraft,
  catalog: CatalogFile,
  clusterName: string,
  imageFiles: string[] = [],
  /**
   * Needed only to know which maps the cluster runs. Absent (or with no map
   * list) means every map counts as running, so nothing is ever cautioned
   * without the admin having said so.
   */
  settings: ProjectSettings | null = null,
): ViewerData {
  const index = buildCatalogIndex({
    sources: [effectiveOfficialSource(catalog), ...catalog.sources],
  });
  const imageIndex = buildImageIndex(imageFiles);

  function classCandidate(bpPath: string): string {
    const cls = bpPath.split(".").pop() ?? "";
    return cls.replace(/_C$/, "").replace(/_Character_BP.*/i, "");
  }

  /** Resolves a creature to its base (manual parent, official class, or name). */
  function baseOf(bpPath: string, name: string) {
    const hit = index.creatures.get(normalizeBpPath(bpPath));
    const parentPath = catalog.variantParents[normalizeBpPath(bpPath)] ?? null;
    return resolveCreatureBase(
      { id: "", name, bpPath },
      {
        parentPath,
        parentName: parentPath
          ? (index.creatures.get(normalizeBpPath(parentPath))?.entry.name ?? "")
          : undefined,
        variantTag: hit?.source.variantTag,
      },
    );
  }

  /** Image match with variant inheritance and placeholder fallback. */
  function imgOf(kind: "creatures" | "items", bpPath: string, name: string): string | null {
    const own = matchImage(imageIndex, kind, [name, classCandidate(bpPath)]);
    if (own) return own;
    if (kind === "creatures") {
      const base = baseOf(bpPath, name);
      if (
        base.bpPath &&
        normalizeBpPath(base.bpPath) !== normalizeBpPath(bpPath)
      ) {
        const inherited = matchImage(imageIndex, kind, [
          base.label,
          classCandidate(base.bpPath),
        ]);
        if (inherited) return inherited;
      } else if (base.label !== name) {
        const inherited = matchImage(imageIndex, kind, [base.label]);
        if (inherited) return inherited;
      }
    }
    return imageIndex.missing[kind];
  }

  function displayName(kind: "creatures" | "items", bpPath: string): string {
    const hit = index[kind].get(normalizeBpPath(bpPath));
    if (hit) return hit.entry.name;
    const file = bpPath.split("/").pop() ?? bpPath;
    return file
      .split(".")[0]
      .replace(/^PrimalItem\w*?_/, "")
      .replace(/_Character_BP.*$/i, "")
      .replace(/_/g, " ");
  }

  function categoryOf(kind: "creatures" | "items", bpPath: string): string {
    const official = officialCategories.get(normalizeBpPath(bpPath));
    if (official) return official;
    const hit = index[kind].get(normalizeBpPath(bpPath));
    if (hit && hit.source.kind !== "official") return hit.source.name;
    return "";
  }

  function iconOf(kind: "creatures" | "items", bpPath: string): string {
    const assigned = catalog.icons[normalizeBpPath(bpPath)];
    // Only emoji assignments travel to the public page; file:/URL icons fall
    // back to category emoji.
    if (assigned && !assigned.startsWith("file:") && !/^https?:/.test(assigned)) {
      return assigned;
    }
    return fallbackIcon(bpPath, kind);
  }

  /**
   * General notes. The structured record is the primary source now; the old
   * per-entry notes map is still read so anything written before the redesign
   * keeps publishing.
   */
  function infoOf(bpPath: string): string {
    const key = normalizeBpPath(bpPath);
    const structured = infoFieldsFor(bpPath)?.notes.trim();
    return prose(structured || (catalog.notes[key] ?? ""));
  }

  /** A creature's effective info, with variant inheritance already applied. */
  function creatureInfoFor(bpPath: string) {
    const key = normalizeBpPath(bpPath);
    const own = catalog.creatureInfo[key];
    const hit = index.creatures.get(key);
    const manual = catalog.variantParents[key] ?? null;
    const base = variantParent(
      hit?.entry ?? { id: "", name: "", bpPath },
      { parentPath: manual, variantTag: hit?.source.variantTag },
    );
    const parentPath = base?.bpPath ?? null;
    const parent = parentPath
      ? catalog.creatureInfo[normalizeBpPath(parentPath)]
      : undefined;
    if (!own && !parent) return null;
    return resolveCreatureInfo(own, parent, parentPath);
  }

  /** Just the effective record, for the many callers that need nothing else. */
  function infoFieldsFor(bpPath: string) {
    return creatureInfoFor(bpPath)?.info ?? null;
  }

  /** Harvest and loot, resolved to real item names and icons where possible. */
  function dropsOf(bpPath: string): ViewerDrops {
    const drops = infoFieldsFor(bpPath)?.drops;
    const out = {} as ViewerDrops;
    for (const list of DROP_LISTS) {
      out[list.key] = (drops?.[list.key] ?? []).map((entry) => {
        const name = entry.bpPath
          ? displayName("items", entry.bpPath)
          : entry.label.trim();
        return {
          ref: entry.bpPath,
          // A free-text drop still needs something to show.
          name: entry.label.trim() || name || "(unnamed)",
          img: entry.bpPath ? imgOf("items", entry.bpPath, name) : null,
          icon: entry.bpPath ? iconOf("items", entry.bpPath) : "📦",
          // Production recurs, so it publishes a rate instead of a quantity.
          qty: list.hasRate ? "" : entry.qty,
          // Odds are meaningless outside random loot, so they never publish
          // somewhere they'd be read as a guarantee.
          chance: list.hasChance ? entry.chance : "",
          rate: list.hasRate ? formatRate(entry) : "",
          note: prose(entry.note),
        };
      });
    }
    return out;
  }

  /**
   * Prose on its way out: inline `{item}`/`{creature}` references become the
   * name the catalog gives them today. The published page is static and has no
   * index to resolve against, so a raw token would reach a reader as literal
   * `[[item:/Game/...]]`.
   */
  function prose(text: string): string {
    if (!hasReferences(text)) return text;
    return flattenReferences(text, (kind, bpPath) =>
      displayName(kind === "creature" ? "creatures" : "items", bpPath),
    );
  }

  /** An item reference inside an ability effect, resolved for display. */
  function effectItem(bpPath: string, label: string): ViewerEffectItem {
    const name = bpPath ? displayName("items", bpPath) : "";
    return {
      ref: bpPath,
      name: label.trim() || name || "(unnamed)",
      img: bpPath ? imgOf("items", bpPath, name) : null,
      icon: bpPath ? iconOf("items", bpPath) : "📦",
    };
  }

  /** Abilities, with any structured per-item table resolved alongside. */
  function abilitiesOf(bpPath: string): ViewerAbility[] {
    return (infoFieldsFor(bpPath)?.abilities ?? []).map((a) => {
      const shape = effectShape(a.effect);
      return {
        label: a.label,
        detail: a.detail,
        kind: a.kind,
        effect: a.effect,
        rows:
          a.effect === "none"
            ? []
            : a.rows.map((row) => ({
                item: effectItem(row.bpPath, row.label),
                percent: shape.hasPercent ? row.percent : "",
                to: shape.hasConversion
                  ? effectItem(row.toBpPath, row.toLabel)
                  : null,
                rate: shape.hasConversion ? row.rate : "",
                toRate: shape.hasConversion ? row.toRate : "",
                note: row.note,
              })),
      };
    });
  }

  /**
   * Where to find it. Falls back to the map of origin when no spawn maps were
   * recorded, since that is still better than saying nothing.
   */
  function mapsOf(bpPath: string): ViewerCreature["maps"] {
    const origin = mapOf(catalog, bpPath);
    const spawns = infoFieldsFor(bpPath)?.spawnMaps ?? [];
    const known = spawns.length > 0 ? spawns : origin ? [origin] : [];
    return {
      origin,
      spawns,
      // Caution only when every map it is known from is switched off. One
      // running map is enough to make it plainly obtainable.
      caution:
        known.length > 0 && known.every((m) => mapIsDisabled(settings, m)),
    };
  }

  /** Structured acquisition for the public page, or null when nothing is set. */
  function acquisitionOf(bpPath: string): ViewerAcquisition | null {
    const resolved = creatureInfoFor(bpPath);
    const info = resolved?.info;
    if (!info || (!info.availability && info.methods.length === 0)) return null;

    /*
     * Attribution comes from the resolution itself rather than being derived
     * again here. The old test — no acquisition override, and a base creature
     * exists — was true of any variant whose parent holds no record at all,
     * so "Same process as Rex" got published over a workflow that was really
     * the variant's own.
     */
    const inheritedAcquisition =
      resolved.inheritedFrom !== null &&
      resolved.inheritedSections.includes("acquisition");

    return {
      availability: info.availability
        ? AVAILABILITY_LABELS[info.availability]
        : "",
      inheritedFrom: inheritedAcquisition
        ? displayName("creatures", resolved.inheritedFrom ?? "")
        : "",
      methods: info.methods.map((m) => ({
        name: methodLabel(m),
        outcome: m.outcome ? OUTCOME_LABELS[m.outcome as MethodOutcome] : "",
        tags: m.tags.map((t) => TAG_LABELS[t as MethodTag] ?? t),
        requirements: prose(m.requirements),
        inputs: m.inputs.map((i) => ({
          // Creature inputs resolve against the creature catalog, items
          // against the item catalog; free text uses its own label.
          name: i.bpPath
            ? displayName(
                i.referenceType === "creature" ? "creatures" : "items",
                i.bpPath,
              )
            : i.label.trim() || "(unnamed)",
          role: ROLE_LABELS[i.role as InputRole] ?? i.role,
          note: prose(i.note),
        })),
        phases: m.phases.map((p) => ({
          name: p.name,
          note: prose(p.note),
          steps: p.steps.map((s) => prose(s.text)).filter(Boolean),
          // Only carried when actually used, so ordinary methods stay lean.
          ...(phaseHasOutcomes(p)
            ? {
                repeatUntil: prose(p.repeatUntil),
                completedWhen: prose(p.completedWhen),
                failureOrReset: prose(p.failureOrReset),
                transitionNote: prose(p.transitionNote),
              }
            : {}),
        })),
        repeatUntil: prose(m.repeatUntil),
        completion: prose(m.completion),
        failure: prose(m.failure),
        effectiveness: prose(m.effectiveness),
        strategy: prose(m.strategy),
      })),
    };
  }

  interface ItemRefs {
    /** First path seen for this item — what the page publishes as its id. */
    path: string;
    producedBy: Set<string>;
    alternateFrom: Set<string>;
    consumedBy: Set<string>;
    from: Record<DropListKey, Set<string>>;
  }

  /**
   * Keyed by normalized path rather than the literal string: the same item
   * reached through a production rule and through a recorded drop is one
   * resource on the page, however each was typed.
   */
  const itemRefs = new Map<string, ItemRefs>();

  function itemRef(bpPath: string): ItemRefs {
    const key = normalizeBpPath(bpPath);
    let ref = itemRefs.get(key);
    if (!ref) {
      ref = {
        path: bpPath,
        producedBy: new Set(),
        alternateFrom: new Set(),
        consumedBy: new Set(),
        from: { harvest: new Set(), guaranteed: new Set(), random: new Set(), production: new Set() },
      };
      itemRefs.set(key, ref);
    }
    return ref;
  }

  /** One creature card — from a production rule, or from its record alone. */
  function creatureCard(bpPath: string, rule: CreatureRule | null): ViewerCreature {
    const cycles: ViewerCycle[] = (rule?.cycles ?? []).map((cycle) => ({
      name: cycle.name,
      interval: cycle.intervalSeconds,
      mode: MODE_NAMES[cycle.itemSelectMode],
      items: cycle.items
        .filter((item) => item.bpPath)
        .map((item) => {
          itemRef(item.bpPath).producedBy.add(bpPath);
          for (const alt of item.alternateItems) {
            if (alt.bpPath) itemRef(alt.bpPath).alternateFrom.add(bpPath);
          }
          for (const consumed of item.consumesItems) {
            if (consumed.bpPath) itemRef(consumed.bpPath).consumedBy.add(bpPath);
          }
          return {
            ref: item.bpPath,
            qty: item.quantityPerDino,
            altChance: item.alternateItemsChance,
            alternates: item.alternateItems
              .filter((a) => a.bpPath)
              .map((a) => ({ ref: a.bpPath, qty: a.quantityPerItem })),
            consumeChance: item.consumesItemsChance,
            consumes: item.consumesItems
              .filter((c) => c.bpPath)
              .map((c) => ({ ref: c.bpPath, qty: c.quantityPerItem })),
          };
        }),
    }));

    const drops = dropsOf(bpPath);
    // A recorded drop is a real answer to "where does this come from", so the
    // resource side of the page gets it too.
    for (const list of DROP_LISTS) {
      for (const entry of drops[list.key]) {
        if (entry.ref) itemRef(entry.ref).from[list.key].add(bpPath);
      }
    }

    const name = displayName("creatures", bpPath);
    return {
      id: bpPath,
      cls: (bpPath.split(".").pop() ?? "").replace(/_C$/, ""),
      name,
      category: categoryOf("creatures", bpPath),
      icon: iconOf("creatures", bpPath),
      img: imgOf("creatures", bpPath, name),
      base: baseOf(bpPath, name).label,
      info: infoOf(bpPath),
      acq: acquisitionOf(bpPath),
      abilities: abilitiesOf(bpPath),
      drops,
      maps: mapsOf(bpPath),
      dragWeight: infoFieldsFor(bpPath)?.technical.dragWeight ?? null,
      chance: rule?.chanceToProduce ?? 0,
      cycles,
      produces: rule !== null,
    };
  }

  const producing = production.rules.filter((rule) => rule.enabled && rule.dinoType);
  const onRoster = new Set(producing.map((rule) => normalizeBpPath(rule.dinoType)));

  /**
   * Creatures the admin has written about but that produce nothing.
   *
   * The page is a creature lookup as much as a production atlas: a knockout
   * workflow, a drop table and a spawn map are worth publishing whether or not
   * the creature happens to be on the passive-production roster. Only records
   * that resolve against the catalog are included — without one there is no
   * name, icon or class to show.
   */
  const documented = [
    ...new Set([
      ...Object.keys(catalog.creatureInfo),
      ...Object.keys(catalog.notes),
    ]),
  ]
    .map((key) => normalizeBpPath(key))
    .filter((key) => !onRoster.has(key))
    .map((key) => index.creatures.get(key)?.entry.bpPath)
    .filter((bpPath): bpPath is string => Boolean(bpPath))
    .filter(
      (bpPath) =>
        hasCreatureInfo(infoFieldsFor(bpPath) ?? undefined) ||
        Boolean(infoOf(bpPath).trim()),
    );

  const creatures: ViewerCreature[] = [
    ...producing.map((rule) => creatureCard(rule.dinoType, rule)),
    ...documented.map((bpPath) => creatureCard(bpPath, null)),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const items: ViewerItem[] = [...itemRefs.values()]
    .map((refs) => {
      const bpPath = refs.path;
      const name = displayName("items", bpPath);
      const info = itemInfoOf(catalog, bpPath);
      return {
        id: bpPath,
        name,
        category: categoryOf("items", bpPath),
        icon: iconOf("items", bpPath),
        img: imgOf("items", bpPath, name),
        info: infoOf(bpPath),
        type: info.type,
        rarity: info.rarity,
        stack: info.stackSize,
        producedBy: [...refs.producedBy].sort(),
        alternateFrom: [...refs.alternateFrom].sort(),
        consumedBy: [...refs.consumedBy].sort(),
        from: DROP_LISTS.reduce(
          (out, list) => {
            out[list.key] = [...refs.from[list.key]].sort();
            return out;
          },
          {} as Record<DropListKey, string[]>,
        ),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const logo =
    imageFiles.find((f) => nameKey(f.split("/").pop() ?? "") === "logo") ??
    null;

  // Deliberately no timestamp: content must be deterministic so the publish
  // page can detect real changes via content hash.
  return {
    cluster: clusterName,
    logo,
    creatures,
    items,
  };
}

export function viewerDataToText(
  production: ProductionDraft,
  catalog: CatalogFile,
  clusterName: string,
  imageFiles: string[] = [],
  settings: ProjectSettings | null = null,
): string {
  return JSON.stringify(
    serializeViewerData(production, catalog, clusterName, imageFiles, settings),
    null,
    2,
  );
}
