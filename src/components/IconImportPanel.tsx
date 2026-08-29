import { useEffect, useRef, useState } from "react";
import { Button, Toggle, cx } from "./ui";
import { ipc, isTauri } from "../services/ipc";
import { pickFile } from "../services/dialogs";
import { writeProjectIcon } from "../services/modAssets";
import { useProjectStore } from "../stores/projectStore";
import { useDraftsStore } from "../stores/draftsStore";

/**
 * Bringing an icon in from a file the administrator already has.
 *
 * The texture picker covers artwork that ships inside a mod; this covers
 * everything else - something drawn, downloaded, or exported by hand. Whatever
 * arrives goes through the same conversion as every other icon, so a 512x512
 * PNG from a documentation site and a texture pulled from a pak both become a 160x160
 * lossless WebP in the project's own images folder.
 */
export function IconImportPanel({
  /** Folder inside the images directory, usually the owning source. */
  group,
  /** Base name for the file, usually the entry being given an icon. */
  entryName,
  onSaved,
}: {
  group: string;
  entryName: string;
  /** Receives the stored `file:` value once the icon is on disk. */
  onSaved: (iconValue: string) => void;
}) {
  const projectDir = useProjectStore((s) => s.dir) ?? "";
  const imagesDirOverride = useProjectStore((s) => s.local?.imagesDir) ?? "";
  const refreshImages = useDraftsStore((s) => s.refreshImages);

  /** Base64 of whatever is staged, without a data URL prefix. */
  const [staged, setStaged] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [invert, setInvert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * The desktop app intercepts file drops itself, so the webview never sees a
   * DOM drop with a File on it. Listening to Tauri's own event is the only way
   * a drop works there; the DOM handlers below cover the browser preview.
   */
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "over") {
            setOver(true);
            return;
          }
          if (event.payload.type === "leave") {
            setOver(false);
            return;
          }
          setOver(false);
          const path = event.payload.paths?.[0];
          if (path) void loadFromPath(path);
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        // No drag-drop channel - the file button still works.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadFromPath(path: string) {
    setError("");
    if (!/\.(webp|png|jpe?g)$/i.test(path)) {
      setError("Pick a WebP, PNG or JPEG image.");
      return;
    }
    try {
      const contentB64 = await ipc<string>("read_file_b64", { path });
      setStaged(contentB64.replace(/\s/g, ""));
      setSourceLabel(path.replace(/^.*[/\\]/, ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function loadFromFile(file: File) {
    setError("");
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of buffer) binary += String.fromCharCode(byte);
      setStaged(btoa(binary));
      setSourceLabel(file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function choose() {
    const path = await pickFile("Choose an icon image", [
      { name: "Image", extensions: ["webp", "png", "jpg", "jpeg"] },
    ]);
    if (path) await loadFromPath(path);
  }

  async function save() {
    if (!staged || !projectDir) return;
    setBusy(true);
    setError("");
    try {
      const name = await writeProjectIcon(
        projectDir,
        imagesDirOverride,
        `${group}/${entryName}`.replace(/^\//, ""),
        staged,
        invert,
      );
      await refreshImages();
      onSaved(`file:${name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-64 shrink-0 border border-ink-700 rounded-lg p-3 flex flex-col gap-2 self-start">
      <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
        Import an image
      </span>

      <div
        className={cx(
          "border border-dashed rounded-lg p-3 text-center transition-colors",
          over ? "border-accent-500 bg-accent-500/5" : "border-ink-600",
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void loadFromFile(file);
        }}
      >
        {staged ? (
          <img
            src={`data:image/png;base64,${staged}`}
            alt={sourceLabel}
            className="max-w-full max-h-28 mx-auto object-contain"
            style={{
              backgroundImage:
                "repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%)",
              backgroundSize: "16px 16px",
              // Shows what saving will write - the backend runs the same
              // inversion on the real pixels.
              filter: invert ? "invert(1)" : undefined,
            }}
          />
        ) : (
          <p className="text-xs text-ink-400">
            Drop an image here, or choose one below. WebP, PNG or JPEG.
          </p>
        )}
      </div>

      {sourceLabel && (
        <p className="text-xs text-ink-500 truncate" title={sourceLabel}>
          {sourceLabel}
        </p>
      )}

      {/*
        The native dialog exists only in the desktop app - in the browser
        preview `pickFile` falls back to a prompt the webview refuses, so the
        plain file input below is what covers that case.
      */}
      {isTauri ? (
        <Button onClick={() => void choose()} disabled={busy}>
          Choose a file…
        </Button>
      ) : (
        <input
          ref={fileInput}
          type="file"
          accept="image/webp,image/png,image/jpeg"
          className="text-xs text-ink-400"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void loadFromFile(file);
          }}
        />
      )}

      <Toggle checked={invert} onChange={setInvert} label="Invert colours" />
      <p className="text-xs text-ink-500">
        Saved as a 160&times;160 lossless WebP under{" "}
        <span className="mono">{group || "images"}</span>.
      </p>

      {error && <p className="text-xs text-red-300">{error}</p>}

      <Button
        variant="primary"
        disabled={!staged || busy || !projectDir}
        onClick={() => void save()}
      >
        {busy ? "Saving…" : "Use this image"}
      </Button>
    </div>
  );
}
