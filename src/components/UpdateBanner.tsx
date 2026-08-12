import { useEffect, useState } from "react";
import { Badge, Button, cx } from "./ui";
import { toast } from "./toast";
import {
  checkForUpdate,
  installUpdate,
  progressPercent,
  UPDATE_STATE_LABELS,
  type AvailableUpdate,
  type UpdateState,
} from "../services/appUpdate";
import { isTauri } from "../services/ipc";
import { flushPendingSaves } from "../stores/draftsStore";
import { flushJournal, useProjectStore } from "../stores/projectStore";
import { studioRepoPath } from "../model/studio";
import { openExternal } from "../services/openExternal";

/**
 * Offering an update, and never installing one uninvited.
 *
 * Installing restarts the application. This app holds a cluster's
 * configuration, and an administrator part-way through editing it should not
 * lose their place because a release went out — so the check is quiet, the
 * offer is a line in the sidebar, and the install waits for a click.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>("idle");
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [handle, setHandle] = useState<unknown>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const dir = useProjectStore((s) => s.dir);

  // Once, on start. Not on a timer: an update that arrives mid-session can wait
  // until next launch, and a background poller is one more thing to go wrong.
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    setState("checking");
    void checkForUpdate().then((result) => {
      if (cancelled) return;
      setState(result.state);
      setUpdate(result.update);
      setHandle(result.handle);
      setMessage(result.message);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function install() {
    // Everything on disk first. The install restarts the app, and a debounce
    // still in flight would be lost.
    if (dir) {
      await flushJournal();
      const flushed = await flushPendingSaves();
      if (!flushed.ok) {
        toast.error("Some changes are not saved yet. Fix that before updating.");
        return;
      }
    }

    setState("downloading");
    try {
      await installUpdate(handle, (progress) => setPercent(progressPercent(progress)));
      // Unreachable in practice — `installUpdate` relaunches.
      setState("ready");
    } catch (e) {
      setState("failed");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  if (state === "idle" || state === "up-to-date" || state === "unsupported") return null;

  if (state === "failed") {
    return (
      <div className="px-4 py-2 border-t border-ink-700 text-[11px] text-ink-500">
        {message || UPDATE_STATE_LABELS.failed}
      </div>
    );
  }

  if (state === "checking") return null;

  return (
    <div className="px-4 py-3 border-t border-ink-700">
      <div className="flex items-center gap-2 mb-1">
        <Badge tone="info">Update available</Badge>
        {update && <span className="text-xs text-ink-300">{update.version}</span>}
      </div>

      {state === "downloading" ? (
        <div className="text-xs text-ink-400">
          {percent === null ? "Downloading…" : `Downloading… ${percent}%`}
        </div>
      ) : (
        <>
          <p className="text-[11px] text-ink-500 mb-2">
            DinoDepot Studio will restart to finish. Your project is saved first.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => void install()}>Update and restart</Button>
            <button
              type="button"
              className={cx("text-[11px] text-ink-500 hover:text-ink-300")}
              onClick={() => void openExternal(studioRepoPath("releases/latest"))}
            >
              What's new ↗
            </button>
          </div>
        </>
      )}
    </div>
  );
}
