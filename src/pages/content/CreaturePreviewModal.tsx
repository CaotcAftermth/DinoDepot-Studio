import { useMemo, useState } from "react";
import { useDraftsStore } from "../../stores/draftsStore";
import { useProjectStore } from "../../stores/projectStore";
import { normalizeBpPath, type CatalogEntry } from "../../model/catalog";
import {
  ABILITY_EFFECT_LABELS,
  ABILITY_KIND_HINTS,
  ABILITY_KIND_LABELS,
  ABILITY_KINDS,
  AVAILABILITY_LABELS,
  DROP_LISTS,
  dropCount,
  effectShape,
  formatRate,
  hasCreatureInfo,
  INFO_SECTIONS,
  InfoSection,
  methodLabel,
  resolveCreatureInfo,
  OUTCOME_LABELS,
  ROLE_LABELS,
  SECTION_LABELS,
  TAG_LABELS,
  type AcquisitionMethod,
  type CreatureAbility,
  type InputRole,
  type MethodOutcome,
} from "../../model/creatureInfo";
import { variantParent } from "../../model/creatureBase";
import { mapIsDisabled, mapOf, mapStyle } from "../../model/maps";
import { shortClassName } from "../../services/spawnCommands";
import { displayNameFor, useCatalogIndex } from "../../stores/useCatalogIndex";
import { EntityIcon, IconValue } from "../../components/EntityIcon";
import { MarkdownText, ReferenceText } from "../../components/ReferenceText";
import { Badge, Button, cx, Modal } from "../../components/ui";

/**
 * A read-only wrap-up of everything recorded for one creature.
 *
 * Tabbed rather than one long scroll: the record has six sections, and an
 * ability that is itself a per-item table ends up four levels deep if every
 * section shares one column. Giving each section the full width costs a click
 * and buys back a readable shape — which is the whole point of a preview.
 */
export function CreaturePreviewModal({
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
  const index = useCatalogIndex();
  const key = normalizeBpPath(entry.bpPath);

  const parentPath = useMemo(() => {
    const manual = catalog.variantParents[key] ?? null;
    const hit = index.creatures.get(key);
    const base = variantParent(
      hit?.entry ?? { id: "", name: entry.name, bpPath: entry.bpPath },
      {
        parentPath: manual,
        parentName: manual
          ? (index.creatures.get(normalizeBpPath(manual))?.entry.name ??
            shortClassName(manual))
          : undefined,
        variantTag: hit?.source.variantTag,
      },
    );
    return base?.bpPath ?? null;
  }, [catalog.variantParents, index, key, entry]);

  const resolved = useMemo(
    () =>
      resolveCreatureInfo(
        catalog.creatureInfo[key],
        parentPath
          ? catalog.creatureInfo[normalizeBpPath(parentPath)]
          : undefined,
        parentPath,
      ),
    [catalog.creatureInfo, key, parentPath],
  );
  const info = resolved.info;
  const parentName = parentPath
    ? displayNameFor(index, "creatures", parentPath)
    : "";
  const inherits = (section: InfoSection) =>
    resolved.inheritedFrom !== null &&
    resolved.inheritedSections.includes(section);

  const origin = mapOf(catalog, entry.bpPath);
  const originStyle = origin ? mapStyle(settings, origin) : null;
  const entryNote = catalog.notes[key] ?? "";

  /** How much each section has to show — drives the tab bar and its counts. */
  const counts: Record<InfoSection, number> = {
    // Availability is acquisition content in its own right — a creature marked
    // Unavailable with no methods has been described, not left blank.
    acquisition: info.methods.length + (info.availability ? 1 : 0),
    spawns: info.spawnMaps.length,
    abilities: info.abilities.length,
    drops: dropCount(info.drops),
    technical: info.technical.dragWeight === null ? 0 : 1,
    notes: info.notes.trim() || entryNote.trim() ? 1 : 0,
  };
  // Only sections with something in them are worth a tab.
  const tabs = INFO_SECTIONS.filter((s) => counts[s] > 0);
  const [tab, setTab] = useState<InfoSection | null>(tabs[0] ?? null);
  const active = tab && counts[tab] > 0 ? tab : (tabs[0] ?? null);

  const empty = !hasCreatureInfo(info) && !entryNote.trim();

  const itemName = (bpPath: string, label: string) =>
    label.trim() ||
    (bpPath ? displayNameFor(index, "items", bpPath) : "") ||
    "(unnamed)";

  return (
    <Modal
      title={`Preview — ${entry.name}`}
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-500">
            {resolved.inheritedSections.length > 0 && parentPath
              ? `Inheriting ${resolved.inheritedSections
                  .map((s) => SECTION_LABELS[s].toLowerCase())
                  .join(", ")} from ${parentName}`
              : "Everything here is recorded on this creature."}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" onClick={onEdit}>
              Edit details…
            </Button>
          </div>
        </div>
      }
    >
      {/* ---- identity ---- */}
      <div className="flex items-start gap-4 pb-4 border-b border-ink-700">
        <EntityIcon
          bpPath={entry.bpPath}
          kind="creatures"
          name={entry.name}
          size={72}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-white truncate">
              {entry.name}
            </h3>
            {info.availability && (
              <Badge tone={info.availability === "acquirable" ? "ok" : "neutral"}>
                {AVAILABILITY_LABELS[info.availability]}
              </Badge>
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
            {parentPath && (
              <span className="text-xs text-ink-400">
                Variant of <span className="text-ink-200">{parentName}</span>
              </span>
            )}
            {info.technical.dragWeight !== null && (
              <span className="text-xs text-ink-400">
                Drag weight{" "}
                <span className="text-ink-200">{info.technical.dragWeight}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {empty || active === null ? (
        <p className="text-sm text-ink-400 border border-dashed border-ink-700 rounded-md px-3 py-6 text-center mt-4">
          Nothing recorded for {entry.name} yet.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-4 border-b border-ink-700 mt-3 mb-3 flex-wrap">
            {tabs.map((section) => (
              <button
                key={section}
                onClick={() => setTab(section)}
                className={cx(
                  "cursor-pointer pb-2 border-b-2 text-sm flex items-center gap-1.5",
                  active === section
                    ? "text-white border-accent-500"
                    : "text-ink-400 border-transparent hover:text-ink-200",
                )}
              >
                {SECTION_LABELS[section]}
                <span className="text-xs text-ink-500">{counts[section]}</span>
                {inherits(section) && (
                  <span title={`Inherited from ${parentName}`}>↳</span>
                )}
              </button>
            ))}
          </div>

          {inherits(active) && (
            <p className="text-xs text-ink-500 mb-2">
              <Badge tone="info">Inherited</Badge> This comes from{" "}
              <span className="text-ink-300">{parentName}</span>, not from{" "}
              {entry.name}.
            </p>
          )}

          {active === "acquisition" && (
            <div className="flex flex-col gap-3">
              {info.availability && (
                <div className="text-sm text-ink-300">
                  <span className="text-ink-500">Availability: </span>
                  <span className="text-ink-100">
                    {AVAILABILITY_LABELS[info.availability]}
                  </span>
                  {info.methods.length === 0 && (
                    <span className="text-ink-500">
                      {" "}
                      — no routes recorded yet.
                    </span>
                  )}
                </div>
              )}
              {info.methods.map((method) => (
                <MethodCard
                  key={method.id}
                  method={method}
                  resolveInput={(bpPath, kind) =>
                    displayNameFor(index, kind, bpPath)
                  }
                />
              ))}
            </div>
          )}

          {active === "spawns" && (
            <div className="flex flex-wrap gap-1.5">
              {info.spawnMaps.map((map) => {
                const style = mapStyle(settings, map);
                const off = mapIsDisabled(settings, map);
                return (
                  <span
                    key={map}
                    className={cx(
                      "text-xs px-2 py-1 rounded-full border inline-flex items-center gap-1",
                      off
                        ? "border-amber-flag/40 text-amber-400"
                        : "border-ink-700 text-ink-200",
                    )}
                    title={off ? "This cluster does not run this map" : undefined}
                  >
                    <IconValue icon={style.icon} officialMap={map} size={13} />
                    {map}
                    {off && " ⚠"}
                  </span>
                );
              })}
            </div>
          )}

          {active === "abilities" && (
            <div className="flex flex-col gap-4">
              {ABILITY_KINDS.map((kind) => {
                const listed = info.abilities.filter((a) => a.kind === kind);
                if (listed.length === 0) return null;
                return (
                  <div key={kind}>
                    <h4
                      className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1.5"
                      title={ABILITY_KIND_HINTS[kind]}
                    >
                      {ABILITY_KIND_LABELS[kind]}
                    </h4>
                    <div className="flex flex-col gap-1.5">
                      {listed.map((ability) => (
                        <AbilityCard
                          key={ability.id}
                          ability={ability}
                          itemName={itemName}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {active === "drops" && (
            <div className="flex flex-col gap-4">
              {DROP_LISTS.map((list) => {
                const entries = info.drops[list.key];
                if (entries.length === 0) return null;
                return (
                  <div key={list.key}>
                    <h4 className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1.5">
                      {list.label}
                    </h4>
                    <div className="flex flex-col gap-1">
                      {entries.map((drop) => (
                        <div
                          key={drop.id}
                          className="flex items-center gap-2 text-sm min-w-0 border border-ink-700 rounded-md px-2.5 py-1.5"
                        >
                          <ItemChip
                            bpPath={drop.bpPath}
                            name={itemName(drop.bpPath, drop.label)}
                          />
                          {!list.hasRate && drop.qty.trim() && (
                            <span className="text-xs text-accent-400 shrink-0">
                              ×{drop.qty}
                            </span>
                          )}
                          {list.hasRate && formatRate(drop) && (
                            <span className="text-xs text-sky-400 shrink-0">
                              {formatRate(drop)}
                            </span>
                          )}
                          {list.hasChance && drop.chance.trim() && (
                            <span className="text-xs text-violet-400 shrink-0">
                              {drop.chance}
                            </span>
                          )}
                          {drop.note.trim() && (
                            <span className="text-xs text-ink-500 truncate">
                              {drop.note}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {active === "technical" && (
            <div className="text-sm text-ink-200">
              Drag weight{" "}
              <span className="text-white font-medium">
                {info.technical.dragWeight}
              </span>
            </div>
          )}

          {active === "notes" && (
            <div className="flex flex-col gap-3">
              {info.notes.trim() && (
                <MarkdownText
                  className="text-sm text-ink-300"
                  text={info.notes}
                />
              )}
              {/* Entry notes live on the catalog rather than the info record,
                  so they are not one of the inheritable sections. */}
              {entryNote.trim() && (
                <div>
                  <h4 className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1">
                    Entry note
                  </h4>
                  <MarkdownText
                    className="text-sm text-ink-300"
                    text={entryNote}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function ItemChip({ bpPath, name }: { bpPath: string; name: string }) {
  return (
    <span className="flex items-center gap-2 min-w-0">
      {bpPath ? (
        <EntityIcon bpPath={bpPath} kind="items" name={name} size={20} />
      ) : (
        <span className="w-5 text-center shrink-0">📦</span>
      )}
      <span className="text-ink-100 truncate">{name}</span>
    </span>
  );
}

/**
 * One acquisition route, in full.
 *
 * The phases and their steps are the point of the record — a count of them
 * tells a reader nothing they can act on — so they are always expanded here.
 */
function MethodCard({
  method,
  resolveInput,
}: {
  method: AcquisitionMethod;
  resolveInput: (bpPath: string, kind: "creatures" | "items") => string;
}) {
  const field = (label: string, value: string) =>
    value.trim() ? (
      <div className="text-xs">
        <span className="text-ink-500">{label}: </span>
        <ReferenceText className="text-ink-200" text={value} />
      </div>
    ) : null;

  return (
    <div className="border border-ink-700 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 bg-ink-850 border-b border-ink-700">
        <span className="text-sm text-white font-medium">
          {methodLabel(method)}
        </span>
        {method.outcome && (
          <Badge tone="ok">
            {OUTCOME_LABELS[method.outcome as MethodOutcome]}
          </Badge>
        )}
        {method.tags.map((tag) => (
          <span
            key={tag}
            className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-700/50 text-ink-300"
          >
            {TAG_LABELS[tag as never] ?? tag}
          </span>
        ))}
      </div>

      <div className="p-3 flex flex-col gap-2.5">
        {field("Needs", method.requirements)}

        {method.inputs.length > 0 && (
          <div>
            <div className="text-xs text-ink-500 mb-1">Inputs</div>
            <div className="flex flex-wrap gap-1.5">
              {method.inputs.map((input) => {
                const kind =
                  input.referenceType === "creature" ? "creatures" : "items";
                const name =
                  input.label.trim() ||
                  (input.bpPath ? resolveInput(input.bpPath, kind) : "") ||
                  "(unnamed)";
                return (
                  <span
                    key={input.id}
                    className="inline-flex items-center gap-1.5 text-xs border border-ink-700 rounded-full pl-1 pr-2.5 py-0.5"
                    title={input.note || undefined}
                  >
                    {input.bpPath ? (
                      <EntityIcon
                        bpPath={input.bpPath}
                        kind={kind}
                        name={name}
                        size={18}
                      />
                    ) : (
                      <span className="w-4 text-center">•</span>
                    )}
                    <span className="text-ink-100">{name}</span>
                    <span className="text-ink-500">
                      {ROLE_LABELS[input.role as InputRole] ?? input.role}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {method.phases.length > 0 && (
          <div className="flex flex-col gap-2">
            {method.phases.map((phase, pi) => (
              <div key={phase.id} className="border-l-2 border-accent-500/40 pl-3">
                <div className="text-sm text-ink-100">
                  <span className="text-ink-500 mr-1.5">{pi + 1}.</span>
                  {phase.name.trim() || "Untitled phase"}
                </div>
                {phase.steps.length > 0 && (
                  <ol className="list-decimal ml-5 mt-1 text-sm text-ink-300 flex flex-col gap-0.5">
                    {phase.steps.map((step) => (
                      <li key={step.id}>
                        <ReferenceText text={step.text} />
                      </li>
                    ))}
                  </ol>
                )}
                <div className="mt-1 flex flex-col gap-0.5">
                  {field("Note", phase.note)}
                  {field("Repeat until", phase.repeatUntil)}
                  {field("Completed when", phase.completedWhen)}
                  {field("Failure / reset", phase.failureOrReset)}
                  {field("Then", phase.transitionNote)}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-0.5">
          {field("Repeat until", method.repeatUntil)}
          {field("Completion", method.completion)}
          {field("Failure / reset", method.failure)}
          {field("Effectiveness", method.effectiveness)}
        </div>

        {method.strategy.trim() && (
          <div>
            <div className="text-xs text-ink-500 mb-0.5">Strategy</div>
            <ReferenceText
              className="text-sm text-ink-300 whitespace-pre-wrap"
              text={method.strategy}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One ability. A structured passive gets a labelled table rather than another
 * level of indentation, so "Preserver" and its item rows read as one thing.
 */
function AbilityCard({
  ability,
  itemName,
}: {
  ability: CreatureAbility;
  itemName: (bpPath: string, label: string) => string;
}) {
  const shape = effectShape(ability.effect);
  const structured = ability.effect !== "none" && ability.rows.length > 0;

  return (
    <div
      className={cx(
        "text-sm",
        structured && "border border-ink-700 rounded-md overflow-hidden",
      )}
    >
      <div
        className={cx(
          "flex items-center gap-2 flex-wrap",
          structured && "px-2.5 py-1.5 bg-ink-850 border-b border-ink-700",
        )}
      >
        <span className="text-ink-100">{ability.label}</span>
        {ability.effect !== "none" && (
          <Badge tone="neutral">{ABILITY_EFFECT_LABELS[ability.effect]}</Badge>
        )}
        {ability.detail.trim() && (
          <span className="text-xs text-ink-400">{ability.detail}</span>
        )}
      </div>

      {structured && (
        <div className="divide-y divide-ink-800">
          {ability.rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-2 px-2.5 py-1.5 min-w-0"
            >
              <ItemChip
                bpPath={row.bpPath}
                name={itemName(row.bpPath, row.label)}
              />
              {shape.hasConversion && (
                <>
                  {row.rate.trim() && (
                    <span className="text-xs text-accent-400 shrink-0">
                      ×{row.rate}
                    </span>
                  )}
                  <span className="text-ink-500 shrink-0">→</span>
                  <ItemChip
                    bpPath={row.toBpPath}
                    name={itemName(row.toBpPath, row.toLabel)}
                  />
                  {row.toRate.trim() && (
                    <span className="text-xs text-accent-400 shrink-0">
                      ×{row.toRate}
                    </span>
                  )}
                </>
              )}
              {shape.hasPercent && row.percent.trim() && (
                <span className="text-xs text-amber-400 shrink-0 ml-auto">
                  {shape.percentLabel} {row.percent}
                </span>
              )}
              {row.note.trim() && (
                <span className="text-xs text-ink-500 truncate">{row.note}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
