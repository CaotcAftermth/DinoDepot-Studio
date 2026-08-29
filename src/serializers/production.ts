import {
  CreatureRule,
  PrimaryItem,
  ProductionDraft,
  PublishedProduction,
  PublishedProductionSchema,
  SubItem,
} from "../model/production";
import { newId } from "../model/ids";

/**
 * Converts the internal editor draft into the strict published Dino Depot v2
 * JSON object. Key order follows the structure guide exactly; disabled rules
 * are excluded; empty alternate/consume arrays are always retained.
 */
export function serializeProduction(draft: ProductionDraft): PublishedProduction {
  return {
    version: 2,
    production: draft.rules
      .filter((rule) => rule.enabled)
      .map((rule) => ({
        dinoType: rule.dinoType,
        chanceToProduce: rule.chanceToProduce,
        produces: rule.cycles.map((cycle) => ({
          ...(cycle.name ? { name: cycle.name } : {}),
          intervalSeconds: cycle.intervalSeconds,
          itemSelectMode: cycle.itemSelectMode,
          items: cycle.items.map(serializeItem),
        })),
      })),
  };
}

function serializeItem(item: PrimaryItem) {
  return {
    bpPath: item.bpPath,
    quantityPerDino: item.quantityPerDino,
    maxQuantityPerCycle: item.maxQuantityPerCycle,
    maxQuantityInTerminal: item.maxQuantityInTerminal,
    alternateSelectMode: item.alternateSelectMode,
    alternateItemsChance: item.alternateItemsChance,
    alternateItems: item.alternateItems.map(serializeSubItem),
    consumesSelectMode: item.consumesSelectMode,
    consumesItemsChance: item.consumesItemsChance,
    consumesItems: item.consumesItems.map(serializeSubItem),
  };
}

function serializeSubItem(sub: SubItem) {
  return {
    bpPath: sub.bpPath,
    quantityPerItem: sub.quantityPerItem,
    maxQuantityPerCycle: sub.maxQuantityPerCycle,
    maxQuantityInTerminal: sub.maxQuantityInTerminal,
  };
}

export function productionToText(draft: ProductionDraft): string {
  return JSON.stringify(serializeProduction(draft), null, 2);
}

/**
 * Parses a published passive production JSON string into the internal draft
 * model (importer for live files). Throws with a readable message on invalid
 * structure.
 */
export function parseProduction(text: string): ProductionDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const result = PublishedProductionSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `Not a valid Dino Depot v2 production file: ${issue.path.join(".")} - ${issue.message}`,
    );
  }
  const rules: CreatureRule[] = result.data.production.map((rule) => ({
    id: newId(),
    enabled: true,
    notes: "",
    dinoType: rule.dinoType,
    chanceToProduce: rule.chanceToProduce,
    cycles: rule.produces.map((cycle) => ({
      id: newId(),
      name: cycle.name ?? "",
      intervalSeconds: cycle.intervalSeconds,
      itemSelectMode: cycle.itemSelectMode,
      items: cycle.items.map((item) => ({
        id: newId(),
        bpPath: item.bpPath,
        quantityPerDino: item.quantityPerDino,
        maxQuantityPerCycle: item.maxQuantityPerCycle,
        maxQuantityInTerminal: item.maxQuantityInTerminal,
        alternateSelectMode: item.alternateSelectMode,
        alternateItemsChance: item.alternateItemsChance,
        alternateItems: item.alternateItems.map(parseSubItem),
        consumesSelectMode: item.consumesSelectMode,
        consumesItemsChance: item.consumesItemsChance,
        consumesItems: item.consumesItems.map(parseSubItem),
      })),
    })),
  }));
  return { schemaVersion: 1, rules };
}

function parseSubItem(sub: {
  bpPath: string;
  quantityPerItem: number;
  maxQuantityPerCycle: number;
  maxQuantityInTerminal: number;
}): SubItem {
  return { id: newId(), ...sub };
}
