import { useMemo, useState } from "react";
import { Badge, Button, Input, Modal, Toggle, cx } from "./ui";
import { useAllSources } from "../stores/useCatalogIndex";
import { officialVariantParents } from "../model/officialCatalog";
import { useDraftsStore } from "../stores/draftsStore";
import { EntityIcon } from "./EntityIcon";
import { buildPickerRows } from "../model/pickerResults";
import { plural } from "../model/text";
import { shortClassName } from "../services/spawnCommands";

/**
 * Modal picker for creature/item blueprint paths from the catalog, with a
 * raw-path escape hatch for paths not in any content source.
 *
 * `variantToggle` opts a caller into the parent-first creature list: variants
 * collapse onto the creature they belong to until the admin asks for them.
 * Off by default, so every existing picker behaves exactly as before.
 */
export function BlueprintPicker({
  kind,
  title,
  variantToggle = false,
  onPick,
  onClose,
}: {
  kind: "creatures" | "items";
  title: string;
  /** Offer "Show variants" and start with variants collapsed. */
  variantToggle?: boolean;
  onPick: (bpPath: string) => void;
  onClose: () => void;
}) {
  const sources = useAllSources();
  const projectVariantParents = useDraftsStore((s) => s.catalog.variantParents);
  // Bundled links first, the project's own on top: an administrator who set a
  // parent by hand has said something the dataset cannot know.
  const variantParents = useMemo(
    () => ({ ...officialVariantParents, ...projectVariantParents }),
    [projectVariantParents],
  );
  const [search, setSearch] = useState("");
  const [rawPath, setRawPath] = useState("");
  // Off on open: the parent is what a production rule almost always wants.
  const [showVariants, setShowVariants] = useState(false);

  // Items collapse too now: a fertilized egg is a variant of its egg, and
  // showing both side by side doubles the egg rows in every search.
  const collapsing = Boolean(variantToggle) && !showVariants;

  const results = useMemo(
    () =>
      buildPickerRows({
        sources,
        kind,
        search,
        collapseVariants: collapsing,
        variantParents,
      }),
    [sources, kind, search, collapsing, variantParents],
  );

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="flex items-center gap-3 mb-3">
        <Input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${kind} by name or path…`}
        />
        {variantToggle && kind === "creatures" && (
          <span className="shrink-0">
            <Toggle
              checked={showVariants}
              onChange={setShowVariants}
              label="Show variants"
            />
          </span>
        )}
      </div>
      {collapsing && (
        <p className="text-xs text-ink-400 mb-2">
          Showing one entry per creature — a rule on the parent already covers
          its variants. Turn on "Show variants" to give one its own production.
        </p>
      )}
      <div className="max-h-[380px] overflow-y-auto flex flex-col divide-y divide-ink-800 mb-4">
        {results.map(({ entry, source, hiddenVariants, matchedVia }) => (
          <button
            key={`${source.id}-${entry.id}`}
            onClick={() => onPick(entry.bpPath)}
            className="text-left py-1.5 px-2 hover:bg-ink-800 rounded cursor-pointer group"
          >
            {/* Name and variant count read as one phrase on the left; where
                the entry came from is a property of the row, so it sits at
                the far edge and lines up down the list instead of pushing the
                name around as source names change length. */}
            <div className="flex items-center gap-2">
              <EntityIcon bpPath={entry.bpPath} kind={kind} />
              <span className="text-sm text-ink-100 truncate">
                {entry.name}
              </span>
              {hiddenVariants > 0 && (
                <span className="text-xs text-ink-400 shrink-0">
                  (+{plural(hiddenVariants, "variant")})
                </span>
              )}
              <span className="flex-1" />
              <Badge
                tone={
                  source.kind === "official"
                    ? "info"
                    : source.removed
                      ? "error"
                      : source.enabled
                        ? "neutral"
                        : "warn"
                }
              >
                {source.name}
              </Badge>
            </div>
            {matchedVia.length > 0 && (
              <div className="text-xs text-accent-400">
                matched {matchedVia.join(", ")}
              </div>
            )}
            {/* The class, not the whole path: display names repeat across
                mods and the class is what actually distinguishes two rows,
                while the full path is four times the width and is only ever
                read when something looks wrong. It stays one hover away. */}
            <div
              className="mono text-xs text-ink-500 truncate"
              title={entry.bpPath}
            >
              {shortClassName(entry.bpPath)}
            </div>
          </button>
        ))}
        {results.length === 0 && (
          <p className="text-sm text-ink-400 py-6 text-center">
            No catalog matches — use a raw path below or add the content to a
            source first.
          </p>
        )}
      </div>

      <div
        className={cx(
          "border-t border-ink-700 pt-3 flex gap-2 items-end",
        )}
      >
        <div className="flex-1">
          <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1">
            Raw blueprint path
          </span>
          <Input
            className="mono"
            value={rawPath}
            onChange={(e) => setRawPath(e.target.value)}
            placeholder="/Game/…/Thing.Thing"
          />
        </div>
        <Button
          variant="primary"
          disabled={!rawPath.trim()}
          onClick={() => onPick(rawPath.trim())}
        >
          Use raw path
        </Button>
      </div>
    </Modal>
  );
}
