import { useState } from "react";
import { useFeedbackStore } from "../../stores/feedbackStore";
import { validateDraft, type DraftProblem } from "../../model/feedback/records";
import {
  BUG_SEVERITIES,
  SEVERITY_HINTS,
  SEVERITY_LABELS,
  type BugSeverity,
  type FeedbackAttachment,
  type FeedbackDraft,
} from "../../model/feedback/types";
import {
  FEEDBACK_CONFIG,
  canSubmitDirectly,
  effectiveConfig,
} from "../../model/feedback/config";
import { feedbackTarget } from "../../model/feedback/targets";
import {
  attachmentBytes,
  attachmentSources,
  canAddAttachment,
  formatBytes,
} from "../../services/feedback/attachments";
import { asStudioError } from "../../model/errors";
import { toast } from "../toast";
import {
  Button,
  Field,
  Input,
  Modal,
  Textarea,
  cx,
  type ModalPlacement,
} from "../ui";
import { AffectedArea } from "./AffectedArea";
import { SelectedTargetSpotlight } from "./SelectedTargetSpotlight";

/**
 * The form itself — one component for all three kinds of report.
 *
 * The three differ in which questions they ask, not in how they behave, so
 * they share a draft, a validator and a submit path. Splitting them into three
 * components would have meant three places to fix the next time the attachment
 * rules or the diagnostics wording changed.
 *
 * The bug form asks four things and only one of them is required. That is the
 * point: the difference between a report that gets filed and one that does not
 * is usually how much the form demanded before it would accept anything.
 */

const HEADINGS = {
  bug: "Report a bug",
  suggestion: "Suggest an improvement",
  feature_request: "Request a feature",
} as const;

const SUBHEADINGS = {
  bug: "Describe what went wrong. Only the first question is required.",
  suggestion: "Tell us what works today and how it could work better.",
  feature_request: "Describe the capability you would like DinoDepot Studio to add.",
} as const;

export function ReportForm({
  placement,
  onPlacementChange,
}: {
  placement: ModalPlacement | null;
  onPlacementChange: (placement: ModalPlacement) => void;
}) {
  const store = useFeedbackStore();
  const draft = store.draft;
  const [showProblems, setShowProblems] = useState(false);

  if (!draft) return null;

  const problems = validateDraft(draft);
  const config = effectiveConfig(store.settings);
  const direct = canSubmitDirectly(config);
  const busy = store.submitting || store.checkingDuplicates;

  function problemFor(field: DraftProblem["field"]): string {
    if (!showProblems) return "";
    return problems.find((problem) => problem.field === field)?.message ?? "";
  }

  const submitLabel = store.checkingDuplicates
    ? "Checking…"
    : store.submitting
      ? "Sending…"
      : direct
        ? submitVerb(draft)
        : "Save and open on GitHub";

  async function onSubmit() {
    setShowProblems(true);
    if (problems.length > 0) return;
    if (direct) {
      await store.submitOrCheck();
      return;
    }
    // With no service configured this is not a degraded submit — it is the
    // only route, and it is a real one. The report is kept locally either way.
    await store.submit();
  }

  return (
    <Modal
      title={HEADINGS[draft.type]}
      subtitle={SUBHEADINGS[draft.type]}
      onClose={() => void store.requestClose()}
      medium
      avoidElement={store.targetElement}
      placementOverride={placement}
      onPlacementChange={
        draft.type === "bug" || draft.type === "suggestion"
          ? onPlacementChange
          : undefined
      }
      backdropDecoration={
        draft.target && store.targetElement ? (
          <SelectedTargetSpotlight element={store.targetElement} />
        ) : undefined
      }
      footer={
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" onClick={() => void store.openDiagnostics()}>
            Review diagnostics
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => void store.requestClose()}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void onSubmit()} disabled={busy}>
              {submitLabel}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4" {...feedbackTarget("feedback-center")}>
        <AffectedArea target={draft.target} />

        {draft.type === "feature_request" && (
          <Field label="Feature" hint="A short name for it.">
            <Input
              autoFocus
              value={draft.title}
              placeholder="Spawn command presets"
              onChange={(e) => store.updateDraft({ title: e.target.value })}
            />
            <Problem message={problemFor("title")} />
          </Field>
        )}

        <Field label={mainLabel(draft)}>
          <Textarea
            autoFocus={draft.type !== "feature_request"}
            rows={5}
            value={draft.description}
            placeholder={mainPlaceholder(draft)}
            onChange={(e) => store.updateDraft({ description: e.target.value })}
          />
          <Problem message={problemFor("description")} />
        </Field>

        {draft.type === "bug" ? (
          <>
            <Field label="What did you expect to happen?" hint="Optional.">
              <Textarea
                rows={2}
                value={draft.expectedBehavior}
                placeholder="The creature should have stayed, with a quantity of 0."
                onChange={(e) => store.updateDraft({ expectedBehavior: e.target.value })}
              />
              <Problem message={problemFor("expectedBehavior")} />
            </Field>
            <Field
              label="Steps to reproduce"
              hint="Optional, but it is the single most useful thing you can add."
            >
              <Textarea
                rows={4}
                value={draft.reproductionSteps}
                placeholder={"1. Open Production Rules\n2. Expand a creature\n3. Set Quantity to 0"}
                onChange={(e) => store.updateDraft({ reproductionSteps: e.target.value })}
              />
              <Problem message={problemFor("reproductionSteps")} />
            </Field>
            <SeverityPicker
              value={draft.severity}
              onChange={(severity) => store.updateDraft({ severity })}
            />
          </>
        ) : (
          <Field label={secondaryLabel(draft)} hint="Optional.">
            <Textarea
              rows={3}
              value={draft.benefit}
              placeholder={secondaryPlaceholder(draft)}
              onChange={(e) => store.updateDraft({ benefit: e.target.value })}
            />
            <Problem message={problemFor("benefit")} />
          </Field>
        )}

        {draft.type === "bug" && <Attachments draft={draft} />}

        <Field
          label="Contact"
          hint="Optional GitHub username, if you are happy to be asked follow-up questions. It will be visible in the report."
        >
          <Input
            className="w-64"
            value={draft.contact}
            placeholder="octocat"
            onChange={(e) => store.updateDraft({ contact: e.target.value })}
          />
          <Problem message={problemFor("contact")} />
        </Field>

        <p className="text-xs text-ink-500 border-t border-ink-700 pt-3">
          DinoDepot sends the text you entered and the diagnostics shown under
          Review diagnostics. The selected area may include its visible label;
          project shape is included only when you switch it on. Text that looks
          like a pasted credential is blocked before it can be saved or sent.
        </p>
      </div>
    </Modal>
  );
}

function Problem({ message }: { message: string }) {
  if (!message) return null;
  return <span className="block text-xs text-red-400 mt-1">{message}</span>;
}

// ---------------------------------------------------------------------------

function SeverityPicker({
  value,
  onChange,
}: {
  value: BugSeverity | null;
  onChange: (severity: BugSeverity | null) => void;
}) {
  return (
    <Field
      label="Severity"
      hint="Your judgement of how much it got in the way. Optional."
      interactiveLabel
    >
      <div className="flex flex-wrap gap-1.5">
        {BUG_SEVERITIES.map((severity) => (
          <button
            key={severity}
            type="button"
            title={SEVERITY_HINTS[severity]}
            // Both halves, in that order. Without it the accessible name comes
            // out as the hint alone — "Cosmetic, or easy to work around" — and
            // a screen reader never says which level was chosen.
            aria-label={`${SEVERITY_LABELS[severity]} — ${SEVERITY_HINTS[severity]}`}
            aria-pressed={value === severity}
            onClick={() => onChange(value === severity ? null : severity)}
            className={cx(
              "px-2.5 py-1 rounded-md text-sm border transition-colors cursor-pointer",
              value === severity
                ? "bg-accent-600 border-accent-500 text-white"
                : "bg-ink-850 border-ink-600 text-ink-200 hover:border-ink-400",
            )}
          >
            {SEVERITY_LABELS[severity]}
          </button>
        ))}
      </div>
      {value && (
        <span className="block text-xs text-ink-400 mt-1">{SEVERITY_HINTS[value]}</span>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------

/**
 * Attachments.
 *
 * Nothing is attached without the reporter choosing it, and the warning above
 * the button is not boilerplate: a screenshot of this app very often has a
 * cluster's name, a player's name or a repository in it, and the reporter is
 * the only person who can judge whether that matters.
 */
function Attachments({ draft }: { draft: FeedbackDraft }) {
  const store = useFeedbackStore();
  const [busy, setBusy] = useState(false);
  const source = attachmentSources[0];

  async function add() {
    setBusy(true);
    try {
      const attachment = await source.pick();
      if (attachment) {
        store.updateDraft({ attachments: [...draft.attachments, attachment] });
      }
    } catch (error) {
      toast.error(
        asStudioError(error, "unknown", "That image could not be attached.").message,
      );
    } finally {
      setBusy(false);
    }
  }

  function remove(attachment: FeedbackAttachment) {
    store.updateDraft({
      attachments: draft.attachments.filter((entry) => entry.id !== attachment.id),
    });
  }

  return (
    <Field
      label="Attachments"
      hint={`Images only, up to ${formatBytes(FEEDBACK_CONFIG.maxAttachmentBytes)} each and ${FEEDBACK_CONFIG.maxAttachments} per report. A screenshot may show your cluster's names — check before you attach it.`}
      interactiveLabel
    >
      {draft.attachments.length > 0 && (
        <ul className="flex flex-col gap-1 mb-2">
          {draft.attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 text-sm bg-ink-850 border border-ink-700 rounded-md px-2.5 py-1.5"
            >
              <span className="flex-1 truncate text-ink-200">{attachment.fileName}</span>
              <span className="text-xs text-ink-500">
                {formatBytes(attachment.sizeBytes)}
              </span>
              <button
                type="button"
                onClick={() => remove(attachment)}
                aria-label={`Remove ${attachment.fileName}`}
                className="text-ink-400 hover:text-red-300 cursor-pointer px-1"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => void add()}
          disabled={busy || !source.available || !canAddAttachment(draft.attachments)}
          title={
            source.available
              ? undefined
              : "Attaching an image needs the desktop app"
          }
        >
          {busy ? "Reading…" : source.label}
        </Button>
        {draft.attachments.length > 0 && (
          <span className="text-xs text-ink-500">
            {formatBytes(attachmentBytes(draft.attachments))} total
          </span>
        )}
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

function mainLabel(draft: FeedbackDraft): string {
  switch (draft.type) {
    case "bug":
      return "What happened?";
    case "suggestion":
      return "What could be improved?";
    case "feature_request":
      return "What should DinoDepot Studio be able to do?";
  }
}

function mainPlaceholder(draft: FeedbackDraft): string {
  switch (draft.type) {
    case "bug":
      return "Setting the quantity to 0 removed the creature from the rule instead of leaving it at zero.";
    case "suggestion":
      return "Searching Content Sources only matches the start of a name, so I cannot find a creature by its suffix.";
    case "feature_request":
      return "Save a set of spawn command arguments as a preset and apply it to another creature.";
  }
}

function secondaryLabel(draft: FeedbackDraft): string {
  return draft.type === "suggestion"
    ? "How would you improve it?"
    : "Why would this be useful?";
}

function secondaryPlaceholder(draft: FeedbackDraft): string {
  return draft.type === "suggestion"
    ? "Match anywhere in the name, the way the blueprint picker already does."
    : "We run six maps with the same colour scheme, and every creature is set up by hand.";
}

function submitVerb(draft: FeedbackDraft): string {
  switch (draft.type) {
    case "bug":
      return "Submit report";
    case "suggestion":
      return "Submit suggestion";
    case "feature_request":
      return "Submit request";
  }
}
