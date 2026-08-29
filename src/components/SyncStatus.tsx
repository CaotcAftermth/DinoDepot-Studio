import { useEffect, useState } from "react";
import { Badge, Button, cx } from "./ui";
import { ConflictResolutionModal } from "./ConflictResolution";
import { useSyncStore } from "../stores/syncStore";
import { useProjectStore } from "../stores/projectStore";
import { canSync } from "../model/localState";
import { SYNC_PHASE_LABELS, type SyncPhase } from "../model/syncState";
import { toast } from "./toast";

/**
 * The Sync control, and the state of the project's sharing in one line.
 *
 * Deliberately the only place in the app that talks about synchronizing at all:
 * Save is automatic and silent, and Publish is its own page. An administrator
 * who never opens this still has every edit safely on their own disk.
 */

/**
 * How each phase should read as a badge.
 *
 * Being offline is amber, not red: nothing is wrong, the work is safe, and it
 * will go out when the connection comes back. Red is reserved for the states
 * that need the administrator to do something.
 */
const TONE: Record<SyncPhase, "ok" | "warn" | "error" | "neutral" | "info"> = {
  synchronized: "ok",
  "local-changes": "warn",
  "saved-locally": "neutral",
  checking: "info",
  integrating: "info",
  "needs-decision": "error",
  sending: "info",
  offline: "warn",
  "access-expired": "error",
  "repository-unavailable": "error",
  blocked: "error",
};

export function SyncStatus() {
  const phase = useSyncStore((s) => s.phase);
  const running = useSyncStore((s) => s.running);
  const conflicts = useSyncStore((s) => s.conflicts);
  const last = useSyncStore((s) => s.last);
  const sync = useSyncStore((s) => s.sync);
  const resolve = useSyncStore((s) => s.resolve);
  const dismiss = useSyncStore((s) => s.dismissConflicts);
  const refreshPhase = useSyncStore((s) => s.refreshPhase);

  const local = useProjectStore((s) => s.local);
  const mode = useProjectStore((s) => s.mode);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(refreshPhase, [refreshPhase]);

  const ready = canSync(local) && mode === "editable";

  async function run() {
    const result = await sync();
    if (result.kind === "needs-decision") return;
    if (result.error) toast.error(result.message);
    else if (result.kind !== "already-synchronized") toast.success(result.message);
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Badge tone={TONE[phase]}>{SYNC_PHASE_LABELS[phase]}</Badge>
        <Button onClick={() => void run()} disabled={running || !ready}>
          {running ? "Syncing…" : "Sync"}
        </Button>
        {conflicts.length > 0 && !running && (
          <Button variant="primary" onClick={() => setShowDetails(false)}>
            Review {conflicts.length}
          </Button>
        )}
      </div>

      {/*
        Commit ids and the technical error live here and nowhere else - the
        normal line above says "Synchronized", not a sha.
      */}
      {last && (
        <button
          type="button"
          className={cx(
            "mt-1 text-[11px] text-ink-500 hover:text-ink-300",
            !last.commit && !last.error && "hidden",
          )}
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? "Hide" : "Show"} advanced details
        </button>
      )}
      {showDetails && last && (
        <dl className="mt-1 text-[11px] text-ink-500 mono flex flex-col gap-0.5">
          {last.syncedCommit && (
            <div>
              <dt className="inline">Source revision: </dt>
              <dd className="inline">{last.syncedCommit.slice(0, 10)}</dd>
            </div>
          )}
          {last.retries > 0 && (
            <div>
              <dt className="inline">Attempts: </dt>
              <dd className="inline">{last.retries + 1}</dd>
            </div>
          )}
          {last.error?.detail && <div className="break-all">{last.error.detail}</div>}
        </dl>
      )}

      {conflicts.length > 0 && (
        <ConflictResolutionModal
          conflicts={conflicts}
          onCancel={dismiss}
          onResolve={(answers) => {
            void resolve(answers).then((result) => {
              if (result.error) toast.error(result.message);
              else if (result.kind !== "needs-decision") toast.success(result.message);
            });
          }}
        />
      )}
    </>
  );
}
