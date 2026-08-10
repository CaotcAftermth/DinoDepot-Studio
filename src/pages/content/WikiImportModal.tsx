import { useMemo, useState } from "react";
import { useDraftsStore } from "../../stores/draftsStore";
import { normalizeBpPath } from "../../model/catalog";
import { useAllSources, useCatalogIndex } from "../../stores/useCatalogIndex";
import {
  hasCreatureInfo,
  INFO_SECTIONS,
  InfoSection,
  SECTION_LABELS,
} from "../../model/creatureInfo";
import {
  applyImport,
  defaultDecision,
  diffImport,
  ImportDecision,
  ImportRecord,
  IMPORT_STATUS_LABELS,
  ImportStatus,
  importCounts,
  isNoOp,
  mergeReimport,
} from "../../model/creatureImport";
import {
  buildImportRecord,
  buildNameIndex,
  fetchWikiPage,
  importFixtures,
  proposedSections,
  WIKI_HOST,
} from "../../services/wikiImport";
import { CREATURE_FIXTURES } from "../../model/creatureInfoFixtures";
import { Badge, Button, cx, Input, Modal, Toggle } from "../../components/ui";
import { toast } from "../../components/toast";
import { confirmDialog } from "../../components/confirm";
import { plural } from "../../model/text";

/**
 * Wiki import review.
 *
 * The importer only ever writes staged proposals; this is where a human turns
 * one into a real record. Nothing is applied wholesale: the reviewer accepts
 * section by section, sees exactly what would change first, and is warned
 * before anything already written by hand is touched.
 */

type Filter = "pending" | "all" | ImportStatus;

export function WikiImportModal({ onClose }: { onClose: () => void }) {
  const { catalog, setCatalog, creatureImports, setCreatureImports } =
    useDraftsStore();

  const [filter, setFilter] = useState<Filter>("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState("");
  const [fetching, setFetching] = useState(false);

  const records = creatureImports.records;
  const counts = useMemo(() => importCounts(records), [records]);

  // Official ASA is bundled rather than stored in `catalog.sources`, so both
  // indexes must come from the merged view — otherwise every reference to an
  // official item or creature reads as unresolved.
  const allSources = useAllSources();
  const catalogIndex = useCatalogIndex();
  const nameIndex = useMemo(() => buildNameIndex(allSources), [allSources]);

  const shown = useMemo(
    () => records.filter((r) => (filter === "all" ? true : r.status === filter)),
    [records, filter],
  );
  const selected = records.find((r) => r.id === selectedId) ?? shown[0] ?? null;

  function setRecords(next: ImportRecord[]) {
    setCreatureImports({ ...creatureImports, records: next });
  }

  function stage(incoming: ImportRecord[], label: string) {
    const result = mergeReimport(records, incoming);
    setRecords(result.records);
    const parts = [`${plural(incoming.length - result.unchanged.length, "new proposal")}`];
    if (result.unchanged.length > 0) {
      parts.push(`${result.unchanged.length} unchanged since last import`);
    }
    if (result.superseded.length > 0) {
      parts.push(`${plural(result.superseded.length, "earlier proposal")} superseded`);
    }
    toast.success(`${label}: ${parts.join(", ")}`);
  }

  function stageFixtures() {
    stage(
      importFixtures(CREATURE_FIXTURES, { catalogIndex }),
      "Verified fixtures staged",
    );
  }

  async function fetchPage() {
    const page = pageInput.trim();
    if (!page) return;
    setFetching(true);
    try {
      const fetched = await fetchWikiPage(page);
      stage(
        [
          buildImportRecord(fetched, {
            nameIndex,
            creatureIndex: nameIndex.creatures,
            variantParents: catalog.variantParents,
            creatureInfo: catalog.creatureInfo,
          }),
        ],
        `Imported ${fetched.page}`,
      );
      setPageInput("");
    } catch (e) {
      toast.error(`Wiki import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFetching(false);
    }
  }

  function updateRecord(id: string, patch: Partial<ImportRecord>) {
    setRecords(records.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function accept(record: ImportRecord, decision: ImportDecision) {
    const accepted = INFO_SECTIONS.filter(
      (s) => decision.sections[s] === "accept",
    );
    if (accepted.length === 0) {
      toast.error("Nothing is accepted — tick at least one section first");
      return;
    }
    if (!record.bpPath) {
      toast.error("This proposal has no target creature, so it cannot be applied");
      return;
    }

    const key = normalizeBpPath(record.bpPath);
    const current = catalog.creatureInfo[key];

    // Anything already written by hand is only replaced on an explicit yes.
    if (hasCreatureInfo(current)) {
      const changing = diffImport(current, record.proposed).filter(
        (d) => accepted.includes(d.section) && d.kind === "change",
      );
      if (changing.length > 0) {
        const ok = await confirmDialog({
          title: `Overwrite existing ${record.creatureName} information?`,
          message: `${plural(changing.length, "section")} already recorded for this creature would be replaced by the wiki proposal.`,
          details: changing.map(
            (d) => `${d.label}: ${plural(d.lines.length, "field")} would change`,
          ),
          confirmLabel: "Overwrite",
          danger: true,
        });
        if (!ok) return;
      }
    }

    setCatalog({
      ...catalog,
      creatureInfo: {
        ...catalog.creatureInfo,
        [key]: applyImport(current, record.proposed, decision),
      },
    });
    updateRecord(record.id, {
      status: "accepted",
      reviewedAt: new Date().toISOString(),
    });
    toast.success(
      `${record.creatureName}: ${plural(accepted.length, "section")} applied`,
    );
  }

  return (
    <Modal title="Import creature information from the wiki" onClose={onClose} xl>
      <p className="text-xs text-ink-400 mb-3">
        Everything below is a <strong className="text-ink-200">proposal</strong>,
        not a record. The importer reads a page's taming section, maps what it
        can into the acquisition schema, and flags anything it had to infer.
        Nothing reaches a creature until you accept it here, section by section.
      </p>

      <div className="flex items-center gap-2 mb-4">
        <Button onClick={stageFixtures} title="The 25 hand-verified reference records">
          Stage verified fixtures ({CREATURE_FIXTURES.length})
        </Button>
        <span className="text-ink-600">|</span>
        <div className="flex-1 min-w-0">
          <Input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchPage()}
            placeholder={`Wiki page title, e.g. "Carcharodontosaurus" or "Mod:Additions Ascended/Edmontonia"`}
          />
        </div>
        <Button
          variant="primary"
          className="shrink-0"
          onClick={fetchPage}
          disabled={fetching || !pageInput.trim()}
        >
          {fetching ? "Fetching…" : `Fetch from ${WIKI_HOST}`}
        </Button>
      </div>

      {records.length === 0 ? (
        <div className="text-center py-12 px-6 border border-dashed border-ink-700 rounded-lg">
          <p className="text-ink-300 font-medium mb-1">Nothing staged yet</p>
          <p className="text-ink-400 text-sm">
            Stage the verified fixtures to see the workflow end to end, or fetch
            a single page above.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-[320px_1fr] gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-1 mb-2">
              {(
                [
                  ["pending", counts.pending],
                  ["accepted", counts.accepted],
                  ["rejected", counts.rejected],
                  ["superseded", counts.superseded],
                  ["all", records.length],
                ] as const
              ).map(([key, n]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key as Filter)}
                  className={cx(
                    "px-2 py-0.5 rounded text-xs capitalize cursor-pointer border",
                    filter === key
                      ? "bg-accent-600/20 text-accent-300 border-accent-500/40"
                      : "bg-ink-800 text-ink-400 border-ink-700 hover:text-ink-200",
                  )}
                >
                  {key} {n}
                </button>
              ))}
            </div>
            <div className="border border-ink-700 rounded-lg divide-y divide-ink-800 max-h-[60vh] overflow-y-auto">
              {shown.length === 0 && (
                <p className="text-xs text-ink-400 p-3">
                  No {filter === "all" ? "" : filter} proposals.
                </p>
              )}
              {shown.map((record) => (
                <button
                  key={record.id}
                  onClick={() => setSelectedId(record.id)}
                  className={cx(
                    "w-full text-left px-3 py-2 cursor-pointer",
                    selected?.id === record.id
                      ? "bg-accent-600/15"
                      : "hover:bg-ink-800",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-ink-100 truncate">
                      {record.creatureName}
                    </span>
                    {record.confidence === "needs-review" && (
                      <span className="text-amber-400 text-xs shrink-0">⚠</span>
                    )}
                  </div>
                  <div className="text-xs text-ink-400 truncate">
                    {record.source.mod || record.source.game} · rev{" "}
                    {record.source.revisionId}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {selected ? (
            <RecordReview
              key={selected.id}
              record={selected}
              onAccept={accept}
              onReject={() =>
                updateRecord(selected.id, {
                  status: "rejected",
                  reviewedAt: new Date().toISOString(),
                })
              }
              onNote={(reviewNote) => updateRecord(selected.id, { reviewNote })}
              onReopen={() =>
                updateRecord(selected.id, { status: "pending", reviewedAt: null })
              }
            />
          ) : (
            <p className="text-sm text-ink-400">Select a proposal to review.</p>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function RecordReview({
  record,
  onAccept,
  onReject,
  onNote,
  onReopen,
}: {
  record: ImportRecord;
  onAccept: (record: ImportRecord, decision: ImportDecision) => void;
  onReject: () => void;
  onNote: (note: string) => void;
  onReopen: () => void;
}) {
  const { catalog } = useDraftsStore();
  const [decision, setDecision] = useState<ImportDecision>(defaultDecision());
  const [showRaw, setShowRaw] = useState(false);

  const current = record.bpPath
    ? catalog.creatureInfo[normalizeBpPath(record.bpPath)]
    : undefined;
  const diffs = useMemo(
    () => diffImport(current, record.proposed),
    [current, record.proposed],
  );
  const offered = proposedSections(record) as InfoSection[];
  const settled = record.status === "accepted" || record.status === "rejected";

  function toggleSection(section: InfoSection) {
    setDecision((d) => ({
      ...d,
      sections: {
        ...d.sections,
        [section]: d.sections[section] === "accept" ? "reject" : "accept",
      },
    }));
  }

  return (
    <div className="min-w-0 space-y-3 max-h-[60vh] overflow-y-auto pr-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-white">
            {record.creatureName}
          </h4>
          <p className="text-xs text-ink-400 mt-0.5">
            <a
              href={record.source.url}
              target="_blank"
              rel="noreferrer"
              className="text-accent-400 hover:underline"
            >
              {record.source.page}
            </a>
            {record.source.section && ` → ${record.source.section}`} · revision{" "}
            {record.source.revisionId} · imported{" "}
            {record.source.importedAt.slice(0, 10)}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge tone={record.source.game === "ASA" ? "ok" : "warn"}>
            {record.source.game}
          </Badge>
          {record.source.mod && <Badge tone="info">{record.source.mod}</Badge>}
          <Badge tone={record.status === "pending" ? "neutral" : "info"}>
            {IMPORT_STATUS_LABELS[record.status]}
          </Badge>
        </div>
      </div>

      {record.source.game === "ASE" && (
        <Warning tone="red">
          This page documents ARK: Survival Evolved. Confirm the creature exists
          in ASA before accepting — some never made the jump.
        </Warning>
      )}
      {record.source.game === "unknown" && (
        <Warning tone="amber">
          The page does not say which game it applies to. The wiki covers ASE and
          ASA together, so confirm this holds for ASA.
        </Warning>
      )}

      {!record.bpPath && (
        <Warning tone="red">
          No catalog creature matched "{record.creatureName}", so this proposal
          has nowhere to go. Add the creature to a content source first.
        </Warning>
      )}

      {record.duplicatesParent && (
        <Warning tone="amber">
          This creature inherits the same information from its parent. Accepting
          would store a duplicate — reject it unless the variant genuinely
          differs.
        </Warning>
      )}

      {record.ambiguities.length > 0 && (
        <div className="border border-amber-flag/30 bg-amber-flag/5 rounded-lg p-3">
          <p className="text-xs font-semibold text-amber-400 mb-1">
            The importer would not guess ({record.ambiguities.length})
          </p>
          <ul className="text-xs text-ink-300 space-y-1 list-disc pl-4">
            {record.ambiguities.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      {record.unresolved.length > 0 && (
        <div className="border border-ink-700 rounded-lg p-3">
          <p className="text-xs font-semibold text-ink-200 mb-1">
            Unresolved references ({record.unresolved.length})
          </p>
          <ul className="text-xs text-ink-400 space-y-0.5">
            {record.unresolved.map((u, i) => (
              <li key={i}>
                <span className="text-ink-200">{u.name}</span> — no {u.kind} by
                that name in the catalog{u.where && ` (${u.where})`}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        {diffs.map((diff) => {
          const isOffered = offered.includes(diff.section);
          const accepted = decision.sections[diff.section] === "accept";
          return (
            <div
              key={diff.section}
              className={cx(
                "border rounded-lg overflow-hidden",
                accepted ? "border-accent-500/40" : "border-ink-700",
              )}
            >
              <div className="flex items-center justify-between px-3 py-2 bg-ink-850">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ink-100">
                    {SECTION_LABELS[diff.section]}
                  </span>
                  {diff.kind === "add" && <Badge tone="ok">New</Badge>}
                  {diff.kind === "change" && <Badge tone="warn">Changes</Badge>}
                  {diff.kind === "same" && <Badge>No change</Badge>}
                </div>
                {isOffered && diff.kind !== "same" && !settled && (
                  <Toggle
                    checked={accepted}
                    onChange={() => toggleSection(diff.section)}
                    label="Accept"
                  />
                )}
              </div>
              {diff.lines.length > 0 && (
                <div className="divide-y divide-ink-800">
                  {/* Column headers rather than a per-line "proposed" label —
                      one heading per side reads as a before/after table. */}
                  <div className="grid grid-cols-[1fr_1fr] gap-3 px-3 py-1.5 bg-ink-900/60">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                      Current
                    </span>
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-accent-400">
                      Proposed Changes:
                    </span>
                  </div>
                  {diff.lines.map((line, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[1fr_1fr] gap-3 px-3 py-1.5 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="text-ink-500 block">{line.field}</span>
                        <span className="text-ink-400 line-through break-words">
                          {line.before}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <span className="text-ink-100 break-words">
                          {line.after}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!settled && (
        <label className="flex items-center gap-2 text-xs text-ink-300">
          <Toggle
            checked={decision.keepLocalStrategy}
            onChange={(v) => setDecision((d) => ({ ...d, keepLocalStrategy: v }))}
            label="Keep my strategy notes on methods I already wrote"
          />
        </label>
      )}

      {Object.keys(record.rawText).length > 0 && (
        <div>
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="text-xs text-accent-400 hover:underline cursor-pointer"
          >
            {showRaw ? "Hide" : "Show"} the original wiki text
          </button>
          {showRaw && (
            <pre className="mt-2 text-xs text-ink-300 bg-ink-950 border border-ink-700 rounded-lg p-3 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
              {Object.entries(record.rawText)
                .map(([section, text]) => `== ${section} ==\n${text}`)
                .join("\n\n")}
            </pre>
          )}
        </div>
      )}

      <Input
        value={record.reviewNote}
        onChange={(e) => onNote(e.target.value)}
        placeholder="Review note (optional) — why you accepted or rejected this"
      />

      <div className="flex items-center gap-2 pt-1">
        {settled ? (
          <>
            <span className="text-xs text-ink-400 flex-1">
              Reviewed {record.reviewedAt?.slice(0, 10)}.
            </span>
            <Button onClick={onReopen}>Reopen for review</Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              onClick={() => onAccept(record, decision)}
              disabled={!record.bpPath || isNoOp(diffs)}
              title={isNoOp(diffs) ? "This proposal would change nothing" : undefined}
            >
              Apply accepted sections
            </Button>
            <Button onClick={onReject}>Reject</Button>
            {isNoOp(diffs) && (
              <span className="text-xs text-ink-400">
                Identical to what is already recorded.
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Warning({
  tone,
  children,
}: {
  tone: "amber" | "red";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cx(
        "text-xs rounded-lg border px-3 py-2",
        tone === "amber"
          ? "border-amber-flag/30 bg-amber-flag/5 text-amber-300"
          : "border-danger/30 bg-danger/5 text-red-300",
      )}
    >
      {children}
    </p>
  );
}
