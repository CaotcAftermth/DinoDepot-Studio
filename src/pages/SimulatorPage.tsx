import { useEffect, useId, useMemo, useState } from "react";
import { useDraftsStore } from "../stores/draftsStore";
import { useProjectStore } from "../stores/projectStore";
import { fmt, simulate, SimConfig, SimRuleResult } from "../simulator/engine";
import { displayNameFor, useCatalogIndex } from "../stores/useCatalogIndex";
import { itemOutputThresholds } from "../model/itemInfo";
import { EntityIcon } from "../components/EntityIcon";
import {
  Badge,
  Card,
  cx,
  EmptyState,
  Field,
  Input,
  PageHeader,
} from "../components/ui";
import { feedbackTarget } from "../model/feedback/targets";

type TimePreset = {
  label: string;
  mode: SimConfig["mode"];
  hours: number;
  /** Mirrors the Simulator default hours from Settings. */
  isDefault?: boolean;
};

const FIXED_PRESETS: TimePreset[] = [
  { label: "1 Cycle", mode: "singleCycle", hours: 1 },
  { label: "1 Hour", mode: "hours", hours: 1 },
  { label: "3 Hours", mode: "hours", hours: 3 },
  { label: "12 Hours", mode: "hours", hours: 12 },
];

function hoursLabel(hours: number): string {
  const rounded = Math.round(hours * 100) / 100;
  return `${rounded} ${rounded === 1 ? "Hour" : "Hours"}`;
}

/**
 * Time presets, with the final slot bound to the Simulator default hours
 * from Settings. When the default already matches a fixed preset, that
 * preset is marked instead of duplicating the button.
 */
function buildTimePresets(defaultHours: number): TimePreset[] {
  const existing = FIXED_PRESETS.findIndex(
    (p) => p.mode === "hours" && p.hours === defaultHours,
  );
  if (existing >= 0) {
    return FIXED_PRESETS.map((p, i) =>
      i === existing ? { ...p, isDefault: true } : p,
    );
  }
  return [
    ...FIXED_PRESETS,
    {
      label: hoursLabel(defaultHours),
      mode: "hours",
      hours: defaultHours,
      isDefault: true,
    },
  ];
}

export function SimulatorPage() {
  const { production, catalog, hydrate } = useDraftsStore();
  const settings = useProjectStore((s) => s.settings);
  const index = useCatalogIndex();
  useEffect(hydrate, [hydrate]);

  const timePresets = useMemo(
    () => buildTimePresets(settings?.simulator.defaultHours ?? 24),
    [settings?.simulator.defaultHours],
  );
  // Track the selection by label so it survives a Settings change.
  const [presetLabel, setPresetLabel] = useState<string | null>(null);
  const preset =
    timePresets.find((p) => p.label === presetLabel) ??
    timePresets.find((p) => p.isDefault) ??
    timePresets[timePresets.length - 1];
  const [defaultCount, setDefaultCount] = useState(
    settings?.simulator.defaultCreatureCount ?? 10,
  );
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const enabledRules = production.rules.filter((r) => r.enabled);

  const result = useMemo(() => {
    if (!settings) return null;
    return simulate(production, {
      mode: preset.mode,
      hours: preset.hours,
      counts,
      defaultCount,
      highOutputPerHour: settings.simulator.highOutputPerHour,
      lowOutputPerHour: settings.simulator.lowOutputPerHour,
      highOutputPerItem: itemOutputThresholds(catalog),
    });
  }, [production, preset, counts, defaultCount, settings, catalog]);

  // Matches the creature, or any item it produces/consumes, so you can ask
  // "who makes Hide?" as easily as "what does the Rex do?".
  const filteredRules = useMemo(() => {
    if (!result) return [];
    const q = search.trim().toLowerCase();
    const matching = !q
      ? result.rules
      : result.rules.filter((r) => {
          if (
            displayNameFor(index, "creatures", r.dinoType).toLowerCase().includes(q)
          ) {
            return true;
          }
          return r.cycles.some((cycle) =>
            cycle.flows.some((flow) =>
              displayNameFor(index, "items", flow.bpPath).toLowerCase().includes(q),
            ),
          );
        });
    // Same order as the Production Rules list, so a creature sits in the same
    // place whichever page you are reading - these two are used side by side
    // while balancing, and file order matched neither expectation.
    return [...matching].sort((a, b) => {
      if (!a.dinoType || !b.dinoType) return a.dinoType ? -1 : b.dinoType ? 1 : 0;
      return displayNameFor(index, "creatures", a.dinoType).localeCompare(
        displayNameFor(index, "creatures", b.dinoType),
        undefined,
        { sensitivity: "base" },
      );
    });
  }, [result, search, index]);

  const windowLabel =
    preset.mode === "singleCycle" ? "one production cycle" : `${preset.hours}h`;

  if (enabledRules.length === 0) {
    return (
      <div>
        <PageHeader
          title="Simulator"
          subtitle="Estimate production output before publishing"
        />
        <Card>
          <EmptyState title="No enabled production rules to simulate">
            Create rules in the Production Rules section first.
          </EmptyState>
        </Card>
      </div>
    );
  }

  function toggleExpanded(ruleId: string) {
    const next = new Set(expanded);
    if (next.has(ruleId)) next.delete(ruleId);
    else next.add(ruleId);
    setExpanded(next);
  }

  return (
    <div {...feedbackTarget("passive-production-simulator")}>
      <PageHeader
        title="Simulator"
        subtitle="Expected-value estimates - chance-based results are statistical averages, not guarantees"
      />

      {/* Controls bar */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-5">
          <div>
            <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1.5">
              Time window
            </span>
            <div className="flex gap-1.5">
              {timePresets.map((p) => (
                <button
                  key={p.label}
                  onClick={() => setPresetLabel(p.label)}
                  title={
                    p.isDefault
                      ? "Default window - set in Settings › Simulator defaults"
                      : undefined
                  }
                  className={cx(
                    "px-3 py-1.5 rounded-md text-sm border cursor-pointer",
                    preset.label === p.label
                      ? "bg-accent-600 border-accent-500 text-white"
                      : "bg-ink-800 border-ink-600 text-ink-300 hover:text-white",
                  )}
                >
                  {p.label}
                  {p.isDefault && <span className="opacity-60"> ★</span>}
                </button>
              ))}
            </div>
          </div>
          <Field
            label="Default creature count"
            className="w-44"
          >
            <div {...feedbackTarget("passive-production-simulator-count")}>
            <Input
              type="number"
              min={0}
              value={defaultCount}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) setDefaultCount(n);
              }}
            />
            </div>
          </Field>
          <Field label="Filter creatures or items" className="flex-1 min-w-52">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search creatures or items…"
            />
          </Field>
        </div>
        {preset.mode === "singleCycle" && (
          <p className="text-xs text-sky-400 mt-3">
            1 Cycle mode: every production cycle fires exactly once, regardless
            of its interval - a snapshot of a single tick.
          </p>
        )}
      </Card>

      {result && result.warnings.length > 0 && (
        <Card title={`Balance warnings (${result.warnings.length})`} className="mb-4">
          <div className="flex flex-col gap-1.5 max-h-44 overflow-y-auto">
            {result.warnings.map((warning, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <Badge tone={warning.level === "warning" ? "warn" : "info"}>
                  {warning.level}
                </Badge>
                <span className="text-ink-300">
                  {warning.bpPath && (
                    <span className="text-ink-100 font-medium">
                      {displayNameFor(index, "items", warning.bpPath)}:{" "}
                    </span>
                  )}
                  {warning.message}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-5 items-start">
        {/* Totals */}
        <Card title={`Net output over ${windowLabel} (all creatures)`}>
          {result && result.totals.length > 0 ? (
            <div className="max-h-[calc(100vh-360px)] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-ink-900">
                  <tr className="text-left text-xs text-ink-400 uppercase tracking-wide">
                    <th className="pb-2">Item</th>
                    <th className="pb-2 text-right">Produced</th>
                    <th className="pb-2 text-right">Consumed</th>
                    <th className="pb-2 text-right">Net</th>
                    {preset.mode === "hours" && (
                      <th className="pb-2 text-right">Per hour</th>
                    )}
                    <th className="pb-2 text-right w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {result.totals.map((total) => (
                    <tr key={total.bpPath}>
                      <td className="py-1.5">
                        <div className="flex items-center gap-1.5 text-ink-100">
                          <EntityIcon bpPath={total.bpPath} kind="items" />
                          {displayNameFor(index, "items", total.bpPath)}
                        </div>
                      </td>
                      <td className="text-right text-ink-200">
                        {fmt(total.produced)}
                      </td>
                      <td className="text-right text-ink-200">
                        {total.consumed > 0 ? fmt(total.consumed) : " - "}
                      </td>
                      <td
                        className={cx(
                          "text-right font-medium",
                          total.net < 0 ? "text-red-400" : "text-accent-400",
                        )}
                      >
                        {fmt(total.net)}
                      </td>
                      {preset.mode === "hours" && (
                        <td className="text-right text-ink-300">
                          {fmt(total.perHour)}
                        </td>
                      )}
                      <td className="text-right">
                        {total.terminalCapped && (
                          <span
                            className="text-amber-400 cursor-help"
                            title="Terminal cap reached within the window - total is clamped at maxQuantityInTerminal"
                          >
                            ⏶
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No output" />
          )}
        </Card>

        {/* Per-creature breakdown with inline counts */}
        <Card
          title={`Per-creature breakdown (${filteredRules.length})`}
          actions={
            <span className="text-xs text-ink-400">
              Set counts directly on each creature
            </span>
          }
        >
          <div className="flex flex-col gap-2 max-h-[calc(100vh-360px)] overflow-y-auto pr-1">
            {filteredRules.map((ruleResult) => (
              <RuleBreakdown
                key={ruleResult.ruleId}
                ruleResult={ruleResult}
                count={counts[ruleResult.ruleId] ?? defaultCount}
                onCount={(n) => setCounts({ ...counts, [ruleResult.ruleId]: n })}
                expanded={expanded.has(ruleResult.ruleId)}
                onToggle={() => toggleExpanded(ruleResult.ruleId)}
              />
            ))}
            {filteredRules.length === 0 && (
              <p className="text-sm text-ink-400 py-4">No matching creatures.</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function RuleBreakdown({
  ruleResult,
  count,
  onCount,
  expanded,
  onToggle,
}: {
  ruleResult: SimRuleResult;
  count: number;
  onCount: (n: number) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const index = useCatalogIndex();
  const bodyId = useId();
  const name = displayNameFor(index, "creatures", ruleResult.dinoType);

  const netSummary = useMemo(() => {
    let produced = 0;
    let consumed = 0;
    for (const cycle of ruleResult.cycles) {
      for (const flow of cycle.flows) {
        produced += flow.produced;
        consumed += flow.consumed;
      }
    }
    return { produced, consumed };
  }, [ruleResult]);

  return (
    <div className="border border-ink-700 rounded-lg bg-ink-850">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer text-left"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
        >
          <span
            className={cx(
              "text-xs transition-transform shrink-0",
              expanded && "rotate-90",
            )}
          >
            ▸
          </span>
          <EntityIcon bpPath={ruleResult.dinoType} kind="creatures" size={20} />
          <span className="text-sm font-medium text-ink-100 truncate">
            {name}
          </span>
          <span className="text-xs text-ink-400 shrink-0">
            +{fmt(netSummary.produced)}
            {netSummary.consumed > 0 && ` / −${fmt(netSummary.consumed)}`}
          </span>
        </button>
        <label className="flex items-center gap-1.5 shrink-0">
          <span className="text-xs text-ink-400">Count</span>
          <Input
            type="number"
            min={0}
            className="w-20"
            value={count}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0) onCount(n);
            }}
          />
        </label>
      </div>

      {expanded && (
        <div id={bodyId} className="px-3 pb-3 flex flex-col gap-3 border-t border-ink-700/60 pt-2">
          {ruleResult.cycles.map((cycle) => (
            <div key={cycle.cycleId}>
              <div className="text-xs text-ink-400 mb-1">
                {cycle.name || "Cycle"} - every {cycle.intervalSeconds}s ·{" "}
                {cycle.attempts} attempt{cycle.attempts === 1 ? "" : "s"} in
                window
              </div>
              <div className="flex flex-col gap-0.5">
                {cycle.flows.map((flow, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-ink-200 truncate mr-3 flex items-center gap-1.5">
                      <EntityIcon bpPath={flow.bpPath} kind="items" />
                      {displayNameFor(index, "items", flow.bpPath)}
                      {flow.perCycleCapHit && (
                        <span className="text-amber-400 text-xs">
                          cycle-capped
                        </span>
                      )}
                      {flow.terminalCapHit && (
                        <span className="text-amber-400 text-xs">
                          terminal cap after {fmt(flow.hoursToTerminalCap ?? 0)}h
                        </span>
                      )}
                    </span>
                    <span
                      className={cx(
                        "shrink-0",
                        flow.consumed > 0 ? "text-amber-400" : "text-ink-200",
                      )}
                    >
                      {flow.consumed > 0
                        ? `−${fmt(flow.consumed)}`
                        : `+${fmt(flow.produced)}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
