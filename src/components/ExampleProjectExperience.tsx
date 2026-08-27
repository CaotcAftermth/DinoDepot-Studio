import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import {
  EXAMPLE_PROJECT_SEED_VERSION,
  EXAMPLE_TOUR_SELECTION_ATTR,
  completeExampleTourStep,
  defaultExampleTourDocument,
  emptyExampleTourProgress,
  exampleTourSelectionKeys,
  firstIncompleteExampleTourStep,
  normalizeExampleTourDocument,
  normalizeExampleTourProgress,
  type ExampleButtonControl,
  type ExampleTourDocument,
  type ExampleTourArrowDirection,
  type ExampleTourExpansion,
  type ExampleTourPlacement,
  type ExampleTourProgress,
  type ExampleTourStep,
} from "../model/exampleProject";
import { FEEDBACK_ATTR, FEEDBACK_IGNORE, parseTargetContext } from "../model/feedback/targets";
import { Button, cx } from "./ui";
import { ExampleWalkthroughAuthoring } from "./ExampleWalkthroughAuthoring";

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  left: number;
  top: number;
}

type FocusResizeMode = "move" | "nw" | "ne" | "se" | "sw";

interface FocusDragState {
  pointerId: number;
  mode: FocusResizeMode;
  startX: number;
  startY: number;
  startRect: SpotlightRect;
  bounds: DOMRect;
  padding: number;
}

function progressKey(projectId: string): string {
  return `ddstudio.exampleTour.${projectId}.v${EXAMPLE_PROJECT_SEED_VERSION}`;
}

function draftKey(projectId: string): string {
  return `ddstudio.exampleTourDraft.${projectId}.v1`;
}

function loadDocument(projectId: string): ExampleTourDocument {
  try {
    const stored = localStorage.getItem(draftKey(projectId));
    if (stored) return normalizeExampleTourDocument(JSON.parse(stored)) ?? defaultExampleTourDocument();
  } catch {
    // Invalid local authoring data falls back to the versioned walkthrough.
  }
  return defaultExampleTourDocument();
}

function saveDocument(projectId: string, document: ExampleTourDocument): void {
  try {
    localStorage.setItem(draftKey(projectId), JSON.stringify(document));
  } catch {
    // Authoring remains usable for the session when storage is unavailable.
  }
}

function loadProgress(projectId: string, steps: readonly ExampleTourStep[]): ExampleTourProgress {
  try {
    return normalizeExampleTourProgress(
      JSON.parse(localStorage.getItem(progressKey(projectId)) ?? "null"),
      steps,
    );
  } catch {
    return emptyExampleTourProgress();
  }
}

function saveProgress(projectId: string, progress: ExampleTourProgress): void {
  try {
    localStorage.setItem(progressKey(projectId), JSON.stringify(progress));
  } catch {
    // Progress is a convenience. Storage refusal must not block the example.
  }
}

function routeMatches(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

function isWalkthroughStep(step: ExampleTourStep): boolean {
  return (step.visual ?? "spotlight") === "spotlight";
}

function targetFor(step: Pick<ExampleTourStep, "targetId" | "targetContext">): HTMLElement | null {
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

function measuredRect(element: HTMLElement, step: ExampleTourStep): SpotlightRect {
  const rect = element.getBoundingClientRect();
  const pad = Math.max(0, Math.min(40, step.padding));
  const widthFraction = step.focusRect?.width ?? (step.focusWidthPercent ?? 100) / 100;
  const heightFraction = step.focusRect?.height ?? (step.focusHeightPercent ?? 100) / 100;
  const width = rect.width * widthFraction;
  const height = rect.height * heightFraction;
  const focusTop = rect.top + rect.height * (step.focusRect?.y ?? (1 - heightFraction) / 2);
  const focusLeft = rect.left + rect.width * (step.focusRect?.x ?? (1 - widthFraction) / 2);
  const top = Math.max(54, focusTop - pad);
  const left = Math.max(8, focusLeft - pad);
  return {
    top,
    left,
    width: Math.max(24, Math.min(window.innerWidth - left - 8, width + pad * 2)),
    height: Math.max(24, Math.min(window.innerHeight - top - 8, height + pad * 2)),
  };
}

function annotationPoint(step: ExampleTourStep): { left: number; top: number } | null {
  const target = targetFor(step);
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  const position = step.annotationPosition ?? { x: 1, y: 0 };
  return {
    left: clamp(rect.left + rect.width * position.x, 8, window.innerWidth - 8),
    top: clamp(rect.top + rect.height * position.y, 54, window.innerHeight - 8),
  };
}

function buttonText(button: HTMLButtonElement): string {
  return (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? button.querySelector<HTMLElement>("h3")?.innerText ?? button.innerText)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function controlFor(control: ExampleButtonControl): HTMLButtonElement | null {
  const area = targetFor(control);
  if (!area) return null;
  const buttons = [
    ...(area.matches("button") ? [area as HTMLButtonElement] : []),
    ...area.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((button) => buttonText(button) === control.label);
  return buttons[control.index] ?? null;
}

function expansionButtonFor(expansion: ExampleTourExpansion): HTMLButtonElement | null {
  if (expansion.key) {
    const keyed = [...document.querySelectorAll<HTMLButtonElement>("button[data-collapse-key]")]
      .find((button) => button.dataset.collapseKey === expansion.key);
    if (keyed) return keyed;
  }
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded][aria-controls]")]
    .filter((button) =>
      !button.closest("[data-walkthrough-authoring]") && buttonText(button) === expansion.label);
  return buttons[expansion.index] ?? null;
}

function selectionButtonFor(key: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>(
    `button[${EXAMPLE_TOUR_SELECTION_ATTR}]`,
  )].find((button) => button.getAttribute(EXAMPLE_TOUR_SELECTION_ATTR) === key) ?? null;
}

function openCollapsedAncestors(step: ExampleTourStep): void {
  const target = targetFor(step);
  if (!target) return;
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[aria-expanded='false'][aria-controls]")) {
    if (button.closest("[data-walkthrough-authoring]")) continue;
    const controlled = document.getElementById(button.getAttribute("aria-controls") ?? "");
    if (controlled?.contains(target)) button.click();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cardPosition(
  rect: SpotlightRect | null,
  placement: ExampleTourPlacement,
  cardHeight: number,
): CSSProperties {
  const width = Math.min(368, window.innerWidth - 32);
  const height = cardHeight || 300;
  const maxLeft = Math.max(8, window.innerWidth - width - 8);
  const maxTop = Math.max(58, window.innerHeight - height - 8);
  if (placement.mode === "custom") {
    return {
      left: clamp(8 + (placement.x ?? 0) * (maxLeft - 8), 8, maxLeft),
      top: clamp(58 + (placement.y ?? 0) * (maxTop - 58), 58, maxTop),
    };
  }
  if (placement.mode === "top-left") return { left: 24, top: 70 };
  if (placement.mode === "top-right") return { right: 24, top: 70 };
  if (placement.mode === "bottom-left") return { left: 24, bottom: 24 };
  if (placement.mode === "bottom-right") return { right: 24, bottom: 24 };
  const gap = 18;
  if (rect && window.innerWidth - (rect.left + rect.width) >= width + gap + 16) {
    return { left: rect.left + rect.width + gap, top: clamp(rect.top, 70, maxTop) };
  }
  if (rect && rect.left >= width + gap + 16) {
    return { left: rect.left - width - gap, top: clamp(rect.top, 70, maxTop) };
  }
  return { right: 24, bottom: 24 };
}

export function ExampleProjectBar({
  projectId,
  devEditing,
  onDevEditingChange,
}: {
  projectId: string;
  devEditing: boolean;
  onDevEditingChange(value: boolean): void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [tourDocument, setTourDocument] = useState(() => loadDocument(projectId));
  const steps = tourDocument.steps;
  const controls = tourDocument.controls;
  const tourSteps = useMemo(
    () => steps.filter(isWalkthroughStep),
    [steps],
  );
  const initial = useRef(loadProgress(projectId, tourSteps));
  const [progress, setProgress] = useState(initial.current);
  const [tourOpen, setTourOpen] = useState(!initial.current.dismissed && initial.current.completed.length === 0 && tourSteps.length > 0);
  const [stepIndex, setStepIndex] = useState(() => firstIncompleteExampleTourStep(initial.current, tourSteps));
  const [rect, setRect] = useState<SpotlightRect | null>(null);
  const [missingTarget, setMissingTarget] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const [cardHeight, setCardHeight] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragPosition, setDragPosition] = useState<{ left: number; top: number } | null>(null);
  const [focusDrag, setFocusDrag] = useState<FocusDragState | null>(null);
  const focusDragRef = useRef<FocusDragState | null>(null);
  const focusRectRef = useRef<SpotlightRect | null>(null);
  const focusMovedRef = useRef(false);
  const [dismissedDots, setDismissedDots] = useState<string[]>([]);
  const [completionReady, setCompletionReady] = useState(false);

  useEffect(() => {
    const nextDocument = loadDocument(projectId);
    const nextSteps = nextDocument.steps;
    const nextTourSteps = nextSteps.filter(isWalkthroughStep);
    const nextProgress = loadProgress(projectId, nextTourSteps);
    setTourDocument(nextDocument);
    setProgress(nextProgress);
    setTourOpen(!nextProgress.dismissed && nextProgress.completed.length === 0 && nextTourSteps.length > 0);
    setStepIndex(firstIncompleteExampleTourStep(nextProgress, nextTourSteps));
    setDismissedDots([]);
    setCompletionReady(false);
  }, [projectId]);

  useEffect(() => saveProgress(projectId, progress), [projectId, progress]);

  function setSteps(next: ExampleTourStep[]) {
    const nextTourSteps = next.filter(isWalkthroughStep);
    const nextDocument = { ...tourDocument, steps: next };
    setTourDocument(nextDocument);
    saveDocument(projectId, nextDocument);
    setProgress((current) => normalizeExampleTourProgress(current, nextTourSteps));
    setStepIndex((current) => clamp(current, 0, Math.max(0, nextTourSteps.length - 1)));
  }

  function setControls(next: ExampleButtonControl[]) {
    const nextDocument = { ...tourDocument, controls: next };
    setTourDocument(nextDocument);
    saveDocument(projectId, nextDocument);
  }

  function updateStep(id: string, patch: Partial<ExampleTourStep>) {
    setSteps(steps.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  const step = tourSteps[stepIndex];
  const activeDots = step
    ? steps.filter((item) => item.visual === "hotspot" && item.parentStepId === step.id)
    : [];
  const pendingDots = activeDots.filter((dot) => !dismissedDots.includes(dot.id));
  const baseCompletionReady = Boolean(
    step && (step.completion === "manual" || step.completion === "page" || completionReady),
  );
  const canProceed = activeDots.length === 0 || (pendingDots.length === 0 && baseCompletionReady);

  function completeCurrentStep() {
    if (!step) return;
    setProgress((current) => completeExampleTourStep(current, step.id, tourSteps));
    setRect(null);
    if (stepIndex >= tourSteps.length - 1) setTourOpen(false);
    else setStepIndex((current) => current + 1);
  }

  function satisfyCurrentCompletion() {
    if (activeDots.length > 0) setCompletionReady(true);
    else completeCurrentStep();
  }

  // Completion rules work during normal exploration, not only while tour is open.
  useEffect(() => {
    const active = tourOpen && step
      ? (routeMatches(location.pathname, step.route) ? [step] : [])
      : tourSteps.filter((item) => routeMatches(location.pathname, item.route) && !progress.completed.includes(item.id));
    if (active.length === 0) return;
    const cleanups: (() => void)[] = [];
    for (const item of active) {
      const complete = () => {
        if (tourOpen && step?.id === item.id) satisfyCurrentCompletion();
        else setProgress((current) => completeExampleTourStep(current, item.id, tourSteps));
      };
      if (item.completion === "page") {
        // Page completion tracks free exploration. Guided playback navigates
        // to the page itself, so completing here would skip the card instantly.
        if (tourOpen) continue;
        const timer = setTimeout(complete, 0);
        cleanups.push(() => clearTimeout(timer));
        continue;
      }
      if (item.completion === "manual") continue;
      let cancelled = false;
      let attempts = 0;
      let retry: ReturnType<typeof setTimeout> | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let clickTarget: HTMLElement | null = null;
      const find = () => {
        if (cancelled) return;
        clickTarget = targetFor(item);
        if (!clickTarget) {
          attempts += 1;
          if (attempts < 30) retry = setTimeout(find, 100);
          return;
        }
        if (item.completion === "click") clickTarget.addEventListener("click", complete, { once: true });
        else timer = setTimeout(complete, (item.viewDurationSeconds ?? 3) * 1_000);
      };
      find();
      cleanups.push(() => {
        cancelled = true;
        if (retry) clearTimeout(retry);
        if (timer) clearTimeout(timer);
        clickTarget?.removeEventListener("click", complete);
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [location.pathname, progress.completed, step, stepIndex, tourOpen, tourSteps]);

  useEffect(() => {
    if (!tourOpen || !step) return;
    if (!routeMatches(location.pathname, step.route)) navigate(step.route);
  }, [location.pathname, navigate, step, tourOpen]);

  useLayoutEffect(() => {
    if (!tourOpen || !step || !routeMatches(location.pathname, step.route)) return;
    let cancelled = false;
    let observer: MutationObserver | null = null;
    const enforce = () => {
      if (cancelled) return;
      for (const selection of exampleTourSelectionKeys(step)) {
        const button = selectionButtonFor(selection);
        if (button?.getAttribute("aria-pressed") !== "true") button?.click();
      }
      openCollapsedAncestors(step);
      for (const expansion of step.expansions ?? []) {
        const button = expansionButtonFor(expansion);
        if (button?.getAttribute("aria-expanded") === "false") button.click();
      }
      if (!observer) {
        observer = new MutationObserver(enforce);
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["aria-expanded", "aria-pressed"],
        });
      }
    };
    enforce();
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [location.pathname, step, tourOpen]);

  useLayoutEffect(() => {
    if (!tourOpen || !step || !routeMatches(location.pathname, step.route)) {
      setRect(null);
      setMissingTarget(false);
      return;
    }
    let target: HTMLElement | null = null;
    let observer: ResizeObserver | null = null;
    let layoutObserver: MutationObserver | null = null;
    let animationFrame: number | null = null;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      target = targetFor(step);
      if (!target) {
        attempts += 1;
        if (attempts < 40) retry = setTimeout(measure, 100);
        else setMissingTarget(true);
        return;
      }
      const current = target.getBoundingClientRect();
      if (current.width <= 0 || current.height <= 0 || target.getClientRects().length === 0) {
        attempts += 1;
        if (attempts < 40) retry = setTimeout(measure, 100);
        else setMissingTarget(true);
        return;
      }
      setMissingTarget(false);
      if (current.top < 60 || current.bottom > window.innerHeight - 20) target.scrollIntoView({ behavior: "smooth", block: "center" });
      if (!focusDragRef.current) setRect(measuredRect(target, step));
      observer?.disconnect();
      observer = new ResizeObserver(() => {
        if (target && !focusDragRef.current) setRect(measuredRect(target, step));
      });
      observer.observe(target);
    };
    const update = () => {
      if (!target || !target.isConnected) {
        target = null;
        measure();
        return;
      }
      const current = target.getBoundingClientRect();
      if (current.width <= 0 || current.height <= 0 || target.getClientRects().length === 0) {
        setRect(null);
        return;
      }
      if (!focusDragRef.current) setRect(measuredRect(target, step));
    };
    layoutObserver = new MutationObserver(() => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(update);
    });
    layoutObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "aria-pressed", "class"],
    });
    measure();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      layoutObserver?.disconnect();
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [location.pathname, step, tourOpen]);

  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const measure = () => setCardHeight(cardRef.current?.offsetHeight ?? 0);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [step, tourOpen]);

  useLayoutEffect(() => {
    const controlled = controls.filter((item) => routeMatches(location.pathname, item.route));
    const cleanups: (() => void)[] = [];
    for (const item of controlled) {
      let button: HTMLButtonElement | null = null;
      let observer: MutationObserver | null = null;
      let retry: ReturnType<typeof setTimeout> | null = null;
      let attempts = 0;
      let originalDisabled = false;
      let cancelled = false;
      const apply = () => {
        if (cancelled) return;
        if (!button) {
          button = controlFor(item);
          if (!button) {
            attempts += 1;
            if (attempts < 30) retry = setTimeout(apply, 100);
            return;
          }
          originalDisabled = button.disabled;
          observer = new MutationObserver(apply);
          observer.observe(button, { attributes: true, attributeFilter: ["disabled"] });
        }
        const disabled = item.state === "disabled";
        if (button.disabled !== disabled) button.disabled = disabled;
        button.setAttribute("data-example-controlled", item.state);
      };
      apply();
      cleanups.push(() => {
        cancelled = true;
        if (retry) clearTimeout(retry);
        observer?.disconnect();
        if (button) {
          button.disabled = originalDisabled;
          button.removeAttribute("data-example-controlled");
        }
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [controls, location.pathname]);

  useEffect(() => {
    if (!drag || !step) return;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      const width = Math.min(368, window.innerWidth - 32);
      setDragPosition({
        left: clamp(drag.left + event.clientX - drag.startX, 8, window.innerWidth - width - 8),
        top: clamp(drag.top + event.clientY - drag.startY, 58, window.innerHeight - cardHeight - 8),
      });
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      const position = dragPosition ?? { left: drag.left, top: drag.top };
      const width = Math.min(368, window.innerWidth - 32);
      const availableX = Math.max(1, window.innerWidth - width - 16);
      const availableY = Math.max(1, window.innerHeight - cardHeight - 66);
      updateStep(step.id, {
        placement: {
          mode: "custom",
          x: clamp((position.left - 8) / availableX, 0, 1),
          y: clamp((position.top - 58) / availableY, 0, 1),
        },
      });
      setDrag(null);
      setDragPosition(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [cardHeight, drag, dragPosition, step, steps]);

  useEffect(() => {
    focusDragRef.current = focusDrag;
    if (!focusDrag || !step) return;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== focusDrag.pointerId) return;
      const dx = event.clientX - focusDrag.startX;
      const dy = event.clientY - focusDrag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) focusMovedRef.current = true;
      const start = focusDrag.startRect;
      const minSize = 28;
      const minLeft = Math.max(8, focusDrag.bounds.left - focusDrag.padding);
      const minTop = Math.max(54, focusDrag.bounds.top - focusDrag.padding);
      const maxRight = Math.min(window.innerWidth - 8, focusDrag.bounds.right + focusDrag.padding);
      const maxBottom = Math.min(window.innerHeight - 8, focusDrag.bounds.bottom + focusDrag.padding);
      let left = start.left;
      let top = start.top;
      let right = start.left + start.width;
      let bottom = start.top + start.height;
      if (focusDrag.mode === "move") {
        left = clamp(start.left + dx, minLeft, maxRight - start.width);
        top = clamp(start.top + dy, minTop, maxBottom - start.height);
        right = left + start.width;
        bottom = top + start.height;
      } else {
        if (focusDrag.mode.includes("w")) left = clamp(start.left + dx, minLeft, right - minSize);
        if (focusDrag.mode.includes("e")) right = clamp(start.left + start.width + dx, left + minSize, maxRight);
        if (focusDrag.mode.includes("n")) top = clamp(start.top + dy, minTop, bottom - minSize);
        if (focusDrag.mode.includes("s")) bottom = clamp(start.top + start.height + dy, top + minSize, maxBottom);
      }
      const nextRect = { left, top, width: right - left, height: bottom - top };
      focusRectRef.current = nextRect;
      setRect(nextRect);
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== focusDrag.pointerId) return;
      const finalRect = focusRectRef.current ?? focusDrag.startRect;
      const bounds = focusDrag.bounds;
      const pad = focusDrag.padding;
      const x = clamp((finalRect.left + pad - bounds.left) / Math.max(1, bounds.width), 0, 0.98);
      const y = clamp((finalRect.top + pad - bounds.top) / Math.max(1, bounds.height), 0, 0.98);
      const width = clamp((finalRect.width - pad * 2) / Math.max(1, bounds.width), 0.02, 1 - x);
      const height = clamp((finalRect.height - pad * 2) / Math.max(1, bounds.height), 0.02, 1 - y);
      updateStep(step.id, {
        focusRect: { x, y, width, height },
        focusWidthPercent: Math.round(width * 100),
        focusHeightPercent: Math.round(height * 100),
      });
      focusDragRef.current = null;
      focusRectRef.current = null;
      setFocusDrag(null);
      setTimeout(() => { focusMovedRef.current = false; }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [focusDrag, step, steps]);

  useEffect(() => {
    setDrag(null);
    setDragPosition(null);
    focusDragRef.current = null;
    focusRectRef.current = null;
    setFocusDrag(null);
    setDismissedDots([]);
    setCompletionReady(false);
  }, [step?.id]);

  useEffect(() => {
    if (!tourOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setTourOpen(false);
      setProgress((current) => ({ ...current, dismissed: true }));
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [tourOpen]);

  function openTour(stepId?: string) {
    const requested = stepId ? tourSteps.findIndex((item) => item.id === stepId) : -1;
    if (stepId && requested < 0) return;
    setStepIndex(requested >= 0 ? requested : firstIncompleteExampleTourStep(progress, tourSteps));
    setProgress((current) => ({ ...current, dismissed: false }));
    setDismissedDots([]);
    setCompletionReady(false);
    setTourOpen(tourSteps.length > 0);
  }

  function restartTour() {
    setProgress(emptyExampleTourProgress());
    setStepIndex(0);
    setDismissedDots([]);
    setCompletionReady(false);
    setTourOpen(tourSteps.length > 0);
  }

  function dismissTour() {
    setTourOpen(false);
    setProgress((current) => ({ ...current, dismissed: true }));
  }

  function nextStep() {
    if (!step || !canProceed) return;
    setProgress((current) => completeExampleTourStep(current, step.id, tourSteps));
    if (stepIndex >= tourSteps.length - 1) return dismissTour();
    setRect(null);
    setStepIndex((current) => current + 1);
  }

  function beginDrag(event: ReactPointerEvent<HTMLElement>) {
    if (!devEditing || !cardRef.current) return;
    const current = cardRef.current.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: current.left, top: current.top });
    setDragPosition({ left: current.left, top: current.top });
  }

  function beginFocusDrag(event: ReactPointerEvent<HTMLElement>, mode: FocusResizeMode) {
    if (!devEditing || !step || !rect) return;
    const target = targetFor(step);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = {
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
      bounds: target.getBoundingClientRect(),
      padding: Math.max(0, Math.min(40, step.padding)),
    };
    focusDragRef.current = next;
    focusRectRef.current = rect;
    focusMovedRef.current = false;
    setFocusDrag(next);
  }

  const completeCount = progress.completed.filter((id) => tourSteps.some((item) => item.id === id)).length;
  const percent = tourSteps.length > 0 ? Math.round((completeCount / tourSteps.length) * 100) : 0;
  const position = step ? dragPosition ?? cardPosition(rect, step.placement, cardHeight) : {};

  return (
    <>
      <div data-walkthrough-authoring className="sticky top-0 z-40 flex min-h-12 items-center gap-3 border-b border-cyan-500/30 bg-cyan-950/95 px-5 py-2 shadow-lg backdrop-blur">
        <span className="rounded bg-cyan-400/15 px-2 py-0.5 text-[11px] font-bold tracking-widest text-cyan-300">EXAMPLE PROJECT</span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-cyan-100">{devEditing ? "DEV editing and walkthrough authoring enabled" : "Protected guided example"}</div>
          <div className="text-[11px] text-cyan-300/70">{completeCount} of {tourSteps.length} walkthrough areas explored · {steps.length - tourSteps.length} hover notes</div>
        </div>
        <Button className="shrink-0" onClick={() => openTour()} disabled={tourSteps.length === 0 || tourOpen}>{tourOpen ? "Walkthrough active" : completeCount > 0 ? "Continue walkthrough" : "Start walkthrough"}</Button>
        {completeCount > 0 && <Button className="shrink-0" variant="ghost" onClick={restartTour} disabled={tourSteps.length === 0}>Restart from beginning</Button>}
        <button
          type="button"
          role="switch"
          aria-checked={devEditing}
          onClick={() => onDevEditingChange(!devEditing)}
          className={cx("flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-bold tracking-wide transition-colors", devEditing ? "border-amber-400/60 bg-amber-400/15 text-amber-200" : "border-cyan-500/30 bg-ink-900/60 text-cyan-200")}
        >
          <span>DEV</span>
          <span className={cx("relative h-4 w-7 rounded-full transition-colors", devEditing ? "bg-amber-400" : "bg-ink-600")}>
            <span className={cx("absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform", devEditing ? "translate-x-3.5" : "translate-x-0.5")} />
          </span>
          <span>{devEditing ? "Edit on" : "Edit off"}</span>
        </button>
      </div>

      <ExampleWalkthroughAuthoring enabled={devEditing} steps={steps} controls={controls} onStepsChange={setSteps} onControlsChange={setControls} onPreview={openTour} />
      {devEditing && (
        <ExampleDevStepMarkers
          steps={tourSteps}
          pathname={location.pathname}
          activeStepId={tourOpen ? step?.id : undefined}
        />
      )}
      <ExampleAnnotations
        steps={steps}
        pathname={location.pathname}
        activeStepId={tourOpen ? step?.id : undefined}
        devEditing={devEditing}
        dismissedDots={devEditing ? [] : dismissedDots}
        onDismissDot={(id) => setDismissedDots((current) => current.includes(id) ? current : [...current, id])}
      />

      {tourOpen && step && (
        <div {...FEEDBACK_IGNORE} data-walkthrough-authoring className="pointer-events-auto fixed inset-0 z-[90]" aria-live="polite">
          {(step.visual ?? "spotlight") === "spotlight" && rect ? (
            <div
              onPointerDown={(event) => beginFocusDrag(event, "move")}
              onClick={() => {
                if (step.completion !== "click" || focusMovedRef.current) return;
                satisfyCurrentCompletion();
              }}
              role={step.completion === "click" ? "button" : undefined}
              tabIndex={step.completion === "click" ? 0 : undefined}
              onKeyDown={(event) => {
                if (step.completion !== "click" || (event.key !== "Enter" && event.key !== " ")) return;
                event.preventDefault();
                satisfyCurrentCompletion();
              }}
              className={cx(
                "fixed touch-none rounded-xl border-2 border-cyan-300 motion-reduce:transition-none",
                devEditing
                  ? "pointer-events-auto cursor-move"
                  : step.completion === "click"
                    ? "pointer-events-auto cursor-pointer transition-all duration-500 ease-out"
                    : "pointer-events-none transition-all duration-500 ease-out",
              )}
              style={{ ...rect, boxShadow: "0 0 0 9999px rgba(2,6,23,.72), 0 0 0 5px rgba(34,211,238,.16), 0 0 28px rgba(34,211,238,.45)" }}
            >
              <span className="pointer-events-none absolute inset-0 rounded-xl border border-cyan-200/80 animate-pulse motion-reduce:animate-none" />
              {devEditing && (
                <>
                  <span className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded bg-cyan-950/90 px-2 py-0.5 text-[10px] font-bold text-cyan-100">Drag · corners resize</span>
                  {(["nw", "ne", "se", "sw"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-label={`Resize focus box ${mode}`}
                      onPointerDown={(event) => beginFocusDrag(event, mode)}
                      className={cx(
                        "absolute size-4 rounded-sm border border-cyan-950 bg-cyan-200 shadow",
                        mode.includes("n") ? "-top-2" : "-bottom-2",
                        mode.includes("w") ? "-left-2" : "-right-2",
                        (mode === "nw" || mode === "se") ? "cursor-nwse-resize" : "cursor-nesw-resize",
                      )}
                    />
                  ))}
                </>
              )}
            </div>
          ) : (step.visual ?? "spotlight") === "spotlight" ? <div className="pointer-events-none fixed inset-0 bg-ink-950/75" /> : null}
          <section ref={cardRef} role="dialog" aria-modal="false" aria-labelledby="example-tour-title" className="pointer-events-auto fixed w-[368px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-cyan-400/40 bg-ink-900 shadow-2xl" style={position}>
            <div className="h-1 bg-ink-700"><div className="h-full bg-cyan-400 transition-[width] duration-500" style={{ width: `${Math.max(percent, ((stepIndex + 1) / tourSteps.length) * 100)}%` }} /></div>
            <header onPointerDown={beginDrag} className={cx("flex items-center justify-between border-b border-ink-700 px-4 py-2", devEditing && "cursor-move select-none")} title={devEditing ? "Drag to place this walkthrough card" : undefined}>
              <span className="text-[10px] font-bold uppercase tracking-widest text-cyan-300">{devEditing ? "Drag to position" : step.eyebrow}</span>
              <span className="text-xs text-ink-400">{stepIndex + 1} / {tourSteps.length}</span>
            </header>
            <div className="p-4">
              {devEditing && <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-cyan-300">{step.eyebrow}</div>}
              <h2 id="example-tour-title" className="text-base font-bold text-white">{step.title}</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-300">{step.body}</p>
              {activeDots.length > 0 && (
                <p className={cx(
                  "mt-3 rounded-md border px-2.5 py-2 text-xs",
                  canProceed
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                    : "border-cyan-400/30 bg-cyan-400/10 text-cyan-100",
                )}>
                  {pendingDots.length > 0
                    ? `View ${pendingDots.length} remaining information ${pendingDots.length === 1 ? "dot" : "dots"}.`
                    : !baseCompletionReady && step.completion === "click"
                      ? "All information dots viewed. Click focus area, then select Next."
                      : !baseCompletionReady
                        ? "All information dots viewed. Keep focus visible until completion, then select Next."
                        : "All information dots viewed. Select Next to continue."}
                </p>
              )}
              {missingTarget && <p className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-2 text-xs text-amber-200">Focus area no longer exists on this page. Step can still be skipped or edited.</p>}
              {devEditing && step.placement.mode === "custom" && <button type="button" className="mt-2 text-xs text-cyan-300 hover:text-cyan-200" onClick={() => updateStep(step.id, { placement: { mode: "auto" } })}>Reset automatic placement</button>}
              <div className="mt-4 flex items-center justify-between gap-2">
                <Button variant="ghost" onClick={dismissTour}>Exit</Button>
                <div className="flex gap-2">
                  <Button variant="ghost" disabled={stepIndex === 0} onClick={() => { setRect(null); setStepIndex((current) => Math.max(0, current - 1)); }}>Back</Button>
                  <Button variant="primary" onClick={nextStep} disabled={!canProceed}>{stepIndex === tourSteps.length - 1 ? "Finish" : "Next"}</Button>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function ExampleDevStepMarkers({
  steps,
  pathname,
  activeStepId,
}: {
  steps: readonly ExampleTourStep[];
  pathname: string;
  activeStepId?: string;
}) {
  return (
    <>
      {steps
        .filter((step) => routeMatches(pathname, step.route) && step.id !== activeStepId)
        .map((step) => <ExampleDevStepMarker key={step.id} step={step} />)}
    </>
  );
}

function ExampleDevStepMarker({ step }: { step: ExampleTourStep }) {
  const [markerRect, setMarkerRect] = useState<SpotlightRect | null>(null);
  useLayoutEffect(() => {
    let target: HTMLElement | null = null;
    let observer: ResizeObserver | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let cancelled = false;
    const update = () => {
      if (cancelled) return;
      target = targetFor(step);
      if (!target) {
        attempts += 1;
        if (attempts < 30) retry = setTimeout(update, 100);
        return;
      }
      const bounds = target.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) {
        setMarkerRect(null);
        return;
      }
      setMarkerRect(measuredRect(target, step));
      if (!observer) {
        observer = new ResizeObserver(update);
        observer.observe(target);
      }
    };
    update();
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      observer?.disconnect();
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [step]);
  if (!markerRect) return null;
  return createPortal(
    <div
      {...FEEDBACK_IGNORE}
      data-walkthrough-authoring
      className="pointer-events-none fixed z-[91] rounded-xl border-2 border-dashed border-amber-300/80 bg-amber-300/5 shadow-[0_0_18px_rgba(251,191,36,.18)]"
      style={markerRect}
    >
      <span className="absolute left-2 top-2 max-w-[calc(100%-16px)] truncate rounded bg-amber-950/95 px-2 py-0.5 text-[10px] font-bold text-amber-200 shadow">
        {step.title}
      </span>
    </div>,
    document.body,
  );
}

function ArrowAnnotation({
  point,
  title,
  direction = "right",
}: {
  point: { left: number; top: number };
  title: string;
  direction?: ExampleTourArrowDirection;
}) {
  const directions: Record<ExampleTourArrowDirection, { x: number; y: number; angle: number }> = {
    up: { x: 0, y: -1, angle: -90 },
    "up-right": { x: 0.707, y: -0.707, angle: -45 },
    right: { x: 1, y: 0, angle: 0 },
    "down-right": { x: 0.707, y: 0.707, angle: 45 },
    down: { x: 0, y: 1, angle: 90 },
    "down-left": { x: -0.707, y: 0.707, angle: 135 },
    left: { x: -1, y: 0, angle: 180 },
    "up-left": { x: -0.707, y: -0.707, angle: -135 },
  };
  const vector = directions[direction];
  const labelLeft = clamp(point.left - vector.x * 180, 118, window.innerWidth - 118);
  const labelTop = clamp(point.top - vector.y * 140, 68, window.innerHeight - 34);
  return (
    <>
      <span
        className="pointer-events-none fixed z-[92] text-5xl leading-none text-amber-300 drop-shadow-lg"
        style={{ left: point.left - vector.x * 46, top: point.top - vector.y * 46, transform: `translate(-50%, -50%) rotate(${vector.angle}deg)` }}
      >➜</span>
      <span
        className="pointer-events-none fixed z-[91] w-[220px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-amber-300/50 bg-amber-950/95 px-3 py-1.5 text-center text-sm font-bold text-amber-200 shadow-xl"
        style={{ left: labelLeft, top: labelTop }}
      >{title}</span>
    </>
  );
}

function ExampleAnnotations({
  steps,
  pathname,
  activeStepId,
  devEditing,
  dismissedDots,
  onDismissDot,
}: {
  steps: readonly ExampleTourStep[];
  pathname: string;
  activeStepId?: string;
  devEditing: boolean;
  dismissedDots: readonly string[];
  onDismissDot(id: string): void;
}) {
  const attached = steps.filter((item) =>
    (item.visual === "arrow" || item.visual === "hotspot") &&
    routeMatches(pathname, item.route) &&
    (devEditing || (activeStepId ? item.parentStepId === activeStepId : false)));
  return (
    <>
      {attached
        .filter((item) =>
          !(item.visual === "hotspot" && dismissedDots.includes(item.id)))
        .map((item) => (
          <AnnotationMarker
            key={item.id}
            step={item}
            onDismiss={() => onDismissDot(item.id)}
          />
        ))}
    </>
  );
}

function AnnotationMarker({ step, onDismiss }: { step: ExampleTourStep; onDismiss(): void }) {
  const [point, setPoint] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    let target: HTMLElement | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let cancelled = false;
    const update = () => {
      if (cancelled) return;
      target = targetFor(step);
      if (!target) {
        attempts += 1;
        if (attempts < 30) retry = setTimeout(update, 100);
        return;
      }
      const visible = target.getBoundingClientRect();
      if (visible.bottom < 54 || visible.top > window.innerHeight) {
        setPoint(null);
        return;
      }
      setPoint(annotationPoint(step));
    };
    update();
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [step]);
  if (!point) return null;
  return createPortal(
    step.visual === "arrow"
      ? <ArrowAnnotation point={point} title={step.title} direction={step.arrowDirection} />
      : <HotspotDot point={point} step={step} onDismiss={onDismiss} />,
    document.body,
  );
}

function HotspotDot({
  point,
  step,
  onDismiss,
}: {
  point: { left: number; top: number };
  step: ExampleTourStep;
  onDismiss(): void;
}) {
  const left = clamp(point.left - 14, 8, window.innerWidth - 36);
  const top = clamp(point.top - 14, 58, window.innerHeight - 36);
  return (
    <div {...FEEDBACK_IGNORE} data-walkthrough-authoring className="group fixed z-[92]" style={{ left, top }} onMouseLeave={onDismiss} onBlur={onDismiss}>
      <button
        type="button"
        aria-label={`More information: ${step.title}`}
        className="relative grid size-7 place-items-center rounded-full border-2 border-cyan-200 bg-cyan-950 shadow-[0_0_0_4px_rgba(34,211,238,.18),0_0_18px_rgba(34,211,238,.5)]"
      >
        <span className="absolute inset-[-7px] rounded-full border border-cyan-300/60 motion-safe:animate-ping" />
        <span className="size-2.5 rounded-full bg-cyan-300" />
      </button>
      <div role="tooltip" className="pointer-events-none absolute right-0 top-9 hidden w-72 rounded-lg border border-cyan-400/35 bg-ink-900 p-3 text-left shadow-2xl group-hover:block group-focus-within:block">
        <div className="text-sm font-bold text-white">{step.title}</div>
        <div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-300">{step.body}</div>
      </div>
    </div>
  );
}
