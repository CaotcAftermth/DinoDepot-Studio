import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFeedbackStore } from "../../stores/feedbackStore";
import { targetBreadcrumb } from "../../model/feedback/resolveTarget";
import { FEEDBACK_IGNORE, areaLabel } from "../../model/feedback/targets";
import { toast } from "../toast";
import { cx } from "../ui";

/**
 * The right-click menu.
 *
 * Its most useful property is that it already knows what was clicked: choosing
 * "Report a problem here" opens the form with the affected area filled in, so
 * the common case takes one right-click and a sentence.
 *
 * The decision about *whether* to show it is not here — it is in
 * `FeedbackHost`, which owns the document listener and refuses to take over
 * the menu in a text field. This component only draws what that decision
 * produced.
 */

const MENU_WIDTH = 272;

export function FeedbackContextMenu() {
  const menu = useFeedbackStore((state) => state.contextMenu);
  const close = useFeedbackStore((state) => state.closeContextMenu);
  const panel = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    if (panel.current) setHeight(panel.current.offsetHeight);
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      if (panel.current?.contains(event.target as Node)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Claimed before anything behind it: this menu is the topmost thing on
      // screen while it is open, so a modal underneath must not also close.
      event.stopPropagation();
      close();
    };
    // `mousedown` rather than `click`, so a press anywhere dismisses before
    // that press turns into an action on whatever is underneath.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
    };
  }, [menu, close]);

  // Focus moves into the menu so it can be driven from the keyboard, which is
  // also how the Windows context-menu key reaches it.
  useEffect(() => {
    if (!menu) return;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu]);

  if (!menu) return null;

  const store = useFeedbackStore.getState();
  const target = menu.target;
  const targetElement = menu.targetElement;

  // Kept inside the window on both axes. Height is measured rather than
  // assumed, because the menu is one row taller when it names a component.
  const left = Math.min(menu.x, Math.max(8, window.innerWidth - MENU_WIDTH - 8));
  const top =
    height > 0 && menu.y + height > window.innerHeight - 8
      ? Math.max(8, menu.y - height)
      : menu.y;

  const items: { label: string; hint?: string; run: () => void }[] = [
    {
      label: "Report a problem here",
      hint: target ? "Something is broken in this area" : "Something is broken or unexpected",
      run: () => {
        store.closeContextMenu();
        store.reportBug({ target, targetElement });
      },
    },
    {
      label: "Suggest an improvement here",
      hint: target ? "This area works, but could work better" : "Something works, but could work better",
      run: () => {
        store.closeContextMenu();
        store.suggestImprovement({ target, targetElement });
      },
    },
    {
      label: "Copy debug information",
      hint: "Version, page and component only",
      run: () => {
        store.closeContextMenu();
        void copyDebugInfo(target);
      },
    },
  ];

  return createPortal(
    <div
      {...FEEDBACK_IGNORE}
      ref={panel}
      role="menu"
      aria-label="Feedback"
      style={{ top, left, width: MENU_WIDTH }}
      className="fixed z-[65] bg-ink-900 border border-ink-600 rounded-lg shadow-2xl py-1 overflow-hidden"
    >
      {target && (
        <div
          className="mb-1 border-b border-ink-700 px-3 py-2.5"
          title={targetBreadcrumb(target)}
        >
          <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-accent-400">
            Selected area
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold leading-tight text-white">
            {target.name}
          </div>
          {target.area && (
            <div className="mt-0.5 truncate text-[11px] text-ink-400">
              {areaLabel(target.area)}
            </div>
          )}
        </div>
      )}
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          onClick={item.run}
          // The first item is focused when the menu opens so keyboard users
          // have a starting point. When a pointer user moves to another row,
          // transfer that focus as a native context menu would; otherwise the
          // first and hovered rows both look selected indefinitely.
          onPointerMove={(event) => {
            if (document.activeElement !== event.currentTarget) {
              event.currentTarget.focus({ preventScroll: true });
            }
          }}
          className={cx(
            "w-full cursor-pointer px-3 py-2.5 text-left",
            "text-ink-200 hover:bg-ink-800 hover:text-white",
            "focus:outline-none focus:bg-ink-800 focus:text-white",
          )}
        >
          <span className="block text-[13px] font-semibold leading-tight">
            {item.label}
          </span>
          {item.hint && (
            <span className="mt-1 block text-[11px] leading-4 text-ink-400">
              {item.hint}
            </span>
          )}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * Puts the debug summary on the clipboard.
 *
 * The webview's clipboard API is the only route — there is no Tauri clipboard
 * plugin in this build — and it can be refused, so the failure says what
 * happened rather than nothing at all.
 */
async function copyDebugInfo(
  target: Parameters<typeof targetBreadcrumb>[0],
): Promise<void> {
  const text = await useFeedbackStore.getState().debugInfo(target);
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Debug information copied.");
  } catch {
    toast.error("Could not reach the clipboard. Open Feedback to read the details instead.");
  }
}
