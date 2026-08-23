import { ReactNode, useMemo, useState } from "react";
import {
  ARK_COLORS,
  COLOR_REGIONS,
  colorById,
  searchColors,
  type ArkColor,
} from "../../model/arkColors";
import {
  normalizeTraitToken,
  searchTraits,
  tiersFor,
  traitByToken,
  TRAIT_CATEGORY_LABELS,
} from "../../model/arkTraits";
import {
  SPAWN_STATS,
  serializeStats,
  serializeTraits,
  type ColorAssignment,
  type SpawnStatKey,
  type StatPoints,
  type TraitAssignment,
} from "../../services/spawnCommands";
import { newId } from "../../model/ids";
import {
  Button,
  cx,
  Input,
  PopoverPanel,
  Select,
  usePopover,
} from "../../components/ui";
import { feedbackTarget } from "../../model/feedback/targets";

/**
 * The three structured editors behind the Dino Depot ball command's -s=, -r=
 * and -g= arguments.
 *
 * All three used to be raw text fields where a misplaced comma produced a
 * command that fails silently in the console. Each is now a small button that
 * drops a panel: most spawns set none of these, so they earn a button's worth
 * of space in the modal and nothing more.
 */

/** Shared shell: the trigger button, its count, and the dropped panel. */
function ArgButton({
  label,
  title,
  count,
  summary,
  onClear,
  width = 340,
  children,
}: {
  label: string;
  title: string;
  /** How many values are set — shown on the button so the modal stays honest. */
  count: number;
  /** The literal argument produced, so it can be sanity-checked at a glance. */
  summary: string;
  onClear: () => void;
  width?: number;
  children: (close: () => void) => ReactNode;
}) {
  const { open, setOpen, toggle, rect, anchor, panel } = usePopover();
  return (
    <div ref={anchor} className="relative">
      <button
        type="button"
        onClick={toggle}
        title={count > 0 ? `${title}\n${summary}` : title}
        className={cx(
          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-sm cursor-pointer transition-colors",
          count > 0
            ? "border-accent-500/50 bg-ink-800 text-ink-100"
            : "border-ink-600 text-ink-300 hover:text-white hover:border-ink-500",
          open && "border-accent-500",
        )}
      >
        {label}
        {count > 0 && (
          <span className="text-xs px-1.5 rounded-full bg-accent-600 text-white">
            {count}
          </span>
        )}
        <span className="text-xs text-ink-400">▾</span>
      </button>
      {open && (
        <PopoverPanel rect={rect} panelRef={panel} width={width}>
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-ink-700 shrink-0">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-300">
              {label}
            </span>
            {count > 0 && (
              <Button variant="ghost" onClick={onClear}>
                Clear
              </Button>
            )}
          </div>
          <div className="overflow-y-auto min-h-0 p-3">{children(() => setOpen(false))}</div>
          {count > 0 && (
            <div className="px-3 py-1.5 border-t border-ink-700 shrink-0">
              <span className="mono text-xs text-accent-400 break-all">
                {summary}
              </span>
            </div>
          )}
        </PopoverPanel>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function StatsEditor({
  stats,
  onChange,
}: {
  stats: StatPoints;
  onChange: (stats: StatPoints) => void;
}) {
  const count = SPAWN_STATS.filter((s) => (stats[s.key] ?? 0) > 0).length;

  function set(key: SpawnStatKey, points: number) {
    const next = { ...stats };
    if (points > 0) next[key] = points;
    else delete next[key];
    onChange(next);
  }

  return (
    <ArgButton
      label="Stats"
      title="Assign wild stat points instead of a level (-s=)"
      count={count}
      summary={`-s=${serializeStats(stats)}`}
      onClear={() => onChange({})}
      width={300}
    >
      {() => (
        <>
          {/* Every stat is listed, in the order -s= expects — the argument is
              positional, and seeing the full nine is how you check it. */}
          <div className="flex flex-col gap-1">
            {SPAWN_STATS.map((stat) => (
              <div key={stat.key} className="flex items-center gap-2">
                <span className="text-sm text-ink-200 flex-1 min-w-0 truncate">
                  {stat.label}{" "}
                  <span className="text-ink-500">({stat.short})</span>
                </span>
                <Input
                  type="number"
                  min={0}
                  className="w-20"
                  value={stats[stat.key] ?? ""}
                  placeholder="0"
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") return set(stat.key, 0);
                    const n = Number(raw);
                    if (Number.isFinite(n)) set(stat.key, Math.max(0, n));
                  }}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </ArgButton>
  );
}

// ---------------------------------------------------------------------------

/** A swatch plus its id and name — the three things needed to pick a colour. */
function ColorOption({ color }: { color: ArkColor }) {
  return (
    <>
      <span
        className="w-4 h-4 rounded-sm border border-ink-600 shrink-0"
        style={{ background: color.hex ? `#${color.hex}` : "transparent" }}
        aria-hidden
      />
      <span className="text-sm text-ink-100 truncate min-w-0 flex-1">
        <span className="mono text-ink-400">{color.id}</span> {color.name}
      </span>
      {color.hex && (
        <span className="mono text-xs text-ink-500 shrink-0">#{color.hex}</span>
      )}
    </>
  );
}

export function ColorsEditor({
  colors,
  onChange,
}: {
  colors: ColorAssignment[];
  onChange: (colors: ColorAssignment[]) => void;
}) {
  const used = colors.filter((c) => c.colorId > 0);
  /** Region whose colour list is showing, or null for the region list. */
  const [picking, setPicking] = useState<number | null>(null);
  const [query, setQuery] = useState("");

  // No cap: the whole palette has to be reachable by scrolling, and 254 rows
  // is nothing to render.
  const results = useMemo(() => searchColors(query), [query]);

  function setRegion(region: number, colorId: number) {
    const rest = colors.filter((c) => c.region !== region);
    onChange(
      colorId > 0
        ? [...rest, { region, colorId }].sort((a, b) => a.region - b.region)
        : rest,
    );
  }

  return (
    <ArgButton
      label="Colors"
      title="Assign colours to this creature's colour regions (-r=)"
      count={used.length}
      summary={`-r=${COLOR_REGIONS.map(
        (r) => used.find((c) => c.region === r)?.colorId ?? 0,
      ).join(",")}`}
      onClear={() => onChange([])}
      width={380}
    >
      {() =>
        picking === null ? (
          <div {...feedbackTarget("spawn-command-color-selector")}>
            <div className="flex flex-col gap-1">
              {COLOR_REGIONS.map((region) => {
                const assignment = used.find((c) => c.region === region);
                const color = assignment
                  ? colorById(assignment.colorId)
                  : undefined;
                return (
                  <div key={region} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ink-400 w-16 shrink-0">
                        Region {region}
                      </span>
                      <button
                        onClick={() => {
                          setQuery("");
                          setPicking(region);
                        }}
                        className="flex items-center gap-2 flex-1 min-w-0 border border-ink-600 rounded-md px-2 py-1 hover:border-accent-500/50 cursor-pointer text-left"
                      >
                        {color ? (
                          <ColorOption color={color} />
                        ) : assignment ? (
                          <span className="text-sm text-ink-400">
                            Unknown id {assignment.colorId}
                          </span>
                        ) : (
                          <span className="text-sm text-ink-500">Not set</span>
                        )}
                      </button>
                      {assignment && (
                        <button
                          onClick={() => setRegion(region, 0)}
                          title={`Clear region ${region}`}
                          className="text-ink-400 hover:text-red-400 cursor-pointer px-1"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {color?.note && (
                      <p className="text-xs text-amber-400/80 pl-[4.5rem]">
                        {color.note}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div {...feedbackTarget("spawn-command-color-selector")}>
            <div className="flex items-center gap-2 mb-2">
              <Button variant="ghost" onClick={() => setPicking(null)}>
                ‹ Back
              </Button>
              <span className="text-xs text-ink-400">Region {picking}</span>
            </div>
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${ARK_COLORS.length} colours by id or name…`}
              className="mb-2"
            />
            <div className="flex flex-col">
              {results.map((color) => (
                <button
                  key={color.id}
                  onClick={() => {
                    setRegion(picking, color.id);
                    setPicking(null);
                  }}
                  title={color.note}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-ink-800 cursor-pointer text-left"
                >
                  <ColorOption color={color} />
                  {color.note && (
                    <span className="text-xs text-amber-400 shrink-0">*</span>
                  )}
                </button>
              ))}
              {results.length === 0 && (
                <p className="text-xs text-ink-500 px-2 py-3">
                  No colour matches "{query}".
                </p>
              )}
            </div>
          </div>
        )
      }
    </ArgButton>
  );
}

// ---------------------------------------------------------------------------

export function TraitsEditor({
  traits,
  onChange,
}: {
  traits: TraitAssignment[];
  onChange: (traits: TraitAssignment[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  // Unsliced, so every trait is reachable by scrolling.
  const results = useMemo(() => searchTraits(query), [query]);
  const custom = normalizeTraitToken(query);

  function add(token: string) {
    // Deliberately no uniqueness check: a creature can carry more than one of
    // the same trait, so the same token may legitimately appear twice.
    onChange([...traits, { id: newId(), token, tier: tiersFor(token)[0] }]);
    setQuery("");
    setAdding(false);
  }

  function update(id: string, patch: Partial<TraitAssignment>) {
    onChange(traits.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  return (
    <ArgButton
      label="Traits"
      title="ASA creature traits (-g=)"
      count={traits.length}
      summary={`-g=${serializeTraits(traits)}`}
      onClear={() => onChange([])}
      width={380}
    >
      {() =>
        adding ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <Button variant="ghost" onClick={() => setAdding(false)}>
                ‹ Back
              </Button>
            </div>
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search traits by name or category…"
              className="mb-2"
            />
            <div className="flex flex-col">
              {results.map((trait) => (
                <button
                  key={trait.token}
                  onClick={() => add(trait.token)}
                  // What the trait does is a hover away rather than a second
                  // line under every row — the list is for finding a name.
                  title={trait.hint}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-ink-800 cursor-pointer text-left"
                >
                  <span className="text-sm text-ink-100 truncate min-w-0 flex-1">
                    {trait.name}
                  </span>
                  <span className="text-xs text-ink-500 shrink-0">
                    {TRAIT_CATEGORY_LABELS[trait.category]}
                  </span>
                </button>
              ))}
              {/* The list is not authoritative, so an unlisted trait must
                  still be reachable — otherwise a valid command is untypeable. */}
              {custom && !traitByToken(custom) && (
                <button
                  onClick={() => add(custom)}
                  className="flex items-center gap-2 px-2 py-1.5 mt-1 rounded border border-dashed border-ink-600 hover:border-accent-500/50 cursor-pointer text-left"
                >
                  <span className="text-sm text-ink-200">
                    Use <span className="mono text-accent-400">{custom}</span> as
                    a trait not in the list
                  </span>
                </button>
              )}
              {results.length === 0 && !custom && (
                <p className="text-xs text-ink-500 px-2 py-3">
                  No trait matches.
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            {traits.length === 0 ? (
              <p className="text-xs text-ink-500 border border-dashed border-ink-700 rounded-md px-3 py-3 mb-2 text-center">
                No traits assigned.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5 mb-2">
                {traits.map((assignment) => {
                  const known = traitByToken(assignment.token);
                  const tiers = tiersFor(assignment.token);
                  return (
                    <div key={assignment.id} className="flex items-center gap-2">
                      {/* Name only. The token is what goes in the command, but
                          for a known trait it is the same word twice — and the
                          command itself is printed at the foot of the panel. */}
                      <span
                        className="text-sm text-ink-100 truncate min-w-0 flex-1"
                        title={
                          known
                            ? [known.hint, `-g= token: ${assignment.token}`]
                                .filter(Boolean)
                                .join("\n")
                            : `Not in the trait list — sent as "${assignment.token}"`
                        }
                      >
                        {known?.name ?? assignment.token}
                        {!known && (
                          <span className="text-xs text-amber-400 ml-1.5">
                            not in list
                          </span>
                        )}
                      </span>
                      <Select
                        className="w-24"
                        value={assignment.tier}
                        onChange={(e) =>
                          update(assignment.id, {
                            tier: Number(e.target.value) as 1 | 2 | 3,
                          })
                        }
                      >
                        {tiers.map((tier) => (
                          <option key={tier} value={tier}>
                            Tier {tier}
                          </option>
                        ))}
                      </Select>
                      <button
                        onClick={() =>
                          onChange(traits.filter((t) => t.id !== assignment.id))
                        }
                        title="Remove trait"
                        className="text-ink-400 hover:text-red-400 cursor-pointer px-1"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <Button
              onClick={() => {
                setQuery("");
                setAdding(true);
              }}
            >
              + Add
            </Button>
          </>
        )
      }
    </ArgButton>
  );
}
