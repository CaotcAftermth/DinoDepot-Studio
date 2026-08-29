import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ContentSource,
  IniBuildState,
  IniSetting,
} from "../../model/catalog";
import {
  BuildEntry,
  buildIniText,
  findPlaceholders,
  invalidOptions,
  isAddedToBuild,
  parseNoteOptions,
  properCaseBool,
  validateValue,
} from "../../model/iniSettings";
import { PlaceholderText } from "./PlaceholderText";
import { Badge, Button, cx, EmptyState, Input, Modal } from "../../components/ui";
import { toast } from "../../components/toast";

/**
 * Composes a ready-to-paste INI block from the settings marked as added.
 *
 * Values here are a working copy: editing them never touches the documented
 * default on the setting itself. Placeholders resolve strictly from that
 * setting's own Extended Notes.
 */
export function BuildIniModal({
  source,
  onToggleAdded,
  onChangeBuild,
  onClose,
}: {
  source: ContentSource;
  onToggleAdded: (id: string, added: boolean) => void;
  /** Persists the composer state onto the mod so it survives closing. */
  onChangeBuild: (iniBuild: Record<string, IniBuildState>) => void;
  onClose: () => void;
}) {
  const settings = source.iniSettings;
  const included = settings.filter(isAddedToBuild);
  const available = settings.filter((s) => !isAddedToBuild(s));

  const build = source.iniBuild;
  const stateOf = (id: string): IniBuildState =>
    build[id] ?? { value: "", choices: {}, optionValues: {} };
  const [showAvailable, setShowAvailable] = useState(false);

  const valueOf = (s: IniSetting) => build[s.id]?.value || s.value;

  const entries: BuildEntry[] = useMemo(
    () =>
      included.map((setting) => ({
        setting,
        value: build[setting.id]?.value || setting.value,
        choices: build[setting.id]?.choices ?? {},
        optionValues: build[setting.id]?.optionValues ?? {},
      })),
    [included, build],
  );

  const output = useMemo(() => buildIniText(entries), [entries]);
  const lineCount = output
    ? output
        .split("\n")
        .filter((l) => l && !l.startsWith(";") && !l.startsWith("[")).length
    : 0;

  const patch = (settingId: string, next: Partial<IniBuildState>) =>
    onChangeBuild({
      ...build,
      [settingId]: { ...stateOf(settingId), ...next },
    });

  function setValue(settingId: string, value: string) {
    patch(settingId, { value });
  }

  function setChoice(settingId: string, name: string, options: string[]) {
    patch(settingId, {
      choices: {
        ...stateOf(settingId).choices,
        [name.toLowerCase()]: options,
      },
    });
  }

  function setOptionValue(
    settingId: string,
    name: string,
    option: string,
    value: string,
  ) {
    const key = name.toLowerCase();
    const current = stateOf(settingId).optionValues;
    patch(settingId, {
      optionValues: {
        ...current,
        [key]: { ...(current[key] ?? {}), [option]: value },
      },
    });
  }

  /** Drops the composed state, returning every setting to its documented default. */
  function resetBuild() {
    onChangeBuild({});
    toast.info("Build reset to the documented defaults");
  }

  return (
    <Modal title={`Build INI - ${source.name}`} onClose={onClose} xl>
      <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4 items-start">
        {/* Composer */}
        <div>
          {included.length === 0 ? (
            <EmptyState title="Nothing added yet">
              Mark settings with the ● toggle in the settings list, or add them
              below.
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1">
              {included.map((setting) => (
                <BuildRow
                  key={setting.id}
                  setting={setting}
                  value={valueOf(setting)}
                  choices={build[setting.id]?.choices ?? {}}
                  optionValues={build[setting.id]?.optionValues ?? {}}
                  onValue={(v) => setValue(setting.id, v)}
                  onChoice={(name, options) =>
                    setChoice(setting.id, name, options)
                  }
                  onOptionValue={(name, option, v) =>
                    setOptionValue(setting.id, name, option, v)
                  }
                  onRemove={() => onToggleAdded(setting.id, false)}
                />
              ))}
            </div>
          )}

          <div className="mt-3 border-t border-ink-700 pt-3">
            <button
              onClick={() => setShowAvailable(!showAvailable)}
              className="text-xs text-ink-300 hover:text-white cursor-pointer"
            >
              {showAvailable ? "▾" : "▸"} Add more settings ({available.length})
            </button>
            {showAvailable && (
              <div className="mt-2 flex flex-col gap-1 max-h-40 overflow-y-auto">
                {available.length === 0 ? (
                  <span className="text-xs text-ink-400">
                    Every setting is already included.
                  </span>
                ) : (
                  available.map((setting) => (
                    <button
                      key={setting.id}
                      onClick={() => onToggleAdded(setting.id, true)}
                      className="flex items-center gap-2 text-left px-2 py-1 rounded hover:bg-ink-800 cursor-pointer"
                    >
                      <span className="text-accent-400">+</span>
                      <span className="mono text-xs text-ink-200 truncate">
                        {setting.key}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* Generated output */}
        <div className="sticky top-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
              Generated INI - {lineCount} line{lineCount === 1 ? "" : "s"}
            </span>
            <div className="flex gap-2">
              <Button
                disabled={Object.keys(build).length === 0}
                onClick={resetBuild}
                title="Discard the composed values and start from the defaults"
              >
                Reset
              </Button>
              <Button
                variant="primary"
                disabled={!output}
                onClick={() => {
                  navigator.clipboard.writeText(output);
                  toast.success(`Copied ${lineCount} INI lines`);
                }}
              >
                Copy INI
              </Button>
            </div>
          </div>
          <p className="text-xs text-ink-500 mb-1">
            Choices are kept with the mod - reopening picks up where you left
            off.
          </p>
          <pre className="mono bg-ink-950 border border-ink-700 rounded-md p-3 h-[64vh] overflow-auto text-ink-200 whitespace-pre-wrap break-all">
            {output || "Nothing to build yet."}
          </pre>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function BuildRow({
  setting,
  value,
  choices,
  optionValues,
  onValue,
  onChoice,
  onOptionValue,
  onRemove,
}: {
  setting: IniSetting;
  value: string;
  choices: Record<string, string[]>;
  optionValues: Record<string, Record<string, string>>;
  onValue: (v: string) => void;
  onChoice: (name: string, options: string[]) => void;
  onOptionValue: (name: string, option: string, value: string) => void;
  onRemove: () => void;
}) {
  // Options come strictly from this setting's own Extended Notes.
  const options = useMemo(
    () => parseNoteOptions(setting.details),
    [setting.details],
  );

  const keyPlaceholders = findPlaceholders(setting.key);
  const valuePlaceholders = findPlaceholders(value);
  const valueIsPlaceholder = /^<[^>]*>$/.test(value.trim());
  const invalid = validateValue(value, setting.type);

  const picker = (name: string, inValue: boolean) => (
    <PlaceholderPicker
      key={name}
      name={name}
      options={options.get(name.toLowerCase()) ?? []}
      selected={choices[name.toLowerCase()] ?? []}
      // The declared type constrains the value only - a key placeholder holds
      // creature names, which have nothing to do with it.
      type={inValue ? setting.type : ""}
      // Key placeholders carry a value per option, so a whole creature list
      // can be configured individually in one pass.
      perOptionValues={
        inValue ? undefined : (optionValues[name.toLowerCase()] ?? {})
      }
      perOptionType={setting.type}
      defaultValue={value}
      onChange={(opts) => onChoice(name, opts)}
      onOptionValue={(option, v) => onOptionValue(name, option, v)}
    />
  );

  return (
    <div className="border border-ink-700 rounded-lg bg-ink-850 px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="mono text-xs text-ink-300 break-all">
            <PlaceholderText text={setting.key} />
          </div>
          {setting.description && (
            <div className="text-xs text-ink-500 break-words">
              {setting.description}
            </div>
          )}
        </div>
        {setting.required && <Badge tone="warn">required</Badge>}
        {!setting.required && (
          <Button variant="ghost" onClick={onRemove} title="Remove from build">
            ✕
          </Button>
        )}
      </div>

      {/* Controls follow the order they appear in `key=value`. */}
      <div className="flex flex-wrap items-center gap-2 mt-2">
        {keyPlaceholders.map((name) => picker(name, false))}
        <span className="text-ink-500 mono">=</span>
        {valueIsPlaceholder ? (
          picker(valuePlaceholders[0], true)
        ) : (
          <>
            <ValueControl
              setting={setting}
              value={value}
              options={options}
              onValue={onValue}
            />
            {valuePlaceholders.map((name) => picker(name, true))}
          </>
        )}
      </div>
      {invalid && <div className="text-xs text-amber-400 mt-1">{invalid}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Type-appropriate editor for the working value. */
function ValueControl({
  setting,
  value,
  options,
  onValue,
}: {
  setting: IniSetting;
  value: string;
  options: Map<string, string[]>;
  onValue: (v: string) => void;
}) {
  if (setting.type === "bool") {
    const isTrue = /^true$/i.test(value.trim());
    return (
      <span className="inline-flex rounded-md overflow-hidden border border-ink-600">
        {["True", "False"].map((option) => {
          const active = option === "True" ? isTrue : !isTrue;
          return (
            <button
              key={option}
              onClick={() => onValue(option)}
              className={cx(
                "px-3 py-1 text-xs cursor-pointer",
                active
                  ? "bg-accent-600 text-white"
                  : "bg-ink-900 text-ink-300 hover:text-white",
              )}
            >
              {option}
            </button>
          );
        })}
      </span>
    );
  }

  if (setting.type === "int" || setting.type === "float") {
    const step = setting.type === "int" ? 1 : 0.1;
    const nudge = (delta: number) => {
      const current = Number(value);
      const base = Number.isFinite(current) ? current : 0;
      const next = base + delta;
      onValue(setting.type === "int" ? String(Math.round(next)) : next.toFixed(2));
    };
    return (
      <span className="inline-flex items-center gap-1">
        <Button variant="ghost" onClick={() => nudge(-step)}>
          −
        </Button>
        <Input
          className="mono w-28 text-center"
          value={value}
          onChange={(e) => onValue(e.target.value)}
        />
        <Button variant="ghost" onClick={() => nudge(step)}>
          +
        </Button>
      </span>
    );
  }

  // A named option list for this value, if the notes define one.
  const named = options.get(setting.key.toLowerCase());
  if (named && named.length > 0) {
    return (
      <select
        value={value}
        onChange={(e) => onValue(e.target.value)}
        className="bg-ink-900 border border-ink-600 rounded-md px-2 py-1 text-xs text-ink-100 mono"
      >
        {named.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Input
      className="mono w-72"
      value={value}
      onChange={(e) => onValue(properCaseBool(e.target.value))}
    />
  );
}

// ---------------------------------------------------------------------------

/** Compact, type-aware editor used inline against a single option. */
function MiniValueEditor({
  value,
  type,
  placeholder,
  onChange,
}: {
  value: string;
  type: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  if (type === "bool") {
    const isTrue = /^true$/i.test(value.trim());
    const isSet = value.trim() !== "";
    return (
      <span className="inline-flex rounded overflow-hidden border border-ink-600 shrink-0">
        {["True", "False"].map((option) => {
          const active = isSet && (option === "True" ? isTrue : !isTrue);
          return (
            <button
              key={option}
              onClick={(e) => {
                e.stopPropagation();
                onChange(active ? "" : option);
              }}
              className={cx(
                "px-1.5 py-0.5 text-[10px] cursor-pointer",
                active
                  ? "bg-accent-600 text-white"
                  : "bg-ink-900 text-ink-400 hover:text-white",
              )}
            >
              {option}
            </button>
          );
        })}
      </span>
    );
  }
  return (
    <input
      value={value}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(properCaseBool(e.target.value))}
      className="w-16 shrink-0 bg-ink-900 border border-ink-600 rounded px-1 py-0.5 mono text-[11px] text-ink-100 focus:outline-none focus:border-accent-500/60"
    />
  );
}

/**
 * Multi-select over a placeholder's options - one INI line per selection.
 * For key placeholders each option also carries its own value, so a whole
 * creature list can be configured individually in a single pass.
 */
function PlaceholderPicker({
  name,
  options,
  selected,
  type,
  perOptionValues,
  perOptionType,
  defaultValue,
  onChange,
  onOptionValue,
}: {
  name: string;
  options: string[];
  selected: string[];
  type: string;
  perOptionValues?: Record<string, string>;
  perOptionType: string;
  defaultValue: string;
  onChange: (options: string[]) => void;
  onOptionValue: (option: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, above: false });
  const bad = invalidOptions(options, type);
  const perOption = perOptionValues !== undefined;

  // The menu is portalled to <body> with fixed positioning: the composer
  // column scrolls, and an absolutely positioned menu would be clipped by it.
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const width = perOption ? 300 : 224;
    const spaceBelow = window.innerHeight - rect.bottom;
    const above = spaceBelow < 260 && rect.top > spaceBelow;
    setPos({
      top: above ? rect.top - 4 : rect.bottom + 4,
      left: Math.min(rect.left, window.innerWidth - width - 8),
      above,
    });
  }, [open, perOption]);

  const label =
    selected.length === 0
      ? `<${name}>`
      : selected.length === 1
        ? selected[0]
        : `${selected.length} selected`;

  return (
    <>
      <button
        ref={anchor}
        onClick={() => setOpen(!open)}
        title={
          options.length === 0
            ? `No <${name}> list in this setting's Extended Notes`
            : `Choose <${name}>`
        }
        className={cx(
          "px-2 py-1 rounded-md border text-xs mono cursor-pointer",
          selected.length > 0
            ? "border-accent-500/60 text-accent-400"
            : options.length === 0
              ? "border-dashed border-ink-600 text-ink-500"
              : "border-sky-500/50 text-sky-400",
        )}
      >
        {label} ▾
      </button>

      {open &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[60]"
              onMouseDown={() => setOpen(false)}
            />
            <div
              className={cx(
                "fixed z-[61] max-h-64 overflow-y-auto bg-ink-850 border border-ink-600 rounded-lg shadow-2xl p-1",
                perOption ? "w-[300px]" : "w-56",
              )}
              style={{
                top: pos.above ? undefined : pos.top,
                bottom: pos.above ? window.innerHeight - pos.top : undefined,
                left: pos.left,
              }}
            >
              {options.length === 0 ? (
                <div className="text-xs text-ink-400 p-2">
                  Define a <span className="mono">&lt;{name}&gt;</span> list in
                  this setting&apos;s Extended Notes to pick from it.
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1 p-1 border-b border-ink-700 mb-1">
                    <Button variant="ghost" onClick={() => onChange(options)}>
                      All
                    </Button>
                    <Button variant="ghost" onClick={() => onChange([])}>
                      None
                    </Button>
                    {perOption && (
                      <span className="ml-auto text-[10px] text-ink-500 pr-1">
                        value per option
                      </span>
                    )}
                  </div>
                  {options.map((option) => {
                    const on = selected.includes(option);
                    return (
                      <div
                        key={option}
                        className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-ink-700"
                      >
                        <button
                          onClick={() =>
                            onChange(
                              on
                                ? selected.filter((s) => s !== option)
                                : [...selected, option],
                            )
                          }
                          className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                        >
                          <span
                            className={cx(
                              "text-xs",
                              on ? "text-accent-400" : "text-ink-600",
                            )}
                          >
                            {on ? "☑" : "☐"}
                          </span>
                          <span className="mono text-xs text-ink-200 truncate">
                            {option}
                          </span>
                        </button>
                        {perOption && on && (
                          <MiniValueEditor
                            value={perOptionValues?.[option] ?? ""}
                            type={perOptionType}
                            placeholder={defaultValue}
                            onChange={(v) => onOptionValue(option, v)}
                          />
                        )}
                      </div>
                    );
                  })}
                </>
              )}
              {bad.length > 0 && (
                <div className="text-xs text-amber-400 p-2 border-t border-ink-700 mt-1">
                  {bad.length} option{bad.length === 1 ? "" : "s"} don&apos;t
                  match the {type} type.
                </div>
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
