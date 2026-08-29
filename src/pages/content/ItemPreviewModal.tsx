import { useDraftsStore } from "../../stores/draftsStore";
import { useProjectStore } from "../../stores/projectStore";
import { normalizeBpPath, type CatalogEntry } from "../../model/catalog";
import { bundledItemInfo, itemInfoOf, RARITY_COLOR } from "../../model/itemInfo";
import { mapIsDisabled, mapOf, mapStyle } from "../../model/maps";
import { shortClassName } from "../../services/spawnCommands";
import { EntityIcon, IconValue } from "../../components/EntityIcon";
import { MarkdownText } from "../../components/ReferenceText";
import { Badge, Button, Modal } from "../../components/ui";

/**
 * A read-only wrap-up of everything recorded for one item - the counterpart to
 * CreaturePreviewModal, opened the same way, from the row's icon.
 *
 * Deliberately much smaller than the creature version: an item's record is
 * four facts and some notes, so it earns a single panel rather than tabs.
 */
export function ItemPreviewModal({
  entry,
  onClose,
  onEdit,
}: {
  entry: CatalogEntry;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { catalog } = useDraftsStore();
  const settings = useProjectStore((s) => s.settings);
  const key = normalizeBpPath(entry.bpPath);

  // Resolved view: administrator values with bundled defaults.
  const info = itemInfoOf(catalog, entry.bpPath);
  const bundled = bundledItemInfo(entry.bpPath);
  const stored = catalog.itemInfo[key];
  const notes = catalog.notes[key] ?? "";

  const origin = mapOf(catalog, entry.bpPath);
  const originStyle = origin ? mapStyle(settings, origin) : null;
  const originDisabled = mapIsDisabled(settings, origin);

  const facts: { label: string; value: string; source?: string }[] = [];
  if (info.type) {
    facts.push({
      label: "Type",
      value: info.type,
      source: !stored?.type && bundled.type ? "from bundled data" : undefined,
    });
  }
  if (info.rarity) facts.push({ label: "Rarity", value: info.rarity });
  if (info.stackSize !== null && info.stackSize !== undefined) {
    facts.push({
      label: "Stack size",
      value: String(info.stackSize),
      source:
        stored?.stackSize === null || stored?.stackSize === undefined
          ? "from bundled data"
          : undefined,
    });
  }
  if (info.highOutputPerHour !== null && info.highOutputPerHour !== undefined) {
    facts.push({
      label: "High output warning",
      value: `${info.highOutputPerHour}/hour`,
      source: "overrides the simulator default",
    });
  }

  const empty = facts.length === 0 && !notes.trim();

  return (
    <Modal
      title={`Preview - ${entry.name}`}
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-500">
            {stored
              ? "Values recorded for this cluster override bundled data."
              : "Nothing recorded for this cluster; showing bundled data."}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" onClick={onEdit}>
              Edit info…
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex items-start gap-4 pb-4 border-b border-ink-700">
        <EntityIcon bpPath={entry.bpPath} kind="items" name={entry.name} size={72} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-white truncate">
              {entry.name}
            </h3>
            {info.rarity && (
              <span
                className="text-xs px-1.5 py-0.5 rounded-full border shrink-0"
                style={{
                  color: RARITY_COLOR[info.rarity] ?? undefined,
                  borderColor: `${RARITY_COLOR[info.rarity] ?? "#6b7280"}55`,
                }}
              >
                {info.rarity}
              </span>
            )}
          </div>
          <div className="mono text-xs text-ink-400 truncate mt-0.5">
            {shortClassName(entry.bpPath)}
          </div>
          <div className="flex items-center gap-3 flex-wrap mt-1.5">
            {origin && (
              <span
                className="text-xs flex items-center gap-1"
                style={{ color: originStyle?.color || undefined }}
                title="Map of origin"
              >
                <IconValue
                  icon={originStyle?.icon ?? "🗺️"}
                  officialMap={origin}
                  size={13}
                />
                {origin}
              </span>
            )}
            {originDisabled && (
              <span title={`${origin} is switched off for this cluster.`}>
                <Badge tone="warn">Caution</Badge>
              </span>
            )}
          </div>
        </div>
      </div>

      {empty ? (
        <p className="text-sm text-ink-400 border border-dashed border-ink-700 rounded-md px-3 py-6 text-center mt-4">
          Nothing recorded for {entry.name} yet.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {facts.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {facts.map((fact) => (
                <div
                  key={fact.label}
                  className="border border-ink-700 rounded-md px-3 py-2 bg-ink-850"
                >
                  <div className="text-xs text-ink-400 uppercase tracking-wide">
                    {fact.label}
                  </div>
                  <div className="text-sm text-ink-100">{fact.value}</div>
                  {fact.source && (
                    <div className="text-xs text-ink-500 mt-0.5">{fact.source}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {notes.trim() && (
            <div>
              <div className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1.5">
                Viewer notes
              </div>
              <div className="border border-ink-700 rounded-md px-3 py-2 bg-ink-850 text-sm text-ink-200">
                <MarkdownText text={notes} />
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
