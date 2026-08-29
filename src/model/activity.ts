import { z } from "zod";

/**
 * A log of meaningful things that happened to this project.
 *
 * Recorded at commit boundaries only - a published output, a rule created, a
 * scrape applied. Deliberately not an edit journal: production rules save on
 * every keystroke, and an entry per character would bury the events worth
 * seeing. Nothing is ever inferred after the fact either; if the app did not
 * record it as it happened, it is not in here.
 */

export const ACTIVITY_KINDS = [
  "publish",
  "production",
  "remap",
  "cosmetics",
  "watchlist",
  "source",
  "settings",
  "players",
] as const;
export const ActivityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/** Where an entry sends you when clicked. Kept in step with the router. */
export const ACTIVITY_KIND_ROUTES: Record<ActivityKind, string> = {
  publish: "/publish",
  production: "/production",
  remap: "/remaps",
  cosmetics: "/curseforge",
  watchlist: "/curseforge",
  source: "/content",
  settings: "/settings",
  players: "/players",
};

export const ActivityEventSchema = z.object({
  id: z.string(),
  /** ISO timestamp of when it happened. */
  at: z.string(),
  kind: ActivityKindSchema,
  /** One line, already written for display. */
  title: z.string(),
  /** Optional second line - counts, names, commit shas. */
  detail: z.string().default(""),
  /** Overrides the kind's default route when the event has a better target. */
  to: z.string().default(""),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

/** What a caller supplies; the id and timestamp are stamped on recording. */
export type ActivityInput = Pick<ActivityEvent, "kind" | "title"> &
  Partial<Pick<ActivityEvent, "detail" | "to">>;

/**
 * How many events a project keeps. Enough to cover a working session or two;
 * bounded because this rides along in the project folder and syncs with it.
 */
export const ACTIVITY_LIMIT = 100;

export const ActivityFileSchema = z.object({
  schemaVersion: z.literal(1),
  events: z.array(ActivityEventSchema).default([]),
});
export type ActivityFile = z.infer<typeof ActivityFileSchema>;

export function emptyActivity(): ActivityFile {
  return { schemaVersion: 1, events: [] };
}

/**
 * Adds an event, newest first, trimming to {@link ACTIVITY_LIMIT}.
 *
 * Pure so the trimming rule is testable on its own - the store just calls it.
 */
export function appendActivity(
  file: ActivityFile,
  event: ActivityEvent,
): ActivityFile {
  return {
    ...file,
    events: [event, ...file.events].slice(0, ACTIVITY_LIMIT),
  };
}

/** The newest events, for Overview's Recent Activity list. */
export function recentActivity(
  file: ActivityFile,
  limit: number,
): ActivityEvent[] {
  return [...file.events]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** Where clicking an event should go. */
export function activityRoute(event: ActivityEvent): string {
  return event.to.trim() || ACTIVITY_KIND_ROUTES[event.kind];
}

/**
 * Clock time for the activity list. The list only ever shows the last day or
 * two of work, so the date is noise - but an event that is not from today
 * needs one, or "9:14 AM" silently means the wrong day.
 */
export function formatActivityTime(at: string, now = new Date()): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  const sameDay = when.toDateString() === now.toDateString();
  const time = when.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (sameDay) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (when.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}
