import { useState } from "react";
import type { ProfileGroup } from "../services/profileImport";
import { Badge, Button, cx, Modal } from "./ui";

/**
 * Picks between several saves of one account.
 *
 * A batch dragged out of dated backup folders routinely holds the same EOS ID
 * more than once. Where those files agree on the Player ID they are just older
 * and newer copies and the newest is taken without asking; where they disagree
 * they are different characters, and only the admin knows which one is wanted.
 *
 * The newest is preselected because it is nearly always the answer — but the
 * file's date is on every row so "nearly always" stays visible.
 */

const dateLabel = (at: number) =>
  at > 0 ? new Date(at).toLocaleString() : "date unknown";

export function ProfileChoiceModal({
  groups,
  onCancel,
  onConfirm,
}: {
  /** Only the groups that actually need a decision. */
  groups: ProfileGroup[];
  onCancel: () => void;
  /** Chosen file index per group key (its EOS ID). */
  onConfirm: (picks: Record<string, number>) => void;
}) {
  const [picks, setPicks] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      groups.map((g) => [g.eosId || g.candidates[0].fileName, g.candidates[0].fileIndex]),
    ),
  );

  return (
    <Modal title="Which profile should be imported?" onClose={onCancel} wide>
      <p className="text-sm text-ink-300 mb-4">
        {groups.length === 1 ? "One account has" : `${groups.length} accounts have`} more
        than one profile in this batch, and they are not the same character — the Player
        IDs differ. The newest of each is selected; change it if the older save is the one
        you want.
      </p>

      <div className="flex flex-col gap-4 max-h-[55vh] overflow-y-auto pr-1">
        {groups.map((group) => {
          const key = group.eosId || group.candidates[0].fileName;
          return (
            <div key={key}>
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
                  EOS ID
                </span>
                <span className="mono text-xs text-ink-200">{group.eosId || "—"}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                {group.candidates.map((candidate, i) => {
                  const selected = picks[key] === candidate.fileIndex;
                  return (
                    <button
                      key={candidate.fileIndex}
                      onClick={() =>
                        setPicks({ ...picks, [key]: candidate.fileIndex })
                      }
                      className={cx(
                        "text-left px-3 py-2 rounded-lg border cursor-pointer",
                        selected
                          ? "bg-ink-800 border-accent-500/60"
                          : "bg-ink-900 border-ink-700 hover:border-ink-600",
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm text-ink-100">
                          {candidate.summary.characterName || "(unnamed survivor)"}
                        </span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          {i === 0 && <Badge tone="ok">newest</Badge>}
                          {selected && <Badge tone="info">selected</Badge>}
                        </span>
                      </div>
                      <div className="text-xs text-ink-400 mt-0.5">
                        Player ID <span className="mono">{candidate.summary.playerDataId}</span>
                        {" · "}level {candidate.summary.level}
                        {candidate.summary.map && ` · ${candidate.summary.map}`}
                        {candidate.summary.tribeId !== "0" &&
                          ` · tribe ${candidate.summary.tribeId}`}
                      </div>
                      <div className="text-xs text-ink-500 mt-0.5 flex gap-2">
                        <span>{dateLabel(candidate.modifiedAt)}</span>
                        <span className="mono truncate" title={candidate.fileName}>
                          {candidate.fileName}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-ink-400 mt-4">
        The profiles you don't pick are left alone — nothing is written for them.
      </p>

      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onCancel}>
          Cancel import
        </Button>
        <Button variant="primary" onClick={() => onConfirm(picks)}>
          Import selected
        </Button>
      </div>
    </Modal>
  );
}
