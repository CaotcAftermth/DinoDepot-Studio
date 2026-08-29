import { Component, type ErrorInfo, type ReactNode } from "react";
import { useFeedbackStore } from "../stores/feedbackStore";
import { sanitizeText, studioLog } from "../model/feedback/log";
import { effectiveConfig } from "../model/feedback/config";
import { Button } from "./ui";

/**
 * The screen a page shows instead of disappearing.
 *
 * Before this, a render error took the whole window: React unmounts the tree
 * from the root when nothing catches, so a mistake in one editor left an
 * administrator staring at a blank window with no way to say what happened.
 *
 * Two things matter here. The rest of the app keeps working, because the
 * boundary is around the routed page rather than around everything. And the
 * error is reportable in one click, with the message and a few stack frames
 * already filled in - that is the report that would otherwise never be written,
 * because "it went white and I closed it" is not a report anybody can act on.
 */

interface Props {
  children: ReactNode;
  /** Named in the message and in the report, e.g. "Production Rules". */
  name?: string;
}

interface State {
  error: Error | null;
  /** Bumped to force a fresh mount of the children when Retry is pressed. */
  attempt: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Sanitized on the way into the log, not on the way out of it: the bundle
    // paths in a stack trace name the machine, and the log is what a report
    // attaches.
    studioLog.error(
      "render",
      sanitizeText(
        `${this.props.name ?? "A page"} failed to render: ${error.message}${
          info.componentStack ? ` (${info.componentStack.trim().split("\n")[0]})` : ""
        }`,
      ),
    );
  }

  private retry = () => {
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }));
  };

  private report = () => {
    const { error } = this.state;
    if (error) useFeedbackStore.getState().reportError(error, this.props.name);
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      // The key is what makes Retry a real retry: without it React keeps the
      // failed subtree's state and the same render throws again immediately.
      return <div key={this.state.attempt}>{this.props.children}</div>;
    }

    return (
      <div className="max-w-lg mx-auto mt-16 rounded-lg border border-danger/40 bg-ink-900 p-6">
        <h2 className="text-base font-semibold text-white">
          Something went wrong
        </h2>
        <p className="mt-2 text-sm text-ink-300">
          {this.props.name ? `${this.props.name} could not be shown.` : "This page could not be shown."}{" "}
          Nothing you have saved is affected - the rest of the app is still
          working, and your project files were not touched.
        </p>
        <p className="mt-3 text-xs text-ink-500 mono break-words">
          {sanitizeText(error.message).slice(0, 300)}
        </p>
        <div className="mt-5 flex gap-2">
          <Button variant="primary" onClick={this.retry}>
            Retry
          </Button>
          <ReportErrorButton onClick={this.report} />
        </div>
      </div>
    );
  }
}

function ReportErrorButton({ onClick }: { onClick: () => void }) {
  const enabled = useFeedbackStore((state) => effectiveConfig(state.settings).enabled);
  if (!enabled) return null;
  return (
    <Button variant="secondary" onClick={onClick}>
      Report this error
    </Button>
  );
}
