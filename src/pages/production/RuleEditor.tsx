import { useEffect, useState } from "react";
import {
  CreatureRule,
  PrimaryItem,
  ProductionCycle,
  SELECT_MODE_LABELS,
  SelectMode,
  SubItem,
} from "../../model/production";
import { newId } from "../../model/ids";
import {
  Badge,
  Button,
  Card,
  CollapsibleCard,
  cx,
  Field,
  Input,
  Select,
  Toggle,
} from "../../components/ui";
import { BlueprintPicker } from "../../components/BlueprintPicker";
import { EntityIcon } from "../../components/EntityIcon";
import { displayNameFor, useCatalogIndex } from "../../stores/useCatalogIndex";
import type { ValidationIssue } from "../../validation/types";
import type { ProjectSettings } from "../../model/project";
import { feedbackTarget } from "../../model/feedback/targets";
import { shortClassName } from "../../services/spawnCommands";

function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: string;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </Field>
  );
}

/**
 * A cap where zero means "no cap".
 *
 * Rendered empty with an "Unlimited" placeholder rather than as a literal `0`,
 * because `0` reads as "produce none of this" — the opposite of what it does.
 * The stored value is still 0, which is what the published file wants; only
 * the way it is shown changes.
 */
function MaxField({
  label,
  value,
  onChange,
  labelled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  /** Screen-reader label when the visible one is a column heading. */
  labelled?: string;
}) {
  const unlimited = !(value > 0);
  return (
    <Field label={label}>
      <Input
        type="number"
        min={0}
        // An empty box is the unlimited state, so blanking the field has to
        // mean the same thing as typing 0 rather than leaving NaN behind.
        value={unlimited ? "" : String(value)}
        placeholder="Unlimited"
        aria-label={labelled ?? label}
        className={cx(unlimited && "text-ink-500")}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return onChange(0);
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(Math.max(0, n));
        }}
      />
    </Field>
  );
}

/**
 * Icon, name and class for one catalog entry, as the sub-item rows show it.
 *
 * The primary item used to show its raw path in a full-width text field above
 * a separate row of numbers, which made the same item look like a different
 * kind of thing depending on which list it was in.
 */
function ItemIdentity({ bpPath }: { bpPath: string }) {
  const catalogIndex = useCatalogIndex();
  return (
    <div className="min-w-0 flex items-center gap-1.5">
      <EntityIcon bpPath={bpPath} kind="items" />
      <div className="min-w-0">
        <div className="text-xs text-ink-300 truncate">
          {bpPath
            ? displayNameFor(catalogIndex, "items", bpPath)
            : "(no item selected)"}
        </div>
        <div className="mono text-xs text-ink-500 truncate" title={bpPath}>
          {bpPath ? shortClassName(bpPath) : "—"}
        </div>
      </div>
    </div>
  );
}

function SelectModeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: SelectMode;
  onChange: (v: SelectMode) => void;
}) {
  return (
    <Field label={label}>
      <Select
        value={value}
        onChange={(e) => onChange(Number(e.target.value) as SelectMode)}
      >
        {([0, 1, 2] as const).map((mode) => (
          <option key={mode} value={mode}>
            {mode} — {SELECT_MODE_LABELS[mode]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** 0.25 -> "25%" — QoL readout under the decimal chance inputs. */
function formatChance(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const pct = Math.round(value * 100 * 100) / 100;
  return `${pct}%`;
}

function formatInterval(seconds: number): string {
  if (!(seconds > 0)) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ---------------------------------------------------------------------------

export function RuleEditor({
  rule,
  issues,
  defaults,
  onChange,
  onSelectCreature,
  onDelete,
  onDuplicate,
  awaitingCreature = false,
  onCreaturePickerDismissed,
}: {
  rule: CreatureRule;
  issues: ValidationIssue[];
  defaults: ProjectSettings["defaults"];
  onChange: (rule: CreatureRule) => void;
  /**
   * Runs the variant/duplicate checks before the path is applied. Resolves
   * "repick" when the admin asked to choose a different creature.
   */
  onSelectCreature: (bpPath: string) => Promise<"repick" | void>;
  onDelete: () => void;
  onDuplicate: () => void;
  /**
   * True while this rule is one the admin has just created and has not yet
   * given a creature. The picker opens on top of it without being asked for.
   */
  awaitingCreature?: boolean;
  /** The picker closed. The page decides whether the rule survives. */
  onCreaturePickerDismissed?: () => void;
}) {
  const index = useCatalogIndex();
  const [pickingCreature, setPickingCreature] = useState(false);
  // Typed paths are checked when the field is done being edited, so the
  // prompts don't fire on a half-typed class name.
  const [typedPath, setTypedPath] = useState<string | null>(null);

  /** Applies a choice, reopening the picker when the admin wants another go. */
  async function chooseCreature(bpPath: string) {
    if ((await onSelectCreature(bpPath)) === "repick") setPickingCreature(true);
  }

  // A rule with no creature is not a rule yet, so the question is asked the
  // moment one is created or duplicated. Keyed on the rule id as well, so
  // duplicating twice in a row asks again for the second copy.
  useEffect(() => {
    if (awaitingCreature) setPickingCreature(true);
  }, [awaitingCreature, rule.id]);

  /**
   * Closing the picker.
   *
   * Told to the page rather than handled here: whether an abandoned rule is
   * deleted depends on the rules list, which is the page's to change.
   */
  function closeCreaturePicker() {
    setPickingCreature(false);
    onCreaturePickerDismissed?.();
  }
  const creatureName = rule.dinoType
    ? displayNameFor(index, "creatures", rule.dinoType)
    : "(no creature selected)";

  function newItem(): PrimaryItem {
    return {
      id: newId(),
      bpPath: "",
      quantityPerDino: defaults.quantityPerDino,
      maxQuantityPerCycle: defaults.maxQuantityPerCycle,
      maxQuantityInTerminal: defaults.maxQuantityInTerminal,
      alternateSelectMode: 0,
      alternateItemsChance: 0,
      alternateItems: [],
      consumesSelectMode: 0,
      consumesItemsChance: 0,
      consumesItems: [],
    };
  }

  function updateCycle(cycleId: string, patch: Partial<ProductionCycle>) {
    onChange({
      ...rule,
      cycles: rule.cycles.map((c) => (c.id === cycleId ? { ...c, ...patch } : c)),
    });
  }

  return (
    <div
      className="flex flex-col gap-4"
      {...feedbackTarget("production-rule-card")}
    >
      <CollapsibleCard
        prefKey={`rule:${rule.id}`}
        title={
          <span className="flex items-center gap-2">
            {rule.dinoType && (
              <EntityIcon
                bpPath={rule.dinoType}
                kind="creatures"
                name={creatureName}
                size={60}
              />
            )}
            {creatureName}
            {!rule.enabled && <Badge tone="neutral">Disabled</Badge>}
          </span>
        }
        actions={
          <>
            {/* The label states what the rule *is*, not what the switch
                would do — a switch already reads as its own verb, and
                "Enabled" beside an off switch is a sentence nobody can
                parse in one look. */}
            <Toggle
              checked={rule.enabled}
              onChange={(v) => onChange({ ...rule, enabled: v })}
              label={rule.enabled ? "Enabled" : "Disabled"}
            />
            <Button onClick={onDuplicate}>Duplicate</Button>
            <Button variant="danger" onClick={onDelete}>
              Delete rule
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-[1fr_140px] gap-3 mb-3">
          <Field label="Creature blueprint path">
            <div className="flex gap-2">
              <Input
                className="mono"
                value={typedPath ?? rule.dinoType}
                onChange={(e) => setTypedPath(e.target.value)}
                onBlur={() => {
                  const next = typedPath;
                  setTypedPath(null);
                  if (next !== null && next.trim() !== rule.dinoType) {
                    void chooseCreature(next);
                  }
                }}
                placeholder="/Game/…/Creature_Character_BP.Creature_Character_BP"
              />
              <Button onClick={() => setPickingCreature(true)}>Pick…</Button>
            </div>
          </Field>
          <NumberField
            label="Chance to produce"
            value={rule.chanceToProduce}
            step="0.05"
            min={0}
            max={1}
            onChange={(v) => onChange({ ...rule, chanceToProduce: v })}
            hint={formatChance(rule.chanceToProduce)}
          />
        </div>
        <Field label="Notes" hint="Internal only — never published">
          <Input
            value={rule.notes}
            onChange={(e) => onChange({ ...rule, notes: e.target.value })}
            placeholder="Why this rule exists, balance context, etc."
          />
        </Field>
      </CollapsibleCard>

      {issues.length > 0 && (
        <Card title={`Validation (${issues.length})`}>
          <div className="flex flex-col gap-1.5">
            {issues.map((issue, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <Badge tone={issue.level === "error" ? "error" : "warn"}>
                  {issue.level}
                </Badge>
                <span className="text-ink-300">
                  <span className="text-ink-400">{issue.where}:</span>{" "}
                  {issue.message}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {rule.cycles.map((cycle, cycleIdx) => (
        <CycleEditor
          key={cycle.id}
          cycle={cycle}
          index={cycleIdx}
          onChange={(patch) => updateCycle(cycle.id, patch)}
          onDelete={() =>
            onChange({
              ...rule,
              cycles: rule.cycles.filter((c) => c.id !== cycle.id),
            })
          }
          newItem={newItem}
        />
      ))}

      <Button
        onClick={() =>
          onChange({
            ...rule,
            cycles: [
              ...rule.cycles,
              {
                id: newId(),
                name: "",
                intervalSeconds: defaults.intervalSeconds,
                itemSelectMode: 0,
                // No blank item: "+ Add item" asks which item, so one that
                // arrives already empty is a row to delete, not a head start.
                items: [],
              },
            ],
          })
        }
      >
        + Add production cycle
      </Button>

      {pickingCreature && (
        <BlueprintPicker
          kind="creatures"
          title="Pick a creature"
          // Variants collapse onto their parent here: a rule on the parent
          // already covers them, so listing every one only gets in the way.
          variantToggle
          onClose={closeCreaturePicker}
          onPick={(bpPath) => {
            setPickingCreature(false);
            void chooseCreature(bpPath);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CycleEditor({
  cycle,
  index,
  onChange,
  onDelete,
  newItem,
}: {
  cycle: ProductionCycle;
  index: number;
  onChange: (patch: Partial<ProductionCycle>) => void;
  onDelete: () => void;
  newItem: () => PrimaryItem;
}) {
  const [pickingItem, setPickingItem] = useState(false);

  return (
    <CollapsibleCard
      prefKey={`cycle:${cycle.id}`}
      feedback={feedbackTarget("production-rule-cycle-editor")}
      title={
        <span className="block truncate">
          {/* A named cycle answers "which one is this?" better than its
              position ever could, so the number is only the fallback. */}
          {cycle.name.trim() || `Cycle ${index + 1}`}
          <span className="text-ink-400 font-normal">
            {" "}
            · every {formatInterval(cycle.intervalSeconds)} ·{" "}
            {SELECT_MODE_LABELS[cycle.itemSelectMode]} of {cycle.items.length} item
            {cycle.items.length === 1 ? "" : "s"}
          </span>
        </span>
      }
      actions={
        <Button variant="ghost" onClick={onDelete}>
          Remove cycle
        </Button>
      }
    >
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Field label="Cycle name" hint="Organizational only">
          <Input
            value={cycle.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Standard Resource Production"
          />
        </Field>
        <div {...feedbackTarget("production-rule-cycle-interval")}>
          <NumberField
            label="Interval (seconds)"
            value={cycle.intervalSeconds}
            min={1}
            onChange={(v) => onChange({ intervalSeconds: v })}
            hint={formatInterval(cycle.intervalSeconds)}
          />
        </div>
        <SelectModeField
          label="Item select mode"
          value={cycle.itemSelectMode}
          onChange={(v) => onChange({ itemSelectMode: v })}
        />
      </div>

      <div className="flex flex-col gap-3">
        {cycle.items.map((item, itemIdx) => (
          <ItemEditor
            key={item.id}
            item={item}
            index={itemIdx}
            onChange={(next) =>
              onChange({
                items: cycle.items.map((it) => (it.id === item.id ? next : it)),
              })
            }
            onDelete={() =>
              onChange({ items: cycle.items.filter((it) => it.id !== item.id) })
            }
          />
        ))}
      </div>

      <Button className="mt-3" onClick={() => setPickingItem(true)}>
        + Add item
      </Button>

      {/* The item comes first here, as it does for an alternate or a consumed
          input. Adding a blank row and then hunting for the Pick button was
          the same job in two more steps. */}
      {pickingItem && (
        <BlueprintPicker
          kind="items"
          title="Pick an item"
          variantToggle
          onClose={() => setPickingItem(false)}
          onPick={(bpPath) => {
            setPickingItem(false);
            onChange({ items: [...cycle.items, { ...newItem(), bpPath }] });
          }}
        />
      )}
    </CollapsibleCard>
  );
}

// ---------------------------------------------------------------------------

function ItemEditor({
  item,
  index,
  onChange,
  onDelete,
}: {
  item: PrimaryItem;
  index: number;
  onChange: (item: PrimaryItem) => void;
  onDelete: () => void;
}) {
  const catalogIndex = useCatalogIndex();
  const [expanded, setExpanded] = useState(false);
  const [picking, setPicking] = useState(false);
  const name = item.bpPath
    ? displayNameFor(catalogIndex, "items", item.bpPath)
    : "(no item selected)";

  return (
    <div className="border border-ink-700 rounded-lg bg-ink-850">
      <button
        className="w-full flex items-center justify-between px-3 py-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center gap-2 text-sm">
          <span className={cx("transition-transform", expanded && "rotate-90")}>
            ▸
          </span>
          {item.bpPath && <EntityIcon bpPath={item.bpPath} kind="items" />}
          <span className="font-medium text-ink-100">
            Item {index + 1}: {name}
          </span>
          <span className="text-ink-400">
            ×{item.quantityPerDino}/dino
            {item.alternateItems.length > 0 &&
              ` · ${item.alternateItems.length} alt`}
            {item.consumesItems.length > 0 &&
              ` · consumes ${item.consumesItems.length}`}
          </span>
        </span>
        <span
          className="text-ink-400 hover:text-red-400 px-1"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ✕
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-4">
          {/* Laid out exactly like an alternate or a consumed input: it is
              the same three numbers against the same kind of item, and the
              old full-width path field made it look like something else. */}
          <div className="grid grid-cols-[1fr_90px_90px_90px_auto] gap-2 items-end">
            <ItemIdentity bpPath={item.bpPath} />
            <div {...feedbackTarget("production-rule-cycle-quantity")}>
              <NumberField
                label="Qty/dino"
                value={item.quantityPerDino}
                min={0}
                onChange={(v) => onChange({ ...item, quantityPerDino: v })}
              />
            </div>
            <MaxField
              label="Max/cycle"
              labelled="Max per cycle"
              value={item.maxQuantityPerCycle}
              onChange={(v) => onChange({ ...item, maxQuantityPerCycle: v })}
            />
            <MaxField
              label="Max/terminal"
              labelled="Max in terminal"
              value={item.maxQuantityInTerminal}
              onChange={(v) => onChange({ ...item, maxQuantityInTerminal: v })}
            />
            <Button className="mb-0.5" onClick={() => setPicking(true)}>
              {item.bpPath ? "Change…" : "Pick…"}
            </Button>
          </div>

          <SubItemsSection
            tone="alternates"
            title="Alternate outputs"
            hint="Bonus/alternate output pool that can roll alongside this item"
            selectMode={item.alternateSelectMode}
            chance={item.alternateItemsChance}
            subs={item.alternateItems}
            onModeChange={(v) => onChange({ ...item, alternateSelectMode: v })}
            onChanceChange={(v) => onChange({ ...item, alternateItemsChance: v })}
            onSubsChange={(subs) => onChange({ ...item, alternateItems: subs })}
          />

          <SubItemsSection
            tone="consumes"
            title="Consumed inputs"
            hint="Items taken FROM the terminal when this output produces"
            selectMode={item.consumesSelectMode}
            chance={item.consumesItemsChance}
            subs={item.consumesItems}
            onModeChange={(v) => onChange({ ...item, consumesSelectMode: v })}
            onChanceChange={(v) => onChange({ ...item, consumesItemsChance: v })}
            onSubsChange={(subs) => onChange({ ...item, consumesItems: subs })}
          />
        </div>
      )}

      {picking && (
        <BlueprintPicker
          kind="items"
          title="Pick an item"
          // Fertilized eggs are variants of their egg; collapsing keeps the
          // list the length it was before they existed.
          variantToggle
          onClose={() => setPicking(false)}
          onPick={(bpPath) => {
            onChange({ ...item, bpPath });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const SUB_SECTION_TONES = {
  alternates: {
    icon: "🎲",
    container: "border-violet-500/40 bg-violet-500/[0.04] border-l-4 border-l-violet-500/70",
    heading: "text-violet-300",
  },
  consumes: {
    icon: "🔻",
    // Amber, not red: consumption is normal behavior, not an error state.
    container: "border-amber-600/40 bg-amber-500/[0.05] border-l-4 border-l-amber-500/70",
    heading: "text-amber-300",
  },
} as const;

function SubItemsSection({
  tone,
  title,
  hint,
  selectMode,
  chance,
  subs,
  onModeChange,
  onChanceChange,
  onSubsChange,
}: {
  tone: keyof typeof SUB_SECTION_TONES;
  title: string;
  hint: string;
  selectMode: SelectMode;
  chance: number;
  subs: SubItem[];
  onModeChange: (v: SelectMode) => void;
  onChanceChange: (v: number) => void;
  onSubsChange: (subs: SubItem[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const style = SUB_SECTION_TONES[tone];

  return (
    <div className={cx("border rounded-md p-3", style.container)}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <div
            className={cx(
              "text-xs font-semibold uppercase tracking-wide",
              style.heading,
            )}
          >
            {style.icon} {title} ({subs.length})
          </div>
          <div className="text-xs text-ink-400">{hint}</div>
        </div>
        <Button variant="ghost" onClick={() => setPicking(true)}>
          + Add
        </Button>
      </div>

      {subs.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <SelectModeField
              label="Select mode"
              value={selectMode}
              onChange={onModeChange}
            />
            <NumberField
              label="Activation chance"
              value={chance}
              step="0.05"
              min={0}
              max={1}
              onChange={onChanceChange}
              hint={formatChance(chance)}
            />
          </div>
          <div className="flex flex-col gap-2">
            {subs.map((sub) => (
              <div
                key={sub.id}
                className="grid grid-cols-[1fr_90px_90px_90px_28px] gap-2 items-end"
              >
                <ItemIdentity bpPath={sub.bpPath} />
                <Field label="Qty">
                  <Input
                    type="number"
                    min={0}
                    value={sub.quantityPerItem}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (!Number.isFinite(n)) return;
                      onSubsChange(
                        subs.map((s) =>
                          s.id === sub.id ? { ...s, quantityPerItem: n } : s,
                        ),
                      );
                    }}
                  />
                </Field>
                <MaxField
                  label="Max/cycle"
                  labelled={`Max per cycle for ${sub.bpPath || "this item"}`}
                  value={sub.maxQuantityPerCycle}
                  onChange={(v) =>
                    onSubsChange(
                      subs.map((s) =>
                        s.id === sub.id ? { ...s, maxQuantityPerCycle: v } : s,
                      ),
                    )
                  }
                />
                <MaxField
                  label="Max/terminal"
                  labelled={`Max in terminal for ${sub.bpPath || "this item"}`}
                  value={sub.maxQuantityInTerminal}
                  onChange={(v) =>
                    onSubsChange(
                      subs.map((s) =>
                        s.id === sub.id ? { ...s, maxQuantityInTerminal: v } : s,
                      ),
                    )
                  }
                />
                <button
                  className="text-ink-400 hover:text-red-400 pb-2 cursor-pointer"
                  onClick={() =>
                    onSubsChange(subs.filter((s) => s.id !== sub.id))
                  }
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {picking && (
        <BlueprintPicker
          kind="items"
          title={`Add to ${title.toLowerCase()}`}
          variantToggle
          onClose={() => setPicking(false)}
          onPick={(bpPath) => {
            onSubsChange([
              ...subs,
              {
                id: newId(),
                bpPath,
                quantityPerItem: 1,
                maxQuantityPerCycle: 0,
                maxQuantityInTerminal: 0,
              },
            ]);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
