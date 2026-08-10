import { z } from "zod";

/**
 * Internal editor model for Dino Depot passive production.
 *
 * This is richer than the published format (ids, enabled flags, notes).
 * `serializers/production.ts` converts to/from the strict published JSON
 * described in StructureExample/Passive Production Commented Structure Guide.
 */

export const SelectModeSchema = z.union([
  z.literal(0), // All
  z.literal(1), // Random
  z.literal(2), // Cycle
]);
export type SelectMode = z.infer<typeof SelectModeSchema>;

export const SELECT_MODE_LABELS: Record<SelectMode, string> = {
  0: "All",
  1: "Random",
  2: "Cycle",
};

export const SubItemSchema = z.object({
  id: z.string(),
  bpPath: z.string(),
  quantityPerItem: z.number(),
  maxQuantityPerCycle: z.number(),
  maxQuantityInTerminal: z.number(),
});
export type SubItem = z.infer<typeof SubItemSchema>;

export const PrimaryItemSchema = z.object({
  id: z.string(),
  bpPath: z.string(),
  quantityPerDino: z.number(),
  maxQuantityPerCycle: z.number(),
  maxQuantityInTerminal: z.number(),
  alternateSelectMode: SelectModeSchema,
  alternateItemsChance: z.number(),
  alternateItems: z.array(SubItemSchema),
  consumesSelectMode: SelectModeSchema,
  consumesItemsChance: z.number(),
  consumesItems: z.array(SubItemSchema),
});
export type PrimaryItem = z.infer<typeof PrimaryItemSchema>;

export const ProductionCycleSchema = z.object({
  id: z.string(),
  /** Optional organizational label; empty string means "no name" (omitted on publish). */
  name: z.string(),
  intervalSeconds: z.number(),
  itemSelectMode: SelectModeSchema,
  items: z.array(PrimaryItemSchema),
});
export type ProductionCycle = z.infer<typeof ProductionCycleSchema>;

export const CreatureRuleSchema = z.object({
  id: z.string(),
  /** Disabled rules are kept in the draft but excluded from published output. */
  enabled: z.boolean(),
  notes: z.string(),
  dinoType: z.string(),
  chanceToProduce: z.number(),
  cycles: z.array(ProductionCycleSchema),
});
export type CreatureRule = z.infer<typeof CreatureRuleSchema>;

export const ProductionDraftSchema = z.object({
  schemaVersion: z.literal(1),
  rules: z.array(CreatureRuleSchema),
});
export type ProductionDraft = z.infer<typeof ProductionDraftSchema>;

export function emptyProductionDraft(): ProductionDraft {
  return { schemaVersion: 1, rules: [] };
}

// ---------------------------------------------------------------------------
// Published format (strict Dino Depot v2 JSON) — used by parser & serializer.
// ---------------------------------------------------------------------------

export const PublishedSubItemSchema = z.object({
  bpPath: z.string(),
  quantityPerItem: z.number(),
  maxQuantityPerCycle: z.number(),
  maxQuantityInTerminal: z.number(),
});

export const PublishedItemSchema = z.object({
  bpPath: z.string(),
  quantityPerDino: z.number(),
  maxQuantityPerCycle: z.number(),
  maxQuantityInTerminal: z.number(),
  alternateSelectMode: SelectModeSchema,
  alternateItemsChance: z.number(),
  alternateItems: z.array(PublishedSubItemSchema),
  consumesSelectMode: SelectModeSchema,
  consumesItemsChance: z.number(),
  consumesItems: z.array(PublishedSubItemSchema),
});

export const PublishedCycleSchema = z.object({
  name: z.string().optional(),
  intervalSeconds: z.number(),
  itemSelectMode: SelectModeSchema,
  items: z.array(PublishedItemSchema),
});

export const PublishedRuleSchema = z.object({
  dinoType: z.string(),
  chanceToProduce: z.number(),
  produces: z.array(PublishedCycleSchema),
});

export const PublishedProductionSchema = z.object({
  version: z.literal(2),
  production: z.array(PublishedRuleSchema),
});
export type PublishedProduction = z.infer<typeof PublishedProductionSchema>;
