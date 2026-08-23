import { useEffect, useMemo, useState } from "react";
import { recordActivity, useDraftsStore } from "../stores/draftsStore";
import { RemapEntry } from "../model/remaps";
import { newId } from "../model/ids";
import { remapsToText } from "../serializers/remaps";
import { validateRemaps } from "../validation/remaps";
import { countIssues } from "../validation/types";
import { normalizeBpPath } from "../model/catalog";
import {
  Badge,
  Button,
  Card,
  CollapsibleCard,
  cx,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Toggle,
} from "../components/ui";
import { toast } from "../components/toast";
import { confirmDialog } from "../components/confirm";
import { BlueprintPicker } from "../components/BlueprintPicker";
import { displayNameFor, useCatalogIndex } from "../stores/useCatalogIndex";
import { pickFile } from "../services/dialogs";
import { ipc } from "../services/ipc";
import { importRemapsText } from "../services/importers";
import { shortClassName } from "../services/spawnCommands";
import { useUiPrefsStore } from "../stores/uiPrefsStore";
import { feedbackTarget } from "../model/feedback/targets";

/** Remap files reference classes with a trailing _C; add it when missing. */
function toClassRef(bpPath: string): string {
  return /_C$/.test(bpPath) ? bpPath : `${bpPath}_C`;
}

export function RemapsPage() {
  const { remaps, setRemaps, catalog, setCatalog, hydrate } = useDraftsStore();
  useEffect(hydrate, [hydrate]);
  const index = useCatalogIndex();

  // Deleting a remap should take its remembered fold state with it, so a later
  // entry can never inherit one.
  const prunePrefs = useUiPrefsStore((s) => s.prune);
  useEffect(() => {
    prunePrefs(
      "remap:",
      remaps.entries.map((e) => `remap:${e.id}`),
    );
  }, [remaps.entries, prunePrefs]);

  const [showJson, setShowJson] = useState(true);
  const [picking, setPicking] = useState<{
    entryId: string;
    field: "fromClass" | "toClass";
  } | null>(null);

  const issues = useMemo(() => validateRemaps(remaps, index), [remaps, index]);
  const issuesByEntry = useMemo(() => {
    const map = new Map<string, typeof issues>();
    for (const issue of issues) {
      const list = map.get(issue.entityId) ?? [];
      list.push(issue);
      map.set(issue.entityId, list);
    }
    return map;
  }, [issues]);

  const jsonPreview = useMemo(() => remapsToText(remaps), [remaps]);
  const totals = countIssues(issues);
  const activeCount = remaps.entries.filter((e) => e.active).length;

  function addEntry() {
    const entry: RemapEntry = {
      id: newId(),
      active: true,
      fromClass: "",
      toClass: "",
      fromSourceId: null,
      toSourceId: null,
      intentional: false,
      notes: "",
    };
    setRemaps({ ...remaps, entries: [...remaps.entries, entry] });
    recordActivity({ kind: "remap", title: "Added a creature remap" });
  }

  function updateEntry(id: string, patch: Partial<RemapEntry>) {
    setRemaps({
      ...remaps,
      entries: remaps.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  }

  async function deleteEntry(entry: RemapEntry) {
    const ok = await confirmDialog({
      title: "Delete remap entry?",
      message: "This removes the creature remap from the published output.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setRemaps({
      ...remaps,
      entries: remaps.entries.filter((e) => e.id !== entry.id),
    });
    recordActivity({
      kind: "remap",
      title: `Deleted remap ${creatureLabel(entry.fromClass) || shortClassName(entry.fromClass) || ""}`.trim(),
    });
  }

  async function importFromFile() {
    const path = await pickFile("Select your live creature remap JSON file");
    if (!path) return;
    try {
      const text = await ipc<string>("read_text_file", { path });
      const result = importRemapsText(text, catalog);
      if (remaps.entries.length > 0) {
        const ok = await confirmDialog({
          title: "Replace draft remaps?",
          message: `The current ${remaps.entries.length} draft entr${remaps.entries.length === 1 ? "y" : "ies"} will be replaced by ${result.draft.entries.length} imported one(s).`,
          confirmLabel: "Replace",
          danger: true,
        });
        if (!ok) return;
      }
      setRemaps(result.draft);
      setCatalog(result.catalog);
      toast.success(
        `Imported ${result.draft.entries.length} remaps` +
          (result.catalogAdded > 0
            ? ` — ${result.catalogAdded} unknown creatures added to "Imported / unsorted"`
            : ""),
      );
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  function creatureLabel(path: string): string {
    if (!path) return "";
    return displayNameFor(index, "creatures", path);
  }

  return (
    <div {...feedbackTarget("creature-remaps")}>
      <PageHeader
        title="Creature Type Remaps"
        subtitle={`${activeCount} active of ${remaps.entries.length} entries · ${totals.errors} errors · ${totals.warnings} warnings — published as a separate raw file referenced by the game INI`}
        actions={
          <>
            <Button onClick={importFromFile}>Import live file…</Button>
            <Button onClick={() => setShowJson(!showJson)}>
              {showJson ? "Hide preview" : "Show preview"}
            </Button>
            <Button variant="primary" onClick={addEntry}>
              + Add remap
            </Button>
          </>
        }
      />

      <div
        className={cx(
          "grid gap-5",
          showJson ? "grid-cols-[minmax(0,1fr)_400px]" : "grid-cols-1",
        )}
      >
        <div className="flex flex-col gap-3">
          {remaps.entries.length === 0 && (
            <Card>
              <EmptyState title="No remaps yet">
                Add a remap before removing a creature or mod from the server so
                existing Dino Depot data converts into something valid.
              </EmptyState>
            </Card>
          )}

          {remaps.entries.map((entry, i) => {
            const entryIssues = issuesByEntry.get(entry.id) ?? [];
            const { errors, warnings } = countIssues(entryIssues);
            return (
              <CollapsibleCard
                key={entry.id}
                prefKey={`remap:${entry.id}`}
                // Remaps are a long list of one-line facts — source becomes
                // destination — so the page is far more useful as an index
                // than as a stack of open forms.
                defaultOpen={false}
                // Source → destination and nothing else: the header is for
                // recognising the remap at a glance, and every other detail is
                // one click away in the card itself.
                title={
                  <span className="flex items-center gap-2">
                    <span className="truncate">
                      {creatureLabel(entry.fromClass) ||
                        shortClassName(entry.fromClass) ||
                        `Remap ${i + 1}`}
                      {entry.toClass && (
                        <span className="text-ink-400 font-normal">
                          {" "}
                          → {creatureLabel(entry.toClass)}
                        </span>
                      )}
                    </span>
                    {errors > 0 && <Badge tone="error">{errors}</Badge>}
                    {warnings > 0 && <Badge tone="warn">{warnings}</Badge>}
                    {!entry.active && <Badge tone="neutral">Inactive</Badge>}
                  </span>
                }
                actions={
                  <>
                    <Toggle
                      checked={entry.intentional}
                      onChange={(v) => updateEntry(entry.id, { intentional: v })}
                      label="Intentional"
                      title={
                        "Marks this remap as a deliberate conversion.\n\n" +
                        "A remap normally exists because the source creature is going away, so " +
                        "validation warns when the source's content is still enabled and not " +
                        "marked \"Being removed\" — that usually means the remap was set up by " +
                        "mistake, and it would silently convert creatures players still have.\n\n" +
                        "Turning this on says you meant it, and dismisses that one warning. It " +
                        "changes nothing in the published output."
                      }
                    />
                    <Toggle
                      checked={entry.active}
                      onChange={(v) => updateEntry(entry.id, { active: v })}
                      label="Active"
                    />
                    <Button variant="danger" onClick={() => deleteEntry(entry)}>
                      Delete
                    </Button>
                  </>
                }
              >
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <Field label="Source creature class (being removed)">
                    <div className="flex gap-2">
                      <Input
                        className="mono"
                        value={entry.fromClass}
                        onChange={(e) =>
                          updateEntry(entry.id, { fromClass: e.target.value })
                        }
                        placeholder="/OldMod/…/Old_Character_BP.Old_Character_BP_C"
                      />
                      <Button
                        onClick={() =>
                          setPicking({ entryId: entry.id, field: "fromClass" })
                        }
                      >
                        Pick…
                      </Button>
                    </div>
                  </Field>
                  <Field label="Destination creature class">
                    <div className="flex gap-2">
                      <Input
                        className="mono"
                        value={entry.toClass}
                        onChange={(e) =>
                          updateEntry(entry.id, { toClass: e.target.value })
                        }
                        placeholder="/Game/…/New_Character_BP.New_Character_BP_C"
                      />
                      <Button
                        onClick={() =>
                          setPicking({ entryId: entry.id, field: "toClass" })
                        }
                      >
                        Pick…
                      </Button>
                    </div>
                  </Field>
                </div>
                <Field label="Notes / reason" hint="Internal only — never published">
                  <Input
                    value={entry.notes}
                    onChange={(e) => updateEntry(entry.id, { notes: e.target.value })}
                    placeholder="e.g. Mod X being removed at end of season"
                  />
                </Field>

                {entryIssues.length > 0 && (
                  <div className="flex flex-col gap-1.5 mt-3 border-t border-ink-700 pt-3">
                    {entryIssues.map((issue, j) => (
                      <div key={j} className="flex items-start gap-2 text-sm">
                        <Badge tone={issue.level === "error" ? "error" : "warn"}>
                          {issue.level}
                        </Badge>
                        <span className="text-ink-300">{issue.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CollapsibleCard>
            );
          })}
        </div>

        {showJson && (
          <div className="min-w-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
                Published output preview
              </span>
              <Button
                variant="ghost"
                onClick={() => {
                  navigator.clipboard.writeText(jsonPreview);
                  toast.success("Remap JSON copied to clipboard");
                }}
              >
                Copy
              </Button>
            </div>
            <pre className="mono bg-ink-950 border border-ink-700 rounded-lg p-3 overflow-auto max-h-[calc(100vh-200px)] text-ink-200 whitespace-pre">
              {jsonPreview}
            </pre>
          </div>
        )}
      </div>

      {picking && (
        <BlueprintPicker
          kind="creatures"
          title={
            picking.field === "fromClass"
              ? "Pick the source creature (being removed)"
              : "Pick the destination creature"
          }
          onClose={() => setPicking(null)}
          onPick={(bpPath) => {
            const entry = remaps.entries.find((e) => e.id === picking.entryId);
            if (entry) {
              const hit = index.creatures.get(normalizeBpPath(bpPath));
              updateEntry(picking.entryId, {
                [picking.field]: toClassRef(bpPath),
                [picking.field === "fromClass" ? "fromSourceId" : "toSourceId"]:
                  hit?.source.id ?? null,
              });
            }
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
