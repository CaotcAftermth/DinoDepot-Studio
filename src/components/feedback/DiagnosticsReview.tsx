import { useFeedbackStore } from "../../stores/feedbackStore";
import {
  EXCLUDED_ROWS,
  includedRows,
} from "../../model/feedback/diagnostics";
import { FEEDBACK_CONFIG } from "../../model/feedback/config";
import type { DiagnosticChoices } from "../../model/feedback/types";
import { Button, Modal, Toggle, cx } from "../ui";

/**
 * What is about to be sent, in full, before it is sent.
 *
 * The screen shows values rather than category names. "✓ Operating system" is
 * a description of a promise; "Windows 11 10.0.26200 x86-64" is the promise
 * itself, and a reporter can only meaningfully consent to the second.
 *
 * The list is rebuilt from the actual payload each time a toggle changes, so
 * switching a category off removes it from the bundle rather than hiding a row
 * describing something that still travels.
 */

const CATEGORIES: {
  key: keyof DiagnosticChoices;
  label: string;
  blurb: string;
  /** Categories that describe the reporter's own work rather than the app. */
  sensitive?: boolean;
}[] = [
  {
    key: "app",
    label: "App and environment",
    blurb: "Version, operating system, webview and window size",
  },
  {
    key: "component",
    label: "Current page and component",
    blurb: "Which screen you were on and which control you picked",
  },
  {
    key: "logs",
    label: "Recent application events",
    blurb: `Up to ${FEEDBACK_CONFIG.diagnosticsLogLimit}, with paths and credentials stripped`,
  },
  {
    key: "project",
    label: "Project shape",
    blurb: "How many rules, creatures and maps - never their names",
    sensitive: true,
  },
];

export function DiagnosticsReview() {
  const store = useFeedbackStore();
  const draft = store.draft;
  const diagnostics = store.diagnostics;
  if (!draft) return null;

  const rows = diagnostics ? includedRows(diagnostics) : [];

  return (
    <Modal
      title="Diagnostics"
      onClose={store.backToForm}
      wide
      footer={
        <div className="flex justify-end">
          <Button variant="primary" onClick={store.backToForm}>
            Back to the report
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <section>
          <h4 className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-2">
            What to include
          </h4>
          <div className="flex flex-col gap-2">
            {CATEGORIES.map((category) => (
              <div
                key={category.key}
                className="flex items-start justify-between gap-3 rounded-md border border-ink-700 bg-ink-850 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm text-ink-100">
                    {category.label}
                    {category.sensitive && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-400">
                        off by default
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-ink-400">{category.blurb}</div>
                </div>
                <Toggle
                  checked={draft.diagnosticChoices[category.key]}
                  onChange={(value) => store.setDiagnosticChoice(category.key, value)}
                  title={category.label}
                />
              </div>
            ))}
          </div>
        </section>

        <section>
          <h4 className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-2">
            Included
          </h4>
          {diagnostics === null ? (
            <p className="text-sm text-ink-400">Reading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-ink-400">
              Nothing beyond the version this report came from.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {rows.map((row) => (
                <Row key={row.key} label={row.label} detail={row.detail} included />
              ))}
            </ul>
          )}
        </section>

        {diagnostics && diagnostics.logs.length > 0 && draft.diagnosticChoices.logs && (
          <section>
            <h4 className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-2">
              The events themselves
            </h4>
            <div className="mono max-h-56 overflow-y-auto rounded-md border border-ink-700 bg-ink-950 p-2.5">
              {diagnostics.logs.map((entry, index) => (
                <div key={index} className="flex gap-2 py-0.5">
                  <span className="text-ink-600 shrink-0">{entry.at.slice(11)}</span>
                  <span
                    className={cx(
                      "shrink-0 w-10",
                      entry.level === "error"
                        ? "text-red-400"
                        : entry.level === "warn"
                          ? "text-amber-400"
                          : "text-ink-500",
                    )}
                  >
                    {entry.level}
                  </span>
                  <span className="text-ink-300 break-all">
                    {entry.scope && <span className="text-ink-500">[{entry.scope}] </span>}
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <h4 className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-2">
            Never included
          </h4>
          <ul className="flex flex-col gap-1">
            {EXCLUDED_ROWS.map((row) => (
              <Row key={row.key} label={row.label} detail={row.detail} included={false} />
            ))}
          </ul>
        </section>
      </div>
    </Modal>
  );
}

function Row({
  label,
  detail,
  included,
}: {
  label: string;
  detail: string;
  included: boolean;
}) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span
        className={cx("shrink-0 mt-0.5", included ? "text-accent-400" : "text-ink-600")}
        aria-hidden
      >
        {included ? "✓" : "✗"}
      </span>
      <span className="min-w-0">
        <span className={included ? "text-ink-100" : "text-ink-400"}>{label}</span>
        {detail && <span className="block text-xs text-ink-500 break-words">{detail}</span>}
      </span>
    </li>
  );
}
