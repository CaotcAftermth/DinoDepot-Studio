import { useFeedbackStore } from "../../stores/feedbackStore";
import { TRAIL_SEPARATOR } from "../../model/feedback/resolveTarget";
import { areaLabel } from "../../model/feedback/targets";
import type { FeedbackTargetSnapshot } from "../../model/feedback/types";
import { Button, cx } from "../ui";

/**
 * Which part of the app a report is about.
 *
 * Shown as a trail rather than an id, because the reporter has to be able to
 * confirm the picker chose what they meant — `production-rule-cycle-quantity`
 * is for the maintainer, and "Production Rules › Creature Rule › Quantity" is
 * for the person who clicked it.
 *
 * Always optional. Plenty of real reports are about the app as a whole, and a
 * required area would push people into picking something arbitrary.
 */

export function AffectedArea({
  target,
  optionalLabel = "Optional — helps us find the right code",
}: {
  target: FeedbackTargetSnapshot | null;
  optionalLabel?: string;
}) {
  const startInspector = useFeedbackStore((state) => state.startInspector);
  const setTarget = useFeedbackStore((state) => state.setTarget);

  return (
    <section aria-label="Affected area">
      {target ? (
        <div className="rounded-lg border border-accent-500/30 bg-accent-500/[0.06] px-3 py-2.5">
          <div className="flex items-start gap-3">
            <span
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-500/15 text-xs font-bold text-accent-400"
              aria-hidden
            >
              ✓
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-accent-400">
                Selected area
              </div>
              <div className="mt-0.5 text-sm font-semibold leading-snug text-white">
                {target.name}
              </div>
              {target.area && (
                <div className="mt-0.5 text-xs text-ink-400">{areaLabel(target.area)}</div>
              )}
            </div>
            <div className="flex shrink-0 gap-1">
              <Button variant="ghost" onClick={startInspector} title="Pick a different area">
                Change
              </Button>
              <Button
                variant="ghost"
                onClick={() => setTarget(null)}
                title="Remove the selected area"
                aria-label="Remove the selected area"
              >
                ×
              </Button>
            </div>
          </div>

          <details className="group mt-2 border-t border-accent-500/15 pt-2">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-ink-400 hover:text-ink-200">
              <span className="transition-transform group-open:rotate-90" aria-hidden>
                ▸
              </span>
              Technical details
            </summary>
            <div className="mt-2 rounded-md border border-ink-700/80 bg-ink-950/50 px-2.5 py-2">
              <TargetTrail target={target} className="text-xs" />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <code className="mono text-[11px] text-ink-400">{target.id}</code>
                {Object.entries(target.context).map(([key, value]) => (
                  <span
                    key={key}
                    className="rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-400"
                  >
                    {key}: {value}
                  </span>
                ))}
              </div>
            </div>
          </details>
        </div>
      ) : (
        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="block text-xs font-semibold uppercase tracking-wide text-ink-300">
              Affected area
            </span>
            <span className="text-xs text-ink-500">{optionalLabel}</span>
          </div>
          <Button variant="secondary" onClick={startInspector}>
            Select affected area
          </Button>
        </div>
      )}
    </section>
  );
}

/** `Production Rules › Creature Rule › Quantity`, wrapping rather than truncating. */
export function TargetTrail({
  target,
  className,
}: {
  target: FeedbackTargetSnapshot;
  className?: string;
}) {
  const trail =
    target.hierarchy.length > 0
      ? target.hierarchy
      : [areaLabel(target.area), target.name].filter(Boolean);

  return (
    <div
      className={cx(
        !className && "text-sm",
        "text-ink-100 leading-snug",
        className,
      )}
    >
      {trail.map((part, index) => (
        <span key={`${part}-${index}`}>
          {index > 0 && <span className="text-ink-500">{TRAIL_SEPARATOR}</span>}
          <span className={index === trail.length - 1 ? "font-medium" : "text-ink-300"}>
            {part}
          </span>
        </span>
      ))}
    </div>
  );
}
