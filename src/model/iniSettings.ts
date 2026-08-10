import type { IniSetting } from "./catalog";

/** Parsing and rendering of mod server-config INI settings. */

export const INI_FILES = ["GameUserSettings.ini", "Game.ini"] as const;

export const VALUE_TYPES = [
  "bool",
  "int",
  "float",
  "string",
  "url",
  "struct",
] as const;
export type IniValueType = (typeof VALUE_TYPES)[number] | "";

/** Matches a value that is entirely one `<placeholder>`. */
const PURE_PLACEHOLDER = /^<([^>]*)>$/;

/**
 * The part of a value that carries its type. `<1>` is a placeholder whose
 * options live in the Extended Notes, but the inner `1` is what tells us the
 * setting is an int — so only the inner content is ever type-checked.
 */
export function typedPart(value: string): string {
  const t = value.trim();
  const m = t.match(PURE_PLACEHOLDER);
  return m ? m[1].trim() : t;
}

/** Normalises a typed boolean to ARK's Proper case: `true` -> `True`. */
export function properCaseBool(value: string): string {
  const trimmed = value.trim();
  if (/^true$/i.test(trimmed)) return "True";
  if (/^false$/i.test(trimmed)) return "False";
  return value;
}

/** Placeholder names appearing in a key or value, in order, de-duplicated. */
export function findPlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/<([^>]+)>/g)) {
    const name = match[1].trim();
    if (name && !out.some((n) => n.toLowerCase() === name.toLowerCase())) {
      out.push(name);
    }
  }
  return out;
}

/** Best guess at a value's type, used to pre-fill on paste. */
export function inferValueType(value: string): IniValueType {
  const v = typedPart(value);
  if (!v) return "";
  if (/^(true|false)$/i.test(v)) return "bool";
  if (/^-?\d+$/.test(v)) return "int";
  if (/^-?\d*\.\d+$/.test(v)) return "float";
  if (/^https?:\/\//i.test(v)) return "url";
  if (v.startsWith("(")) return "struct";
  return "string";
}

/**
 * Human-readable complaint when a value doesn't match its declared type.
 * For a `<placeholder>` the inner content is what gets checked, so `<1>` is a
 * valid int placeholder while `<HelloWorld>` is not.
 */
export function validateValue(value: string, type: string): string | null {
  const v = typedPart(value);
  if (!type || !v) return null;
  switch (type) {
    case "bool":
      return /^(true|false)$/i.test(v) ? null : "Expected True or False";
    case "int":
      return /^-?\d+$/.test(v) ? null : "Expected a whole number";
    case "float":
      return /^-?\d*\.?\d+$/.test(v) ? null : "Expected a number";
    case "url":
      return /^https?:\/\//i.test(v) ? null : "Expected an http(s) URL";
    case "struct":
      return v.startsWith("(") && v.endsWith(")")
        ? null
        : "Expected a (…) struct value";
    default:
      return null;
  }
}

const GAME_USER_SECTIONS = [
  "serversettings",
  "sessionsettings",
  "messageoftheday",
  "/script/engine.gamesession",
];

/**
 * Best guess at which file a section belongs in. `[/script/shootergame.shootergamemode]`
 * is Game.ini; the well-known server sections are GameUserSettings.ini.
 * Mod-specific sections are left blank for the admin to set.
 */
export function inferIniFile(section: string): string {
  const s = section.trim().toLowerCase();
  if (!s) return "";
  if (s.includes("shootergamemode")) return "Game.ini";
  if (GAME_USER_SECTIONS.some((known) => s === known || s.includes(known))) {
    return "GameUserSettings.ini";
  }
  return "";
}

/**
 * Index of the `;` that starts a trailing comment, ignoring semicolons inside
 * quotes or parentheses — ARK values like
 * `ConfigOverrideItemMaxQuantity=(ItemClassString="X",Quantity=(...))` are common.
 */
function trailingCommentAt(value: string): number {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') inQuote = !inQuote;
    else if (inQuote) continue;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) return i;
  }
  return -1;
}

export type ParsedIniSetting = Omit<
  IniSetting,
  "id" | "details" | "required" | "added"
>;

export interface IniParseResult {
  settings: ParsedIniSetting[];
  /** Lines that were neither a section, comment, nor Key=Value. */
  skipped: string[];
}

/**
 * Parses a pasted INI block. Section headers scope the settings that follow,
 * and comment lines (`;` or `#`) directly above a setting — or trailing it —
 * become that setting's description.
 */
export function parseIniText(text: string): IniParseResult {
  const settings: ParsedIniSetting[] = [];
  const skipped: string[] = [];
  let section = "";
  let pending: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      pending = [];
      continue;
    }
    if (/^[;#]/.test(line)) {
      pending.push(line.replace(/^[;#]+\s?/, "").trim());
      continue;
    }
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      pending = [];
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      skipped.push(line);
      pending = [];
      continue;
    }

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    let inline = "";
    const commentAt = trailingCommentAt(value);
    if (commentAt >= 0) {
      inline = value.slice(commentAt + 1).trim();
      value = value.slice(0, commentAt).trim();
    }

    const description = [pending.join(" ").trim(), inline]
      .filter(Boolean)
      .join(" — ");

    settings.push({
      section,
      key,
      value,
      type: inferValueType(value),
      file: inferIniFile(section),
      description,
    });
    pending = [];
  }

  return { settings, skipped };
}

/**
 * Renders settings as a pasteable INI block, grouped by file and section.
 * Descriptions are omitted by default so a copy contains only config — the
 * file banner survives only when settings span more than one file, since
 * merging Game.ini and GameUserSettings.ini lines would be a real footgun.
 */
export function iniSettingsToText(
  settings: IniSetting[],
  includeComments = false,
): string {
  if (settings.length === 0) return "";

  const byFile = new Map<string, IniSetting[]>();
  for (const setting of settings) {
    const file = setting.file || "";
    const list = byFile.get(file) ?? [];
    list.push(setting);
    byFile.set(file, list);
  }

  // Named files first, "unspecified" last.
  const files = [...byFile.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  const blocks: string[] = [];
  const multiFile = files.length > 1;
  for (const file of files) {
    const lines: string[] = [];
    if (file && (includeComments || multiFile)) {
      lines.push(`; ===== ${file} =====`);
    }

    const bySection = new Map<string, IniSetting[]>();
    for (const setting of byFile.get(file)!) {
      const list = bySection.get(setting.section) ?? [];
      list.push(setting);
      bySection.set(setting.section, list);
    }

    for (const [section, group] of bySection) {
      if (section) lines.push(`[${section}]`);
      for (const setting of group) {
        if (includeComments && setting.description) {
          lines.push(`; ${setting.description}`);
        }
        lines.push(`${setting.key}=${setting.value}`);
      }
      lines.push("");
    }
    blocks.push(lines.join("\n").trimEnd());
  }
  return blocks.join("\n\n");
}

/** A single pasteable line for one setting. */
export function iniSettingLine(setting: IniSetting): string {
  return `${setting.key}=${setting.value}`;
}

// ---------------------------------------------------------------------------
// Placeholder option lists, defined in a setting's Extended Notes
// ---------------------------------------------------------------------------

/** Guard against a careless range like `1-100000`. */
const MAX_RANGE = 500;

/**
 * Expands `1-9` into the whole numbers 1…9. A dash between two integers means
 * "through"; anything else is taken literally (so `Raw-Meat` stays one option).
 */
export function expandRange(item: string): string[] {
  const match = item.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
  if (!match) return [item];
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [item];
  const step = from <= to ? 1 : -1;
  const out: string[] = [];
  for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
    out.push(String(v));
    if (out.length >= MAX_RANGE) break;
  }
  return out;
}

/**
 * Reads the option lists an admin wrote in a setting's Extended Notes:
 *
 *   <Creature>
 *   - Ammonite
 *   - Cnidaria
 *
 * A line that is just `<Name>` (optionally as a markdown heading) opens a
 * list; the `-`/`*` bullets under it are its options, until the next `<Name>`.
 * Keyed by lowercased name so lookups are case-insensitive.
 */
export function parseNoteOptions(details: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current: string | null = null;

  for (const raw of details.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("```")) continue;

    const header = line.match(/^#{0,6}\s*<([^>]+)>\s*$/);
    if (header) {
      current = header[1].trim().toLowerCase();
      if (!map.has(current)) map.set(current, []);
      continue;
    }
    if (!current) continue;

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      const item = bullet[1].trim();
      if (item) map.get(current)!.push(...expandRange(item));
    }
  }
  return map;
}

/**
 * Whether a setting takes part in Build INI. Required settings are always
 * included and can't be removed, so this also repairs older data where
 * `required` was set before `added` existed.
 */
export function isAddedToBuild(setting: IniSetting): boolean {
  return setting.required || setting.added;
}

/**
 * Ensures every `<placeholder>` used by a setting has a section in its
 * Extended Notes. Only the `<Name>` header is written — the "how to fill this
 * in" guidance is rendered as UI hint text, never as editable content that
 * would have to be deleted before typing the first option.
 */
export function scaffoldPlaceholderSections(
  key: string,
  value: string,
  details: string,
): string {
  const used = findPlaceholders(`${key} ${value}`);
  if (used.length === 0) return details;

  const existing = parseNoteOptions(details);
  const missing = used.filter((name) => !existing.has(name.toLowerCase()));
  if (missing.length === 0) return details;

  const body = missing.map((name) => `<${name}>`).join("\n\n");
  return details.trim() ? `${details.trimEnd()}\n\n${body}` : body;
}

/**
 * Placeholders used by a setting that have no options listed yet, so the
 * editor can prompt for them without writing anything into the notes.
 */
export function placeholdersNeedingOptions(
  key: string,
  value: string,
  details: string,
): string[] {
  const options = parseNoteOptions(details);
  return findPlaceholders(`${key} ${value}`).filter(
    (name) => (options.get(name.toLowerCase()) ?? []).length === 0,
  );
}

/**
 * Drops notes sections for placeholders the setting no longer uses, but only
 * when they are empty. Typing `<test>` a character at a time leaves `<t>`,
 * `<te>` and `<tes>` behind; renaming a placeholder strands the old one. An
 * options list is admin-written work, so a section that has any is kept
 * whatever the key says.
 */
export function pruneEmptyPlaceholderSections(
  key: string,
  value: string,
  details: string,
): string {
  const used = new Set(
    findPlaceholders(`${key} ${value}`).map((n) => n.toLowerCase()),
  );
  const options = parseNoteOptions(details);

  const stale = new Set<string>();
  for (const [name, list] of options) {
    if (!used.has(name) && list.length === 0) stale.add(name);
  }
  if (stale.size === 0) return details;

  const kept: string[] = [];
  let dropping = false;
  for (const raw of details.split(/\r?\n/)) {
    const header = raw.trim().match(/^#{0,6}\s*<([^>]+)>\s*$/);
    if (header) dropping = stale.has(header[1].trim().toLowerCase());
    if (!dropping) kept.push(raw);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Brings a setting's notes in step with the placeholders its key and value
 * use: stale empty sections out, missing ones in. Run when a field is done
 * being edited, never mid-keystroke.
 */
export function syncPlaceholderSections(
  key: string,
  value: string,
  details: string,
): string {
  return scaffoldPlaceholderSections(
    key,
    value,
    pruneEmptyPlaceholderSections(key, value, details),
  );
}

/** Options that don't satisfy the setting's declared value type. */
export function invalidOptions(options: string[], type: string): string[] {
  if (!type) return [];
  return options.filter((option) => validateValue(option, type) !== null);
}

// ---------------------------------------------------------------------------
// Build INI: turning a template into concrete lines
// ---------------------------------------------------------------------------

/** Cap on generated lines, so several multi-selects can't explode. */
export const MAX_BUILD_LINES = 200;

/**
 * Substitutes chosen placeholder values into a key/value pair, producing one
 * line per combination. Placeholders with nothing chosen are left as-is so
 * the output still shows what's outstanding.
 */
export interface ExpandOptions {
  /**
   * Per-option value overrides, keyed by placeholder then option — lets each
   * creature in `PreventRemapping<creature>` carry its own value.
   */
  optionValues?: Record<string, Record<string, string>>;
  max?: number;
}

export function expandPlaceholders(
  key: string,
  value: string,
  choices: Record<string, string[]>,
  { optionValues = {}, max = MAX_BUILD_LINES }: ExpandOptions = {},
): string[] {
  const names = findPlaceholders(`${key} ${value}`);
  let combos: Record<string, string>[] = [{}];

  for (const name of names) {
    const lower = name.toLowerCase();
    const chosen = choices[lower]?.filter(Boolean) ?? [];
    const options = chosen.length > 0 ? chosen : [`<${name}>`];
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const option of options) {
        if (next.length >= max) break;
        next.push({ ...combo, [lower]: option });
      }
    }
    combos = next;
  }

  const substitute = (text: string, combo: Record<string, string>) =>
    text.replace(/<([^>]+)>/g, (whole, name: string) => {
      const replacement = combo[name.trim().toLowerCase()];
      return replacement ?? whole;
    });

  return combos.map((combo) => {
    // A chosen option may override the value for just its own line.
    let effective = value;
    for (const [name, perOption] of Object.entries(optionValues)) {
      const chosen = combo[name.toLowerCase()];
      const override = chosen == null ? undefined : perOption[chosen];
      if (override !== undefined && override !== "") {
        effective = override;
        break;
      }
    }
    return `${substitute(key, combo)}=${substitute(effective, combo)}`;
  });
}

export interface BuildEntry {
  setting: IniSetting;
  /** Working value for this build — never written back to the default. */
  value: string;
  /** Placeholder name (lowercased) -> chosen options. */
  choices: Record<string, string[]>;
  /** Placeholder name (lowercased) -> option -> that option's own value. */
  optionValues?: Record<string, Record<string, string>>;
}

/** Renders a Build INI block: config only, grouped by file and section. */
export function buildIniText(entries: BuildEntry[]): string {
  if (entries.length === 0) return "";

  const byFile = new Map<string, BuildEntry[]>();
  for (const entry of entries) {
    const file = entry.setting.file || "";
    const list = byFile.get(file) ?? [];
    list.push(entry);
    byFile.set(file, list);
  }
  const files = [...byFile.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  const multiFile = files.length > 1;
  const blocks: string[] = [];
  for (const file of files) {
    const lines: string[] = [];
    if (file && multiFile) lines.push(`; ===== ${file} =====`);

    const bySection = new Map<string, BuildEntry[]>();
    for (const entry of byFile.get(file)!) {
      const list = bySection.get(entry.setting.section) ?? [];
      list.push(entry);
      bySection.set(entry.setting.section, list);
    }

    for (const [section, group] of bySection) {
      if (section) lines.push(`[${section}]`);
      for (const entry of group) {
        lines.push(
          ...expandPlaceholders(entry.setting.key, entry.value, entry.choices, {
            optionValues: entry.optionValues,
          }),
        );
      }
      lines.push("");
    }
    blocks.push(lines.join("\n").trimEnd());
  }
  return blocks.join("\n\n");
}
