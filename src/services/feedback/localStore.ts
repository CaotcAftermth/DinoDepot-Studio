import { ipc } from "../ipc";
import { FEEDBACK_SCOPE, studioLog } from "../../model/feedback/log";
import {
  ensureReporterId,
  migrateFeedbackState,
  pruneRecords,
} from "../../model/feedback/records";
import { emptyFeedbackState, type FeedbackState } from "../../model/feedback/types";

/**
 * Where reports live between being written and being read.
 *
 * One JSON file in the application-data folder, beside the machine-local
 * project records. Not in the project: a bug report is about the application,
 * and putting it in the project would synchronize one administrator's
 * complaints to everybody else on the cluster.
 *
 * A read failure returns an empty history. A write failure is logged and
 * returned to the feedback state machine so it can keep the draft open and
 * tell the reporter that it is not yet safe on disk. It never escapes into an
 * unrelated app workflow - see the failure isolation note in
 * `docs/architecture/feedback.md`.
 */

let inFlight: Promise<void> | null = null;

/**
 * Reads the stored history.
 *
 * Generates the installation id on the first read, which is also the first
 * time anything about feedback happens on this machine - so an installation
 * that never sends a report never gets an id at all until it is used.
 */
export async function loadFeedbackState(): Promise<FeedbackState> {
  try {
    const raw = await ipc<string | null>("feedback_state_get", {});
    return migrateFeedbackState(raw);
  } catch (error) {
    studioLog.error(
      FEEDBACK_SCOPE,
      `Could not read the feedback history: ${error instanceof Error ? error.message : String(error)}`,
    );
    return ensureReporterId(emptyFeedbackState());
  }
}

/**
 * Writes the history back.
 *
 * Serialized against itself: two reports finishing at once would otherwise
 * both read, both modify and both write, and the second would erase the first.
 * The caller always holds the whole state, so waiting for the previous write
 * is enough - there is no partial update to reconcile.
 */
export async function saveFeedbackState(state: FeedbackState): Promise<void> {
  const previous = inFlight ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(async () => {
      const trimmed: FeedbackState = {
        ...state,
        records: pruneRecords(state.records),
      };
      try {
        await ipc<void>("feedback_state_set", {
          content: JSON.stringify(trimmed),
        });
      } catch (error) {
        studioLog.error(
          FEEDBACK_SCOPE,
          `Could not save the feedback history: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    });
  inFlight = write;
  return write;
}
