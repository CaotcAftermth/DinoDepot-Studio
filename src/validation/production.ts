import {
  CreatureRule,
  PrimaryItem,
  ProductionDraft,
  SubItem,
} from "../model/production";
import { CatalogIndex, normalizeBpPath } from "../model/catalog";
import { ValidationIssue } from "./types";

/**
 * Semantic validation for the production draft. Errors block publishing;
 * warnings require acknowledgement.
 */
export function validateProduction(
  draft: ProductionDraft,
  index: CatalogIndex | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenDinoTypes = new Map<string, string>();

  /**
   * Disabled rules don't publish, so they can't collide in the output — but
   * the editor refuses to create a second rule for a creature whether or not
   * the first is switched off, and enabling one later turns this into an
   * error. Imported files are the way these get in, so they are surfaced as a
   * warning rather than left to be discovered at publish time.
   */
  const disabledDinoTypes = new Map<string, string>();
  for (const rule of draft.rules) {
    if (rule.enabled || !rule.dinoType.trim()) continue;
    const key = normalizeBpPath(rule.dinoType);
    if (!disabledDinoTypes.has(key)) disabledDinoTypes.set(key, ruleLabel(rule));
  }

  for (const rule of draft.rules) {
    if (!rule.enabled) continue;
    const label = ruleLabel(rule);

    if (!rule.dinoType.trim()) {
      issues.push(err(rule.id, label, "Creature blueprint path is empty"));
    } else {
      checkBpPathFormat(issues, rule.id, label, rule.dinoType, "Creature path");
      const key = normalizeBpPath(rule.dinoType);
      const duplicate = seenDinoTypes.get(key);
      if (duplicate) {
        issues.push(
          err(
            rule.id,
            label,
            `Duplicate creature: another enabled rule (${duplicate}) already uses this dinoType`,
          ),
        );
      } else {
        seenDinoTypes.set(key, label);
        const disabled = disabledDinoTypes.get(key);
        if (disabled) {
          issues.push(
            warn(
              rule.id,
              label,
              `A disabled rule (${disabled}) uses the same creature — enabling it would make both apply`,
            ),
          );
        }
      }
      checkCreatureCatalog(issues, index, rule.id, label, rule.dinoType);
    }

    checkChance(issues, rule.id, label, rule.chanceToProduce, "chanceToProduce");

    if (rule.cycles.length === 0) {
      issues.push(warn(rule.id, label, "Rule has no production cycles"));
    }

    rule.cycles.forEach((cycle, cycleIdx) => {
      const cycleWhere = `${label} › Cycle ${cycleIdx + 1}${cycle.name ? ` (${cycle.name})` : ""}`;

      if (!(cycle.intervalSeconds > 0)) {
        issues.push(
          err(rule.id, cycleWhere, "intervalSeconds must be greater than 0"),
        );
      } else if (cycle.intervalSeconds < 10) {
        issues.push(
          warn(
            rule.id,
            cycleWhere,
            `Very short interval (${cycle.intervalSeconds}s) — this cycle runs extremely often`,
          ),
        );
      }

      if (cycle.items.length === 0) {
        issues.push(warn(rule.id, cycleWhere, "Cycle has no items"));
      }

      cycle.items.forEach((item, itemIdx) => {
        checkItem(
          issues,
          index,
          rule.id,
          `${cycleWhere} › Item ${itemIdx + 1}`,
          item,
        );
      });
    });
  }

  return issues;
}

function checkItem(
  issues: ValidationIssue[],
  index: CatalogIndex | null,
  entityId: string,
  where: string,
  item: PrimaryItem,
) {
  if (!item.bpPath.trim()) {
    issues.push(err(entityId, where, "Item blueprint path is empty"));
  } else {
    checkBpPathFormat(issues, entityId, where, item.bpPath, "Item path");
    checkItemCatalog(issues, index, entityId, where, item.bpPath);
  }

  if (item.quantityPerDino < 0) {
    issues.push(err(entityId, where, "quantityPerDino cannot be negative"));
  }
  if (item.quantityPerDino === 0) {
    issues.push(warn(entityId, where, "quantityPerDino is 0 — produces nothing"));
  }
  checkCaps(issues, entityId, where, item.maxQuantityPerCycle, item.maxQuantityInTerminal);

  checkChance(issues, entityId, where, item.alternateItemsChance, "alternateItemsChance");
  checkChance(issues, entityId, where, item.consumesItemsChance, "consumesItemsChance");

  if (item.alternateItemsChance > 0 && item.alternateItems.length === 0) {
    issues.push(
      warn(entityId, where, "alternateItemsChance is set but there are no alternate items"),
    );
  }
  if (item.consumesItemsChance > 0 && item.consumesItems.length === 0) {
    issues.push(
      warn(entityId, where, "consumesItemsChance is set but there are no consumed items"),
    );
  }

  item.alternateItems.forEach((sub, i) =>
    checkSubItem(issues, index, entityId, `${where} › Alternate ${i + 1}`, sub),
  );
  item.consumesItems.forEach((sub, i) =>
    checkSubItem(issues, index, entityId, `${where} › Consumes ${i + 1}`, sub),
  );
}

function checkSubItem(
  issues: ValidationIssue[],
  index: CatalogIndex | null,
  entityId: string,
  where: string,
  sub: SubItem,
) {
  if (!sub.bpPath.trim()) {
    issues.push(err(entityId, where, "Blueprint path is empty"));
  } else {
    checkBpPathFormat(issues, entityId, where, sub.bpPath, "Path");
    checkItemCatalog(issues, index, entityId, where, sub.bpPath);
  }
  if (sub.quantityPerItem < 0) {
    issues.push(err(entityId, where, "quantityPerItem cannot be negative"));
  }
  checkCaps(issues, entityId, where, sub.maxQuantityPerCycle, sub.maxQuantityInTerminal);
}

// ---------------------------------------------------------------------------

function checkBpPathFormat(
  issues: ValidationIssue[],
  entityId: string,
  where: string,
  path: string,
  what: string,
) {
  // Expected shape: /Root/…/Name.Name  (optionally _C suffix on class refs)
  const ok = /^\/[^\s]+\/[^\s/.]+\.[^\s/.]+$/.test(path.trim());
  if (!ok) {
    issues.push(
      err(
        entityId,
        where,
        `${what} does not look like a blueprint path (expected /…/Name.Name): ${path}`,
      ),
    );
  }
}

function checkChance(
  issues: ValidationIssue[],
  entityId: string,
  where: string,
  value: number,
  field: string,
) {
  if (value < 0 || value > 1) {
    issues.push(
      err(entityId, where, `${field} must be between 0.0 and 1.0 (got ${value})`),
    );
  }
}

function checkCaps(
  issues: ValidationIssue[],
  entityId: string,
  where: string,
  perCycle: number,
  inTerminal: number,
) {
  if (perCycle < 0 || inTerminal < 0) {
    issues.push(err(entityId, where, "Quantity caps cannot be negative"));
  }
  if (perCycle > 0 && inTerminal > 0 && perCycle > inTerminal) {
    issues.push(
      warn(
        entityId,
        where,
        `maxQuantityPerCycle (${perCycle}) exceeds maxQuantityInTerminal (${inTerminal})`,
      ),
    );
  }
}

function checkCreatureCatalog(
  issues: ValidationIssue[],
  index: CatalogIndex | null,
  entityId: string,
  where: string,
  path: string,
) {
  if (!index) return;
  const hit = index.creatures.get(normalizeBpPath(path));
  if (!hit) {
    issues.push(
      warn(entityId, where, "Creature is not in the catalog — check the path or add it to a content source"),
    );
  } else if (hit.source.removed) {
    issues.push(
      warn(entityId, where, `Creature belongs to "${hit.source.name}", which is being removed from the server`),
    );
  } else if (!hit.source.enabled) {
    issues.push(
      warn(entityId, where, `Creature belongs to "${hit.source.name}", which is disabled`),
    );
  }
}

function checkItemCatalog(
  issues: ValidationIssue[],
  index: CatalogIndex | null,
  entityId: string,
  where: string,
  path: string,
) {
  if (!index) return;
  const hit = index.items.get(normalizeBpPath(path));
  if (!hit) {
    issues.push(
      warn(entityId, where, "Item is not in the catalog — check the path or add it to a content source"),
    );
  } else if (hit.source.removed) {
    issues.push(
      warn(entityId, where, `Item belongs to "${hit.source.name}", which is being removed from the server`),
    );
  } else if (!hit.source.enabled) {
    issues.push(
      warn(entityId, where, `Item belongs to "${hit.source.name}", which is disabled`),
    );
  }
}

function ruleLabel(rule: CreatureRule): string {
  const file = rule.dinoType.split("/").pop() ?? rule.dinoType;
  return file.split(".")[0] || "New rule";
}

function err(entityId: string, where: string, message: string): ValidationIssue {
  return { level: "error", entityId, where, message };
}

function warn(entityId: string, where: string, message: string): ValidationIssue {
  return { level: "warning", entityId, where, message };
}
