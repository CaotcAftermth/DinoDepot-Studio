import { useEffect } from "react";
import { useFeedbackStore } from "../../stores/feedbackStore";
import { effectiveConfig } from "../../model/feedback/config";
import { FEEDBACK_SCOPE, sanitizeText, studioLog } from "../../model/feedback/log";
import { findFeedbackTarget } from "../../model/feedback/resolveTarget";
import { FeedbackPanels } from "./FeedbackPanels";

/**
 * The panels are kept with the host rather than fetched after the first click.
 *
 * This costs a small amount of startup parsing, but a reporting facility must
 * still open when a dev-server hot update, stale chunk, or transient asset
 * failure occurs. A rejected React.lazy import is cached for the lifetime of
 * the page and previously escaped into the router error boundary, leaving no
 * feedback entry point able to recover without a full reload.
 */

/**
 * The Feedback Center's root.
 *
 * Mounted next to `ToastContainer` and `ConfirmHost`, and for the same reason:
 * it is a facility the whole application shares rather than anything belonging
 * to a page. It is rendered both inside the project shell *and* on the welcome
 * screen, because a bug on the welcome screen is still a bug and there is no
 * project open to report it from.
 *
 * Nothing here decides anything. It owns the document-level listeners - the
 * shortcut, the right-click menu, the crash handlers - and renders whichever
 * panel the store says is current.
 */

/** Opens Feedback from anywhere. Chosen because nothing else in the app uses it. */
export const FEEDBACK_SHORTCUT = "Ctrl+Shift+F";

export function FeedbackHost() {
  const view = useFeedbackStore((state) => state.view);
  const inspecting = useFeedbackStore((state) => state.inspecting);
  const contextMenu = useFeedbackStore((state) => state.contextMenu);
  const settings = useFeedbackStore((state) => state.settings);
  const enabled = effectiveConfig(settings).enabled;

  // Reads the stored history once, on the first mount. Failure is handled
  // inside - this must not be able to stop the app rendering.
  useEffect(() => {
    void useFeedbackStore.getState().init();
  }, []);

  useKeyboardShortcut(enabled);
  useContextMenu(enabled);
  useCrashLogging();

  if (!enabled) return null;
  // Nothing to draw until something is open.
  if (view === "closed" && !inspecting && !contextMenu) return null;

  return <FeedbackPanels />;
}

// ---------------------------------------------------------------------------

function useKeyboardShortcut(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    function onKey(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      // `code` rather than `key`: with Shift held, some layouts report a
      // different character, and the shortcut should be the physical F.
      if (event.code !== "KeyF") return;
      event.preventDefault();
      const store = useFeedbackStore.getState();
      // While the picker is running the shortcut would open a modal over it.
      if (store.inspecting) return;
      if (store.view === "closed") store.openLauncher();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/**
 * The right-click menu, and the three cases where it must not appear.
 *
 * Getting this wrong is worse than not having the feature. An administrator
 * who right-clicks a text field wants Paste; one who right-clicks selected
 * text wants Copy. Taking the menu over in either case would break something
 * that works today in exchange for something that is only ever a shortcut.
 */
function useContextMenu(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    function onContextMenu(event: MouseEvent) {
      const element = event.target;
      if (!(element instanceof Element)) return;

      // 1. Editable fields keep the native menu, which has cut, copy and paste.
      if (element.closest('input, textarea, select, [contenteditable="true"]')) return;

      // 2. So does a selection, which is the other reason to want Copy.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;

      // 3. And the Feedback Center's own surfaces, which would otherwise offer
      //    to file a bug against the bug report form.
      if (element.closest("[data-feedback-ignore]")) return;

      const store = useFeedbackStore.getState();
      if (store.inspecting) return;

      event.preventDefault();
      const found = findFeedbackTarget(element as unknown as HTMLElement);
      store.openContextMenu({
        x: event.clientX,
        y: event.clientY,
        target: found?.snapshot ?? null,
        targetElement: (found?.node as Element | undefined) ?? null,
        editable: false,
      });
    }

    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [enabled]);
}

/**
 * Records crashes that no component caught.
 *
 * These are the failures nobody can describe afterwards - a rejected promise
 * in a background refresh, an error from a listener - and they are exactly
 * what makes the log worth attaching to a report. Nothing is sent; the entry
 * simply exists if a report is made later.
 */
function useCrashLogging() {
  useEffect(() => {
    function onError(event: ErrorEvent) {
      studioLog.error(
        "window",
        sanitizeText(event.message || String(event.error ?? "Unknown error")),
      );
    }
    function onRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      studioLog.error(
        "promise",
        sanitizeText(
          reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
        ),
      );
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
}

/** Logged by anything that wants a line in the report's recent events. */
export { studioLog, FEEDBACK_SCOPE };
