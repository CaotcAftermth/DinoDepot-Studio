import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { recordActivity, useDraftsStore } from "../../stores/draftsStore";
import { useProjectStore } from "../../stores/projectStore";
import { CreatureRule } from "../../model/production";
import { newId } from "../../model/ids";
import { productionToText } from "../../serializers/production";
import { validateProduction } from "../../validation/production";
import { countIssues } from "../../validation/types";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  Input,
  PageHeader,
} from "../../components/ui";
import { toast } from "../../components/toast";
import { chooseDialog, confirmDialog } from "../../components/confirm";
import {
  findDuplicateRule,
  isUntouchedRule,
  resolveSelectionParent,
} from "../../model/productionSelect";
import { shortClassName } from "../../services/spawnCommands";
import { EntityIcon } from "../../components/EntityIcon";
import { RuleEditor } from "./RuleEditor";
import { displayNameFor, useCatalogIndex } from "../../stores/useCatalogIndex";
import { pickFile } from "../../services/dialogs";
import { ipc } from "../../services/ipc";
import { importProductionText } from "../../services/importers";
import { plural } from "../../model/text";
import { useUiPrefsStore } from "../../stores/uiPrefsStore";

export function ProductionRulesPage() {
  const { production, setProduction, catalog, setCatalog, hydrate } =
    useDraftsStore();
  const settings = useProjectStore((s) => s.settings);
  useEffect(hydrate, [hydrate]);

  const index = useCatalogIndex();

  // Fold state is remembered per rule and per cycle; drop the entries whose
  // rule or cycle no longer exists.
  const prunePrefs = useUiPrefsStore((s) => s.prune);
  useEffect(() => {
    prunePrefs("rule:", production.rules.map((r) => `rule:${r.id}`));
    prunePrefs(
      "cycle:",
      production.rules.flatMap((r) => r.cycles.map((c) => `cycle:${c.id}`)),
    );
  }, [production.rules, prunePrefs]);

  // `/production/<ruleId>` opens straight onto that rule, which is how a
  // validation row on Overview reaches the thing it is complaining about.
  const { ruleId } = useParams();
  const [selectedId, setSelectedId] = useState<string | null>(ruleId ?? null);
  useEffect(() => {
    if (ruleId) setSelectedId(ruleId);
  }, [ruleId]);
  const [search, setSearch] = useState("");
  const [showJson, setShowJson] = useState(false);

  const issues = useMemo(
    () => validateProduction(production, index),
    [production, index],
  );
  const issuesByRule = useMemo(() => {
    const map = new Map<string, typeof issues>();
    for (const issue of issues) {
      const list = map.get(issue.entityId) ?? [];
      list.push(issue);
      map.set(issue.entityId, list);
    }
    return map;
  }, [issues]);

  const filteredRules = useMemo(() => {
    const q = search.toLowerCase();
    const matching = q
      ? production.rules.filter((rule) => {
          const name = displayNameFor(index, "creatures", rule.dinoType);
          return (
            name.toLowerCase().includes(q) ||
            rule.dinoType.toLowerCase().includes(q) ||
            rule.notes.toLowerCase().includes(q)
          );
        })
      : production.rules;

    // Sorted by creature name, not by when the rule was added: the list is how
    // you find a rule, and file order is meaningless to anyone looking for the
    // Rex. A rule with no creature yet is the one just added, so it goes last
    // rather than sorting under "(".
    return [...matching].sort((a, b) => {
      if (!a.dinoType || !b.dinoType) return a.dinoType ? -1 : b.dinoType ? 1 : 0;
      return displayNameFor(index, "creatures", a.dinoType).localeCompare(
        displayNameFor(index, "creatures", b.dinoType),
        undefined,
        { sensitivity: "base" },
      );
    });
  }, [production.rules, search, index]);

  const selected = production.rules.find((r) => r.id === selectedId) ?? null;
  const jsonPreview = useMemo(
    () => (showJson ? productionToText(production) : ""),
    [showJson, production],
  );
  const totals = countIssues(issues);

  function addRule() {
    if (!settings) return;
    const rule: CreatureRule = {
      id: newId(),
      enabled: true,
      notes: "",
      dinoType: "",
      chanceToProduce: settings.defaults.chanceToProduce,
      cycles: [
        {
          id: newId(),
          name: "",
          intervalSeconds: settings.defaults.intervalSeconds,
          itemSelectMode: 0,
          items: [],
        },
      ],
    };
    setProduction({ ...production, rules: [...production.rules, rule] });
    setSelectedId(rule.id);
    recordActivity({ kind: "production", title: "Added a production rule" });
  }

  function updateRule(next: CreatureRule) {
    setProduction({
      ...production,
      rules: production.rules.map((r) => (r.id === next.id ? next : r)),
    });
  }

  function blankCycle() {
    return {
      id: newId(),
      name: "",
      intervalSeconds: settings?.defaults.intervalSeconds ?? 300,
      itemSelectMode: 0 as const,
      items: [],
    };
  }

  /**
   * Applies a creature choice to a rule, checking the two things that catch
   * admins out:
   *
   * 1. Variants. Dino Depot reads a child class as its parent, so one rule on
   *    the Rex already covers every Rex variant on the cluster — a separate
   *    rule per variant is usually wasted work. It stays available, because
   *    that is exactly how you give one variant its own output.
   * 2. Duplicates. A second rule for a creature that already has one is
   *    almost always meant to be another cycle on the existing rule.
   */
  async function selectCreature(
    rule: CreatureRule,
    rawPath: string,
  ): Promise<"repick" | void> {
    const bpPath = rawPath.trim();
    if (!bpPath) {
      updateRule({ ...rule, dinoType: "" });
      return;
    }

    let chosen = bpPath;
    const parent = resolveSelectionParent(bpPath, index, catalog.variantParents);

    if (parent) {
      const childName = displayNameFor(index, "creatures", bpPath);
      const answer = await chooseDialog({
        title: `${childName} is a variant of ${parent.label}`,
        message:
          `Dino Depot treats a child class as its parent, so a rule on ${parent.label} ` +
          `already applies to ${childName} — you don't need a rule per variant.\n\n` +
          `Add one only when this variant should produce something different.`,
        // Display names repeat across mods; the class is what actually differs.
        details: [
          `Variant class: ${shortClassName(bpPath)}`,
          parent.bpPath ? `Parent class: ${shortClassName(parent.bpPath)}` : "",
        ].filter(Boolean),
        options: [
          {
            key: "parent",
            label: `Use ${parent.label} instead`,
            variant: "primary",
            hint: "Covers this variant and every other one",
          },
          {
            key: "child",
            label: `Use ${childName} anyway`,
            hint: "Give this variant its own production",
          },
        ],
      });
      if (!answer) return;
      if (answer === "parent" && parent.bpPath) chosen = parent.bpPath;
    }

    const existing = findDuplicateRule(production.rules, rule.id, chosen);
    if (existing) {
      const name = displayNameFor(index, "creatures", chosen);
      const answer = await chooseDialog({
        title: `${name} already has a rule`,
        message:
          `That rule has ${plural(existing.cycles.length, "production cycle")}. ` +
          `Two rules for the same creature would both apply, so add a cycle to ` +
          `the existing one — or pick a different creature.`,
        details: [`Class: ${shortClassName(chosen)}`],
        options: [
          {
            key: "cycle",
            label: "Add a cycle to the existing rule",
            variant: "primary",
          },
          {
            key: "repick",
            label: "Change creature",
            hint: "Leaves this rule's creature as it was",
          },
        ],
        // Two rules for one creature is never the right answer, so there is
        // deliberately no way to create one.
        cancelLabel: null,
      });
      if (answer === "repick") return "repick";
      if (!answer) return;
      if (answer === "cycle") {
        const rules = production.rules
          // A blank rule that only existed to prompt this is just scaffolding;
          // a rule the admin had already filled in is left exactly as it was.
          .filter((r) => r.id !== rule.id || !isUntouchedRule(rule))
          .map((r) =>
            r.id === existing.id
              ? { ...r, cycles: [...r.cycles, blankCycle()] }
              : r,
          );
        setProduction({ ...production, rules });
        setSelectedId(existing.id);
        toast.success(`Cycle added to the ${name} rule`);
        return;
      }
    }

    updateRule({ ...rule, dinoType: chosen });
  }

  async function deleteRule(rule: CreatureRule) {
    const name = displayNameFor(index, "creatures", rule.dinoType);
    const ok = await confirmDialog({
      title: `Delete the rule for "${name}"?`,
      message: "Its production cycles, items, alternates and consumed inputs go with it.",
      confirmLabel: "Delete rule",
      danger: true,
    });
    if (!ok) return;
    setProduction({
      ...production,
      rules: production.rules.filter((r) => r.id !== rule.id),
    });
    if (selectedId === rule.id) setSelectedId(null);
    recordActivity({ kind: "production", title: `Deleted rule for ${name}` });
  }

  function duplicateRule(rule: CreatureRule) {
    const copy: CreatureRule = structuredClone(rule);
    copy.id = newId();
    copy.enabled = false;
    copy.dinoType = "";
    copy.cycles.forEach((c) => {
      c.id = newId();
      c.items.forEach((i) => {
        i.id = newId();
        i.alternateItems.forEach((s) => (s.id = newId()));
        i.consumesItems.forEach((s) => (s.id = newId()));
      });
    });
    setProduction({ ...production, rules: [...production.rules, copy] });
    setSelectedId(copy.id);
    recordActivity({
      kind: "production",
      title: `Duplicated the ${displayNameFor(index, "creatures", rule.dinoType)} rule`,
    });
    toast.info("Rule duplicated (disabled, creature cleared) — pick the new creature");
  }

  async function importFromFile() {
    const path = await pickFile("Select your live passive production JSON file");
    if (!path) return;
    try {
      const text = await ipc<string>("read_text_file", { path });
      const result = importProductionText(text, catalog);
      if (production.rules.length > 0) {
        const ok = await confirmDialog({
          title: "Replace draft rules?",
          message: `The current ${production.rules.length} draft rule(s) will be replaced by ${result.draft.rules.length} imported rule(s).`,
          confirmLabel: "Replace",
          danger: true,
        });
        if (!ok) return;
      }
      setProduction(result.draft);
      setCatalog(result.catalog);
      setSelectedId(null);
      recordActivity({
        kind: "production",
        title: `Imported ${plural(result.draft.rules.length, "production rule")}`,
        detail: "from a live passive production file",
      });
      toast.success(
        `Imported ${result.draft.rules.length} rules` +
          (result.catalogAdded > 0
            ? ` — ${result.catalogAdded} unknown paths added to "Imported / unsorted"`
            : ""),
      );
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <div>
      <PageHeader
        title="Production Rules"
        subtitle={`${production.rules.length} rules · ${totals.errors} errors · ${totals.warnings} warnings`}
        actions={
          <>
            <Button onClick={importFromFile}>Import live file…</Button>
            <Button onClick={() => setShowJson(!showJson)}>
              {showJson ? "Hide JSON" : "Show JSON"}
            </Button>
            <Button variant="primary" onClick={addRule}>
              + Add rule
            </Button>
          </>
        }
      />

      <div
        className={cx(
          "grid gap-5",
          showJson
            ? "grid-cols-[260px_minmax(0,1fr)_420px]"
            : "grid-cols-[260px_minmax(0,1fr)]",
        )}
      >
        {/* Rule list */}
        <div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rules…"
            className="mb-2"
          />
          <div className="flex flex-col gap-1.5 max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
            {filteredRules.map((rule) => {
              const ruleIssues = issuesByRule.get(rule.id) ?? [];
              const { errors, warnings } = countIssues(ruleIssues);
              const name = rule.dinoType
                ? displayNameFor(index, "creatures", rule.dinoType)
                : "(new rule)";
              return (
                <button
                  key={rule.id}
                  onClick={() => setSelectedId(rule.id)}
                  className={cx(
                    "text-left px-3 py-2 rounded-lg border cursor-pointer",
                    rule.id === selectedId
                      ? "bg-ink-800 border-accent-500/50"
                      : "bg-ink-900 border-ink-700 hover:border-ink-600",
                    !rule.enabled && "opacity-50",
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {rule.dinoType && (
                      <EntityIcon
                        bpPath={rule.dinoType}
                        kind="creatures"
                        name={name}
                        size={36}
                      />
                    )}
                    <div className="flex flex-col min-w-0">
                      <div className="text-sm font-medium text-ink-100 truncate">
                        {name}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-xs text-ink-400">
                          {rule.cycles.length} cycle
                          {rule.cycles.length === 1 ? "" : "s"}
                        </span>
                        {errors > 0 && <Badge tone="error">{errors}</Badge>}
                        {warnings > 0 && <Badge tone="warn">{warnings}</Badge>}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
            {filteredRules.length === 0 && (
              <p className="text-sm text-ink-400 px-2 py-4">
                {search ? "No matches." : "No rules yet."}
              </p>
            )}
          </div>
        </div>

        {/* Editor */}
        <div className="min-w-0">
          {selected && settings ? (
            <RuleEditor
              rule={selected}
              issues={issuesByRule.get(selected.id) ?? []}
              defaults={settings.defaults}
              onChange={updateRule}
              onSelectCreature={(bpPath) => selectCreature(selected, bpPath)}
              onDelete={() => deleteRule(selected)}
              onDuplicate={() => duplicateRule(selected)}
            />
          ) : (
            <EmptyState title="Select a rule to edit">
              Or add a new rule, or import your live passive production file.
            </EmptyState>
          )}
        </div>

        {/* JSON preview */}
        {showJson && (
          <div className="min-w-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
                Published JSON preview
              </span>
              <Button
                variant="ghost"
                onClick={() => {
                  navigator.clipboard.writeText(jsonPreview);
                  toast.success("JSON copied to clipboard");
                }}
              >
                Copy
              </Button>
            </div>
            <pre className="mono bg-ink-950 border border-ink-700 rounded-lg p-3 overflow-auto max-h-[calc(100vh-220px)] text-ink-200 whitespace-pre">
              {jsonPreview}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
