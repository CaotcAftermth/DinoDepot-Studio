import { useMemo, useState } from "react";
import { useDraftsStore } from "../../stores/draftsStore";
import { normalizeBpPath, type CatalogEntry } from "../../model/catalog";
import { variantParent } from "../../model/creatureBase";
import { shortClassName } from "../../services/spawnCommands";
import { displayNameFor, useCatalogIndex } from "../../stores/useCatalogIndex";
import { BlueprintPicker } from "../../components/BlueprintPicker";
import { EntityIcon } from "../../components/EntityIcon";
import { Badge, Button, cx, Modal } from "../../components/ui";
import { toast } from "../../components/toast";

/**
 * Whether a creature stands on its own or hangs off another one.
 *
 * Dino Depot reads a child class as its parent, and the catalog groups
 * variants under a base creature - both of which come down to a single fact
 * the admin can state here rather than infer from the grouping heuristic.
 */
export function AssociationModal({
  entry,
  onClose,
}: {
  entry: CatalogEntry;
  onClose: () => void;
}) {
  const { catalog, setCatalog } = useDraftsStore();
  const index = useCatalogIndex();
  const key = normalizeBpPath(entry.bpPath);

  const assigned = catalog.variantParents[key] ?? "";
  /** What the name-based heuristic would make of this creature on its own. */
  const detected = useMemo(() => {
    const hit = index.creatures.get(key);
    const base = variantParent(hit?.entry ?? entry, {
      parentPath: null,
      variantTag: hit?.source.variantTag,
    });
    return base?.bpPath ?? null;
  }, [index, key, entry]);

  const [role, setRole] = useState<"parent" | "child">(
    assigned ? "child" : "parent",
  );
  const [parentPath, setParentPath] = useState(assigned);
  const [picking, setPicking] = useState(false);

  const children = useMemo(
    () =>
      Object.entries(catalog.variantParents)
        .filter(([, parent]) => normalizeBpPath(parent) === key)
        .map(([child]) => child),
    [catalog.variantParents, key],
  );

  function save() {
    const variantParents = { ...catalog.variantParents };
    if (role === "child") {
      const chosen = parentPath.trim();
      if (!chosen) {
        toast.error("Pick the parent class first");
        return;
      }
      if (normalizeBpPath(chosen) === key) {
        toast.error("A creature cannot be its own parent");
        return;
      }
      variantParents[key] = chosen;
    } else {
      delete variantParents[key];
    }
    setCatalog({ ...catalog, variantParents });
    onClose();
    toast.success(
      role === "child"
        ? `${entry.name} grouped under ${displayNameFor(index, "creatures", parentPath)}`
        : `${entry.name} is now a parent class`,
    );
  }

  return (
    <Modal
      title={`Association - ${entry.name}`}
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-500">
            {children.length > 0 &&
              `${children.length} creature${children.length === 1 ? "" : "s"} name this one as their parent.`}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={role === "child" && !parentPath.trim()}
              onClick={save}
            >
              Save
            </Button>
          </div>
        </div>
      }
    >
      <p className="text-xs text-ink-400 mb-3">
        Dino Depot treats a child class as its parent, so a production rule on
        the parent already covers this creature. The catalog also groups
        variants under their parent instead of listing each one.
      </p>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <RoleCard
          selected={role === "parent"}
          onSelect={() => setRole("parent")}
          title="Parent class"
          blurb="Stands on its own. Other creatures may be grouped under it."
        />
        <RoleCard
          selected={role === "child"}
          onSelect={() => setRole("child")}
          title="Child class"
          blurb="A variant of another creature, which it inherits from."
        />
      </div>

      {role === "child" && (
        <div className="border border-ink-700 rounded-lg p-3 bg-ink-850">
          <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-2">
            Parent class
          </span>
          {parentPath ? (
            <div className="flex items-center gap-2 mb-2">
              <EntityIcon bpPath={parentPath} kind="creatures" size={36} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink-100 truncate">
                  {displayNameFor(index, "creatures", parentPath)}
                </div>
                <div className="mono text-xs text-ink-400 truncate" title={parentPath}>
                  {shortClassName(parentPath)}
                </div>
              </div>
              <Button variant="ghost" onClick={() => setParentPath("")}>
                Clear
              </Button>
            </div>
          ) : (
            <p className="text-xs text-ink-500 mb-2">
              No parent chosen yet.
              {detected && (
                <>
                  {" "}
                  Without one, the name-based grouping would put this under{" "}
                  <span className="text-ink-300">
                    {displayNameFor(index, "creatures", detected)}
                  </span>
                  .
                </>
              )}
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={() => setPicking(true)}>
              {parentPath ? "Change parent…" : "Pick parent…"}
            </Button>
            {detected && normalizeBpPath(detected) !== normalizeBpPath(parentPath) && (
              <Button
                variant="ghost"
                onClick={() => setParentPath(detected)}
                title="Use the parent the name-based grouping already found"
              >
                Use detected: {displayNameFor(index, "creatures", detected)}
              </Button>
            )}
          </div>
        </div>
      )}

      {role === "parent" && assigned && (
        <Badge tone="warn">
          Saving removes the assigned parent{" "}
          {displayNameFor(index, "creatures", assigned)}
        </Badge>
      )}

      {picking && (
        <BlueprintPicker
          kind="creatures"
          title={`Pick the parent creature for ${entry.name}`}
          onClose={() => setPicking(false)}
          onPick={(bpPath) => {
            setParentPath(bpPath);
            setPicking(false);
          }}
        />
      )}
    </Modal>
  );
}

function RoleCard({
  selected,
  onSelect,
  title,
  blurb,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  blurb: string;
}) {
  return (
    <button
      onClick={onSelect}
      className={cx(
        "text-left px-3 py-2.5 rounded-lg border cursor-pointer",
        selected
          ? "border-accent-500 bg-ink-800"
          : "border-ink-700 bg-ink-900 hover:border-ink-600",
      )}
    >
      <div className="text-sm font-medium text-ink-100">{title}</div>
      <div className="text-xs text-ink-400 mt-0.5">{blurb}</div>
    </button>
  );
}
