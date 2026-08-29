import {
  CreatureRule,
  ProductionDraft,
  SelectMode,
} from "../model/production";

/**
 * Expected-value production simulator.
 *
 * Modeling assumptions (documented for transparency; all values are
 * statistical estimates, not exact game behavior):
 * - Each cycle attempts every `intervalSeconds`; each creature independently
 *   passes the rule-level `chanceToProduce` per attempt.
 * - itemSelectMode: All (0) processes every primary item per attempt;
 *   Random (1) picks one uniformly; Cycle (2) rotates - both average 1/n
 *   per item over time.
 * - Per production event (creature × attempt that passed the chance roll):
 *   the primary item produces `quantityPerDino`; with `alternateItemsChance`
 *   the alternate pool activates and each selected alternate produces
 *   `quantityPerItem`; with `consumesItemsChance` the consume pool activates
 *   and each selected entry consumes `quantityPerItem`.
 * - `maxQuantityPerCycle` clamps a definition's expected contribution per
 *   cycle; `maxQuantityInTerminal` caps the accumulated total (reported as
 *   time-to-cap).
 */

export interface SimConfig {
  /**
   * "hours": every cycle repeats for the whole window.
   * "singleCycle": every cycle runs exactly once (one production attempt),
   * regardless of its interval - useful for judging a single tick's output.
   */
  mode: "hours" | "singleCycle";
  hours: number;
  /** Creature count per rule id (falls back to defaultCount). */
  counts: Record<string, number>;
  defaultCount: number;
  highOutputPerHour: number;
  lowOutputPerHour: number;
  /**
   * Per-item high-output thresholds (normalized blueprint path -> items/hour),
   * overriding `highOutputPerHour`. 500 Element/hour is not the same problem
   * as 500 Fiber/hour.
   */
  highOutputPerItem?: Record<string, number>;
}

export interface SimItemFlow {
  bpPath: string;
  produced: number;
  consumed: number;
  /** True if the per-cycle cap limited this flow. */
  perCycleCapHit: boolean;
  /** Hours until the terminal cap fills, when a terminal cap exists. */
  hoursToTerminalCap: number | null;
  /** True if the terminal cap was reached inside the simulated window. */
  terminalCapHit: boolean;
}

export interface SimRuleResult {
  ruleId: string;
  dinoType: string;
  creatureCount: number;
  cycles: {
    cycleId: string;
    name: string;
    intervalSeconds: number;
    attempts: number;
    flows: SimItemFlow[];
  }[];
}

export interface SimItemTotal {
  bpPath: string;
  produced: number;
  consumed: number;
  net: number;
  perHour: number;
  terminalCapped: boolean;
}

export interface SimWarning {
  level: "warning" | "info";
  message: string;
  bpPath?: string;
}

export interface SimResult {
  rules: SimRuleResult[];
  totals: SimItemTotal[];
  warnings: SimWarning[];
}

/** Matches model/catalog's normalizeBpPath, kept local so the engine stays pure. */
function normalizePath(bpPath: string): string {
  return bpPath.trim().replace(/_C$/i, "").toLowerCase();
}

function selectWeight(mode: SelectMode, poolSize: number): number {
  if (poolSize <= 0) return 0;
  return mode === 0 ? 1 : 1 / poolSize;
}

export function simulate(draft: ProductionDraft, config: SimConfig): SimResult {
  const horizonSeconds = config.hours * 3600;
  const rules: SimRuleResult[] = [];
  const produced = new Map<string, number>();
  const consumed = new Map<string, number>();
  const terminalCapped = new Set<string>();
  const warnings: SimWarning[] = [];

  for (const rule of draft.rules) {
    if (!rule.enabled) continue;
    const count = config.counts[rule.id] ?? config.defaultCount;
    // A rule set to zero creatures still belongs in the breakdown, showing no
    // output - dropping it makes the row the count was typed into disappear
    // under the cursor. Its (all-zero) flows are accumulated into a throwaway
    // so the totals table doesn't fill with empty rows.
    const acc =
      count > 0
        ? { produced, consumed, terminalCapped }
        : {
            produced: new Map<string, number>(),
            consumed: new Map<string, number>(),
            terminalCapped: new Set<string>(),
          };
    rules.push(
      simulateRule(rule, Math.max(count, 0), horizonSeconds, config.mode, acc),
    );
  }

  const allPaths = new Set([...produced.keys(), ...consumed.keys()]);
  const totals: SimItemTotal[] = [...allPaths]
    .map((bpPath) => {
      const p = produced.get(bpPath) ?? 0;
      const c = consumed.get(bpPath) ?? 0;
      return {
        bpPath,
        produced: p,
        consumed: c,
        net: p - c,
        perHour:
          config.mode === "hours" && config.hours > 0
            ? (p - c) / config.hours
            : 0,
        terminalCapped: terminalCapped.has(bpPath),
      };
    })
    .sort((a, b) => b.net - a.net);

  for (const total of totals) {
    // Per-hour balance thresholds only make sense over a time window.
    if (config.mode === "hours") {
      const override =
        config.highOutputPerItem?.[normalizePath(total.bpPath)];
      const highThreshold = override ?? config.highOutputPerHour;
      if (total.perHour > highThreshold) {
        warnings.push({
          level: "warning",
          bpPath: total.bpPath,
          message:
            `High output: ${fmt(total.perHour)}/hour exceeds the ${highThreshold}/hour threshold` +
            (override !== undefined ? " set for this item" : ""),
        });
      } else if (
        total.net > 0 &&
        total.perHour < config.lowOutputPerHour &&
        !total.terminalCapped
      ) {
        warnings.push({
          level: "info",
          bpPath: total.bpPath,
          message: `Weak output: ${fmt(total.perHour)}/hour is below the ${config.lowOutputPerHour}/hour threshold`,
        });
      }
    }
    // Items that are only ever consumed (Rex eggs, berries…) are supplied by
    // players, not by passive production - that's a normal setup, not a
    // balance problem. Only flag a genuine deficit: something the config
    // produces AND consumes, where consumption outpaces production.
    if (total.produced > 0 && total.net < 0) {
      warnings.push({
        level: "warning",
        bpPath: total.bpPath,
        message: `Consumption outpaces production: ${fmt(total.consumed)} consumed vs ${fmt(total.produced)} produced over the window`,
      });
    }
  }

  return { rules, totals, warnings };
}

interface Accumulators {
  produced: Map<string, number>;
  consumed: Map<string, number>;
  terminalCapped: Set<string>;
}

function simulateRule(
  rule: CreatureRule,
  count: number,
  horizonSeconds: number,
  mode: SimConfig["mode"],
  acc: Accumulators,
): SimRuleResult {
  const result: SimRuleResult = {
    ruleId: rule.id,
    dinoType: rule.dinoType,
    creatureCount: count,
    cycles: [],
  };

  for (const cycle of rule.cycles) {
    if (!(cycle.intervalSeconds > 0)) continue;
    const attempts =
      mode === "singleCycle"
        ? 1
        : Math.floor(horizonSeconds / cycle.intervalSeconds);
    const flows: SimItemFlow[] = [];
    const itemWeight = selectWeight(cycle.itemSelectMode, cycle.items.length);

    for (const item of cycle.items) {
      // Expected production events for this item definition per cycle.
      const eventsPerCycle = count * rule.chanceToProduce * itemWeight;

      // --- Primary output
      let perCycle = eventsPerCycle * item.quantityPerDino;
      let perCycleCapHit = false;
      if (item.maxQuantityPerCycle > 0 && perCycle > item.maxQuantityPerCycle) {
        perCycle = item.maxQuantityPerCycle;
        perCycleCapHit = true;
      }
      const primary = addFlow(
        acc,
        item.bpPath,
        perCycle,
        attempts,
        cycle.intervalSeconds,
        item.maxQuantityInTerminal,
        false,
      );
      flows.push({ ...primary, perCycleCapHit });

      // --- Alternates
      const altWeight = selectWeight(
        item.alternateSelectMode,
        item.alternateItems.length,
      );
      for (const alt of item.alternateItems) {
        let altPerCycle =
          eventsPerCycle * item.alternateItemsChance * altWeight * alt.quantityPerItem;
        let altCapHit = false;
        if (alt.maxQuantityPerCycle > 0 && altPerCycle > alt.maxQuantityPerCycle) {
          altPerCycle = alt.maxQuantityPerCycle;
          altCapHit = true;
        }
        const flow = addFlow(
          acc,
          alt.bpPath,
          altPerCycle,
          attempts,
          cycle.intervalSeconds,
          alt.maxQuantityInTerminal,
          false,
        );
        flows.push({ ...flow, perCycleCapHit: altCapHit });
      }

      // --- Consumes
      const consumeWeight = selectWeight(
        item.consumesSelectMode,
        item.consumesItems.length,
      );
      for (const consume of item.consumesItems) {
        const consumePerCycle =
          eventsPerCycle *
          item.consumesItemsChance *
          consumeWeight *
          consume.quantityPerItem;
        const flow = addFlow(
          acc,
          consume.bpPath,
          consumePerCycle,
          attempts,
          cycle.intervalSeconds,
          0,
          true,
        );
        flows.push(flow);
      }
    }

    result.cycles.push({
      cycleId: cycle.id,
      name: cycle.name,
      intervalSeconds: cycle.intervalSeconds,
      attempts,
      flows,
    });
  }

  return result;
}

function addFlow(
  acc: Accumulators,
  bpPath: string,
  perCycle: number,
  attempts: number,
  intervalSeconds: number,
  terminalCap: number,
  isConsumption: boolean,
): SimItemFlow {
  let total = perCycle * attempts;
  let hoursToTerminalCap: number | null = null;
  let terminalCapHit = false;

  if (!isConsumption && terminalCap > 0 && perCycle > 0) {
    const cyclesToCap = terminalCap / perCycle;
    hoursToTerminalCap = (cyclesToCap * intervalSeconds) / 3600;
    if (total > terminalCap) {
      total = terminalCap;
      terminalCapHit = true;
      acc.terminalCapped.add(bpPath);
    }
  }

  const map = isConsumption ? acc.consumed : acc.produced;
  map.set(bpPath, (map.get(bpPath) ?? 0) + total);

  return {
    bpPath,
    produced: isConsumption ? 0 : total,
    consumed: isConsumption ? total : 0,
    perCycleCapHit: false,
    hoursToTerminalCap,
    terminalCapHit,
  };
}

export function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2);
}
