import { useMemo, useState } from "react";
import { useDraftsStore } from "../../stores/draftsStore";
import { normalizeBpPath, type CatalogEntry } from "../../model/catalog";
import { newId } from "../../model/ids";
import {
  ABILITY_EFFECT_HINTS,
  ABILITY_EFFECT_LABELS,
  ABILITY_EFFECTS,
  ABILITY_KIND_HINTS,
  ABILITY_KIND_LABELS,
  ABILITY_KINDS,
  ABILITY_PRESETS,
  abilityPresetFor,
  AbilityEffect,
  AbilityEffectRow,
  AbilityKind,
  AbilityPreset,
  effectShape,
  emptyAbilityEffectRow,
  AVAILABILITIES,
  Availability,
  AcquisitionMethod,
  CreatureInfo,
  DROP_LISTS,
  DropEntry,
  DropListKey,
  Drops,
  emptyCreatureInfo,
  emptyDropEntry,
  emptyMethod,
  hasDrops,
  pruneCreatureInfo,
  INFO_SECTIONS,
  InfoSection,
  inheritSection,
  overrideSection,
  resolveCreatureInfo,
  SECTION_LABELS,
  AVAILABILITY_HINTS,
  AVAILABILITY_LABELS,
  TAG_LABELS,
  methodLabel,
  methodStepCount,
} from "../../model/creatureInfo";
import { variantParent } from "../../model/creatureBase";
import { mapList, mapOf, mapStyle } from "../../model/maps";
import { useProjectStore } from "../../stores/projectStore";
import { MapOfOriginModal } from "./MapOfOriginModal";
import { BlueprintPicker } from "../../components/BlueprintPicker";
import { ReferenceInput } from "../../components/ReferenceText";
import { EntityIcon, IconValue } from "../../components/EntityIcon";
import { displayNameFor, useCatalogIndex } from "../../stores/useCatalogIndex";
import { shortClassName } from "../../services/spawnCommands";
import {
  Badge,
  Button,
  cx,
  Field,
  Input,
  Modal,
  Select,
} from "../../components/ui";
import { toast } from "../../components/toast";
import { confirmDialog } from "../../components/confirm";
import { MethodEditor } from "./MethodEditor";

/**
 * Creature details: acquisition workflows, abilities, technical facts and
 * notes, as four tabs over one record.
 *
 * A variant inherits each section from its parent creature until it explicitly
 * overrides it, so an Aberrant or modded child stores only what actually
 * differs rather than a duplicate of the whole thing.
 */
export function CreatureDetailsModal({
  entry,
  onClose,
}: {
  entry: CatalogEntry;
  onClose: () => void;
}) {
  const { catalog, setCatalog } = useDraftsStore();
  const settings = useProjectStore((s) => s.settings);
  const index = useCatalogIndex();
  const key = normalizeBpPath(entry.bpPath);

  /** The parent this creature inherits from, when it is a variant. */
  const parentPath = useMemo(() => {
    const manual = catalog.variantParents[key] ?? null;
    const hit = index.creatures.get(key);
    const base = variantParent(hit?.entry ?? { id: "", name: entry.name, bpPath: entry.bpPath }, {
      parentPath: manual,
      parentName: manual
        ? (index.creatures.get(normalizeBpPath(manual))?.entry.name ??
          shortClassName(manual))
        : undefined,
      variantTag: hit?.source.variantTag,
    });
    return base?.bpPath ?? null;
  }, [catalog.variantParents, index, key, entry]);

  const parentInfo = parentPath
    ? catalog.creatureInfo[normalizeBpPath(parentPath)]
    : undefined;

  const [draft, setDraft] = useState<CreatureInfo>(
    catalog.creatureInfo[key] ?? emptyCreatureInfo(),
  );
  const [tab, setTab] = useState<InfoSection>("acquisition");
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null);
  const [editingMap, setEditingMap] = useState(false);

  // Where the creature comes from is a fact about the creature, so it belongs
  // with the rest of its record. It is stored on the catalog rather than in
  // this draft, and saves on its own — hence a chip, not a form field.
  const originMap = mapOf(catalog, entry.bpPath);
  const originStyle = originMap ? mapStyle(settings, originMap) : null;

  const resolved = resolveCreatureInfo(draft, parentInfo, parentPath);
  const view = resolved.info;
  const inherits = (section: InfoSection) =>
    resolved.inheritedFrom !== null &&
    resolved.inheritedSections.includes(section);

  const parentName = parentPath
    ? displayNameFor(index, "creatures", parentPath)
    : "";

  /** Edits are only allowed on a section this creature owns. */
  function claim(section: InfoSection) {
    setDraft(overrideSection(draft, view, section));
  }

  function release(section: InfoSection) {
    setDraft(inheritSection(draft, section));
  }

  function save() {
    const creatureInfo = { ...catalog.creatureInfo };
    // Half-filled rows are a by-product of exploring the form, not content.
    const cleaned = pruneCreatureInfo(draft);
    const nothingOwned =
      cleaned.overrides.length === 0 &&
      !cleaned.availability &&
      cleaned.methods.length === 0 &&
      cleaned.spawnMaps.length === 0 &&
      cleaned.abilities.length === 0 &&
      !hasDrops(cleaned.drops) &&
      cleaned.technical.dragWeight === null &&
      !cleaned.notes.trim();
    if (nothingOwned) delete creatureInfo[key];
    else creatureInfo[key] = cleaned;
    setCatalog({ ...catalog, creatureInfo });
    onClose();
    toast.success(`Details saved for ${entry.name}`);
  }

  const methods = view.methods;
  const current =
    methods.find((m) => m.id === selectedMethod) ?? methods[0] ?? null;

  function updateMethod(next: AcquisitionMethod) {
    claim("acquisition");
    setDraft((d) => {
      const owned = d.overrides.includes("acquisition")
        ? d
        : overrideSection(d, view, "acquisition");
      return {
        ...owned,
        methods: owned.methods.map((m) => (m.id === next.id ? next : m)),
      };
    });
  }

  function addMethod() {
    const method = emptyMethod(newId());
    setDraft((d) => {
      const owned = d.overrides.includes("acquisition")
        ? d
        : overrideSection(d, view, "acquisition");
      return { ...owned, methods: [...owned.methods, method] };
    });
    setSelectedMethod(method.id);
  }

  async function removeMethod(method: AcquisitionMethod) {
    const ok = await confirmDialog({
      title: `Remove "${methodLabel(method)}"?`,
      message: "Its phases, steps and inputs go with it.",
      confirmLabel: "Remove method",
      danger: true,
    });
    if (!ok) return;
    setDraft((d) => {
      const owned = d.overrides.includes("acquisition")
        ? d
        : overrideSection(d, view, "acquisition");
      return {
        ...owned,
        methods: owned.methods.filter((m) => m.id !== method.id),
      };
    });
  }

  return (
    <Modal
      title={`Creature details — ${entry.name}`}
      onClose={onClose}
      xl
      // Pinned: a method with several phases makes this modal tall enough that
      // Save would otherwise sit far below the fold.
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-500">
            {resolved.inheritedSections.length > 0 && parentPath
              ? `Inheriting ${resolved.inheritedSections
                  .map((s) => SECTION_LABELS[s].toLowerCase())
                  .join(", ")} from ${parentName}`
              : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save}>
              Save details
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex items-center justify-between gap-3 mb-3 border-b border-ink-700">
        <div className="flex items-center gap-4">
          {INFO_SECTIONS.map((section) => (
            <button
              key={section}
              onClick={() => setTab(section)}
              className={cx(
                "cursor-pointer pb-2 border-b-2 text-sm flex items-center gap-1.5",
                tab === section
                  ? "text-white border-accent-500"
                  : "text-ink-400 border-transparent hover:text-ink-200",
              )}
            >
              {SECTION_LABELS[section]}
              {inherits(section) && (
                <span title={`Inherited from ${parentName}`}>↳</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 pb-2 shrink-0">
          <span className="flex items-center gap-1.5">
            {/* Labelled, because a bare map chip reads as a fact about the
                modal rather than as this creature's editable origin. */}
            <span className="text-xs font-semibold text-ink-400 uppercase tracking-wide">
              Origin
            </span>
            <button
              onClick={() => setEditingMap(true)}
              title="Set which map this creature comes from"
              className={cx(
                "flex items-center gap-1.5 text-xs rounded-full border px-2 py-0.5 cursor-pointer transition-colors",
                originMap
                  ? "border-ink-700 hover:border-accent-500/40"
                  : "border-dashed border-ink-700 text-ink-500 hover:text-accent-400 hover:border-accent-500/40",
              )}
              style={{ color: originStyle?.color || undefined }}
            >
              {originMap ? (
                <>
                  <IconValue
                    icon={originStyle?.icon ?? "🗺️"}
                    officialMap={originMap}
                    size={14}
                  />
                  <span>{originMap}</span>
                </>
              ) : (
                <span>🗺️ Set map…</span>
              )}
            </button>
          </span>
          {parentPath && (
            <span className="text-xs text-ink-400">
              Variant of <span className="text-ink-200">{parentName}</span>
            </span>
          )}
        </div>
      </div>

      {inherits(tab) && (
        <InheritanceBanner
          parentName={parentName}
          section={tab}
          onOverride={() => claim(tab)}
        />
      )}
      {parentPath && !inherits(tab) && (
        <div className="flex items-center justify-between gap-3 mb-3 px-3 py-2 rounded-md border border-ink-700 bg-ink-850">
          <span className="text-xs text-ink-300">
            This variant defines its own {SECTION_LABELS[tab].toLowerCase()}.
          </span>
          <Button
            variant="ghost"
            onClick={() => release(tab)}
            title={`Discard the override and follow ${parentName} again`}
          >
            Inherit from {parentName}
          </Button>
        </div>
      )}

      <fieldset
        disabled={inherits(tab)}
        className={cx(inherits(tab) && "opacity-60 pointer-events-none")}
      >
        {tab === "acquisition" && (
          <div>
            <div className="mb-3">
              <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1.5">
                Availability
              </span>
              <div className="flex gap-1.5">
                {AVAILABILITIES.map((availability) => (
                  <button
                    key={availability}
                    onClick={() => {
                      claim("acquisition");
                      setDraft((d) => {
                        const owned = d.overrides.includes("acquisition")
                          ? d
                          : overrideSection(d, view, "acquisition");
                        return {
                          ...owned,
                          availability:
                            owned.availability === availability
                              ? ""
                              : (availability as Availability),
                        };
                      });
                    }}
                    title={AVAILABILITY_HINTS[availability]}
                    className={cx(
                      "px-3 py-1.5 rounded-md border text-xs cursor-pointer",
                      view.availability === availability
                        ? "border-accent-500 bg-ink-800 text-white"
                        : "border-ink-700 text-ink-300 hover:border-ink-600",
                    )}
                  >
                    {AVAILABILITY_LABELS[availability]}
                  </button>
                ))}
                <span className="text-xs text-ink-500 self-center ml-2">
                  What each route leaves you with is set per method.
                </span>
              </div>
            </div>

            <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 items-start">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
                    Methods
                  </span>
                  <Button variant="ghost" onClick={addMethod}>
                    + Add
                  </Button>
                </div>
                {methods.length === 0 ? (
                  <p className="text-xs text-ink-500 border border-dashed border-ink-700 rounded-md px-3 py-2">
                    No methods yet. A creature can have several — add one per
                    valid route.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {methods.map((method) => (
                      <button
                        key={method.id}
                        onClick={() => setSelectedMethod(method.id)}
                        className={cx(
                          "text-left px-2.5 py-2 rounded-md border cursor-pointer",
                          method.id === current?.id
                            ? "bg-ink-800 border-accent-500/50"
                            : "bg-ink-900 border-ink-700 hover:border-ink-600",
                        )}
                      >
                        <div className="text-sm text-ink-100 truncate">
                          {methodLabel(method)}
                        </div>
                        <div className="text-[11px] text-ink-400 truncate">
                          {method.phases.length} phase
                          {method.phases.length === 1 ? "" : "s"} ·{" "}
                          {methodStepCount(method)} step
                          {methodStepCount(method) === 1 ? "" : "s"}
                        </div>
                        {method.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {method.tags.slice(0, 3).map((tag) => (
                              <span
                                key={tag}
                                className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-700/50 text-ink-300"
                              >
                                {TAG_LABELS[tag as never] ?? tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="min-w-0">
                {current ? (
                  <MethodEditor
                    method={current}
                    onChange={updateMethod}
                    onRemove={() => removeMethod(current)}
                  />
                ) : (
                  <p className="text-sm text-ink-400 px-3 py-8 text-center border border-dashed border-ink-700 rounded-md">
                    Add a method to describe how this creature is acquired.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === "spawns" && (
          <SpawnsTab
            spawnMaps={view.spawnMaps}
            onChange={(spawnMaps) => {
              claim("spawns");
              setDraft((d) => {
                const owned = d.overrides.includes("spawns")
                  ? d
                  : overrideSection(d, view, "spawns");
                return { ...owned, spawnMaps };
              });
            }}
          />
        )}

        {tab === "abilities" && (
          <AbilitiesTab
            abilities={view.abilities}
            onChange={(abilities) => {
              claim("abilities");
              setDraft((d) => {
                const owned = d.overrides.includes("abilities")
                  ? d
                  : overrideSection(d, view, "abilities");
                return { ...owned, abilities };
              });
            }}
          />
        )}

        {tab === "drops" && (
          <DropsTab
            drops={view.drops}
            onChange={(drops) => {
              claim("drops");
              setDraft((d) => {
                const owned = d.overrides.includes("drops")
                  ? d
                  : overrideSection(d, view, "drops");
                return { ...owned, drops };
              });
            }}
          />
        )}

        {tab === "technical" && (
          <div className="grid grid-cols-2 gap-3 max-w-lg">
            <Field
              label="Drag weight"
              hint="Decides what can carry it and which traps hold it"
            >
              <Input
                type="number"
                min="0"
                value={view.technical.dragWeight ?? ""}
                placeholder="unknown"
                onChange={(e) => {
                  const v = e.target.value.trim();
                  const n = Number(v);
                  const dragWeight =
                    !v || !Number.isFinite(n) || n < 0 ? null : n;
                  claim("technical");
                  setDraft((d) => {
                    const owned = d.overrides.includes("technical")
                      ? d
                      : overrideSection(d, view, "technical");
                    return { ...owned, technical: { ...owned.technical, dragWeight } };
                  });
                }}
              />
            </Field>
          </div>
        )}

        {tab === "notes" && (
          <div>
            <p className="text-xs text-ink-400 mb-2">
              General notes about the creature — anything that isn't part of a
              specific acquisition method. Published to the cluster viewer.
              Simple markdown: <span className="mono"># headers</span>,{" "}
              <span className="mono">**bold**</span>,{" "}
              <span className="mono">- lists</span>.
            </p>
            <ReferenceInput
              multiline
              rows={14}
              value={view.notes}
              onChange={(notes) => {
                claim("notes");
                setDraft((d) => {
                  const owned = d.overrides.includes("notes")
                    ? d
                    : overrideSection(d, view, "notes");
                  return { ...owned, notes };
                });
              }}
              placeholder={"Where it spawns, what it's used for on this cluster, quirks worth knowing."}
            />
          </div>
        )}
      </fieldset>

      {editingMap && (
        <MapOfOriginModal entry={entry} onClose={() => setEditingMap(false)} />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function InheritanceBanner({
  parentName,
  section,
  onOverride,
}: {
  parentName: string;
  section: InfoSection;
  onOverride: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3 px-3 py-2 rounded-md border border-dashed border-ink-600 bg-ink-850">
      <span className="text-xs text-ink-300">
        <Badge tone="info">Inherited</Badge>{" "}
        {SECTION_LABELS[section]} comes from{" "}
        <span className="text-ink-100">{parentName}</span>. Editing it here
        creates an override for this variant only.
      </span>
      <Button className="shrink-0" onClick={onOverride}>
        Override for this variant
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Which maps this creature actually spawns on.
 *
 * Deliberately separate from the catalog's map *of origin*: origin is derived
 * from the blueprint path and answers "where did this content come from",
 * which is a fact about the mod. This answers "where do I go to find one",
 * which is what a player is asking, and the two disagree constantly — a
 * Scorched Earth wyvern also spawns on Ragnarok.
 */
function SpawnsTab({
  spawnMaps,
  onChange,
}: {
  spawnMaps: string[];
  onChange: (next: string[]) => void;
}) {
  const settings = useProjectStore((s) => s.settings);
  const maps = mapList(settings);
  const [custom, setCustom] = useState("");

  const listed = (name: string) =>
    spawnMaps.some((m) => m.trim().toLowerCase() === name.trim().toLowerCase());

  function toggle(name: string) {
    onChange(
      listed(name)
        ? spawnMaps.filter(
            (m) => m.trim().toLowerCase() !== name.trim().toLowerCase(),
          )
        : [...spawnMaps, name],
    );
  }

  function addCustom() {
    const name = custom.trim();
    if (!name) return;
    if (listed(name)) {
      toast.error(`${name} is already listed`);
      return;
    }
    onChange([...spawnMaps, name]);
    setCustom("");
  }

  /** Listed maps that aren't in the Settings list — typed by hand, or renamed since. */
  const unknown = spawnMaps.filter(
    (m) => !maps.some((x) => x.name.toLowerCase() === m.trim().toLowerCase()),
  );

  return (
    <div>
      <p className="text-xs text-ink-400 mb-3">
        The maps this creature can actually be found on. This is separate from
        its map of origin — content first released on one map often spawns on
        later ones too. Published to the cluster viewer.
      </p>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {maps.map((map) => {
          const on = listed(map.name);
          return (
            <button
              key={map.name}
              onClick={() => toggle(map.name)}
              title={
                map.enabled
                  ? undefined
                  : `${map.name} is switched off for this cluster`
              }
              className={cx(
                "text-xs px-2 py-1 rounded-full border cursor-pointer inline-flex items-center gap-1",
                on
                  ? "bg-accent-500/15 text-accent-400 border-accent-500/40"
                  : "border-ink-700 text-ink-400 hover:text-ink-200 hover:border-ink-600",
                !map.enabled && "opacity-60",
              )}
            >
              <IconValue icon={map.icon} officialMap={map.name} size={13} />
              {map.name}
              {!map.enabled && <span className="text-amber-400">⚠</span>}
            </button>
          );
        })}
      </div>

      <div className="flex gap-2 max-w-md">
        <Input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCustom()}
          placeholder="A map not in Settings…"
        />
        <Button className="shrink-0" onClick={addCustom} disabled={!custom.trim()}>
          Add
        </Button>
      </div>

      {unknown.length > 0 && (
        <p className="text-xs text-amber-400 mt-3">
          Not in the Settings map list: {unknown.join(", ")}. They still
          publish — add them under Settings → Maps to give them an icon.
        </p>
      )}

      {spawnMaps.length === 0 && (
        <p className="text-xs text-ink-500 border border-dashed border-ink-700 rounded-md px-3 py-2 mt-3">
          No spawn maps recorded. The viewer falls back to the map of origin.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Harvest yields and special loot, as three separate lists.
 *
 * They are separate because a player asks about them separately: what do I get
 * for harvesting the body, what am I guaranteed for killing it, and what might
 * I get if I'm lucky. Merging them into one table with a "type" column would
 * read as one question with a confusing answer.
 */
function DropsTab({
  drops,
  onChange,
}: {
  drops: Drops;
  onChange: (next: Drops) => void;
}) {
  const index = useCatalogIndex();
  /** Which list a blueprint pick is for, plus the row when it's a re-pick. */
  const [picking, setPicking] = useState<{
    list: DropListKey;
    entryId?: string;
  } | null>(null);

  const setList = (key: DropListKey, entries: DropEntry[]) =>
    onChange({ ...drops, [key]: entries });

  const patch = (key: DropListKey, id: string, next: Partial<DropEntry>) =>
    setList(
      key,
      drops[key].map((d) => (d.id === id ? { ...d, ...next } : d)),
    );

  return (
    <div className="flex flex-col gap-4">
      {DROP_LISTS.map((list) => {
        const entries = drops[list.key];
        return (
          <div key={list.key}>
            <div className="flex items-center justify-between mb-1.5">
              <div>
                <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
                  {list.label}
                </span>
                <span className="text-xs text-ink-500 ml-2">{list.hint}</span>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  onClick={() => setPicking({ list: list.key })}
                >
                  + Item
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setList(list.key, [...entries, emptyDropEntry(newId())])
                  }
                  title="Something the item catalog doesn't cover"
                >
                  + Other
                </Button>
              </div>
            </div>

            {entries.length === 0 ? (
              <p className="text-xs text-ink-500 border border-dashed border-ink-700 rounded-md px-3 py-2">
                Nothing listed.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {entries.map((entry, i) => {
                  const known =
                    Boolean(entry.bpPath) &&
                    index.items.has(normalizeBpPath(entry.bpPath));
                  const name = entry.bpPath
                    ? displayNameFor(index, "items", entry.bpPath)
                    : "";
                  return (
                    <div
                      key={entry.id}
                      className="flex items-center gap-2 min-w-0 border border-ink-700 rounded-md px-2 py-1.5"
                    >
                      <span className="text-xs text-ink-500 w-4 shrink-0">
                        {i + 1}
                      </span>
                      {entry.bpPath ? (
                        <>
                          <EntityIcon
                            bpPath={entry.bpPath}
                            kind="items"
                            name={name}
                            size={22}
                          />
                          <span
                            className={cx(
                              "text-sm truncate w-44 shrink-0",
                              known ? "text-ink-100" : "text-amber-400",
                            )}
                            title={
                              known
                                ? entry.bpPath
                                : "Not in the item catalog — re-pick it"
                            }
                          >
                            {entry.label.trim() || name}
                            {!known && " ⚠"}
                          </span>
                        </>
                      ) : (
                        <Input
                          className="w-44 shrink-0 text-xs"
                          value={entry.label}
                          placeholder="What drops?"
                          onChange={(e) =>
                            patch(list.key, entry.id, { label: e.target.value })
                          }
                        />
                      )}
                      <Button
                        variant="ghost"
                        className="shrink-0 text-xs"
                        onClick={() =>
                          setPicking({ list: list.key, entryId: entry.id })
                        }
                        title={
                          entry.bpPath
                            ? "Choose a different item"
                            : "Point this at a catalog item"
                        }
                      >
                        {entry.bpPath ? "Replace…" : "Pick…"}
                      </Button>
                      {list.hasRate ? (
                        // A rate, not a quantity — production recurs.
                        <>
                          <Input
                            className="w-16 shrink-0 text-xs"
                            value={entry.rate}
                            placeholder="#"
                            title="How many are produced"
                            onChange={(e) =>
                              patch(list.key, entry.id, { rate: e.target.value })
                            }
                          />
                          <span className="text-ink-500 shrink-0 text-xs">/</span>
                          <Input
                            className="w-24 shrink-0 text-xs"
                            value={entry.per}
                            placeholder="5 min"
                            title="Over what period"
                            onChange={(e) =>
                              patch(list.key, entry.id, { per: e.target.value })
                            }
                          />
                        </>
                      ) : (
                        <Input
                          className="w-20 shrink-0 text-xs"
                          value={entry.qty}
                          placeholder="qty"
                          onChange={(e) =>
                            patch(list.key, entry.id, { qty: e.target.value })
                          }
                        />
                      )}
                      {list.hasChance && (
                        <Input
                          className="w-24 shrink-0 text-xs"
                          value={entry.chance}
                          placeholder="chance"
                          title="However you want to phrase the odds — 12%, 1 in 8"
                          onChange={(e) =>
                            patch(list.key, entry.id, { chance: e.target.value })
                          }
                        />
                      )}
                      <Input
                        className="flex-1 text-xs"
                        value={entry.note}
                        placeholder="note"
                        onChange={(e) =>
                          patch(list.key, entry.id, { note: e.target.value })
                        }
                      />
                      <Button
                        variant="ghost"
                        className="shrink-0"
                        onClick={() =>
                          setList(
                            list.key,
                            entries.filter((d) => d.id !== entry.id),
                          )
                        }
                        title="Remove"
                      >
                        ✕
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {picking && (
        <BlueprintPicker
          kind="items"
          title={`Pick an item — ${
            DROP_LISTS.find((l) => l.key === picking.list)?.label
          }`}
          onClose={() => setPicking(null)}
          onPick={(bpPath) => {
            const { list, entryId } = picking;
            setPicking(null);
            if (entryId) {
              patch(list, entryId, { bpPath });
            } else {
              setList(list, [...drops[list], emptyDropEntry(newId(), bpPath)]);
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The per-item table behind a structured passive.
 *
 * Weight reduction and preservation are one item and one percentage; a
 * conversion is two items and two rates, which is why it gets its own row
 * shape rather than being squeezed into the same columns.
 */
function AbilityEffectRows({
  ability,
  onChange,
}: {
  ability: CreatureInfo["abilities"][number];
  onChange: (rows: AbilityEffectRow[]) => void;
}) {
  const index = useCatalogIndex();
  const shape = effectShape(ability.effect);
  /** Which row and which side of it a blueprint pick is for. */
  const [picking, setPicking] = useState<{
    rowId: string;
    side: "from" | "to";
  } | null>(null);

  const patch = (id: string, next: Partial<AbilityEffectRow>) =>
    onChange(ability.rows.map((r) => (r.id === id ? { ...r, ...next } : r)));

  /**
   * One item slot. Catalog-only: these tables are per-item lookups, and a
   * typed name that resolves to nothing would give the viewer no icon and no
   * link, so the picker is the only way in.
   */
  function ItemSlot({
    row,
    side,
  }: {
    row: AbilityEffectRow;
    side: "from" | "to";
  }) {
    const bpPath = side === "from" ? row.bpPath : row.toBpPath;
    const label = side === "from" ? row.label : row.toLabel;
    const known = Boolean(bpPath) && index.items.has(normalizeBpPath(bpPath));
    const name = bpPath ? displayNameFor(index, "items", bpPath) : "";
    return (
      <>
        {bpPath && (
          <>
            <EntityIcon bpPath={bpPath} kind="items" name={name} size={20} />
            <span
              className={cx(
                "text-xs truncate w-32 shrink-0",
                known ? "text-ink-100" : "text-amber-400",
              )}
              title={known ? bpPath : "Not in the item catalog — re-pick it"}
            >
              {label.trim() || name}
              {!known && " ⚠"}
            </span>
          </>
        )}
        <Button
          variant="ghost"
          className={cx("shrink-0 text-xs", !bpPath && "text-amber-400")}
          onClick={() => setPicking({ rowId: row.id, side })}
          title={bpPath ? "Choose a different item" : "Point this at a catalog item"}
        >
          {bpPath ? "Replace…" : side === "to" ? "Pick output…" : "Pick item…"}
        </Button>
      </>
    );
  }

  return (
    <div className="ml-6 mt-1.5 mb-2 border-l-2 border-ink-700 pl-3 flex flex-col gap-1.5">
      {ability.rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2 min-w-0">
          <ItemSlot row={row} side="from" />

          {shape.hasPercent && (
            <Input
              className="w-28 shrink-0 text-xs"
              value={row.percent}
              placeholder={shape.percentLabel}
              title={shape.percentLabel}
              onChange={(e) => patch(row.id, { percent: e.target.value })}
            />
          )}

          {shape.hasConversion && (
            <>
              <Input
                className="w-16 shrink-0 text-xs"
                value={row.rate}
                placeholder="qty"
                title="How much goes in"
                onChange={(e) => patch(row.id, { rate: e.target.value })}
              />
              <span className="text-ink-500 shrink-0 text-xs">→</span>
              <ItemSlot row={row} side="to" />
              <Input
                className="w-16 shrink-0 text-xs"
                value={row.toRate}
                placeholder="qty"
                title="How much comes out"
                onChange={(e) => patch(row.id, { toRate: e.target.value })}
              />
            </>
          )}

          <Input
            className="flex-1 text-xs"
            value={row.note}
            placeholder="note"
            onChange={(e) => patch(row.id, { note: e.target.value })}
          />
          <Button
            variant="ghost"
            className="shrink-0"
            onClick={() => onChange(ability.rows.filter((r) => r.id !== row.id))}
            title="Remove"
          >
            ✕
          </Button>
        </div>
      ))}

      <div>
        <Button
          variant="ghost"
          className="text-xs"
          onClick={() => onChange([...ability.rows, emptyAbilityEffectRow(newId())])}
        >
          + Add item
        </Button>
      </div>

      {picking && (
        <BlueprintPicker
          kind="items"
          title={
            picking.side === "to" ? "Pick the item produced" : "Pick the item affected"
          }
          onClose={() => setPicking(null)}
          onPick={(bpPath) => {
            const { rowId, side } = picking;
            setPicking(null);
            patch(rowId, side === "from" ? { bpPath } : { toBpPath: bpPath });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AbilitiesTab({
  abilities,
  onChange,
}: {
  abilities: CreatureInfo["abilities"];
  onChange: (next: CreatureInfo["abilities"]) => void;
}) {
  const [custom, setCustom] = useState("");
  const [customKind, setCustomKind] = useState<AbilityKind>("passive");

  /**
   * Labels are compared case-insensitively throughout — the preset chips and
   * the custom field have to agree on what counts as the same ability, or
   * "Grappling" and "grappling" both end up in the list.
   */
  const fold = (label: string) => label.trim().toLowerCase();

  function toggle(preset: AbilityPreset) {
    const existing = abilities.find((a) => fold(a.label) === fold(preset.label));
    onChange(
      existing
        ? abilities.filter((a) => a.id !== existing.id)
        : [
            ...abilities,
            {
              id: newId(),
              label: preset.label,
              detail: "",
              kind: preset.kind,
              effect: preset.effect ?? "none",
              // A structured effect starts with one empty row, so the table it
              // implies is visible rather than something to go looking for.
              rows:
                preset.effect && preset.effect !== "none"
                  ? [emptyAbilityEffectRow(newId())]
                  : [],
            },
          ],
    );
  }

  function addCustom() {
    const label = custom.trim();
    if (!label) return;
    if (abilities.some((a) => fold(a.label) === fold(label))) {
      toast.error(`"${label}" is already listed`);
      return;
    }
    // A typed label that names a preset inherits the preset's kind, so the
    // two routes to the same ability never disagree about what it is.
    const preset = abilityPresetFor(label);
    const effect = preset?.effect ?? "none";
    onChange([
      ...abilities,
      {
        id: newId(),
        label,
        detail: "",
        kind: preset?.kind ?? customKind,
        effect,
        rows: effect === "none" ? [] : [emptyAbilityEffectRow(newId())],
      },
    ]);
    setCustom("");
  }

  /** Labels that now collide after a rename, so the rows can say so. */
  const duplicated = new Set(
    abilities
      .map((a) => fold(a.label))
      .filter((label, i, all) => label && all.indexOf(label) !== i),
  );

  const patch = (id: string, next: Partial<CreatureInfo["abilities"][number]>) =>
    onChange(abilities.map((a) => (a.id === id ? { ...a, ...next } : a)));

  return (
    <div>
      {/* Presets grouped by kind, so picking one also answers "which sort is
          this" without the admin having to decide afterwards. */}
      {ABILITY_KINDS.map((kind) => (
        <div key={kind} className="mb-3">
          <span
            className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1.5"
            title={ABILITY_KIND_HINTS[kind]}
          >
            {ABILITY_KIND_LABELS[kind]}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {ABILITY_PRESETS.filter((p) => p.kind === kind).map((preset) => {
              const on = abilities.some((a) => fold(a.label) === fold(preset.label));
              return (
                <button
                  key={preset.label}
                  onClick={() => toggle(preset)}
                  className={cx(
                    "text-xs px-2 py-1 rounded-full border cursor-pointer",
                    on
                      ? "bg-accent-500/15 text-accent-400 border-accent-500/40"
                      : "border-ink-700 text-ink-400 hover:text-ink-200 hover:border-ink-600",
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex gap-2 mb-4 max-w-xl">
        <Input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCustom()}
          placeholder="Something else…"
        />
        <div className="w-32 shrink-0">
          <Select
            value={customKind}
            onChange={(e) => setCustomKind(e.target.value as AbilityKind)}
            title={ABILITY_KIND_HINTS[customKind]}
          >
            {ABILITY_KINDS.map((k) => (
              <option key={k} value={k}>
                {ABILITY_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
        <Button className="shrink-0" onClick={addCustom} disabled={!custom.trim()}>
          Add
        </Button>
      </div>

      {abilities.length === 0 ? (
        <p className="text-xs text-ink-500 border border-dashed border-ink-700 rounded-md px-3 py-2">
          Nothing listed yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {ABILITY_KINDS.map((kind) => {
            const listed = abilities.filter((a) => a.kind === kind);
            if (listed.length === 0) return null;
            return (
              <div key={kind}>
                <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1.5">
                  {ABILITY_KIND_LABELS[kind]} ({listed.length})
                </span>
                <div className="flex flex-col gap-1.5">
                  {listed.map((ability) => (
                    <div key={ability.id}>
                    <div
                      className="flex items-center gap-2 min-w-0"
                    >
                      {/* Editable: a label chosen from a preset or typed in
                          haste should be fixable without losing its detail. */}
                      <Input
                        className={cx(
                          "w-44 shrink-0 text-sm",
                          (!ability.label.trim() ||
                            duplicated.has(fold(ability.label))) &&
                            "border-amber-flag/60",
                        )}
                        value={ability.label}
                        placeholder="Ability name"
                        title={
                          duplicated.has(fold(ability.label))
                            ? "Another ability already uses this name"
                            : undefined
                        }
                        onChange={(e) => patch(ability.id, { label: e.target.value })}
                      />
                      <div className="w-28 shrink-0">
                        <Select
                          value={ability.kind}
                          title={ABILITY_KIND_HINTS[ability.kind]}
                          onChange={(e) =>
                            patch(ability.id, {
                              kind: e.target.value as AbilityKind,
                            })
                          }
                        >
                          {ABILITY_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {ABILITY_KIND_LABELS[k]}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="w-36 shrink-0">
                        <Select
                          value={ability.effect}
                          title={ABILITY_EFFECT_HINTS[ability.effect]}
                          onChange={(e) => {
                            const effect = e.target.value as AbilityEffect;
                            patch(ability.id, {
                              effect,
                              // Switching away from a table discards its rows;
                              // switching into one starts it off visible.
                              rows:
                                effect === "none"
                                  ? []
                                  : ability.rows.length > 0
                                    ? ability.rows
                                    : [emptyAbilityEffectRow(newId())],
                            });
                          }}
                        >
                          {ABILITY_EFFECTS.map((fx) => (
                            <option key={fx} value={fx}>
                              {ABILITY_EFFECT_LABELS[fx]}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <Input
                        className="flex-1 text-xs"
                        value={ability.detail}
                        placeholder="Specifics — amount, target, caveat"
                        onChange={(e) => patch(ability.id, { detail: e.target.value })}
                      />
                      <Button
                        variant="ghost"
                        className="shrink-0"
                        onClick={() =>
                          onChange(abilities.filter((a) => a.id !== ability.id))
                        }
                        title="Remove"
                      >
                        ✕
                      </Button>
                    </div>
                    {ability.effect !== "none" && (
                      <AbilityEffectRows
                        ability={ability}
                        onChange={(rows) => patch(ability.id, { rows })}
                      />
                    )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
