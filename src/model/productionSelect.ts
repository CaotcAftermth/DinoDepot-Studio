import { normalizeBpPath, type CatalogIndex } from "./catalog";
import { variantParent, type CreatureBase } from "./creatureBase";
import type { CreatureRule } from "./production";
import { shortClassName } from "../services/spawnCommands";

/**
 * The decisions behind picking a creature for a production rule.
 *
 * The picker, the raw-path box inside the picker, and the blueprint field the
 * admin types into all funnel through one code path in ProductionRulesPage, so
 * these are the checks every one of those routes gets. They live here because
 * "does a typed `/game/x/rex.rex_c` collide with a picked `/Game/X/Rex.Rex`"
 * is a question worth answering in a test rather than by clicking.
 */

/**
 * A rule that already claims this creature. Case-insensitive, `_C`-insensitive
 * and whitespace-trimmed via `normalizeBpPath`, so no spelling of the same
 * class sneaks a second rule past it.
 *
 * Disabled rules count. Two rules for one creature is a mistake whether or not
 * one of them is currently switched off — and a disabled rule is usually one
 * the admin means to switch back on.
 */
export function findDuplicateRule(
  rules: CreatureRule[],
  currentRuleId: string,
  bpPath: string,
): CreatureRule | null {
  const key = normalizeBpPath(bpPath);
  if (!key) return null;
  return (
    rules.find(
      (r) =>
        r.id !== currentRuleId &&
        r.dinoType.trim() !== "" &&
        normalizeBpPath(r.dinoType) === key,
    ) ?? null
  );
}

/**
 * A rule the admin has not put anything into yet — scaffolding created by
 * "+ Add rule" that is safe to clear away when the choice lands elsewhere.
 */
export function isUntouchedRule(rule: CreatureRule): boolean {
  return (
    !rule.dinoType &&
    !rule.notes &&
    rule.cycles.length === 1 &&
    rule.cycles[0].items.every((item) => !item.bpPath)
  );
}

/**
 * The creature this path is a variant of, resolved the same way whether the
 * path came from the picker or was typed by hand: manual parent assignment
 * first, then the official class-stem match, then the mod's variant tag.
 *
 * A path that is in no content source still resolves — the class stem is
 * enough to recognise `Rex_Character_BP_Aberrant` as a Rex.
 */
export function resolveSelectionParent(
  bpPath: string,
  index: CatalogIndex,
  variantParents: Record<string, string>,
): CreatureBase | null {
  const trimmed = bpPath.trim();
  if (!trimmed) return null;

  const key = normalizeBpPath(trimmed);
  const hit = index.creatures.get(key);
  const parentPath = variantParents[key] ?? null;

  return variantParent(
    hit?.entry ?? { id: "", name: shortClassName(trimmed), bpPath: trimmed },
    {
      parentPath,
      parentName: parentPath
        ? (index.creatures.get(normalizeBpPath(parentPath))?.entry.name ??
          shortClassName(parentPath))
        : undefined,
      variantTag: hit?.source.variantTag,
    },
  );
}
