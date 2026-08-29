import { useFeedbackStore } from "../../stores/feedbackStore";
import { FEEDBACK_TYPE_LABELS } from "../../model/feedback/types";
import { openExternal } from "../../services/openExternal";
import { Button, Modal } from "../ui";

/**
 * The two screens a submission can end on.
 *
 * Both say what happened to the report and what the reporter can do next.
 * Neither shows a stack trace: an administrator whose report failed to send
 * needs to know it is safe and how to try again, and the technical detail is
 * in the sanitized log where a maintainer can ask for it.
 */

const THANKS: Record<string, string> = {
  bug: "Thanks - that is exactly the kind of report that gets things fixed.",
  suggestion: "Thanks for helping improve DinoDepot Studio.",
  feature_request: "Thanks - feature requests are read, even the ambitious ones.",
};

export function SubmittedPanel() {
  const store = useFeedbackStore();
  const result = store.result;
  const type = store.draft?.type ?? "bug";
  if (!result) return null;

  const title = result.linked
    ? "Added to an existing report"
    : result.alreadyFiled
      ? "Already submitted"
      : `${FEEDBACK_TYPE_LABELS[type]} submitted`;

  return (
    <Modal
      title={title}
      onClose={() => void store.discardAndClose()}
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={store.openReports}>
            My reports
          </Button>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => void openExternal(result.issueUrl).catch(() => {})}
            >
              View issue ↗
            </Button>
            <Button variant="primary" onClick={() => void store.discardAndClose()}>
              Done
            </Button>
          </div>
        </div>
      }
    >
      <p className="text-sm text-ink-200">
        {result.linked
          ? "Your report now points at that issue, so it will show up on your list and update when it does."
          : result.alreadyFiled
            ? "This report had already reached us, so nothing was filed twice."
            : THANKS[type]}
      </p>
      <p className="mt-3 text-sm text-ink-300">
        It is issue{" "}
        <span className="mono text-ink-100">#{result.issueNumber}</span>. You can
        follow it from My reports without opening GitHub.
      </p>
      {result.missingLabels.length > 0 && (
        <p className="mt-3 text-xs text-ink-500">
          Some labels are not set up on the repository yet
          {` (${result.missingLabels.join(", ")})`}, so they were left off. The
          report itself is unaffected.
        </p>
      )}
    </Modal>
  );
}

/**
 * The failure screen.
 *
 * Its first sentence says whether the report is actually safe on disk. Retry
 * is offered only when retrying could plausibly work - after a refusal it
 * would just fail again, and the useful route is GitHub.
 */
export function FailedPanel() {
  const store = useFeedbackStore();
  const failure = store.failure;
  if (!failure) return null;

  return (
    <Modal
      title="Your report was not sent"
      onClose={() => void store.requestClose()}
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={store.backToForm}>
            Edit
          </Button>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => void store.openGithubFallback()}
            >
              Open on GitHub ↗
            </Button>
            {failure.retryable && (
              <Button
                variant="primary"
                onClick={() => void store.submit()}
                disabled={store.submitting}
              >
                {store.submitting ? "Sending…" : "Try again"}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <p className="text-sm text-ink-100 font-medium">
        {failure.saved
          ? "Your report is saved on this computer."
          : "Your report is still open, but it could not be saved on this computer."}
      </p>
      <p className="mt-2 text-sm text-ink-300">{failure.message}</p>
      <p className="mt-3 text-xs text-ink-500">
        {failure.saved
          ? "It is in My reports as “Not sent”, so you can come back to it. "
          : "Keep DinoDepot open while you edit or try again. "}
        Opening it on GitHub fills in everything except the diagnostics - those
        are left out because a link is not a safe place to carry them.
      </p>
    </Modal>
  );
}
