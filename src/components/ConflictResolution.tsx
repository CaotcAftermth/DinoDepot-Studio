import { useMemo, useState } from "react";
import { Badge, Button, Card, Modal, cx } from "./ui";
import {
  describeConflict,
  displayValue,
  groupByDomain,
  type Conflict,
  type Resolution,
  type ResolvedConflict,
} from "../model/merge/conflicts";

/**
 * "Needs your decision".
 *
 * Everything the merge could settle on its own is already settled by the time
 * this opens; what is left is genuine disagreement - two people changed the
 * same thing to different values. So the question is asked in exactly those
 * terms: here is the creature, here is the field, here is what each of you set
 * it to.
 *
 * No commit ids, no file paths, no diff. Those live under Advanced details for
 * the one administrator in twenty who wants them.
 */

interface Props {
  conflicts: Conflict[];
  /** Who the other side is, if known. Falls back to "another administrator". */
  otherName?: string;
  onCancel(): void;
  onResolve(resolved: ResolvedConflict[]): void;
}

export function ConflictResolutionModal({
  conflicts,
  otherName,
  onCancel,
  onResolve,
}: Props) {
  const [choices, setChoices] = useState<Record<string, Resolution>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  const groups = useMemo(() => groupByDomain(conflicts), [conflicts]);
  const decided = conflicts.filter((c) => choices[c.id]).length;
  const allDecided = decided === conflicts.length;
  const them = otherName?.trim() || "another administrator";

  function choose(id: string, resolution: Resolution) {
    setChoices((current) => ({ ...current, [id]: resolution }));
  }

  /** Answers every remaining question the same way. */
  function chooseAll(resolution: Resolution) {
    setChoices((current) => {
      const next = { ...current };
      for (const conflict of conflicts) {
        if (!next[conflict.id]) next[conflict.id] = resolution;
      }
      return next;
    });
  }

  function submit() {
    onResolve(
      conflicts.map((conflict) => ({
        ...conflict,
        resolution: choices[conflict.id] ?? "mine",
      })),
    );
  }

  return (
    <Modal
      title="Needs your decision"
      onClose={onCancel}
      wide
      footer={
        <div className="flex items-center justify-between w-full gap-3">
          <span className="text-xs text-ink-400">
            {decided} of {conflicts.length} decided
          </span>
          <div className="flex gap-2">
            <Button onClick={onCancel}>Not now</Button>
            <Button variant="primary" onClick={submit} disabled={!allDecided}>
              Continue
            </Button>
          </div>
        </div>
      }
    >
      <p className="text-sm text-ink-300 mb-1">
        You and {them} both changed the same {conflicts.length === 1 ? "thing" : "things"}.
        Everything else has already been brought together.
      </p>
      <p className="text-xs text-ink-400 mb-4">
        Nothing is sent until every question here has an answer. Your work stays
        on this computer in the meantime.
      </p>

      {conflicts.length > 2 && (
        <div className="flex gap-2 mb-4">
          <Button onClick={() => chooseAll("mine")}>Keep all of mine</Button>
          <Button onClick={() => chooseAll("theirs")}>Keep all of theirs</Button>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {groups.map(([domain, items]) => (
          <Card key={domain} title={`${titleCase(domain)} (${items.length})`}>
            <div className="flex flex-col gap-3">
              {items.map((conflict) => (
                <ConflictRow
                  key={conflict.id}
                  conflict={conflict}
                  otherName={otherName?.trim() || ""}
                  chosen={choices[conflict.id]}
                  onChoose={(resolution) => choose(conflict.id, resolution)}
                />
              ))}
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-4 border-t border-ink-700 pt-3">
        <button
          type="button"
          className="text-xs text-ink-400 hover:text-ink-200"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "Hide" : "Show"} advanced details
        </button>
        {showAdvanced && (
          <ul className="mt-2 text-xs text-ink-400 mono flex flex-col gap-1">
            {conflicts.map((conflict) => (
              <li key={conflict.id}>{conflict.id}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function ConflictRow({
  conflict,
  otherName,
  chosen,
  onChoose,
}: {
  conflict: Conflict;
  /** The other administrator's name, when it is known. */
  otherName: string;
  chosen: Resolution | undefined;
  onChoose(resolution: Resolution): void;
}) {
  return (
    <div className="border border-ink-700 rounded p-3">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <div className="text-sm font-medium">{conflict.itemLabel || conflict.itemId}</div>
          <div className="text-xs text-ink-400">{describeConflict(conflict)}</div>
        </div>
        {chosen ? (
          <Badge tone="ok">Decided</Badge>
        ) : (
          <Badge tone="warn">Undecided</Badge>
        )}
      </div>

      {/*
        The base value is shown only when it helps: for a straight field
        disagreement it explains where the two of you started. For an addition
        there is no "before", and showing an empty one is noise.
      */}
      {conflict.kind === "field" && conflict.base !== undefined && (
        <div className="text-xs text-ink-500 mb-2">
          Was <span className="mono">{displayValue(conflict.base)}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <ValueChoice
          label="Yours"
          value={conflict.mine}
          missingLabel="Removed"
          selected={chosen === "mine"}
          onSelect={() => onChoose("mine")}
        />
        {/*
          "Theirs" rather than the full phrase: the column heading is rendered
          uppercase, and "ANOTHER ADMINISTRATOR'S" shouts across two lines. Who
          "they" are is already said once, in the paragraph at the top.
        */}
        <ValueChoice
          label={otherName ? `${otherName}'s` : "Theirs"}
          value={conflict.theirs}
          missingLabel="Removed"
          selected={chosen === "theirs"}
          onSelect={() => onChoose("theirs")}
        />
      </div>

      {/*
        Only offered where it means something: two administrators added
        different things that happened to collide on an id. Theirs is the one
        re-identified, so the ids on this computer stay stable and nothing else
        referring to them breaks.
      */}
      {conflict.canKeepBoth && conflict.kind === "add-vs-add" && (
        <button
          type="button"
          className={cx(
            "mt-2 text-xs underline",
            chosen === "both" ? "text-brand-300" : "text-ink-400 hover:text-ink-200",
          )}
          onClick={() => onChoose("both")}
        >
          Keep both - theirs is added alongside yours
        </button>
      )}
    </div>
  );
}

function ValueChoice({
  label,
  value,
  missingLabel,
  selected,
  onSelect,
}: {
  label: string;
  value: unknown;
  /** What to show when the value is absent - a deletion, not an empty value. */
  missingLabel: string;
  selected: boolean;
  onSelect(): void;
}) {
  const missing = value === undefined;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        "text-left rounded border p-2 transition",
        selected
          ? "border-brand-400 bg-brand-500/10"
          : "border-ink-700 hover:border-ink-500",
      )}
    >
      <div className="text-[11px] uppercase tracking-wide text-ink-400">{label}</div>
      <div className={cx("text-sm mt-0.5", missing && "text-ink-500 italic")}>
        {missing ? missingLabel : displayValue(value)}
      </div>
    </button>
  );
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
