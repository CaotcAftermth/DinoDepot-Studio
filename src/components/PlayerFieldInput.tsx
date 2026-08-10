import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDraftsStore } from "../stores/draftsStore";
import { useProjectStore } from "../stores/projectStore";
import { playerChoices, type PlayerFieldKey } from "../model/players";
import { Input, cx, useEscapeLayer } from "./ui";

/**
 * A text field for a player identifier that can also pick from the roster.
 *
 * Admins know players by name, not by a twenty-digit EOS id — so when the
 * Player Data module is on and someone in the roster has the identifier this
 * field wants, a picker offers them by name and fills in the value. Typing is
 * never blocked: rosters are incomplete, and the module may be off entirely,
 * in which case this is exactly a plain input.
 */
export function PlayerFieldInput({
  field,
  value,
  onChange,
  placeholder,
  className,
}: {
  /** Which identifier this field holds. */
  field: PlayerFieldKey;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const players = useDraftsStore((s) => s.players.players);
  const moduleOn = useProjectStore(
    (s) => s.settings?.modules["player-data"] === true,
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchor = useRef<HTMLDivElement>(null);

  const choices = useMemo(
    () => (moduleOn ? playerChoices(players, field) : []),
    [moduleOn, players, field],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return choices;
    return choices.filter((c) =>
      `${c.label} ${c.aka} ${c.value}`.toLowerCase().includes(q),
    );
  }, [choices, query]);

  // Close on an outside click or Escape, like the other portalled menus.
  useEscapeLayer(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Nothing to offer — this is just an input.
  if (choices.length === 0) {
    return (
      <Input
        className={className}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    );
  }

  const matched = choices.find((c) => c.value === value.trim());

  return (
    <div ref={anchor} className="relative">
      <div className="flex gap-1.5">
        <Input
          className={className}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          title={matched ? `${matched.label}'s ${field}` : undefined}
        />
        <button
          onClick={() => {
            const r = anchor.current?.getBoundingClientRect() ?? null;
            setRect(r);
            setQuery("");
            setOpen(!open);
          }}
          title={`Pick from ${choices.length} player${choices.length === 1 ? "" : "s"}`}
          className={cx(
            "shrink-0 px-2 rounded-md border cursor-pointer text-sm",
            open
              ? "border-accent-500 text-accent-400"
              : "border-ink-600 text-ink-400 hover:text-ink-200",
          )}
        >
          ▾
        </button>
      </div>

      {matched && (
        <span className="block text-xs text-accent-400 mt-1 truncate">
          {matched.label}
        </span>
      )}

      {open &&
        rect &&
        createPortal(
          <div
            className="fixed z-[70] bg-ink-900 border border-ink-600 rounded-lg shadow-2xl overflow-hidden"
            style={{
              top: rect.bottom + 4,
              left: rect.left,
              width: Math.max(rect.width, 240),
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="p-2 border-b border-ink-700">
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search players…"
              />
            </div>
            <div className="max-h-64 overflow-y-auto">
              {filtered.map((choice) => (
                <button
                  key={choice.player.id}
                  onClick={() => {
                    onChange(choice.value);
                    setOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-ink-800 cursor-pointer"
                >
                  <div className="text-sm text-ink-100 truncate">
                    {choice.label}
                    {choice.aka && (
                      <span className="text-ink-500"> · {choice.aka}</span>
                    )}
                  </div>
                  <div className="mono text-xs text-ink-400 truncate">
                    {choice.value}
                  </div>
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="text-xs text-ink-400 px-3 py-3">
                  No player matches — type the value instead.
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
