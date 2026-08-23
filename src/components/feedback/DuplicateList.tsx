import { useFeedbackStore } from "../../stores/feedbackStore";
import { statusFromIssue } from "../../model/feedback/status";
import { IssueStateSchema } from "../../model/feedback/types";
import { openExternal } from "../../services/openExternal";
import { Badge, Button, Modal } from "../ui";

/**
 * "Somebody may have already reported this."
 *
 * Shown between writing and submitting, and never in the way: every route out
 * of this screen is available at once, including submitting anyway. A
 * duplicate costs a maintainer half a minute; a report somebody was talked out
 * of filing costs them the bug.
 *
 * A closed issue is worth showing too. "Fixed in 1.3.9" is often the answer
 * the reporter actually wanted.
 */

export function DuplicateList() {
  const store = useFeedbackStore();
  const candidates = store.duplicates;

  return (
    <Modal
      title="Possible existing reports"
      onClose={() => void store.requestClose()}
      wide
      footer={
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" onClick={store.backToForm}>
            Back to my report
          </Button>
          <Button
            variant="primary"
            onClick={() => void store.submit()}
            disabled={store.submitting}
          >
            {store.submitting ? "Sending…" : "Submit anyway"}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-ink-300 mb-4">
        These look similar to what you described. If one of them is your
        problem, saying so keeps it on your list without filing a second
        report — otherwise submit yours.
      </p>

      <ul className="flex flex-col gap-2">
        {candidates.map((candidate) => {
          const status = statusFromIssue(
            IssueStateSchema.parse({
              state: candidate.state,
              labels: candidate.labels,
              title: candidate.title,
              updatedAt: candidate.updatedAt,
            }),
          );
          return (
            <li
              key={candidate.number}
              className="rounded-lg border border-ink-700 bg-ink-850 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-ink-100">
                    <span className="text-ink-500 mono mr-1.5">#{candidate.number}</span>
                    {candidate.title}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="text-xs text-ink-500">{candidate.reason}</span>
                  </div>
                </div>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  onClick={() => void openExternal(candidate.url).catch(() => {})}
                >
                  View ↗
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void store.linkExisting({
                      number: candidate.number,
                      url: candidate.url,
                      state: candidate.state,
                      labels: candidate.labels,
                    })
                  }
                >
                  This is my issue
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
