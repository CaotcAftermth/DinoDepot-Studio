import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFeedbackStore } from "../../stores/feedbackStore";
import { findFeedbackTarget, targetBreadcrumb } from "../../model/feedback/resolveTarget";
import { FEEDBACK_IGNORE } from "../../model/feedback/targets";
import type { FeedbackTargetSnapshot } from "../../model/feedback/types";

/**
 * "Select affected area" — the element picker.
 *
 * Modelled on the browser inspector, but pointed at parts of DinoDepot Studio
 * rather than at DOM nodes: what lights up is a *registered component*, so
 * clicking a number inside a rule highlights the quantity field, not the
 * `<span>` the digits happen to be in.
 *
 * ## Why there is no capture overlay
 *
 * The obvious implementation puts a transparent layer over the app to catch
 * the pointer. It cannot work: with a layer in front, every `mousemove` has
 * the layer as its target, and the app underneath is unreachable. So the
 * listeners go on the document in the capture phase, the highlight is drawn in
 * a layer that is explicitly `pointer-events: none`, and the click is
 * swallowed before it can reach whatever is underneath.
 *
 * Swallowing that click matters more than it sounds. Without it, picking the
 * Delete button on a rule as the affected area would delete the rule.
 */

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

function boxOf(node: Element): Box {
  const rect = node.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

export function Inspector() {
  const inspecting = useFeedbackStore((state) => state.inspecting);
  const hovered = useFeedbackStore((state) => state.hovered);
  const [box, setBox] = useState<Box | null>(null);
  /** The element currently highlighted, so scrolling can re-measure it. */
  const node = useRef<Element | null>(null);

  useEffect(() => {
    if (!inspecting) {
      node.current = null;
      setBox(null);
      return;
    }

    const store = useFeedbackStore.getState();

    function resolve(event: Event): FeedbackTargetSnapshot | null {
      const element = event.target;
      if (!(element instanceof Element)) return null;
      const found = findFeedbackTarget(element as unknown as HTMLElement);
      if (!found) {
        node.current = null;
        setBox(null);
        return null;
      }
      node.current = found.node as unknown as Element;
      setBox(boxOf(found.node as unknown as Element));
      return found.snapshot;
    }

    const onMove = (event: MouseEvent) => {
      store.hoverTarget(resolve(event));
    };

    /**
     * Every way a press can turn into an action, stopped.
     *
     * `click` alone is not enough — plenty of this app's controls act on
     * `mousedown`, and a menu that opens on `mousedown` would appear over the
     * thing being inspected.
     */
    const swallow = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const onDown = (event: MouseEvent) => {
      swallow(event);
      const snapshot = resolve(event);
      // A press on empty space cancels, which is what somebody who has
      // changed their mind reaches for before they remember Escape exists.
      if (snapshot) store.pickTarget(snapshot, node.current);
      else store.cancelInspector();
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        store.cancelInspector();
        return;
      }
      // Enter picks whatever is highlighted, so the picker is usable from the
      // keyboard once something has been focused or hovered.
      if (event.key === "Enter" && useFeedbackStore.getState().hovered) {
        event.preventDefault();
        event.stopPropagation();
        const snapshot = useFeedbackStore.getState().hovered;
        if (snapshot) store.pickTarget(snapshot, node.current);
      }
    };

    /**
     * Scrolling stays enabled — the affected area is often not on screen when
     * the picker starts — so the highlight has to follow what it is drawn
     * around. Nested scroll containers are why this listens in the capture
     * phase on the document rather than on the window.
     */
    const onScroll = () => {
      if (node.current?.isConnected) setBox(boxOf(node.current));
      else setBox(null);
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mouseup", swallow, true);
    document.addEventListener("click", swallow, true);
    document.addEventListener("contextmenu", swallow, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "crosshair";

    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mouseup", swallow, true);
      document.removeEventListener("click", swallow, true);
      document.removeEventListener("contextmenu", swallow, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      document.body.style.cursor = previousCursor;
    };
  }, [inspecting]);

  if (!inspecting) return null;

  return createPortal(
    <div
      {...FEEDBACK_IGNORE}
      // Nothing in this layer may take the pointer, or the element under the
      // cursor would always be this overlay.
      className="fixed inset-0 z-[70] pointer-events-none"
      aria-hidden
    >
      <div className="absolute inset-0 bg-ink-950/40" />

      {box && box.width > 0 && (
        <>
          <div
            className="absolute border-2 border-accent-400 bg-accent-500/15 rounded-sm transition-all duration-75"
            style={{
              top: box.top,
              left: box.left,
              width: box.width,
              height: box.height,
            }}
          />
          {hovered && <HoverLabel box={box} target={hovered} />}
        </>
      )}

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-ink-900 border border-ink-600 rounded-full px-4 py-2 text-sm text-ink-100 shadow-2xl">
        Click an area to select it
        <span className="text-ink-400"> · Esc to cancel</span>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The floating name.
 *
 * Sits above the highlight, or below it when the highlight is against the top
 * of the window — a label drawn off screen is the same as no label.
 */
function HoverLabel({ box, target }: { box: Box; target: FeedbackTargetSnapshot }) {
  const above = box.top > 34;
  return (
    <div
      className="absolute max-w-md truncate bg-accent-600 text-white text-xs font-medium px-2 py-1 rounded shadow-lg"
      style={{
        top: above ? box.top - 26 : box.top + box.height + 6,
        left: Math.max(8, Math.min(box.left, window.innerWidth - 320)),
      }}
    >
      {targetBreadcrumb(target)}
    </div>
  );
}
