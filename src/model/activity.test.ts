import { describe, expect, it } from "vitest";
import {
  ACTIVITY_KIND_ROUTES,
  ACTIVITY_LIMIT,
  ActivityFileSchema,
  activityRoute,
  appendActivity,
  emptyActivity,
  formatActivityTime,
  recentActivity,
  type ActivityEvent,
} from "./activity";

function event(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "e1",
    at: "2026-08-09T12:00:00.000Z",
    kind: "publish",
    title: "Published Passive Production",
    detail: "",
    to: "",
    ...over,
  };
}

describe("appendActivity", () => {
  it("puts the newest event first", () => {
    const file = appendActivity(
      appendActivity(emptyActivity(), event({ id: "a" })),
      event({ id: "b" }),
    );
    expect(file.events.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("keeps the log bounded so it cannot grow with the project", () => {
    let file = emptyActivity();
    for (let i = 0; i < ACTIVITY_LIMIT + 25; i++) {
      file = appendActivity(file, event({ id: `e${i}` }));
    }
    expect(file.events).toHaveLength(ACTIVITY_LIMIT);
    // The newest survive; the oldest fall off.
    expect(file.events[0].id).toBe(`e${ACTIVITY_LIMIT + 24}`);
    expect(file.events.some((e) => e.id === "e0")).toBe(false);
  });

  it("does not mutate the file it was given", () => {
    const before = emptyActivity();
    appendActivity(before, event());
    expect(before.events).toHaveLength(0);
  });
});

describe("recentActivity", () => {
  it("returns the newest events by timestamp, whatever order they are stored in", () => {
    const file = {
      ...emptyActivity(),
      events: [
        event({ id: "old", at: "2026-08-01T09:00:00.000Z" }),
        event({ id: "new", at: "2026-08-09T09:00:00.000Z" }),
        event({ id: "mid", at: "2026-08-05T09:00:00.000Z" }),
      ],
    };
    expect(recentActivity(file, 2).map((e) => e.id)).toEqual(["new", "mid"]);
  });

  it("copes with fewer events than asked for", () => {
    expect(recentActivity(emptyActivity(), 8)).toEqual([]);
  });
});

describe("activityRoute", () => {
  it("falls back to the kind's page", () => {
    expect(activityRoute(event({ kind: "cosmetics" }))).toBe("/curseforge");
    expect(activityRoute(event({ kind: "production" }))).toBe("/production");
  });

  it("prefers an explicit target", () => {
    expect(activityRoute(event({ kind: "publish", to: "/settings" }))).toBe(
      "/settings",
    );
  });

  it("has a route for every kind", () => {
    for (const [kind, route] of Object.entries(ACTIVITY_KIND_ROUTES)) {
      expect(route.startsWith("/"), kind).toBe(true);
    }
  });
});

describe("formatActivityTime", () => {
  const now = new Date("2026-08-09T15:00:00");

  it("shows just the time for today", () => {
    const text = formatActivityTime("2026-08-09T09:14:00", now);
    expect(text).toMatch(/9:14/);
    expect(text).not.toMatch(/Aug/);
  });

  it("marks yesterday explicitly", () => {
    // "9:14 AM" alone would silently read as today.
    expect(formatActivityTime("2026-08-08T09:14:00", now)).toMatch(/^Yesterday/);
  });

  it("dates anything older", () => {
    expect(formatActivityTime("2026-08-02T09:14:00", now)).toMatch(/Aug 2/);
  });

  it("returns nothing for an unparseable timestamp", () => {
    expect(formatActivityTime("not a date", now)).toBe("");
  });
});

describe("ActivityFileSchema", () => {
  it("defaults the optional fields so older files still load", () => {
    const parsed = ActivityFileSchema.parse({
      schemaVersion: 1,
      events: [
        { id: "a", at: "2026-08-09T12:00:00.000Z", kind: "remap", title: "Added" },
      ],
    });
    expect(parsed.events[0].detail).toBe("");
    expect(parsed.events[0].to).toBe("");
  });

  it("defaults a file with no events at all", () => {
    expect(ActivityFileSchema.parse({ schemaVersion: 1 }).events).toEqual([]);
  });

  it("rejects an unknown activity kind rather than silently dropping it", () => {
    const result = ActivityFileSchema.safeParse({
      schemaVersion: 1,
      events: [{ id: "a", at: "2026-08-09T12:00:00.000Z", kind: "nope", title: "x" }],
    });
    expect(result.success).toBe(false);
  });
});
