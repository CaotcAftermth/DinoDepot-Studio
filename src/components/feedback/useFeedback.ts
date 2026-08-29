import { useFeedbackStore } from "../../stores/feedbackStore";
import { canSubmitDirectly, effectiveConfig } from "../../model/feedback/config";
import type { FeedbackTargetSnapshot } from "../../model/feedback/types";

/**
 * The one way any part of the app starts a report.
 *
 * ```tsx
 * const { reportBug } = useFeedback();
 * <Button onClick={() => reportBug({ target })}>Report this</Button>
 * ```
 *
 * A hook over the store rather than a second store: the point is that a button
 * on a page, an item in the right-click menu, the keyboard shortcut and an
 * error boundary all end up in the same place, with the same draft and the
 * same rules about what may be sent.
 */

export interface FeedbackApi {
  /** Whether the Feedback Center is switched on at all in this build. */
  enabled: boolean;
  /** Whether reports can be filed without opening a browser. */
  canSubmitDirectly: boolean;
  openFeedback(): void;
  openMyReports(): void;
  reportBug(options?: { target?: FeedbackTargetSnapshot | null }): void;
  suggestImprovement(options?: { target?: FeedbackTargetSnapshot | null }): void;
  requestFeature(options?: { target?: FeedbackTargetSnapshot | null }): void;
  /** Starts a bug report already describing a caught error. */
  reportError(error: unknown, componentName?: string): void;
  startInspector(): void;
}

export function useFeedback(): FeedbackApi {
  const settings = useFeedbackStore((state) => state.settings);
  const config = effectiveConfig(settings);

  return {
    enabled: config.enabled,
    canSubmitDirectly: canSubmitDirectly(config),
    openFeedback: () => useFeedbackStore.getState().openLauncher(),
    openMyReports: () => useFeedbackStore.getState().openReports(),
    reportBug: (options) => useFeedbackStore.getState().reportBug(options),
    suggestImprovement: (options) =>
      useFeedbackStore.getState().suggestImprovement(options),
    requestFeature: (options) => useFeedbackStore.getState().requestFeature(options),
    reportError: (error, componentName) =>
      useFeedbackStore.getState().reportError(error, componentName),
    startInspector: () => useFeedbackStore.getState().startInspector(),
  };
}

/**
 * The same operations without a React subscription.
 *
 * For call sites that are not components - an error handler, a keyboard
 * binding - where subscribing would be meaningless.
 */
export const feedback = {
  open: () => useFeedbackStore.getState().openLauncher(),
  reportBug: (options?: { target?: FeedbackTargetSnapshot | null }) =>
    useFeedbackStore.getState().reportBug(options),
  reportError: (error: unknown, componentName?: string) =>
    useFeedbackStore.getState().reportError(error, componentName),
  captureTarget: (target: FeedbackTargetSnapshot | null) =>
    useFeedbackStore.getState().setTarget(target),
  linkExistingIssue: (candidate: {
    number: number;
    url: string;
    state: "open" | "closed";
    labels: string[];
  }) => useFeedbackStore.getState().linkExisting(candidate),
  submit: () => useFeedbackStore.getState().submit(),
};
