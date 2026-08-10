import { PLAYER_FIELDS } from "../model/players";
import type { ProfileImportResult } from "../services/profileImport";
import { Badge, Button, Modal } from "./ui";

/**
 * What a bulk import did, file by file.
 *
 * Import runs unattended — the admin drops a folder and walks away — so the
 * result has to be reviewable afterwards rather than confirmed up front. The
 * two things worth their attention are files that could not be read and values
 * that disagreed with what they had already typed; both are called out rather
 * than folded into a count.
 */

const MATCH_LABELS: Record<NonNullable<ProfileImportResult["matchedBy"]>, string> = {
  eosId: "matched on EOS ID",
  playerId: "matched on Player ID",
  characterName: "matched on survivor name",
  new: "new roster entry",
};

const fieldLabel = (key: string) =>
  PLAYER_FIELDS.find((f) => f.key === key)?.label ?? key;

export function ProfileImportReview({
  results,
  onClose,
  onSelectPlayer,
}: {
  results: ProfileImportResult[];
  onClose: () => void;
  onSelectPlayer: (playerId: string) => void;
}) {
  const failed = results.filter((r) => !r.summary);
  const imported = results.filter((r) => r.summary);
  const conflicted = imported.filter((r) => r.conflicts.length > 0);
  const unsaved = imported.filter((r) => r.storeError);

  return (
    <Modal title="Profile import" onClose={onClose} wide>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Badge tone={imported.length > 0 ? "ok" : "neutral"}>
          {imported.length} read
        </Badge>
        {conflicted.length > 0 && (
          <Badge tone="warn">{conflicted.length} with conflicts</Badge>
        )}
        {unsaved.length > 0 && <Badge tone="warn">{unsaved.length} not saved</Badge>}
        {failed.length > 0 && <Badge tone="error">{failed.length} unreadable</Badge>}
      </div>

      <div className="flex flex-col gap-2 max-h-[55vh] overflow-y-auto pr-1">
        {results.map((result, i) => (
          <div
            key={`${result.fileName}-${i}`}
            className="border border-ink-700 rounded-lg px-3 py-2 bg-ink-900"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="mono text-xs text-ink-400 truncate" title={result.fileName}>
                {result.fileName}
              </span>
              {result.summary && result.matchedBy && (
                <span className="text-xs text-ink-500 shrink-0">
                  {MATCH_LABELS[result.matchedBy]}
                </span>
              )}
            </div>

            {!result.summary ? (
              <p className="text-sm text-red-400 mt-1">
                Could not be read — {result.error}
              </p>
            ) : (
              <>
                <div className="flex items-baseline gap-2 mt-1 flex-wrap">
                  <button
                    onClick={() => {
                      if (result.playerId) onSelectPlayer(result.playerId);
                      onClose();
                    }}
                    className="text-sm font-medium text-ink-100 hover:text-accent-400 cursor-pointer"
                  >
                    {result.playerName}
                  </button>
                  <span className="text-xs text-ink-400">
                    level {result.summary.level}
                    {result.summary.map && ` · ${result.summary.map}`}
                    {result.summary.tribeId !== "0" && ` · tribe ${result.summary.tribeId}`}
                  </span>
                </div>

                {result.filled.length > 0 && (
                  <p className="text-xs text-ink-400 mt-1">
                    Filled in: {result.filled.map(fieldLabel).join(", ")}
                  </p>
                )}

                {result.conflicts.length > 0 && (
                  <div className="mt-1.5 flex flex-col gap-0.5">
                    {result.conflicts.map((conflict) => (
                      <p key={conflict.key} className="text-xs text-amber-400">
                        {conflict.label}: kept{" "}
                        <span className="mono">{conflict.existing}</span>, profile said{" "}
                        <span className="mono">{conflict.incoming}</span>
                      </p>
                    ))}
                  </div>
                )}

                {result.storeError && (
                  <p className="text-xs text-amber-400 mt-1">
                    Details recorded, but the file was not saved — {result.storeError}
                  </p>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {conflicted.length > 0 && (
        <p className="text-xs text-ink-400 mt-4">
          Conflicting values were left as you had them. Open the player and edit
          if the profile is the one that's right.
        </p>
      )}

      <div className="flex justify-end mt-4">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
