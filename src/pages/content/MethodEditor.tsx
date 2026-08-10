import { useState } from "react";
import { newId } from "../../model/ids";
import { normalizeBpPath } from "../../model/catalog";
import {
  AcquisitionInput,
  AcquisitionMethod,
  AcquisitionPhase,
  applyTemplate,
  describeTemplate,
  emptyPhase,
  phaseHasOutcomes,
  INPUT_ROLES,
  InputRole,
  METHOD_OUTCOMES,
  METHOD_TAGS,
  METHOD_TEMPLATES,
  MethodOutcome,
  MethodTag,
  MethodTemplate,
  OUTCOME_HINTS,
  OUTCOME_LABELS,
  REFERENCE_TYPES,
  ReferenceType,
  REFERENCE_LABELS,
  ROLE_LABELS,
  TAG_LABELS,
  TEMPLATE_MODE_LABELS,
  TemplateMode,
} from "../../model/creatureInfo";
import { BlueprintPicker } from "../../components/BlueprintPicker";
import { ReferenceInput } from "../../components/ReferenceText";
import { EntityIcon } from "../../components/EntityIcon";
import { displayNameFor, useCatalogIndex } from "../../stores/useCatalogIndex";
import {
  Button,
  cx,
  Field,
  Input,
  Modal,
  Select,
} from "../../components/ui";
import { toast } from "../../components/toast";
import { confirmDialog } from "../../components/confirm";

/**
 * One acquisition method: what it's called, how it's classified, what you need,
 * and the ordered phases of the process.
 *
 * Editorial rather than programmable — phases are cards with short steps, not
 * a node graph. The point is that an admin can write down Rhyniognatha's host
 * mechanic as readily as a Dodo's passive tame.
 */
export function MethodEditor({
  method,
  onChange,
  onRemove,
}: {
  method: AcquisitionMethod;
  onChange: (next: AcquisitionMethod) => void;
  onRemove: () => void;
}) {
  /**
   * Either the "add an input" flow (`kind` only) or a re-pick for one existing
   * row, which replaces that row's path instead of appending.
   */
  const [pickingInput, setPickingInput] = useState<{
    kind: "items" | "creatures";
    forInputId?: string;
  } | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [customTag, setCustomTag] = useState("");
  /** Input whose note is open for editing, if any. */
  const [notingInput, setNotingInput] = useState<string | null>(null);
  const catalogIndex = useCatalogIndex();

  /**
   * An input is well-formed when it says what it points at: free text needs a
   * label, a catalog reference needs a path that resolves in the catalog its
   * type names. Surfaced rather than blocked — a half-written method should
   * still save.
   */
  const inputProblems = method.inputs.filter((input) => {
    if (input.referenceType === "text") return !input.label.trim();
    if (!input.bpPath.trim()) return true;
    const kind = input.referenceType === "creature" ? "creatures" : "items";
    return !catalogIndex[kind].has(normalizeBpPath(input.bpPath));
  }).length;

  const set = (patch: Partial<AcquisitionMethod>) =>
    onChange({ ...method, ...patch });

  function toggleTag(tag: string) {
    set({
      tags: method.tags.includes(tag)
        ? method.tags.filter((t) => t !== tag)
        : [...method.tags, tag],
    });
  }

  /** Tags the admin typed — anything not backed by a preset chip above. */
  const freeTags = method.tags.filter(
    (t) => !(METHOD_TAGS as readonly string[]).includes(t),
  );

  function addCustomTag() {
    const tag = customTag.trim();
    if (!tag) return;
    // A typed tag that names a preset should light the preset up rather than
    // sit beside it as a near-duplicate.
    const preset = (METHOD_TAGS as readonly string[]).find(
      (t) =>
        t.toLowerCase() === tag.toLowerCase() ||
        TAG_LABELS[t as MethodTag].toLowerCase() === tag.toLowerCase(),
    );
    const value = preset ?? tag;
    if (method.tags.some((t) => t.toLowerCase() === value.toLowerCase())) {
      toast.info(`"${tag}" is already on this method`);
      setCustomTag("");
      return;
    }
    set({ tags: [...method.tags, value] });
    setCustomTag("");
  }

  // ---- inputs ----
  function addInput(bpPath: string, referenceType: "item" | "creature") {
    // A creature input is almost always the host it's being used as.
    const role = referenceType === "creature" ? "host-creature" : "taming-food";
    // The same item can legitimately appear twice in different roles — kibble
    // that is both the taming food and a crafting ingredient, say. Only an
    // identical path *and* role is a genuine duplicate.
    if (
      method.inputs.some(
        (i) =>
          i.bpPath &&
          normalizeBpPath(i.bpPath) === normalizeBpPath(bpPath) &&
          i.role === role,
      )
    ) {
      toast.info(
        `Already listed as "${ROLE_LABELS[role]}". To list it in two roles, change that row's role first, then add it again.`,
      );
      return;
    }
    set({
      inputs: [
        ...method.inputs,
        {
          id: newId(),
          referenceType,
          bpPath,
          label: "",
          role,
          qty: "",
          note: "",
        },
      ],
    });
  }

  function addFreeInput() {
    set({
      inputs: [
        ...method.inputs,
        {
          id: newId(),
          referenceType: "text",
          bpPath: "",
          label: "",
          role: "optional-aid",
          qty: "",
          note: "",
        },
      ],
    });
  }

  const patchInput = (id: string, patch: Partial<AcquisitionInput>) =>
    set({
      inputs: method.inputs.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    });

  const moveInput = (i: number, by: number) => {
    const inputs = [...method.inputs];
    const j = i + by;
    if (j < 0 || j >= inputs.length) return;
    [inputs[i], inputs[j]] = [inputs[j], inputs[i]];
    set({ inputs });
  };

  // ---- phases ----
  function addPhase() {
    set({ phases: [...method.phases, emptyPhase(newId(), "New phase")] });
  }

  const patchPhase = (id: string, patch: Partial<AcquisitionPhase>) =>
    set({
      phases: method.phases.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });

  const movePhase = (i: number, by: number) => {
    const phases = [...method.phases];
    const j = i + by;
    if (j < 0 || j >= phases.length) return;
    [phases[i], phases[j]] = [phases[j], phases[i]];
    set({ phases });
  };

  return (
    <div className="border border-ink-700 rounded-lg p-3">
      <div className="flex items-start gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <Field label="Method name">
            <Input
              value={method.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="e.g. Mounted hunt, Host impregnation"
            />
          </Field>
        </div>
        <div className="w-48 shrink-0">
          <Field
            label="Outcome"
            hint={
              method.outcome
                ? OUTCOME_HINTS[method.outcome as MethodOutcome]
                : "What this route leaves you with"
            }
          >
            <Select
              value={method.outcome}
              onChange={(e) =>
                set({ outcome: e.target.value as MethodOutcome | "" })
              }
            >
              <option value="">Unspecified</option>
              {METHOD_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_LABELS[o]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex gap-1 pt-5 shrink-0">
          <Button onClick={() => setTemplateOpen(true)}>Template…</Button>
          <Button variant="ghost" onClick={onRemove} title="Remove this method">
            ✕
          </Button>
        </div>
      </div>

      <div className="mb-3">
        <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1.5">
          Classification
        </span>
        <div className="flex flex-wrap gap-1.5">
          {METHOD_TAGS.map((tag) => (
            <button
              key={tag}
              onClick={() => toggleTag(tag)}
              className={cx(
                "text-xs px-2 py-1 rounded-full border cursor-pointer",
                method.tags.includes(tag)
                  ? "bg-accent-500/15 text-accent-400 border-accent-500/40"
                  : "border-ink-700 text-ink-400 hover:text-ink-200 hover:border-ink-600",
              )}
            >
              {TAG_LABELS[tag]}
            </button>
          ))}
          {/* The model takes any string, so anything the presets don't cover
              is typed here and shows alongside them. */}
          {freeTags.map((tag) => (
            <span
              key={tag}
              className="text-xs pl-2 pr-1 py-1 rounded-full border border-accent-500/40 bg-accent-500/15 text-accent-400 inline-flex items-center gap-1"
            >
              {tag}
              <button
                onClick={() => toggleTag(tag)}
                title={`Remove "${tag}"`}
                aria-label={`Remove tag ${tag}`}
                className="cursor-pointer text-accent-400/70 hover:text-white leading-none px-1"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-1.5 mt-1.5 max-w-xs">
          <Input
            className="text-xs"
            value={customTag}
            onChange={(e) => setCustomTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustomTag();
              }
            }}
            placeholder="Another classification…"
          />
          <Button
            variant="ghost"
            className="shrink-0"
            onClick={addCustomTag}
            disabled={!customTag.trim()}
          >
            Add
          </Button>
        </div>
      </div>

      <Field label="Requirements" hint="Gear, mounts, structures, levels">
        <Input
          value={method.requirements}
          onChange={(e) => set({ requirements: e.target.value })}
          placeholder="e.g. A tamed Equus, tranq arrows, a taming pen"
        />
      </Field>

      {/* ---- inputs ---- */}
      <div className="mt-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
            Inputs &amp; consumables
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              onClick={() => setPickingInput({ kind: "items" })}
            >
              + Item
            </Button>
            <Button
              variant="ghost"
              onClick={() => setPickingInput({ kind: "creatures" })}
            >
              + Creature
            </Button>
            <Button variant="ghost" onClick={addFreeInput}>
              + Other
            </Button>
          </div>
        </div>
        {method.inputs.length === 0 ? (
          <p className="text-xs text-ink-500 border border-dashed border-ink-700 rounded-md px-3 py-2">
            Nothing listed. Catalog items resolve to their real name and icon;
            "Other" is for things that aren't items ("a tamed Equus").
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {method.inputs.map((input, i) => (
              <div
                key={input.id}
                className="flex items-center gap-2 min-w-0 border border-ink-700 rounded-md px-2 py-1.5"
              >
                <span className="text-xs text-ink-500 w-4 shrink-0">{i + 1}</span>
                {input.referenceType !== "text" && input.bpPath ? (
                  <ReferencedInput input={input} />
                ) : input.referenceType !== "text" ? (
                  // A catalog-backed input with no path yet — the state a type
                  // change lands in. It has to be repairable in place.
                  <span className="w-44 shrink-0 text-xs text-amber-400 truncate">
                    No {input.referenceType} chosen
                  </span>
                ) : (
                  <Input
                    className={cx(
                      "w-44 shrink-0 text-xs",
                      !input.label.trim() && "border-amber-flag/60",
                    )}
                    value={input.label}
                    placeholder="What is it? (required)"
                    onChange={(e) =>
                      patchInput(input.id, { label: e.target.value })
                    }
                  />
                )}
                <div className="w-24 shrink-0">
                  <Select
                    value={input.referenceType}
                    title="What this input points at"
                    onChange={(e) => {
                      const referenceType = e.target.value as ReferenceType;
                      patchInput(input.id, {
                        referenceType,
                        // A type change invalidates whatever path was there.
                        bpPath: "",
                      });
                      // Offer the right catalog straight away rather than
                      // leaving the row in its unpickable half-state.
                      if (referenceType !== "text") {
                        setPickingInput({
                          kind: referenceType === "creature" ? "creatures" : "items",
                          forInputId: input.id,
                        });
                      }
                    }}
                  >
                    {REFERENCE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {REFERENCE_LABELS[t]}
                      </option>
                    ))}
                  </Select>
                </div>
                {input.referenceType !== "text" && (
                  <Button
                    variant="ghost"
                    className="shrink-0 text-xs"
                    onClick={() =>
                      setPickingInput({
                        kind:
                          input.referenceType === "creature" ? "creatures" : "items",
                        forInputId: input.id,
                      })
                    }
                    title={
                      input.bpPath
                        ? "Choose a different blueprint"
                        : `Choose the ${input.referenceType} this points at`
                    }
                  >
                    {input.bpPath ? "Replace…" : "Pick…"}
                  </Button>
                )}
                <div className="w-36 shrink-0">
                  <Select
                    value={input.role}
                    onChange={(e) => patchInput(input.id, { role: e.target.value })}
                  >
                    {INPUT_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role as InputRole]}
                      </option>
                    ))}
                  </Select>
                </div>
                {/* A note can run to a paragraph, which a row-height field
                    cannot show. The button carries a preview instead. */}
                <Button
                  variant="ghost"
                  className={cx(
                    "flex-1 min-w-0 text-xs text-left justify-start",
                    input.note.trim() ? "text-ink-200" : "text-ink-500",
                  )}
                  onClick={() => setNotingInput(input.id)}
                  title={input.note.trim() || "Add a note about this input"}
                >
                  <span className="block truncate">
                    {input.note.trim() || "+ Note"}
                  </span>
                </Button>
                <div className="flex shrink-0">
                  <Button variant="ghost" onClick={() => moveInput(i, -1)} title="Move up">
                    ↑
                  </Button>
                  <Button variant="ghost" onClick={() => moveInput(i, 1)} title="Move down">
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      set({ inputs: method.inputs.filter((x) => x.id !== input.id) })
                    }
                    title="Remove"
                  >
                    ✕
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {inputProblems > 0 && (
          <p className="text-xs text-amber-400 mt-1.5">
            {inputProblems} input
            {inputProblems === 1 ? " needs" : "s need"} finishing — free text
            needs a label, and an item or creature needs a blueprint that
            resolves in that catalog.
          </p>
        )}
      </div>

      {/* ---- phases ---- */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
            Phases
          </span>
          <Button variant="ghost" onClick={addPhase}>
            + Add phase
          </Button>
        </div>
        {method.phases.length === 0 ? (
          <p className="text-xs text-ink-500 border border-dashed border-ink-700 rounded-md px-3 py-2">
            No phases yet. Group the process into stages — "Prepare", "Knock
            out", "Feed" — with short steps in each. <b>Template…</b> offers a
            starting shape for the tags above.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {method.phases.map((phase, pi) => (
              <PhaseCard
                key={phase.id}
                phase={phase}
                index={pi}
                onChange={(patch) => patchPhase(phase.id, patch)}
                onMoveUp={() => movePhase(pi, -1)}
                onMoveDown={() => movePhase(pi, 1)}
                onRemove={async () => {
                  if (phase.steps.length > 0) {
                    const ok = await confirmDialog({
                      title: `Remove phase "${phase.name || "Untitled"}"?`,
                      message: `Its ${phase.steps.length} step(s) go with it.`,
                      confirmLabel: "Remove phase",
                      danger: true,
                    });
                    if (!ok) return;
                  }
                  set({ phases: method.phases.filter((p) => p.id !== phase.id) });
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* ---- outcome fields ---- */}
      <div className="grid grid-cols-2 gap-3 mt-4">
        <Field label="Repeat until" hint="The loop, when there is one">
          <Input
            value={method.repeatUntil}
            onChange={(e) => set({ repeatUntil: e.target.value })}
            placeholder="e.g. The trust bar fills"
          />
        </Field>
        <Field label="Completion" hint="How you know it worked">
          <Input
            value={method.completion}
            onChange={(e) => set({ completion: e.target.value })}
          />
        </Field>
        <Field label="Failure / reset" hint="What ruins it">
          <Input
            value={method.failure}
            onChange={(e) => set({ failure: e.target.value })}
          />
        </Field>
        <Field label="Effectiveness" hint="Rates, multipliers, best food">
          <Input
            value={method.effectiveness}
            onChange={(e) => set({ effectiveness: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-3">
        <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1">
          Strategy notes
        </span>
        <ReferenceInput
          multiline
          rows={3}
          value={method.strategy}
          onChange={(strategy) => set({ strategy })}
          placeholder="Advice specific to this method."
        />
      </div>

      {pickingInput && (
        <BlueprintPicker
          kind={pickingInput.kind}
          title={
            pickingInput.kind === "creatures"
              ? "Pick an input creature"
              : "Pick an input item"
          }
          onClose={() => setPickingInput(null)}
          onPick={(bpPath) => {
            const { kind, forInputId } = pickingInput;
            setPickingInput(null);
            const referenceType = kind === "creatures" ? "creature" : "item";
            if (forInputId) {
              patchInput(forInputId, { referenceType, bpPath });
            } else {
              addInput(bpPath, referenceType);
            }
          }}
        />
      )}

      {notingInput &&
        (() => {
          const input = method.inputs.find((i) => i.id === notingInput);
          if (!input) return null;
          return (
            <InputNoteModal
              input={input}
              onClose={() => setNotingInput(null)}
              onSave={(note) => {
                patchInput(input.id, { note });
                setNotingInput(null);
              }}
            />
          );
        })()}

      {templateOpen && (
        <TemplateModal
          method={method}
          onClose={() => setTemplateOpen(false)}
          onApply={(next) => {
            onChange(next);
            setTemplateOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * A catalog-backed input. Resolves against the creature or item catalog per
 * its reference type — a v1 host that pointed at an item lands here as an
 * unresolved creature, which is surfaced rather than silently shown wrong.
 */
function ReferencedInput({ input }: { input: AcquisitionInput }) {
  const index = useCatalogIndex();
  const kind = input.referenceType === "creature" ? "creatures" : "items";
  const known = index[kind].has(normalizeBpPath(input.bpPath));
  const name = displayNameFor(index, kind, input.bpPath);

  return (
    <>
      <EntityIcon bpPath={input.bpPath} kind={kind} name={name} size={22} />
      <span
        className={cx(
          "text-sm truncate w-40 shrink-0",
          known ? "text-ink-100" : "text-amber-400",
        )}
        title={
          known
            ? input.bpPath
            : `Not in the ${kind === "creatures" ? "creature" : "item"} catalog — re-pick it`
        }
      >
        {input.label.trim() || name}
        {!known && " ⚠"}
      </span>
    </>
  );
}

/**
 * An input's note, given room to be a paragraph.
 *
 * Edits are committed on save rather than per keystroke: this sits over an
 * editor the admin is already part-way through, and a Cancel that silently
 * kept half a sentence would be a lie.
 */
function InputNoteModal({
  input,
  onSave,
  onClose,
}: {
  input: AcquisitionInput;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const index = useCatalogIndex();
  const [text, setText] = useState(input.note);
  const kind = input.referenceType === "creature" ? "creatures" : "items";
  const name =
    input.label.trim() ||
    (input.bpPath ? displayNameFor(index, kind, input.bpPath) : "") ||
    "this input";

  return (
    <Modal
      title={`Note — ${name}`}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(text)}>
            Save note
          </Button>
        </div>
      }
    >
      <ReferenceInput
        multiline
        rows={6}
        autoFocus
        value={text}
        onChange={setText}
        placeholder="Anything worth knowing about this input — where to get it, what it substitutes for, how much you actually need."
      />
      {input.note.trim() && (
        <Button
          variant="ghost"
          className="mt-2 text-xs"
          onClick={() => setText("")}
        >
          Clear
        </Button>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function PhaseCard({
  phase,
  index,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  phase: AcquisitionPhase;
  index: number;
  onChange: (patch: Partial<AcquisitionPhase>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const hasOutcomes = phaseHasOutcomes(phase);
  const [showOutcomes, setShowOutcomes] = useState(hasOutcomes);

  const moveStep = (i: number, by: number) => {
    const steps = [...phase.steps];
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    onChange({ steps });
  };

  return (
    <div className="border border-ink-700 rounded-md bg-ink-850">
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-ink-700">
        <span className="text-xs text-ink-500 shrink-0">{index + 1}</span>
        <Input
          value={phase.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Phase name"
        />
        <div className="flex shrink-0">
          <Button variant="ghost" onClick={onMoveUp} title="Move up">
            ↑
          </Button>
          <Button variant="ghost" onClick={onMoveDown} title="Move down">
            ↓
          </Button>
          <Button variant="ghost" onClick={onRemove} title="Remove phase">
            ✕
          </Button>
        </div>
      </div>
      <div className="p-2.5 flex flex-col gap-1.5">
        {phase.steps.map((step, si) => (
          <div key={step.id} className="flex items-center gap-2">
            <span className="text-xs text-ink-500 w-4 shrink-0">{si + 1}.</span>
            <div className="flex-1 min-w-0">
              <ReferenceInput
                value={step.text}
                placeholder="Short instruction"
                onChange={(text) =>
                  onChange({
                    steps: phase.steps.map((s) =>
                      s.id === step.id ? { ...s, text } : s,
                    ),
                  })
                }
              />
            </div>
            <div className="flex shrink-0">
              <Button variant="ghost" onClick={() => moveStep(si, -1)} title="Move up">
                ↑
              </Button>
              <Button variant="ghost" onClick={() => moveStep(si, 1)} title="Move down">
                ↓
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  onChange({ steps: phase.steps.filter((s) => s.id !== step.id) })
                }
                title="Remove step"
              >
                ✕
              </Button>
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() =>
              onChange({ steps: [...phase.steps, { id: newId(), text: "" }] })
            }
          >
            + Add step
          </Button>
          <Input
            className="text-xs"
            value={phase.note}
            placeholder="Note about this phase (optional)"
            onChange={(e) => onChange({ note: e.target.value })}
          />
          <Button
            variant="ghost"
            className="shrink-0"
            onClick={() => setShowOutcomes(!showOutcomes)}
            title="Loop and reset conditions for this phase alone"
          >
            {showOutcomes ? "Hide outcomes" : "Outcomes"}
            {hasOutcomes && !showOutcomes ? " •" : ""}
          </Button>
        </div>

        {/* Optional — a simple knockout phase never needs these. */}
        {showOutcomes && (
          <div className="grid grid-cols-2 gap-2 mt-1 pt-2 border-t border-ink-700/60">
            <Field label="Repeat until">
              <Input
                className="text-xs"
                value={phase.repeatUntil}
                onChange={(e) => onChange({ repeatUntil: e.target.value })}
                placeholder="e.g. the adult is distracted"
              />
            </Field>
            <Field label="Completed when">
              <Input
                className="text-xs"
                value={phase.completedWhen}
                onChange={(e) => onChange({ completedWhen: e.target.value })}
              />
            </Field>
            <Field label="Failure / reset">
              <Input
                className="text-xs"
                value={phase.failureOrReset}
                onChange={(e) => onChange({ failureOrReset: e.target.value })}
                placeholder="e.g. adult aggro resets taming"
              />
            </Field>
            <Field label="Transition note">
              <Input
                className="text-xs"
                value={phase.transitionNote}
                onChange={(e) => onChange({ transitionNote: e.target.value })}
                placeholder="How you move to the next phase"
              />
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Template application with a preview. A template must never silently
 * overwrite work, so the exact changes are listed before anything happens and
 * replace mode additionally confirms.
 */
function TemplateModal({
  method,
  onApply,
  onClose,
}: {
  method: AcquisitionMethod;
  onApply: (next: AcquisitionMethod) => void;
  onClose: () => void;
}) {
  const suggested = method.tags.find((t) =>
    (METHOD_TAGS as readonly string[]).includes(t),
  ) as MethodTag | undefined;
  const [tag, setTag] = useState<MethodTag>(suggested ?? "knockout");
  const [mode, setMode] = useState<TemplateMode>("merge-missing");

  const template: MethodTemplate = METHOD_TEMPLATES[tag];
  const changes = describeTemplate(method, template, mode);

  async function apply() {
    if (mode === "replace") {
      const ok = await confirmDialog({
        title: "Replace this method's template-managed fields?",
        message:
          `All ${method.phases.length} existing phase(s) and their steps are discarded and rebuilt from the "${template.name}" template, along with requirements, repeat-until, completion and failure. ` +
          "Inputs, strategy notes, effectiveness and any name, outcome or tags you already set are kept.",
        confirmLabel: "Replace template-managed fields",
        danger: true,
      });
      if (!ok) return;
    }
    onApply(applyTemplate(method, template, mode, newId));
    toast.success(`Template applied (${TEMPLATE_MODE_LABELS[mode].toLowerCase()})`);
  }

  return (
    <Modal title="Apply a method template" onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Field label="Template">
          <Select value={tag} onChange={(e) => setTag(e.target.value as MethodTag)}>
            {METHOD_TAGS.map((t) => (
              <option key={t} value={t}>
                {TAG_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How to apply">
          <Select
            value={mode}
            onChange={(e) => setMode(e.target.value as TemplateMode)}
          >
            {(
              ["fill-empty", "merge-missing", "replace"] as TemplateMode[]
            ).map((m) => (
              <option key={m} value={m}>
                {TEMPLATE_MODE_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1">
        Preview
      </span>
      {changes.length === 0 ? (
        <p className="text-sm text-ink-400 border border-dashed border-ink-700 rounded-md px-3 py-3">
          Nothing would change — this method already has everything the
          template offers.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 border border-ink-700 rounded-md p-3 max-h-64 overflow-y-auto">
          {changes.map((line, i) => (
            <li
              key={i}
              className={cx(
                "text-sm",
                line.startsWith("Remove") ? "text-red-400" : "text-ink-200",
              )}
            >
              • {line}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={mode === "replace" ? "danger" : "primary"}
          onClick={apply}
          disabled={changes.length === 0}
        >
          Apply template
        </Button>
      </div>
    </Modal>
  );
}
