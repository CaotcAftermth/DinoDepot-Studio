import { useState } from "react";
import { useDraftsStore } from "../../stores/draftsStore";
import { normalizeBpPath, type CatalogEntry } from "../../model/catalog";
import { classNameOf } from "../../services/spawnCommands";
import {
  EntityIcon,
  IconPickerModal,
} from "../../components/EntityIcon";
import { Badge, Button, Field, Input, Modal } from "../../components/ui";
import { toast } from "../../components/toast";

/**
 * Renames a record keyed by normalized blueprint path. Returns the same object
 * when there was nothing under the old key, so unchanged maps stay identical.
 */
function rekey<T>(
  record: Record<string, T>,
  from: string,
  to: string,
): Record<string, T> {
  if (!(from in record)) return record;
  const next = { ...record };
  next[to] = next[from];
  delete next[from];
  return next;
}

/**
 * The entry's own data — what the catalog stores about it, as opposed to what
 * has been recorded *for* it. Name, class, and icon in one place, so the row
 * itself needs no edit affordances of its own.
 */
export function EntryDataModal({
  entry,
  kind,
  /** False for bundled official content, whose name and path are read-only. */
  editable,
  /** The entry already using a path, anywhere in the effective catalog. */
  findConflict,
  onSave,
  onClose,
}: {
  entry: CatalogEntry;
  kind: "creatures" | "items";
  editable: boolean;
  findConflict: (bpPath: string) => { label: string } | null;
  onSave: (next: CatalogEntry) => void;
  onClose: () => void;
}) {
  const { catalog, setCatalog } = useDraftsStore();
  const [name, setName] = useState(entry.name);
  const [bpPath, setBpPath] = useState(entry.bpPath);
  const [pickingIcon, setPickingIcon] = useState(false);

  const trimmedPath = bpPath.trim();
  const pathChanged = normalizeBpPath(trimmedPath) !== normalizeBpPath(entry.bpPath);
  const conflict = pathChanged && trimmedPath ? findConflict(trimmedPath) : null;
  const dirty = name.trim() !== entry.name || trimmedPath !== entry.bpPath;

  function save() {
    if (!name.trim() || !trimmedPath || conflict) return;
    // Everything the catalog records for an entry hangs off its normalized
    // path, so a repath has to take the icon, map, notes and info with it —
    // otherwise the edit silently strips the entry of its whole record.
    if (pathChanged) {
      const from = normalizeBpPath(entry.bpPath);
      const to = normalizeBpPath(trimmedPath);
      const variantParents = rekey(catalog.variantParents, from, to);
      setCatalog({
        ...catalog,
        icons: rekey(catalog.icons, from, to),
        notes: rekey(catalog.notes, from, to),
        maps: rekey(catalog.maps, from, to),
        itemInfo: rekey(catalog.itemInfo, from, to),
        creatureInfo: rekey(catalog.creatureInfo, from, to),
        // Children pointing at the old path have to follow it too.
        variantParents: Object.fromEntries(
          Object.entries(variantParents).map(([child, parent]) => [
            child,
            normalizeBpPath(parent) === from ? trimmedPath : parent,
          ]),
        ),
      });
    }
    onSave({ ...entry, name: name.trim(), bpPath: trimmedPath });
    toast.success(`${name.trim()} updated`);
    onClose();
  }

  return (
    <Modal
      title={`Entry data — ${entry.name}`}
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-500">
            {editable
              ? "The blueprint path is the identity of this entry."
              : "Bundled official content — only the icon can be changed."}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                !editable || !dirty || !name.trim() || !trimmedPath || Boolean(conflict)
              }
              onClick={save}
            >
              Save
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <EntityIcon bpPath={entry.bpPath} kind={kind} name={entry.name} size={72} />
          <div className="flex flex-col gap-1.5 items-start">
            <Button onClick={() => setPickingIcon(true)}>Change icon…</Button>
            <span className="text-xs text-ink-500">
              An image named after the entry is used automatically; this
              overrides it.
            </span>
          </div>
        </div>

        <Field label="Display name">
          <Input
            value={name}
            disabled={!editable}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>

        <Field
          label="Blueprint path"
          hint={
            kind === "creatures"
              ? "e.g. /Game/Mods/X/Creatures/X_Character_BP.X_Character_BP"
              : "e.g. /Game/Mods/X/Items/PrimalItemResource_X.PrimalItemResource_X"
          }
        >
          <Input
            className="mono"
            value={bpPath}
            disabled={!editable}
            onChange={(e) => setBpPath(e.target.value)}
          />
        </Field>

        <Field
          label="Class"
          hint="Derived from the blueprint path — this is what commands and remap files reference"
        >
          <div className="flex gap-2 items-center">
            <Input
              className="mono"
              value={trimmedPath ? classNameOf(trimmedPath) : ""}
              readOnly
            />
            <Button
              disabled={!trimmedPath}
              onClick={() => {
                navigator.clipboard.writeText(classNameOf(trimmedPath));
                toast.success("Class copied");
              }}
            >
              Copy
            </Button>
          </div>
        </Field>

        {conflict && (
          <p className="text-xs rounded-lg border border-danger/30 bg-danger/5 text-red-300 px-3 py-2">
            This class is already catalogued as {conflict.label}. A class in two
            places makes pickers and validation ambiguous.
          </p>
        )}
        {pathChanged && !conflict && (
          <p className="text-xs rounded-lg border border-amber-flag/30 bg-amber-flag/5 text-amber-300 px-3 py-2">
            Changing the path moves this entry's icon, map, notes and recorded
            info with it. Anything referencing the old class elsewhere —
            production rules, remaps — keeps pointing at the old path.
          </p>
        )}
        {!editable && (
          <Badge tone="neutral">
            Bundled Official ASA entry — name and path are read-only
          </Badge>
        )}
      </div>

      {pickingIcon && (
        <IconPickerModal
          bpPath={entry.bpPath}
          name={entry.name}
          kind={kind}
          onClose={() => setPickingIcon(false)}
        />
      )}
    </Modal>
  );
}
