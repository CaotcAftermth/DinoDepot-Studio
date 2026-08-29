import { useMemo, useState } from "react";
import type { ContentSource, IniSetting } from "../../model/catalog";
import { newId } from "../../model/ids";
import {
  INI_FILES,
  inferValueType,
  iniSettingLine,
  iniSettingsToText,
  isAddedToBuild,
  parseIniText,
  placeholdersNeedingOptions,
  properCaseBool,
  scaffoldPlaceholderSections,
  syncPlaceholderSections,
  validateValue,
  VALUE_TYPES,
} from "../../model/iniSettings";
import { PlaceholderText } from "./PlaceholderText";
import { pickFile } from "../../services/dialogs";
import { ipc, isTauri } from "../../services/ipc";
import { BuildIniModal } from "./BuildIniModal";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Toggle,
} from "../../components/ui";
import { toast } from "../../components/toast";
import { confirmDialog } from "../../components/confirm";

/**
 * The mod's server-config settings, as a full-width tab rather than a modal:
 * a searchable list of Key=Value settings, each with its own detail view for
 * longer explanations, plus a paste-to-parse importer and freeform notes.
 */
export function IniSettingsPanel({
  source,
  onChange,
}: {
  source: ContentSource;
  onChange: (patch: Partial<ContentSource>) => void;
}) {
  const [search, setSearch] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [detailFor, setDetailFor] = useState<IniSetting | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [viewNotesFor, setViewNotesFor] = useState<IniSetting | null>(null);
  const [buildOpen, setBuildOpen] = useState(false);

  const settings = source.iniSettings;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return settings;
    return settings.filter((s) =>
      [s.key, s.value, s.section, s.description, s.file]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [settings, search]);

  /** Groups for display: file -> section -> settings. */
  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, IniSetting[]>>();
    for (const setting of filtered) {
      const file = setting.file || "Unassigned file";
      const sections = map.get(file) ?? new Map<string, IniSetting[]>();
      const section = setting.section || "(no section)";
      const list = sections.get(section) ?? [];
      list.push(setting);
      sections.set(section, list);
      map.set(file, sections);
    }
    return [...map.entries()];
  }, [filtered]);

  function update(id: string, patch: Partial<IniSetting>) {
    onChange({
      iniSettings: settings.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  }

  async function remove(setting: IniSetting) {
    const ok = await confirmDialog({
      title: "Remove setting?",
      message: `"${setting.key}" will be removed from this mod's INI settings.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    onChange({ iniSettings: settings.filter((s) => s.id !== setting.id) });
  }

  function addBlank() {
    const setting: IniSetting = {
      id: newId(),
      section: "",
      key: "NewSetting",
      value: "",
      type: "",
      file: "",
      description: "",
      details: "",
      required: false,
      added: false,
    };
    onChange({ iniSettings: [...settings, setting] });
    setDetailFor(setting);
  }

  function copyAll() {
    const text = iniSettingsToText(settings);
    if (!text) {
      toast.error("No settings to copy");
      return;
    }
    navigator.clipboard.writeText(text);
    toast.success(`Copied ${settings.length} settings as an INI block`);
  }

  const requiredCount = settings.filter((s) => s.required).length;
  const addedCount = settings.filter(isAddedToBuild).length;
  const hasLegacyNotes = Boolean(source.iniNotes.trim());

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${settings.length} settings…`}
          />
        </div>
        <Button onClick={() => setNotesOpen(true)}>
          Notes{hasLegacyNotes ? " •" : ""}
        </Button>
        <Button onClick={copyAll} disabled={settings.length === 0}>
          Copy all
        </Button>
        <Button onClick={() => setPasteOpen(true)}>Upload INI…</Button>
        <Button onClick={() => setBuildOpen(true)} disabled={settings.length === 0}>
          Build INI…
        </Button>
        <Button variant="primary" onClick={addBlank}>
          + Add setting
        </Button>
      </div>

      {(requiredCount > 0 || addedCount > 0) && (
        <p className="text-xs text-ink-400 mb-3">
          {addedCount} of {settings.length} added to Build INI
          {requiredCount > 0 && <> · {requiredCount} marked required</>}
        </p>
      )}

      {hasLegacyNotes && settings.length === 0 && (
        <div className="mb-3 px-3 py-2.5 bg-ink-800 border border-ink-600 rounded-md flex items-center justify-between gap-3">
          <span className="text-sm text-ink-200">
            This mod has config notes from before - parse them into settings?
          </span>
          <Button
            variant="primary"
            onClick={() => {
              const { settings: parsed } = parseIniText(source.iniNotes);
              if (parsed.length === 0) {
                toast.error("No Key=Value lines found in the notes");
                return;
              }
              onChange({
                iniSettings: parsed.map((p) => ({
                  ...p,
                  id: newId(),
                  details: scaffoldPlaceholderSections(p.key, p.value, ""),
                  required: false,
                  added: false,
                })),
              });
              toast.success(`Parsed ${parsed.length} settings from notes`);
            }}
          >
            Parse notes
          </Button>
        </div>
      )}

      {settings.length === 0 ? (
        <EmptyState title="No INI settings recorded">
          Paste this mod's config block and the app will split it into
          individual settings you can search, annotate, and copy one at a time.
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState title="No matching settings" />
      ) : (
        <div className="flex flex-col gap-4 max-h-[calc(100vh-400px)] overflow-y-auto pr-1">
          {grouped.map(([file, sections]) => (
            <div key={file}>
              <div className="text-xs font-semibold text-accent-400 uppercase tracking-wide mb-1.5">
                {file}
              </div>
              {[...sections.entries()].map(([section, group]) => (
                <div key={section} className="mb-3">
                  <div className="mono text-ink-400 mb-1">
                    {section === "(no section)" ? section : `[${section}]`}
                  </div>
                  <div className="flex flex-col divide-y divide-ink-800 border border-ink-700 rounded-lg overflow-hidden">
                    {group.map((setting) => (
                      <SettingRow
                        key={setting.id}
                        setting={setting}
                        onToggleAdded={() => {
                          if (setting.required) {
                            toast.info(
                              "Required settings are always part of Build INI",
                            );
                            return;
                          }
                          update(setting.id, { added: !setting.added });
                        }}
                        onDetails={() => setDetailFor(setting)}
                        onShowNotes={() => setViewNotesFor(setting)}
                        onRemove={() => remove(setting)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {pasteOpen && (
        <PasteIniModal
          onClose={() => setPasteOpen(false)}
          onImport={(parsed, replace) => {
            const fresh: IniSetting[] = parsed.map((p) => ({
              ...p,
              id: newId(),
              details: scaffoldPlaceholderSections(p.key, p.value, ""),
              required: false,
              added: false,
            }));
            const existingKeys = new Set(
              settings.map((s) => `${s.section}|${s.key}`.toLowerCase()),
            );
            const merged = replace
              ? fresh
              : [
                  ...settings,
                  ...fresh.filter(
                    (f) =>
                      !existingKeys.has(`${f.section}|${f.key}`.toLowerCase()),
                  ),
                ];
            onChange({ iniSettings: merged });
            setPasteOpen(false);
            toast.success(
              replace
                ? `Replaced with ${fresh.length} settings`
                : `Added ${merged.length - settings.length} new settings`,
            );
          }}
        />
      )}

      {detailFor && (
        <SettingDetailModal
          setting={
            settings.find((s) => s.id === detailFor.id) ?? detailFor
          }
          onSave={(patch) => update(detailFor.id, patch)}
          onClose={() => setDetailFor(null)}
        />
      )}

      {buildOpen && (
        <BuildIniModal
          source={source}
          onClose={() => setBuildOpen(false)}
          onToggleAdded={(id, added) => update(id, { added })}
          onChangeBuild={(iniBuild) => onChange({ iniBuild })}
        />
      )}

      {viewNotesFor && (
        <SettingNotesModal
          setting={
            settings.find((s) => s.id === viewNotesFor.id) ?? viewNotesFor
          }
          onEdit={() => {
            setDetailFor(viewNotesFor);
            setViewNotesFor(null);
          }}
          onClose={() => setViewNotesFor(null)}
        />
      )}

      {notesOpen && (
        <NotesModal
          value={source.iniNotes}
          onSave={(text) => onChange({ iniNotes: text })}
          onClose={() => setNotesOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SettingRow({
  setting,
  onToggleAdded,
  onDetails,
  onShowNotes,
  onRemove,
}: {
  setting: IniSetting;
  onToggleAdded: () => void;
  onDetails: () => void;
  onShowNotes: () => void;
  onRemove: () => void;
}) {
  const invalid = validateValue(setting.value, setting.type);
  const added = isAddedToBuild(setting);
  return (
    <div className="flex items-start gap-3 px-3 py-2 group bg-ink-900">
      <button
        onClick={onToggleAdded}
        title={
          setting.required
            ? "Added to Build INI (required settings are always included)"
            : added
              ? "Added to Build INI"
              : "Not added to Build INI"
        }
        className={cx(
          "shrink-0 mt-0.5 text-sm leading-none",
          setting.required
            ? "text-accent-400 cursor-default"
            : added
              ? "text-accent-400 cursor-pointer"
              : "text-ink-600 hover:text-ink-400 cursor-pointer",
        )}
      >
        {added ? "●" : "○"}
      </button>
      <div className="min-w-0 flex-1">
        <div className="mono text-ink-100 break-all">
          <span className="text-accent-400">
            <PlaceholderText text={setting.key} />
          </span>
          <span className="text-ink-500">=</span>
          <span>
            <PlaceholderText text={setting.value} />
          </span>
          {setting.details && (
            <button
              onClick={onShowNotes}
              title="View extended notes"
              className="ml-1.5 cursor-pointer align-middle"
            >
              <Badge tone="info">Info</Badge>
            </button>
          )}
        </div>
        {setting.description && (
          <div className="text-xs text-ink-400 break-words">
            {setting.description}
          </div>
        )}
        {invalid && (
          <div className="text-xs text-amber-400 break-words">{invalid}</div>
        )}
      </div>
      {setting.required && (
        <span className="shrink-0 mt-0.5">
          <Badge tone="warn">required</Badge>
        </span>
      )}
      {setting.type && (
        <span className="text-[10px] text-ink-500 uppercase shrink-0 mt-1">
          {setting.type}
        </span>
      )}
      {/* focus-within keeps these from being reachable-but-invisible by keyboard. */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 shrink-0">
        <Button
          variant="ghost"
          onClick={() => {
            navigator.clipboard.writeText(iniSettingLine(setting));
            toast.success(`Copied ${setting.key}`);
          }}
        >
          Copy
        </Button>
        <Button variant="ghost" onClick={onDetails}>
          Details…
        </Button>
        <Button variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SettingDetailModal({
  setting,
  onSave,
  onClose,
}: {
  setting: IniSetting;
  onSave: (patch: Partial<IniSetting>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(setting);
  const set = (patch: Partial<IniSetting>) =>
    setDraft({ ...draft, ...patch });

  /**
   * Placeholder sections are rebuilt when a field is done being edited, not
   * per keystroke: typing `<test>` between the arrows would otherwise leave a
   * trail of `<t>`, `<te>`, `<tes>` sections behind.
   */
  const syncNotes = () =>
    setDraft((d) => {
      const details = syncPlaceholderSections(d.key, d.value, d.details);
      return details === d.details ? d : { ...d, details };
    });

  const needsOptions = placeholdersNeedingOptions(
    draft.key,
    draft.value,
    draft.details,
  );

  return (
    <Modal title={`Setting - ${setting.key}`} onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Field label="Key">
          <Input
            className="mono"
            value={draft.key}
            onChange={(e) => set({ key: e.target.value })}
            onBlur={syncNotes}
            autoFocus
          />
        </Field>
        <Field
          label="Default value"
          hint={validateValue(draft.value, draft.type) ?? undefined}
        >
          <Input
            className="mono"
            value={draft.value}
            // Bools typed by hand get ARK's Proper case.
            onChange={(e) => set({ value: properCaseBool(e.target.value) })}
            // Type is only inferred once the field is done being edited -
            // reading it mid-keystroke calls "0." a string and sticks with it.
            onBlur={(e) => {
              setDraft((d) => ({
                ...d,
                type: d.type || inferValueType(e.target.value),
                details: syncPlaceholderSections(d.key, d.value, d.details),
              }));
            }}
          />
        </Field>
        <Field label="Section" hint="Without brackets, e.g. ServerSettings">
          <Input
            className="mono"
            value={draft.section}
            onChange={(e) => set({ section: e.target.value })}
          />
        </Field>
        <Field label="Value type" hint="Documentation only - INI is text on disk">
          <Select
            value={draft.type}
            onChange={(e) => set({ type: e.target.value })}
          >
            <option value="">Unspecified</option>
            {VALUE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="File">
          <Select
            value={draft.file}
            onChange={(e) => set({ file: e.target.value })}
          >
            <option value="">Unassigned</option>
            {INI_FILES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Summary" hint="One line, shown in the settings list">
        <Input
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="e.g. Doubles passive production output"
        />
      </Field>

      <div className="mt-3">
        <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1">
          Extended notes
        </span>
        <textarea
          value={draft.details}
          onChange={(e) => set({ details: e.target.value })}
          rows={10}
          className="w-full bg-ink-950 border border-ink-600 rounded-md p-3 text-sm text-ink-100 focus:outline-none focus:border-accent-500/60"
          placeholder={PLACEHOLDER_GUIDANCE}
        />
        {needsOptions.length > 0 && <OptionsHint names={needsOptions} />}
      </div>

      <div className="flex items-center justify-between mt-3">
        <Toggle
          checked={draft.required}
          onChange={(v) => set({ required: v, added: v || draft.added })}
          label="Required for this mod"
        />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!draft.key.trim()}
            onClick={() => {
              // Saving straight from a focused field never blurs it.
              onSave({
                ...draft,
                details: syncPlaceholderSections(
                  draft.key,
                  draft.value,
                  draft.details,
                ),
              });
              onClose();
              toast.success(`Saved ${draft.key}`);
            }}
          >
            Save setting
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const PLACEHOLDER_GUIDANCE =
  "What this actually does, accepted values, gotchas.\n\n" +
  "e.g. Range 0.1–10.0. Values above 5 cause terminal spam.\n" +
  "Requires a server restart, not just a reload.";

/**
 * Live prompt for `<placeholder>` sections that have no options yet. Rendered
 * as hint text rather than seeded into the notes, so there is nothing to
 * delete before typing the first real option.
 */
function OptionsHint({ names }: { names: string[] }) {
  return (
    <div className="mt-2 text-xs text-ink-400 border border-dashed border-ink-700 rounded-md px-3 py-2">
      <p>
        No options listed yet for{" "}
        {names.map((name, i) => (
          <span key={name}>
            {i > 0 && ", "}
            <span className="mono text-sky-400">&lt;{name}&gt;</span>
          </span>
        ))}
        . List them under the heading, one per line:
      </p>
      <pre className="mono text-ink-500 mt-1.5 leading-relaxed">
        {"- Option 1\n- Option 2\n- Option 3"}
      </pre>
      <p className="mt-1.5">
        Use <span className="mono text-ink-300">- 1-9</span> for a numeric
        range.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Read view for a setting's extended notes, opened from the 📝 marker. */
function SettingNotesModal({
  setting,
  onEdit,
  onClose,
}: {
  setting: IniSetting;
  onEdit: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={setting.key} onClose={onClose} wide>
      <div className="mono text-ink-200 break-all mb-1">
        <span className="text-accent-400">
          <PlaceholderText text={setting.key} />
        </span>
        <span className="text-ink-500">=</span>
        <span>
          <PlaceholderText text={setting.value} />
        </span>
      </div>
      {setting.description && (
        <p className="text-xs text-ink-400 mb-3">{setting.description}</p>
      )}
      <div className="text-sm text-ink-100 whitespace-pre-wrap break-words bg-ink-950 border border-ink-700 rounded-md p-3 max-h-[55vh] overflow-auto">
        {setting.details}
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <Button
          onClick={() => {
            navigator.clipboard.writeText(iniSettingLine(setting));
            toast.success(`Copied ${setting.key}`);
          }}
        >
          Copy setting
        </Button>
        <Button onClick={onEdit}>Edit</Button>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function PasteIniModal({
  onImport,
  onClose,
}: {
  onImport: (parsed: ReturnType<typeof parseIniText>["settings"], replace: boolean) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const result = useMemo(() => parseIniText(text), [text]);

  async function loadFile() {
    const path = await pickFile("Select an INI file");
    if (!path) return;
    try {
      setText(await ipc<string>("read_text_file", { path }));
    } catch (e) {
      toast.error(`Could not read file: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <Modal title="Upload INI settings" onClose={onClose} wide>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-xs text-ink-400">
          Load an INI file, or paste the mod's config block straight from its
          CurseForge page. Section headers scope the settings below them, and
          comment lines become each setting's summary.
        </p>
        {isTauri && (
          <Button onClick={loadFile} className="shrink-0">
            Choose file…
          </Button>
        )}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
        autoFocus
        className="w-full bg-ink-950 border border-ink-600 rounded-md p-3 mono text-ink-100 focus:outline-none focus:border-accent-500/60"
        placeholder={`[ServerSettings]\n; Doubles XP for all players\nXPMultiplier=2.0\nTamingSpeedMultiplier=5.0\n\n[/script/shootergame.shootergamemode]\nbUseCorpseLocator=true`}
      />
      <div className="flex items-center justify-between mt-3">
        <div className="text-xs">
          <span className="text-accent-400">
            {result.settings.length} settings parsed
          </span>
          {result.skipped.length > 0 && (
            <span className="text-amber-400 ml-3">
              {result.skipped.length} line
              {result.skipped.length === 1 ? "" : "s"} ignored
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={result.settings.length === 0}
            onClick={() => onImport(result.settings, true)}
            title="Discard existing settings and use only these"
          >
            Replace all
          </Button>
          <Button
            variant="primary"
            disabled={result.settings.length === 0}
            onClick={() => onImport(result.settings, false)}
          >
            Add {result.settings.length}
          </Button>
        </div>
      </div>
      {result.settings.length > 0 && (
        <div className="mt-3 max-h-40 overflow-y-auto border-t border-ink-700 pt-2">
          {result.settings.slice(0, 30).map((s, i) => (
            <div key={i} className="mono text-xs text-ink-300">
              <span className="text-ink-500">
                {s.section ? `[${s.section}] ` : ""}
              </span>
              <span className="text-accent-400">{s.key}</span>={s.value}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function NotesModal({
  value,
  onSave,
  onClose,
}: {
  value: string;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(value);
  return (
    <Modal title="Config notes" onClose={onClose} wide>
      <p className="text-xs text-ink-400 mb-2">
        Anything that doesn't fit the Key=Value shape - install order, launch
        arguments, warnings, links to a config generator.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
        autoFocus
        className={cx(
          "w-full bg-ink-950 border border-ink-600 rounded-md p-3 text-sm",
          "text-ink-100 focus:outline-none focus:border-accent-500/60",
        )}
      />
      <div className="flex justify-end gap-2 mt-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            onSave(text);
            onClose();
            toast.success("Config notes saved");
          }}
        >
          Save notes
        </Button>
      </div>
    </Modal>
  );
}
