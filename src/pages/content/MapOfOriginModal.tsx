import { useState } from "react";
import { useDraftsStore } from "../../stores/draftsStore";
import { useProjectStore } from "../../stores/projectStore";
import { normalizeBpPath, type CatalogEntry } from "../../model/catalog";
import { deriveMapFromPath, mapList } from "../../model/maps";
import { IconValue } from "../../components/EntityIcon";
import { Button, cx, Field, Input, Modal } from "../../components/ui";
import { toast } from "../../components/toast";

/**
 * Map-of-origin assignment for one catalog entry.
 *
 * Lives in its own file because two places need it: the item row's Map action,
 * and the creature details modal, where the map belongs alongside everything
 * else recorded about the creature.
 */
export function MapOfOriginModal({
  entry,
  onClose,
}: {
  entry: CatalogEntry;
  onClose: () => void;
}) {
  const { catalog, setCatalog } = useDraftsStore();
  const settings = useProjectStore((s) => s.settings);
  const maps = mapList(settings);
  const key = normalizeBpPath(entry.bpPath);
  const override = catalog.maps[key] ?? "";
  const derived = deriveMapFromPath(entry.bpPath);
  const [value, setValue] = useState(override);
  const [custom, setCustom] = useState(
    override && !maps.some((m) => m.name === override) ? override : "",
  );

  function save(map: string) {
    const maps = { ...catalog.maps };
    if (map.trim()) maps[key] = map.trim();
    else delete maps[key];
    setCatalog({ ...catalog, maps });
    onClose();
    toast.success(
      map.trim()
        ? `${entry.name} assigned to ${map.trim()}`
        : `${entry.name} map reset${derived ? ` (auto: ${derived})` : ""}`,
    );
  }

  return (
    <Modal title={`Map of origin — ${entry.name}`} onClose={onClose} wide>
      <p className="text-xs text-ink-400 mb-3">
        {derived
          ? `Auto-detected from the blueprint path: ${derived}. An assignment here overrides it.`
          : "No map could be derived from the blueprint path — assign one here."}
      </p>
      <div className="flex flex-col gap-3">
        <Field label="Map" hint="The list is editable in Settings → Maps">
          {/* Buttons rather than a <select> so image icons can show. */}
          <div className="grid grid-cols-3 gap-1.5">
            <button
              onClick={() => setValue("")}
              className={cx(
                "flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-sm cursor-pointer text-left",
                value === ""
                  ? "border-accent-500 bg-ink-800 text-ink-100"
                  : "border-ink-700 text-ink-400 hover:border-ink-600 hover:text-ink-200",
              )}
            >
              <span className="shrink-0">↺</span>
              <span className="truncate">
                {derived ? `Auto (${derived})` : "None"}
              </span>
            </button>
            {maps.map((m) => (
              <button
                key={m.name}
                onClick={() => setValue(m.name)}
                title={
                  m.enabled
                    ? undefined
                    : `${m.name} is switched off for this cluster — assigning it marks the entry Caution`
                }
                className={cx(
                  "flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-sm cursor-pointer text-left",
                  value === m.name
                    ? "border-accent-500 bg-ink-800"
                    : "border-ink-700 hover:border-ink-600",
                  // Still selectable — an entry's origin is a fact about the
                  // entry, not about which maps the cluster happens to run.
                  !m.enabled && "opacity-55",
                )}
                style={{ color: m.color || undefined }}
              >
                <IconValue icon={m.icon} officialMap={m.name} size={16} />
                <span className="truncate">{m.name}</span>
                {!m.enabled && <span className="text-amber-400 shrink-0">⚠</span>}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Or custom map/source name">
          <Input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="e.g. Nyrandil"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {override && (
            <Button variant="ghost" onClick={() => save("")}>
              Reset to auto
            </Button>
          )}
          <Button variant="primary" onClick={() => save(custom.trim() || value)}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
