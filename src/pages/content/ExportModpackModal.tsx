import { useEffect, useState } from "react";
import type { ContentSource } from "../../model/catalog";
import {
  packDirName,
  packIconFiles,
  sourceToModpack,
  type Modpack,
  type ModpackRegistry,
} from "../../model/modpack";
import {
  assemblePack,
  planPublish,
  publishPack,
  writePackToDisk,
  type AssembledPack,
  type PublishPlan,
} from "../../services/modpackPublish";
import { useDraftsStore } from "../../stores/draftsStore";
import { useProjectStore } from "../../stores/projectStore";
import { pickFolder } from "../../services/dialogs";
import { openExternal } from "../../services/openExternal";
import { isTauri } from "../../services/ipc";
import { Badge, Button, Field, Input, Modal } from "../../components/ui";
import { toast } from "../../components/toast";

/**
 * Exporting one mod as a publishable pack.
 *
 * Saving to disk and opening a pull request build the same folder, so what a
 * submitter inspects locally is exactly what would be proposed. The PR route
 * always shows its plan — which repository, which branch, which files — and
 * waits for a deliberate confirmation, because opening a pull request on a
 * public repository is not something to discover after the fact.
 */
export function ExportModpackModal({
  source,
  registry,
  onClose,
}: {
  source: ContentSource;
  registry: ModpackRegistry;
  onClose: () => void;
}) {
  const { catalog } = useDraftsStore();
  const imagesDirSetting = useProjectStore((s) => s.local?.imagesDir);
  const dir = useProjectStore((s) => s.dir);

  const [version, setVersion] = useState(source.modpackVersion || "1.0.0");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  const [assembled, setAssembled] = useState<AssembledPack | null>(null);
  const [plan, setPlan] = useState<PublishPlan | null>(null);
  const [busy, setBusy] = useState("");
  const [prUrl, setPrUrl] = useState("");

  /** The images folder icons are read from — the setting, else the project's. */
  const imagesDir = imagesDirSetting?.trim() || (dir ? `${dir}/images` : "");

  const pack: Modpack = sourceToModpack(source, catalog, {
    id: source.modpackId || undefined,
    version,
    author,
    description,
  });
  const dirName = packDirName(pack.meta);
  const iconCount = packIconFiles(pack).length;

  // Re-assemble whenever the metadata that lands in the file changes.
  useEffect(() => {
    let cancelled = false;
    assemblePack(pack, imagesDir)
      .then((result) => {
        if (!cancelled) setAssembled(result);
      })
      .catch(() => {
        if (!cancelled) setAssembled(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, author, description, imagesDir, source.id]);

  async function saveToDisk() {
    if (!assembled) return;
    setBusy("Saving…");
    try {
      const target = await pickFolder("Choose where to save the modpack folder");
      if (!target) return;
      const sep = target.includes("\\") && !target.includes("/") ? "\\" : "/";
      await writePackToDisk(assembled, `${target}${sep}${dirName}`);
      toast.success(
        `Saved ${dirName}/ — ${assembled.files.length} file${assembled.files.length === 1 ? "" : "s"}` +
          (assembled.missingIcons.length
            ? ` · ${assembled.missingIcons.length} icon(s) could not be read`
            : ""),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function preparePr() {
    if (!assembled) return;
    setBusy("Checking the registry…");
    try {
      setPlan(await planPublish(registry, assembled));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function submitPr() {
    if (!assembled || !plan) return;
    try {
      const result = await publishPack(
        registry,
        assembled,
        plan,
        pack.meta,
        setBusy,
      );
      setPrUrl(result.url);
      toast.success(`Pull request #${result.number} opened`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <Modal
      title={`Export modpack — ${source.name}`}
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-ink-500 truncate">
            {busy || `${dirName}/ · ${assembled?.files.length ?? 0} files`}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              onClick={saveToDisk}
              disabled={!isTauri || !assembled || Boolean(busy)}
              title={isTauri ? undefined : "Saving files needs the desktop app"}
            >
              Save to folder…
            </Button>
            <Button
              variant="primary"
              onClick={plan ? submitPr : preparePr}
              disabled={!isTauri || !assembled || Boolean(busy) || Boolean(prUrl)}
              title={
                isTauri
                  ? "Open a pull request adding this pack to the registry"
                  : "Submitting needs the desktop app"
              }
            >
              {plan ? "Confirm & open pull request" : "Submit pull request…"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Version" hint="Bump this on every submission">
            <Input value={version} onChange={(e) => setVersion(e.target.value)} />
          </Field>
          <Field label="Author" hint="Credit, and someone to ask">
            <Input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Your name or Discord handle"
            />
          </Field>
          <Field label="Pack id" hint="Stable across versions — set once">
            <Input value={pack.meta.id} readOnly className="text-ink-400" />
          </Field>
        </div>
        <Field label="Description">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One or two lines on what this mod adds."
          />
        </Field>

        <div className="border border-ink-700 rounded-lg p-3">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="mono text-sm text-ink-100">{dirName}/</span>
            <Badge tone="neutral">{pack.creatures.length} creatures</Badge>
            <Badge tone="neutral">{pack.items.length} items</Badge>
            <Badge tone="neutral">{pack.iniSettings.length} INI</Badge>
            <Badge tone={iconCount > 0 ? "ok" : "neutral"}>
              {iconCount} icon{iconCount === 1 ? "" : "s"}
            </Badge>
          </div>
          <ul className="text-xs text-ink-400 mono flex flex-col gap-0.5 max-h-32 overflow-y-auto">
            {(assembled?.files ?? []).map((f) => (
              <li key={f.path}>{f.path}</li>
            ))}
          </ul>
          {assembled && assembled.missingIcons.length > 0 && (
            <p className="text-xs text-amber-400 mt-2">
              {assembled.missingIcons.length} referenced icon image
              {assembled.missingIcons.length === 1 ? "" : "s"} could not be read
              from {imagesDir || "the images folder"} and will not be included:{" "}
              {assembled.missingIcons.join(", ")}
            </p>
          )}
        </div>

        {plan && !prUrl && (
          <div className="border border-amber-flag/40 bg-amber-flag/5 rounded-lg p-3">
            <p className="text-sm text-amber-300 font-medium mb-1">
              This will open a public pull request.
            </p>
            <ul className="text-xs text-ink-300 flex flex-col gap-0.5">
              <li>
                Pull request against{" "}
                <span className="mono">
                  {registry.owner}/{registry.repo}
                </span>{" "}
                ← <span className="mono">{plan.head}</span>
              </li>
              {plan.forked && (
                <li>
                  You cannot push to that repository, so it will be forked to
                  your account first.
                </li>
              )}
              <li>Files added or replaced:</li>
            </ul>
            <ul className="text-xs text-ink-400 mono mt-1 flex flex-col gap-0.5 max-h-28 overflow-y-auto">
              {plan.paths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}

        {prUrl && (
          <div className="border border-accent-500/40 bg-accent-500/5 rounded-lg p-3 flex items-center justify-between gap-3">
            <span className="text-sm text-ink-200">
              Pull request opened. A maintainer reviews it before it appears in
              search.
            </span>
            <Button
              variant="primary"
              className="shrink-0"
              onClick={() => void openExternal(prUrl)}
            >
              View on GitHub ↗
            </Button>
          </div>
        )}

        {!isTauri && (
          <p className="text-xs text-amber-400">
            Saving and submitting both need the desktop app.
          </p>
        )}
      </div>
    </Modal>
  );
}
