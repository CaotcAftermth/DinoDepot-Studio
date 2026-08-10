import { ReactNode, useEffect, useRef, useState } from "react";
import { isTauri } from "../services/ipc";
import { readProfilePaths } from "../services/profileFiles";
import { isProfileFileName, type ProfileFile } from "../services/profileImport";
import { cx } from "./ui";

/**
 * Drop target for `.arkprofile` files.
 *
 * The two runtimes deliver a drop completely differently and neither is
 * optional: the desktop app gets file *paths* from a Tauri window event
 * (the webview's own drag events are suppressed), while browser mock mode gets
 * real `File` objects from the DOM. Both are funnelled into the same list of
 * named byte arrays so the importer never has to care which one it came from.
 */

/** Files that were dropped but are not profiles, so the page can say so. */
export interface DropRejects {
  ignored: string[];
  errors: string[];
}

async function readBrowserFiles(list: FileList): Promise<{
  files: ProfileFile[];
  rejects: DropRejects;
}> {
  const files: ProfileFile[] = [];
  const rejects: DropRejects = { ignored: [], errors: [] };
  for (const file of Array.from(list)) {
    if (!isProfileFileName(file.name)) {
      rejects.ignored.push(file.name);
      continue;
    }
    try {
      files.push({
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        modifiedAt: file.lastModified,
      });
    } catch (e) {
      rejects.errors.push(`${file.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { files, rejects };
}

export function ProfileDropZone({
  onFiles,
  disabled,
  busy,
  children,
}: {
  onFiles: (files: ProfileFile[], rejects: DropRejects) => void;
  disabled?: boolean;
  busy?: boolean;
  children?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const zone = useRef<HTMLDivElement>(null);
  // Read through a ref inside the Tauri listener: it outlives a render, and a
  // stale closure here would drop files into an old copy of the roster.
  const handler = useRef(onFiles);
  handler.current = onFiles;
  const blocked = useRef(Boolean(disabled || busy));
  blocked.current = Boolean(disabled || busy);

  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type === "over") {
          setOver(overZone(zone.current, event.payload.position));
          return;
        }
        if (event.payload.type !== "drop") {
          setOver(false);
          return;
        }
        // The event is window-wide, so a drop outside this zone is not ours.
        const mine = overZone(zone.current, event.payload.position);
        setOver(false);
        if (!mine || blocked.current) return;
        const read = await readProfilePaths(event.payload.paths);
        handler.current(read.files, { ignored: read.ignored, errors: read.errors });
      });
      if (cancelled) unlisten();
      else stop = unlisten;
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return (
    <div
      ref={zone}
      // Browser mock mode only: in the desktop app these never fire, which is
      // why the Tauri listener above exists at all.
      onDragOver={(e) => {
        if (isTauri || blocked.current) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => !isTauri && setOver(false)}
      onDrop={async (e) => {
        if (isTauri || blocked.current) return;
        e.preventDefault();
        setOver(false);
        const { files, rejects } = await readBrowserFiles(e.dataTransfer.files);
        handler.current(files, rejects);
      }}
      className={cx(
        "rounded-lg border border-dashed px-4 py-3 transition-colors",
        over && !blocked.current
          ? "border-accent-500 bg-accent-500/10"
          : "border-ink-600 bg-ink-900/40",
        disabled && "opacity-50",
      )}
    >
      {children}
    </div>
  );
}

/** Whether a window-relative drop position falls inside the zone. */
function overZone(
  element: HTMLDivElement | null,
  position: { x: number; y: number },
): boolean {
  if (!element) return false;
  const box = element.getBoundingClientRect();
  // Tauri reports physical pixels; the DOM is in CSS pixels.
  const scale = window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}
