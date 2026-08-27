import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import {
  defaultExampleTourDocument,
  EXAMPLE_TOUR_SELECTION_ATTR,
  normalizeExampleTourDocument,
  type ExampleButtonControl,
  type ExampleTourArrowDirection,
  type ExampleTourCompletion,
  type ExampleTourControl,
  type ExampleTourExpansion,
  type ExampleTourPlacementMode,
  type ExampleTourStep,
  type ExampleTourVisual,
} from "../model/exampleProject";
import { snapshotFor, targetBreadcrumb } from "../model/feedback/resolveTarget";
import {
  FEEDBACK_ATTR,
  FEEDBACK_IGNORE,
  parseTargetContext,
  targetDefinition,
} from "../model/feedback/targets";
import { toast } from "./toast";
import { Button, Field, Input, Select, Textarea, cx } from "./ui";

const AUTHORABLE_ROUTES = [
  "/overview",
  "/production",
  "/simulator",
  "/content",
  "/remaps",
  "/curseforge",
  "/publish",
  "/settings",
] as const;

interface PickedArea {
  x: number;
  y: number;
  route: string;
  element: HTMLElement;
  targetId: string;
  targetName: string;
  targetContext?: Record<string, string>;
  breadcrumb: string;
  annotationPosition: { x: number; y: number };
  control?: Omit<ExampleTourControl, "state">;
  expansions: ExampleTourExpansion[];
  selections: string[];
}

type PickingTarget =
  | { stepId: string; kind: "focus" }
  | { controlId: string; kind: "control" };

function buttonLabel(button: HTMLButtonElement): string {
  return (
    button.getAttribute("aria-label") ??
    button.getAttribute("title") ??
    button.querySelector<HTMLElement>("h3")?.innerText ??
    button.innerText
  ).replace(/\s+/g, " ").trim().slice(0, 160);
}

function pickedControl(start: Element, area: HTMLElement): Omit<ExampleTourControl, "state"> | undefined {
  const button = start.closest<HTMLButtonElement>("button");
  if (!button || !(button === area || area.contains(button))) return undefined;
  const label = buttonLabel(button);
  if (!label) return undefined;
  const candidates = [
    ...(area.matches("button") ? [area as HTMLButtonElement] : []),
    ...area.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((item) => buttonLabel(item) === label);
  return { label, index: Math.max(0, candidates.indexOf(button)) };
}

function pickedExpansions(start: Element, area: HTMLElement): ExampleTourExpansion[] {
  const all = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded][aria-controls]')]
    .filter((button) => !button.closest("[data-walkthrough-authoring]"));
  const expanded = all.filter((button) => {
    if (button.getAttribute("aria-expanded") !== "true") return false;
    const controlled = document.getElementById(button.getAttribute("aria-controls") ?? "");
    return Boolean(controlled && (
      controlled.contains(start) || controlled.contains(area) || area.contains(controlled)
    ));
  });
  return expanded.flatMap((button) => {
    const label = buttonLabel(button);
    if (!label) return [];
    const matching = all.filter((candidate) => buttonLabel(candidate) === label);
    return [{
      key: button.dataset.collapseKey || undefined,
      label,
      index: Math.max(0, matching.indexOf(button)),
    }];
  });
}

function pickedSelections(): string[] {
  return [...document.querySelectorAll<HTMLElement>(
    `[${EXAMPLE_TOUR_SELECTION_ATTR}][aria-pressed="true"]`,
  )].flatMap((element) => {
    const key = element.getAttribute(EXAMPLE_TOUR_SELECTION_ATTR)?.trim();
    return key ? [key] : [];
  });
}

function pickedArea(start: Element, route: string, x: number, y: number): PickedArea | null {
  const element = start.closest<HTMLElement>(`[${FEEDBACK_ATTR.id}]`);
  if (!element || element.closest(`[${FEEDBACK_ATTR.ignore}]`)) return null;
  const targetId = element.getAttribute(FEEDBACK_ATTR.id) ?? "";
  const definition = targetDefinition(targetId);
  if (!definition) return null;
  const snapshot = snapshotFor(element, targetId);
  const rect = element.getBoundingClientRect();
  const unit = (value: number) => Math.max(0, Math.min(1, value));
  return {
    x,
    y,
    route,
    element,
    targetId,
    targetName: definition.name,
    targetContext:
      Object.keys(snapshot.context).length > 0 ? snapshot.context : undefined,
    breadcrumb: targetBreadcrumb(snapshot),
    annotationPosition: {
      x: unit((x - rect.left) / Math.max(1, rect.width)),
      y: unit((y - rect.top) / Math.max(1, rect.height)),
    },
    control: pickedControl(start, element),
    expansions: pickedExpansions(start, element),
    selections: pickedSelections(),
  };
}

function sameArea(step: ExampleTourStep, area: PickedArea): boolean {
  return (
    step.route === area.route &&
    step.targetId === area.targetId &&
    JSON.stringify(step.targetContext ?? {}) === JSON.stringify(area.targetContext ?? {})
  );
}

function elementForStep(step: ExampleTourStep): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    `[${FEEDBACK_ATTR.id}="${step.targetId}"]`,
  );
  if (!step.targetContext || Object.keys(step.targetContext).length === 0) {
    return candidates[0] ?? null;
  }
  return [...candidates].find((element) => {
    const context = parseTargetContext(element.getAttribute(FEEDBACK_ATTR.context));
    return Object.entries(step.targetContext ?? {}).every(([key, value]) => context[key] === value);
  }) ?? null;
}

function focusContainsPoint(step: ExampleTourStep, point: { x: number; y: number }): boolean {
  const target = elementForStep(step);
  if (!target) return false;
  const rect = target.getBoundingClientRect();
  const widthFraction = step.focusRect?.width ?? (step.focusWidthPercent ?? 100) / 100;
  const heightFraction = step.focusRect?.height ?? (step.focusHeightPercent ?? 100) / 100;
  const left = rect.left + rect.width * (step.focusRect?.x ?? (1 - widthFraction) / 2) - step.padding;
  const top = rect.top + rect.height * (step.focusRect?.y ?? (1 - heightFraction) / 2) - step.padding;
  const right = left + rect.width * widthFraction + step.padding * 2;
  const bottom = top + rect.height * heightFraction + step.padding * 2;
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

function walkthroughStepsOnRoute(steps: readonly ExampleTourStep[], route: string): ExampleTourStep[] {
  return steps.filter((step) =>
    (step.visual ?? "spotlight") === "spotlight" && step.route === route);
}

function dotParentOptions(
  dot: Pick<ExampleTourStep, "route" | "targetId" | "targetContext" | "annotationPosition" | "padding" | "focusRect" | "focusWidthPercent" | "focusHeightPercent">,
  steps: readonly ExampleTourStep[],
): ExampleTourStep[] {
  const pageSteps = walkthroughStepsOnRoute(steps, dot.route);
  const target = elementForStep(dot as ExampleTourStep);
  const rect = target?.getBoundingClientRect();
  const position = dot.annotationPosition ?? { x: 1, y: 0 };
  const point = rect
    ? { x: rect.left + rect.width * position.x, y: rect.top + rect.height * position.y }
    : null;
  const containing = point ? pageSteps.filter((step) => focusContainsPoint(step, point)) : [];
  return containing.length > 0 ? containing : pageSteps.slice(-1);
}

function newStep(
  area: PickedArea,
  visual: ExampleTourVisual = "spotlight",
  parentStepId?: string,
): ExampleTourStep {
  return {
    id: `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    route: area.route,
    targetId: area.targetId,
    targetContext: area.targetContext,
    targetName: area.targetName,
    eyebrow: "Walkthrough",
    title: area.targetName,
    body: `Explain what ${area.targetName} shows and what the administrator should do here.`,
    completion: "view",
    viewDurationSeconds: 3,
    padding: 8,
    placement: { mode: "auto" },
    visual,
    focusWidthPercent: 100,
    focusHeightPercent: 100,
    annotationPosition: visual === "spotlight" ? undefined : area.annotationPosition,
    arrowDirection: visual === "arrow" ? "right" : undefined,
    expansions: visual === "spotlight" && area.expansions.length > 0 ? area.expansions : undefined,
    selections: visual === "spotlight" && area.selections.length > 0 ? area.selections : undefined,
    parentStepId: visual === "spotlight" ? undefined : parentStepId,
  };
}

function downloadDocument(steps: readonly ExampleTourStep[], controls: readonly ExampleButtonControl[]) {
  const blob = new Blob([`${JSON.stringify({ version: 1, steps, controls }, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "dinodepot-example-walkthrough.json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ExampleWalkthroughAuthoring({
  enabled,
  steps,
  controls,
  onStepsChange,
  onControlsChange,
  onPreview,
}: {
  enabled: boolean;
  steps: readonly ExampleTourStep[];
  controls: readonly ExampleButtonControl[];
  onStepsChange(steps: ExampleTourStep[]): void;
  onControlsChange(controls: ExampleButtonControl[]): void;
  onPreview(stepId: string): void;
}) {
  const location = useLocation();
  const [menu, setMenu] = useState<PickedArea | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedControlId, setSelectedControlId] = useState<string | null>(null);
  const [editorTab, setEditorTab] = useState<"walkthrough" | "buttons">("walkthrough");
  const [picking, setPicking] = useState<PickingTarget | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!enabled) {
      setMenu(null);
      setEditorOpen(false);
      setPicking(null);
      return;
    }
    const open = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-walkthrough-authoring]")) return;
      const area = pickedArea(
        target,
        location.pathname,
        event.clientX,
        event.clientY,
      );
      if (!area) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (picking?.kind === "focus") {
        replaceFocus(area);
        return;
      }
      setMenu(area);
    };
    document.addEventListener("contextmenu", open, true);
    return () => document.removeEventListener("contextmenu", open, true);
  }, [enabled, location.pathname, picking, steps]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest("[data-walkthrough-menu]")) return;
      setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", close, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [menu]);

  function updateStep(id: string, patch: Partial<ExampleTourStep>) {
    onStepsChange(steps.map((step) => (step.id === id ? { ...step, ...patch } : step)));
  }

  function addArea(area: PickedArea, visual: ExampleTourVisual = "spotlight") {
    const pageSteps = walkthroughStepsOnRoute(steps, area.route);
    const containingSteps = pageSteps.filter((step) =>
      focusContainsPoint(step, { x: area.x, y: area.y }));
    const parentStepId = visual === "spotlight"
      ? undefined
      : visual === "hotspot"
        ? (containingSteps.at(-1) ?? pageSteps.at(-1))?.id
        : pageSteps.at(-1)?.id;
    const step = newStep(area, visual, parentStepId);
    onStepsChange([...steps, step]);
    setSelectedId(step.id);
    setEditorOpen(true);
    setMenu(null);
  }

  function editArea(area: PickedArea) {
    const existing = steps.find((step) => sameArea(step, area));
    if (!existing) return addArea(area);
    setSelectedId(existing.id);
    setEditorOpen(true);
    setMenu(null);
  }

  function editState(area: PickedArea) {
    if (!area.control) return;
    const existing = controls.find((control) =>
      control.route === area.route &&
      control.targetId === area.targetId &&
      JSON.stringify(control.targetContext ?? {}) === JSON.stringify(area.targetContext ?? {}) &&
      control.label === area.control?.label &&
      control.index === area.control.index);
    if (existing) {
      setSelectedControlId(existing.id);
    } else {
      const control: ExampleButtonControl = {
        id: `control-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        route: area.route,
        targetId: area.targetId,
        targetContext: area.targetContext,
        targetName: area.targetName,
        ...area.control,
        state: "disabled",
        scope: "example",
      };
      onControlsChange([...controls, control]);
      setSelectedControlId(control.id);
    }
    setEditorTab("buttons");
    setEditorOpen(true);
    setMenu(null);
  }

  function replaceFocus(area: PickedArea) {
    if (!picking || picking.kind !== "focus") return;
    updateStep(picking.stepId, {
      route: area.route,
      targetId: area.targetId,
      targetContext: area.targetContext,
      targetName: area.targetName,
      expansions: area.expansions.length > 0 ? area.expansions : undefined,
      selections: area.selections.length > 0 ? area.selections : undefined,
    });
    setSelectedId(picking.stepId);
    setPicking(null);
    setMenu(null);
    setEditorOpen(true);
  }

  function setControl(area: PickedArea) {
    if (!picking || picking.kind !== "control" || !area.control) return;
    onControlsChange(controls.map((control) => control.id === picking.controlId ? {
      ...control,
      route: area.route,
      targetId: area.targetId,
      targetContext: area.targetContext,
      targetName: area.targetName,
      label: area.control!.label,
      index: area.control!.index,
    } : control));
    setSelectedControlId(picking.controlId);
    setEditorTab("buttons");
    setPicking(null);
    setMenu(null);
    setEditorOpen(true);
  }

  useEffect(() => {
    if (!enabled || picking?.kind !== "control") return;
    const select = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-walkthrough-authoring]")) return;
      const area = pickedArea(target, location.pathname, event.clientX, event.clientY);
      if (!area?.control) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setControl(area);
    };
    document.addEventListener("pointerdown", select, true);
    return () => document.removeEventListener("pointerdown", select, true);
  }, [controls, enabled, location.pathname, picking]);

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = normalizeExampleTourDocument(JSON.parse(await file.text()));
      if (!parsed) throw new Error("Invalid walkthrough document");
      onStepsChange(parsed.steps);
      onControlsChange(parsed.controls);
      setSelectedId(parsed.steps[0]?.id ?? null);
      toast.success(`Imported ${parsed.steps.length} walkthrough steps.`);
    } catch {
      toast.error("Could not import that walkthrough JSON.");
    }
  }

  if (!enabled) return null;
  const matching = menu ? steps.filter((step) => sameArea(step, menu)) : [];

  return (
    <>
      {menu && <AuthoringMenu area={menu} matching={matching} onAdd={() => addArea(menu)} onAddArrow={() => addArea(menu, "arrow")} onAddHotspot={() => addArea(menu, "hotspot")} onEdit={() => editArea(menu)} onEditState={() => editState(menu)} onPreview={(id) => { setMenu(null); onPreview(id); }} onOpenEditor={() => { setSelectedId(matching[0]?.id ?? steps[0]?.id ?? null); setEditorTab("walkthrough"); setMenu(null); setEditorOpen(true); }} />}
      {editorOpen && (
        <WalkthroughEditor
          steps={steps}
          controls={controls}
          tab={editorTab}
          onTab={setEditorTab}
          selectedId={selectedId}
          onSelectedId={setSelectedId}
          selectedControlId={selectedControlId}
          onSelectedControlId={setSelectedControlId}
          onChange={updateStep}
          onStepsChange={onStepsChange}
          onControlsChange={onControlsChange}
          onPreview={onPreview}
          onClose={() => setEditorOpen(false)}
          onImport={() => importInput.current?.click()}
          onExport={() => downloadDocument(steps, controls)}
          onReset={() => {
            if (!window.confirm("Replace the local walkthrough draft with the built-in walkthrough?")) return;
            const defaults = defaultExampleTourDocument().steps;
            onStepsChange(defaults);
            onControlsChange([]);
            setSelectedId(defaults[0]?.id ?? null);
          }}
          onPickFocus={(id) => {
            setPicking({ stepId: id, kind: "focus" });
            setEditorOpen(false);
            toast.success("Right-click the new focus area for this step.");
          }}
          onPickControl={(id) => {
            setPicking({ controlId: id, kind: "control" });
            setEditorOpen(false);
            toast.success("Click the button this override should control.");
          }}
        />
      )}
      <input
        ref={importInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => void importFile(event)}
      />
      {picking ? (
        <div {...FEEDBACK_IGNORE} data-walkthrough-authoring className="fixed bottom-5 right-5 z-[58] flex items-center gap-3 rounded-lg border border-amber-400/50 bg-amber-950 px-3 py-2 text-xs font-bold text-amber-200 shadow-xl">
          {picking.kind === "focus" ? "Right-click new focus area" : "Click button to control"}
          <button className="text-amber-300/70 hover:text-amber-100" onClick={() => setPicking(null)}>Cancel</button>
        </div>
      ) : (
        <button
          {...FEEDBACK_IGNORE}
          type="button"
          data-walkthrough-authoring
          onClick={() => {
            setSelectedId((current) => current ?? steps[0]?.id ?? null);
            setEditorTab("walkthrough");
            setEditorOpen(true);
          }}
          className="fixed bottom-5 right-5 z-[58] rounded-lg border border-amber-400/50 bg-amber-950 px-3 py-2 text-xs font-bold text-amber-200 shadow-xl hover:bg-amber-900"
        >
          Walkthrough editor · {steps.length + controls.length}
        </button>
      )}
    </>
  );
}

function AuthoringMenu({
  area,
  matching,
  onAdd,
  onAddArrow,
  onAddHotspot,
  onEdit,
  onEditState,
  onPreview,
  onOpenEditor,
}: {
  area: PickedArea;
  matching: readonly ExampleTourStep[];
  onAdd(): void;
  onAddArrow(): void;
  onAddHotspot(): void;
  onEdit(): void;
  onEditState(): void;
  onPreview(id: string): void;
  onOpenEditor(): void;
}) {
  const rect = area.element.getBoundingClientRect();
  const size = 400;
  const half = size / 2;
  const left = Math.max(8, Math.min(area.x - half, window.innerWidth - size - 8));
  const top = Math.max(58, Math.min(area.y - half, window.innerHeight - size - 8));
  const playable = matching.find((step) => (step.visual ?? "spotlight") === "spotlight");
  const editable = matching[0];
  const actions = [
    { label: "Play Step", hint: "Run walkthrough", onClick: () => playable && onPreview(playable.id), disabled: !playable },
    { label: "Edit Step", hint: "Change details", onClick: onEdit, disabled: !editable },
    { label: "Edit State", hint: area.control?.label ?? "Right-click button", onClick: onEditState, disabled: !area.control },
    { label: "+ Step", hint: "Focus box", onClick: onAdd, disabled: false },
    { label: "+ Arrow", hint: "Titled pointer", onClick: onAddArrow, disabled: false },
    { label: "+ Dot", hint: "Hover note", onClick: onAddHotspot, disabled: false },
  ] as const;
  const positions = [
    { left: 264, top: 66 },
    { left: 304, top: 158 },
    { left: 245, top: 270 },
    { left: 69, top: 270 },
    { left: 8, top: 158 },
    { left: 48, top: 66 },
  ];
  return createPortal(
    <>
      <div
        className="pointer-events-none fixed z-[94] rounded-lg border-2 border-amber-300"
        style={{
          left: Math.max(4, rect.left - 5),
          top: Math.max(52, rect.top - 5),
          width: rect.width + 10,
          height: rect.height + 10,
          boxShadow: "0 0 0 9999px rgba(2,6,23,.38), 0 0 24px rgba(251,191,36,.35)",
        }}
      />
      <div
        {...FEEDBACK_IGNORE}
        data-walkthrough-authoring
        data-walkthrough-menu
        role="menu"
        aria-label={`Walkthrough tools for ${area.targetName}`}
        className="fixed z-[95]"
        style={{ left, top, width: size, height: size }}
      >
        <div className="absolute left-1/2 top-3 w-40 -translate-x-1/2 text-center" title={area.breadcrumb}>
          <div className="text-[9px] font-bold uppercase tracking-[.16em] text-amber-300">Current focus</div>
          <div className="mt-0.5 truncate text-sm font-bold text-white">{area.targetName}</div>
          <div className="truncate text-[10px] text-ink-400">{area.route}</div>
        </div>
        {actions.map((action, index) => (
          <button
            key={action.label}
            role="menuitem"
            disabled={action.disabled}
            onClick={action.onClick}
            className="absolute flex size-[88px] flex-col items-center justify-center rounded-full border border-amber-400/35 bg-ink-900 px-2 text-center shadow-lg transition hover:scale-105 hover:border-amber-300 hover:bg-amber-950 focus:outline-none focus:ring-2 focus:ring-amber-300 disabled:cursor-not-allowed disabled:border-ink-700 disabled:text-ink-600 disabled:opacity-50"
            style={positions[index]}
          >
            <span className="text-xs font-bold text-current">{action.label}</span>
            <span className="mt-1 line-clamp-2 text-[9px] leading-3 text-ink-400">{action.hint}</span>
          </button>
        ))}
        <button type="button" aria-label="Open walkthrough editor" onClick={onOpenEditor} className="absolute left-1/2 top-1/2 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-amber-400/50 bg-amber-950 text-xs font-black tracking-widest text-amber-200 shadow-xl hover:bg-amber-900">DEV<br /><span className="text-[9px] font-semibold tracking-normal">Editor</span></button>
      </div>
    </>,
    document.body,
  );
}

function WalkthroughEditor({
  steps,
  controls,
  tab,
  onTab,
  selectedId,
  onSelectedId,
  selectedControlId,
  onSelectedControlId,
  onChange,
  onStepsChange,
  onControlsChange,
  onPreview,
  onClose,
  onImport,
  onExport,
  onReset,
  onPickFocus,
  onPickControl,
}: {
  steps: readonly ExampleTourStep[];
  controls: readonly ExampleButtonControl[];
  tab: "walkthrough" | "buttons";
  onTab(tab: "walkthrough" | "buttons"): void;
  selectedId: string | null;
  onSelectedId(id: string | null): void;
  selectedControlId: string | null;
  onSelectedControlId(id: string | null): void;
  onChange(id: string, patch: Partial<ExampleTourStep>): void;
  onStepsChange(steps: ExampleTourStep[]): void;
  onControlsChange(controls: ExampleButtonControl[]): void;
  onPreview(id: string): void;
  onClose(): void;
  onImport(): void;
  onExport(): void;
  onReset(): void;
  onPickFocus(id: string): void;
  onPickControl(id: string): void;
}) {
  const selected = steps.find((step) => step.id === selectedId) ?? null;
  const annotationParentOptions = !selected || (selected.visual ?? "spotlight") === "spotlight"
    ? []
    : selected.visual === "hotspot"
      ? dotParentOptions(selected, steps)
      : walkthroughStepsOnRoute(steps, selected.route);
  const pointerDrag = useRef<{ pointerId: number; stepId: string; overId: string } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const covered = new Set(steps.map((step) => step.route));

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [onClose]);

  useEffect(() => {
    if (!draggedId) return;
    const move = (event: PointerEvent) => {
      const current = pointerDrag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      event.preventDefault();
      const row = document.elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-walkthrough-step-id]");
      const overId = row?.dataset.walkthroughStepId;
      if (!overId || overId === current.overId) return;
      current.overId = overId;
      setDragOverId(overId);
    };
    const finish = (event: PointerEvent) => {
      const current = pointerDrag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const from = steps.findIndex((step) => step.id === current.stepId);
      const at = steps.findIndex((step) => step.id === current.overId);
      if (from >= 0 && at >= 0 && from !== at) {
        const reordered = [...steps];
        const [moved] = reordered.splice(from, 1);
        reordered.splice(at, 0, moved);
        onStepsChange(reordered);
      }
      pointerDrag.current = null;
      setDraggedId(null);
      setDragOverId(null);
    };
    const cancel = (event: PointerEvent) => {
      if (pointerDrag.current?.pointerId !== event.pointerId) return;
      pointerDrag.current = null;
      setDraggedId(null);
      setDragOverId(null);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [draggedId, onStepsChange, steps]);

  return createPortal(
    <div {...FEEDBACK_IGNORE} data-walkthrough-authoring className="fixed inset-0 z-[105] flex items-center justify-center bg-black/65 p-6">
      <section role="dialog" aria-modal="true" aria-labelledby="walkthrough-editor-title" className="flex h-[min(820px,calc(100vh-48px))] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-amber-400/35 bg-ink-900 shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-ink-700 px-5 py-4">
          <div>
            <h2 id="walkthrough-editor-title" className="text-lg font-bold text-white">Example walkthrough editor</h2>
            <p className="mt-1 text-xs text-ink-400">Right-click registered page areas to add steps. Draft saves on this device.</p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => onTab("walkthrough")} className={cx("rounded-md px-3 py-1.5 text-xs font-semibold", tab === "walkthrough" ? "bg-amber-400/15 text-amber-200" : "text-ink-400 hover:bg-ink-800 hover:text-white")}>Walkthrough · {steps.length}</button>
              <button type="button" onClick={() => onTab("buttons")} className={cx("rounded-md px-3 py-1.5 text-xs font-semibold", tab === "buttons" ? "bg-amber-400/15 text-amber-200" : "text-ink-400 hover:bg-ink-800 hover:text-white")}>Button states · {controls.filter((control) => control.state === "disabled").length} disabled</button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onImport}>Import JSON</Button>
            <Button variant="ghost" onClick={onExport} disabled={steps.length === 0}>Export JSON</Button>
            <Button variant="ghost" onClick={onReset}>Reset</Button>
            <Button variant="primary" onClick={() => { toast.success("Walkthrough saved."); onClose(); }}>Save</Button>
            <button aria-label="Close editor" className="size-8 rounded-md text-xl text-ink-400 hover:bg-ink-800 hover:text-white" onClick={onClose}>×</button>
          </div>
        </header>
        {tab === "buttons" ? (
          <ButtonControlsEditor
            controls={controls}
            selectedId={selectedControlId}
            onSelectedId={onSelectedControlId}
            onChange={(id, patch) => onControlsChange(controls.map((control) => control.id === id ? { ...control, ...patch } : control))}
            onRemove={(id) => {
              const next = controls.filter((control) => control.id !== id);
              onControlsChange(next);
              onSelectedControlId(next[0]?.id ?? null);
            }}
            onPick={onPickControl}
          />
        ) : <div className="grid min-h-0 flex-1 grid-cols-[320px_1fr]">
          <aside className="flex min-h-0 flex-col border-r border-ink-700">
            <div className="border-b border-ink-700 px-4 py-3">
              <div className="text-xs font-semibold text-ink-200">{steps.filter((step) => (step.visual ?? "spotlight") === "spotlight").length} walkthrough steps · {steps.filter((step) => (step.visual ?? "spotlight") !== "spotlight").length} annotations</div>
              <div className="mt-1 text-[11px] text-ink-500">Drag steps to reorder. Missing: {AUTHORABLE_ROUTES.filter((route) => !covered.has(route)).join(", ") || "none"}</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {steps.length === 0 && <p className="p-4 text-sm text-ink-400">Right-click a page area to add first step.</p>}
              {steps.map((step, index) => (
                <div
                  key={step.id}
                  data-walkthrough-step-id={step.id}
                  className={cx(
                    "mb-1 flex w-full items-center gap-1 rounded-md border px-1.5 py-1.5",
                    selected?.id === step.id ? "border-amber-400/50 bg-amber-400/10" : "border-transparent hover:bg-ink-800",
                    draggedId === step.id && "opacity-45",
                    dragOverId === step.id && draggedId !== step.id && "border-cyan-300 bg-cyan-400/10",
                  )}
                >
                  <button
                    type="button"
                    aria-label={`Drag ${step.title} to reorder`}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      pointerDrag.current = { pointerId: event.pointerId, stepId: step.id, overId: step.id };
                      setDraggedId(step.id);
                      setDragOverId(step.id);
                    }}
                    className="grid size-7 touch-none cursor-grab select-none place-items-center rounded text-ink-500 hover:bg-ink-700 hover:text-white active:cursor-grabbing"
                  >⠿</button>
                  <button type="button" onClick={() => onSelectedId(step.id)} className="min-w-0 flex-1 px-1 text-left">
                    <span className="block truncate text-sm font-semibold text-ink-100">{index + 1}. {step.title}</span>
                    <span className="block truncate text-[11px] text-ink-500">{step.route} · {step.targetName}</span>
                  </button>
                </div>
              ))}
            </div>
          </aside>
          <main className="min-h-0 overflow-y-auto p-5">
            {!selected ? (
              <div className="grid h-full place-items-center text-sm text-ink-400">Select step to edit.</div>
            ) : (
              <div className="mx-auto max-w-2xl space-y-4">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">Focus area</div>
                    <div className="mt-1 truncate text-sm font-semibold text-white">{selected.targetName}</div>
                    <div className="truncate text-xs text-ink-400">{selected.route} · {selected.targetId}</div>
                  </div>
                  <Button variant="ghost" className="shrink-0" onClick={() => onPickFocus(selected.id)}>Select another area</Button>
                </div>
                {(selected.visual ?? "spotlight") === "spotlight" && (
                  <>
                    <div className="grid grid-cols-[180px_1fr] gap-4">
                      <Field label="Section label"><Input value={selected.eyebrow} maxLength={80} onChange={(event) => onChange(selected.id, { eyebrow: event.target.value })} /></Field>
                      <Field label="Step title"><Input value={selected.title} maxLength={160} onChange={(event) => onChange(selected.id, { title: event.target.value })} /></Field>
                    </div>
                    <Field label="Walkthrough notes" hint="Explain what this area means, what to inspect, and what outcome to expect.">
                      <Textarea rows={10} maxLength={6000} value={selected.body} onChange={(event) => onChange(selected.id, { body: event.target.value })} />
                    </Field>
                  </>
                )}
                {(selected.visual ?? "spotlight") === "arrow" && (
                  <Field label="Arrow title"><Input value={selected.title} maxLength={160} onChange={(event) => onChange(selected.id, { title: event.target.value })} /></Field>
                )}
                {(selected.visual ?? "spotlight") === "hotspot" && (
                  <>
                    <Field label="Dot title"><Input value={selected.title} maxLength={160} onChange={(event) => onChange(selected.id, { title: event.target.value })} /></Field>
                    <Field label="Hover message" hint="Shown while pointer rests on dot.">
                      <Textarea rows={8} maxLength={6000} value={selected.body} onChange={(event) => onChange(selected.id, { body: event.target.value })} />
                    </Field>
                  </>
                )}
                {(selected.visual ?? "spotlight") !== "spotlight" && (
                  <Field label="Appears during step" hint="Annotation stays attached when steps are reordered.">
                    <Select value={selected.parentStepId ?? ""} onChange={(event) => onChange(selected.id, { parentStepId: event.target.value || undefined })}>
                      <option value="">Choose walkthrough step</option>
                      {annotationParentOptions.map((step) => (
                        <option key={step.id} value={step.id}>{step.title}</option>
                      ))}
                    </Select>
                  </Field>
                )}
                <div className="grid grid-cols-3 gap-4">
                  <Field label="Visual type">
                    <Select value={selected.visual ?? "spotlight"} onChange={(event) => onChange(selected.id, { visual: event.target.value as ExampleTourVisual })}>
                      <option value="spotlight">Focus box</option><option value="arrow">Arrow with title</option><option value="hotspot">Hover information dot</option>
                    </Select>
                  </Field>
                  {(selected.visual ?? "spotlight") === "spotlight" && (
                    <>
                      <Field
                        label="Completion"
                        hint={selected.completion === "page"
                          ? "Marks this step complete when user explores this page independently. During guided playback, card waits for Next."
                          : "Controls automatic progress tracking."}
                      >
                        <Select value={selected.completion} onChange={(event) => onChange(selected.id, { completion: event.target.value as ExampleTourCompletion })}>
                          <option value="view">Focus visible for assigned time</option><option value="click">Focus area clicked</option><option value="page">Page visited outside walkthrough</option><option value="manual">Next button only</option>
                        </Select>
                      </Field>
                      <Field label="Modal placement">
                        <Select value={selected.placement.mode} onChange={(event) => onChange(selected.id, { placement: { mode: event.target.value as ExampleTourPlacementMode } })}>
                          <option value="auto">Automatic</option><option value="top-left">Top left</option><option value="top-right">Top right</option><option value="bottom-left">Bottom left</option><option value="bottom-right">Bottom right</option><option value="custom">Dragged position</option>
                        </Select>
                      </Field>
                    </>
                  )}
                </div>
                {(selected.visual ?? "spotlight") === "spotlight" && selected.completion === "view" && (
                  <Field label="Visible duration (seconds)" hint="0.5–60 seconds before walkthrough advances.">
                    <Input
                      type="number"
                      min={0.5}
                      max={60}
                      step={0.5}
                      value={selected.viewDurationSeconds ?? 3}
                      onChange={(event) => onChange(selected.id, {
                        viewDurationSeconds: Math.round(Math.max(0.5, Math.min(60, Number(event.target.value) || 0.5)) * 10) / 10,
                      })}
                    />
                  </Field>
                )}
                {(selected.visual ?? "spotlight") === "arrow" && (
                  <Field label="Arrow direction" hint="Direction the arrow points toward the selected anchor.">
                    <Select value={selected.arrowDirection ?? "right"} onChange={(event) => onChange(selected.id, { arrowDirection: event.target.value as ExampleTourArrowDirection })}>
                      <option value="up">Up</option><option value="up-right">Up right</option><option value="right">Right</option><option value="down-right">Down right</option><option value="down">Down</option><option value="down-left">Down left</option><option value="left">Left</option><option value="up-left">Up left</option>
                    </Select>
                  </Field>
                )}
                {(selected.visual ?? "spotlight") === "spotlight" && (
                  <>
                    <div className="grid grid-cols-3 gap-4">
                      <Field label="Focus width" hint="10–100% of selected area">
                        <Input type="number" min={10} max={100} value={selected.focusWidthPercent ?? 100} onChange={(event) => onChange(selected.id, { focusWidthPercent: Math.max(10, Math.min(100, Number(event.target.value))), focusRect: undefined })} />
                      </Field>
                      <Field label="Focus height" hint="10–100% of selected area">
                        <Input type="number" min={10} max={100} value={selected.focusHeightPercent ?? 100} onChange={(event) => onChange(selected.id, { focusHeightPercent: Math.max(10, Math.min(100, Number(event.target.value))), focusRect: undefined })} />
                      </Field>
                      <Field label="Focus padding">
                        <Input type="number" min={0} max={40} value={selected.padding} onChange={(event) => onChange(selected.id, { padding: Math.max(0, Math.min(40, Number(event.target.value))) })} />
                      </Field>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-cyan-500/25 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-100">
                      <span>{selected.focusRect ? "Custom dragged focus box saved." : "Use Play Step in DEV mode, then drag the box or its corners."}</span>
                      {selected.focusRect && <Button variant="ghost" onClick={() => onChange(selected.id, { focusRect: undefined })}>Reset box</Button>}
                    </div>
                  </>
                )}
                <div className="flex items-center justify-between border-t border-ink-700 pt-4">
                  <Button variant="danger" onClick={() => { onStepsChange(steps.filter((step) => step.id !== selected.id)); onSelectedId(steps.find((step) => step.id !== selected.id)?.id ?? null); }}>Delete step</Button>
                  <div className="flex gap-2">
                    <Button onClick={() => { const copy = { ...selected, id: `step-${Date.now().toString(36)}`, title: `${selected.title} (copy)`, placement: { ...selected.placement } }; const index = steps.findIndex((step) => step.id === selected.id); const next = [...steps]; next.splice(index + 1, 0, copy); onStepsChange(next); onSelectedId(copy.id); }}>Duplicate</Button>
                    <Button variant="primary" disabled={(selected.visual ?? "spotlight") !== "spotlight"} onClick={() => { onClose(); onPreview(selected.id); }}>Play Step</Button>
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>}
      </section>
    </div>,
    document.body,
  );
}

function ButtonControlsEditor({
  controls,
  selectedId,
  onSelectedId,
  onChange,
  onRemove,
  onPick,
}: {
  controls: readonly ExampleButtonControl[];
  selectedId: string | null;
  onSelectedId(id: string | null): void;
  onChange(id: string, patch: Partial<ExampleButtonControl>): void;
  onRemove(id: string): void;
  onPick(id: string): void;
}) {
  const selected = controls.find((control) => control.id === selectedId) ?? controls[0] ?? null;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[320px_1fr]">
      <aside className="flex min-h-0 flex-col border-r border-ink-700">
        <div className="border-b border-ink-700 px-4 py-3 text-xs text-ink-400">
          Overrides apply whenever user visits matching Example-project page.
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {controls.length === 0 && <p className="p-4 text-sm text-ink-400">Right-click a button and choose Edit State.</p>}
          {controls.map((control) => (
            <button key={control.id} type="button" onClick={() => onSelectedId(control.id)} className={cx("mb-1 w-full rounded-md border px-3 py-2 text-left", selected?.id === control.id ? "border-amber-400/50 bg-amber-400/10" : "border-transparent hover:bg-ink-800")}>
              <span className="block truncate text-sm font-semibold text-ink-100">{control.label}</span>
              <span className="block truncate text-[11px] text-ink-500">{control.route} · {control.state}</span>
            </button>
          ))}
        </div>
      </aside>
      <main className="min-h-0 overflow-y-auto p-5">
        {!selected ? <div className="grid h-full place-items-center text-sm text-ink-400">No button states assigned.</div> : (
          <div className="mx-auto max-w-2xl space-y-4">
            <div className="rounded-lg border border-ink-700 bg-ink-850 px-4 py-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">Button</div>
              <div className="mt-1 text-base font-bold text-white">{selected.label}</div>
              <div className="mt-1 text-xs text-ink-400">{selected.route} · {selected.targetName}</div>
            </div>
            <Field label="State in Example project">
              <Select value={selected.state} onChange={(event) => onChange(selected.id, { state: event.target.value as "enabled" | "disabled" })}>
                <option value="disabled">Disabled</option>
                <option value="enabled">Enabled</option>
              </Select>
            </Field>
            <div className="flex items-center justify-between border-t border-ink-700 pt-4">
              <Button variant="danger" onClick={() => onRemove(selected.id)}>Remove override</Button>
              <Button onClick={() => onPick(selected.id)}>Select another button</Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
