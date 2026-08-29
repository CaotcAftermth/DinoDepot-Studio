import { describe, expect, it } from "vitest";
import { WatchedModSchema, WatchlistSchema, type WatchedMod } from "./watchlist";

const mod = (patch: Partial<WatchedMod> = {}): WatchedMod => ({
  id: "w1",
  modId: "912345",
  name: "Some Mod",
  url: "https://cf/mod",
  knownUpdated: "2026-05-01",
  latestUpdated: "2026-05-01",
  lastCheckedAt: "2026-05-02T00:00:00.000Z",
  needsReview: false,
  notes: "",
  watching: true,
  ...patch,
});

describe("WatchedMod schema", () => {
  it("treats entries written before `watching` existed as watched", () => {
    const legacy = { ...mod() } as Record<string, unknown>;
    delete legacy.watching;
    expect(WatchedModSchema.parse(legacy).watching).toBe(true);
  });

  it("round-trips a parked entry with its history intact", () => {
    const parked = WatchlistSchema.parse({
      schemaVersion: 1,
      mods: [mod({ watching: false, notes: "check the new saddle" })],
    });
    expect(parked.mods[0].watching).toBe(false);
    expect(parked.mods[0].knownUpdated).toBe("2026-05-01");
    expect(parked.mods[0].notes).toBe("check the new saddle");
  });
});

/**
 * The point of keeping a parked entry: `applyResults` only baselines when
 * `knownUpdated` is empty, so a retained value means an update released while
 * the mod was unwatched still gets flagged on the next check.
 */
function reviewOutcome(known: string, scraped: string) {
  const first = !known;
  return {
    baselined: first,
    needsReview: !first && scraped !== known,
  };
}

describe("re-watching after a pause", () => {
  it("flags an update that landed while the mod was unwatched", () => {
    expect(reviewOutcome("2026-05-01", "2026-06-10")).toEqual({
      baselined: false,
      needsReview: true,
    });
  });

  it("stays quiet when nothing changed while it was unwatched", () => {
    expect(reviewOutcome("2026-05-01", "2026-05-01")).toEqual({
      baselined: false,
      needsReview: false,
    });
  });

  it("silently baselines when the history was discarded - what we avoid", () => {
    expect(reviewOutcome("", "2026-06-10")).toEqual({
      baselined: true,
      needsReview: false,
    });
  });
});
