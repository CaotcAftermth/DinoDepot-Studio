import { useFeedbackStore } from "../../stores/feedbackStore";
import { useProjectStore } from "../../stores/projectStore";
import { recordsForProject } from "../../model/feedback/records";
import { canSubmitDirectly, effectiveConfig } from "../../model/feedback/config";
import { STUDIO_NAME, studioRepoUrl } from "../../model/studio";
import { openExternal } from "../../services/openExternal";
import { feedbackTarget } from "../../model/feedback/targets";
import { Button, Modal, cx } from "../ui";

/**
 * The first screen: what kind of thing is this?
 *
 * Three choices, in the words somebody would use themselves. Nothing here
 * mentions GitHub, issues or labels - a cluster administrator reporting that a
 * quantity field eats their entry should not have to know or care that the
 * report becomes an issue in a repository, and the ones who do care can see it
 * on the confirmation screen afterwards.
 */

interface Choice {
  key: "bug" | "suggestion" | "feature_request";
  icon: string;
  label: string;
  blurb: string;
}

const CHOICES: Choice[] = [
  {
    key: "bug",
    icon: "🐛",
    label: "Report a bug",
    blurb: "Something is broken, or does not do what it says.",
  },
  {
    key: "suggestion",
    icon: "💡",
    label: "Suggest an improvement",
    blurb: "Something works, but could work better.",
  },
  {
    key: "feature_request",
    icon: "✨",
    label: "Request a feature",
    blurb: "Something DinoDepot Studio cannot do yet.",
  },
];

export function FeedbackLauncher() {
  const store = useFeedbackStore();
  const config = effectiveConfig(store.settings);
  // The same scope My Reports itself lists. Counting every report on the
  // machine here meant the button promised a list that did not match it.
  const projectId = useProjectStore((s) => s.settings?.projectId ?? "");
  const reportCount = recordsForProject(store.records, projectId).length;

  return (
    <Modal title="Feedback" onClose={store.close} wide>
      <div {...feedbackTarget("feedback-center")}>
        <p className="text-sm text-ink-300 mb-4">
          Tell us what happened. {STUDIO_NAME} collects a little information
          about this build and the page you were on - you can read all of it
          before anything is sent.
        </p>

        <div className="flex flex-col gap-2">
          {CHOICES.map((choice) => (
            <button
              key={choice.key}
              onClick={() => store.startReport(choice.key)}
              // Named explicitly: the visible label sits in a nested span next
              // to an aria-hidden emoji, and the name computed from contents
              // would otherwise trail the whole description behind it.
              aria-label={choice.label}
              className={cx(
                "flex items-start gap-3 text-left rounded-lg border p-3 cursor-pointer transition-colors",
                "bg-ink-850 border-ink-700 hover:border-accent-500/50 hover:bg-ink-800",
                "focus:outline-none focus:border-accent-500",
              )}
            >
              <span className="text-xl leading-none mt-0.5" aria-hidden>
                {choice.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink-100">
                  {choice.label}
                </span>
                <span className="block text-xs text-ink-400">{choice.blurb}</span>
              </span>
            </button>
          ))}
        </div>

        {!canSubmitDirectly(config) && (
          <p className="mt-4 text-xs text-amber-400 border border-amber-flag/30 bg-amber-flag/10 rounded-md px-3 py-2">
            This build has no feedback service configured, so reports cannot be
            sent from inside the app. You can still write one here and open it
            on GitHub with everything filled in.
          </p>
        )}

        <div className="mt-4 rounded-md border border-ink-700 bg-ink-950/60 px-3 py-2 text-xs text-ink-400">
          <div>
            <kbd className="mono text-ink-200">Ctrl</kbd>
            {" + "}
            <kbd className="mono text-ink-200">Shift</kbd>
            {" + "}
            <kbd className="mono text-ink-200">F</kbd> opens this from anywhere.
          </div>
          <div className="mt-1">
            Right-click any part of the app to report a problem with that exact
            control - it fills in the affected area for you.
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-ink-700 flex items-center justify-between gap-3">
          <Button variant="ghost" onClick={store.openReports}>
            My reports
            {reportCount > 0 && (
              <span className="ml-1.5 text-xs text-ink-400">({reportCount})</span>
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void openExternal(studioRepoUrl()).catch(() => {})}
            title="Opens the DinoDepot Studio repository in your browser"
          >
            Browse all reports on GitHub ↗
          </Button>
        </div>
      </div>
    </Modal>
  );
}
