/** Number text accepted by production-rule inputs. */
const NUMBER_SOURCE = String.raw`(?:\d+(?:\.\d*)?|\.\d+)`;
const PLAIN_NUMBER = new RegExp(`^${NUMBER_SOURCE}$`);
const PERCENTAGE = new RegExp(`^(${NUMBER_SOURCE})\\s*%$`);

/**
 * Parses a probability written either as a stored fraction or a percentage.
 *
 * Fractions must already be between 0 and 1. Values above 1 require a `%`, so
 * accidentally typing `10` cannot silently become either 10% or an invalid
 * stored probability.
 */
export function parseChanceInput(raw: string): number | null {
  const text = raw.trim();
  const percentage = PERCENTAGE.exec(text);
  const value = percentage
    ? Number(percentage[1]) / 100
    : PLAIN_NUMBER.test(text)
      ? Number(text)
      : Number.NaN;
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

const DURATION_TOKEN = new RegExp(
  `(${NUMBER_SOURCE})\\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)`,
  "gi",
);

function durationMultiplier(unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("h")) return 3600;
  if (normalized.startsWith("m")) return 60;
  return 1;
}

/**
 * Parses seconds, minutes, and hours, including compact compound values.
 *
 * A unitless number remains seconds for compatibility with the existing
 * field. Examples: `94`, `94s`, `1 minute`, `1min 34s`, `1.5 hours`.
 */
export function parseDurationInput(raw: string): number | null {
  const text = raw.trim();
  if (PLAIN_NUMBER.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  DURATION_TOKEN.lastIndex = 0;
  let seconds = 0;
  let end = 0;
  let found = false;
  for (const match of text.matchAll(DURATION_TOKEN)) {
    if (text.slice(end, match.index).trim()) return null;
    seconds += Number(match[1]) * durationMultiplier(match[2]);
    end = (match.index ?? 0) + match[0].length;
    found = true;
  }
  if (!found || text.slice(end).trim()) return null;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Stored probability as a percentage for the subdued field hint. */
export function formatChance(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const percentage = Math.round(value * 10_000) / 100;
  return `${percentage}%`;
}

/** Seconds as a compact, exact human-readable duration. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || !(seconds > 0)) return "—";

  const rounded = Math.round(seconds * 1000) / 1000;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded - hours * 3600) / 60);
  const remaining = Math.round((rounded - hours * 3600 - minutes * 60) * 1000) / 1000;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}hr`);
  if (minutes) parts.push(`${minutes}min`);
  if (remaining) parts.push(`${remaining}s`);
  return parts.join(" ") || "—";
}
