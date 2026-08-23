import { useState } from "react";
import { useFeedbackStore } from "../../stores/feedbackStore";
import type { ModalPlacement } from "../ui";
import { FeedbackContextMenu } from "./FeedbackContextMenu";
import { FeedbackLauncher } from "./FeedbackLauncher";
import { DiagnosticsReview } from "./DiagnosticsReview";
import { DuplicateList } from "./DuplicateList";
import { Inspector } from "./Inspector";
import { MyReports } from "./MyReports";
import { ReportForm } from "./ReportForm";
import { FailedPanel, SubmittedPanel } from "./SubmissionPanels";

/**
 * Everything the Feedback Center draws.
 *
 * Split from `FeedbackHost` to keep the listener plumbing separate from the
 * surfaces it renders. The module is imported eagerly: feedback must remain
 * available even when a late-loaded asset would fail or become stale.
 *
 * One component rather than seven independent roots: they are panels of a
 * single dialog and share one state machine.
 */
export function FeedbackPanels() {
  const view = useFeedbackStore((state) => state.view);
  // Kept at the panel-suite level so reviewing diagnostics or using the area
  // picker does not forget where the reporter put the form.
  const [reportPlacement, setReportPlacement] = useState<ModalPlacement | null>(null);

  return (
    <>
      {view === "launcher" && <FeedbackLauncher />}
      {view === "form" && (
        <ReportForm
          placement={reportPlacement}
          onPlacementChange={setReportPlacement}
        />
      )}
      {view === "diagnostics" && <DiagnosticsReview />}
      {view === "duplicates" && <DuplicateList />}
      {view === "submitted" && <SubmittedPanel />}
      {view === "failed" && <FailedPanel />}
      {view === "reports" && <MyReports />}
      <Inspector />
      <FeedbackContextMenu />
    </>
  );
}
