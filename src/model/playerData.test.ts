import { describe, expect, it } from "vitest";
import {
  defaultPlayerDataSettings,
  PlayerDataSettingsSchema,
  profileAgeDays,
  profileIsArchived,
  profileIsStale,
  rosterHealth,
  saveVersionWarning,
  SKILL_TREE_SAVE_VERSION,
  storedProfiles,
} from "./playerData";
import { newPlayer, StoredProfileSchema, type Player, type StoredProfile } from "./players";

const NOW = Date.parse("2026-08-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function profile(patch: Partial<StoredProfile> = {}): StoredProfile {
  return StoredProfileSchema.parse({
    fileName: "someone.arkprofile",
    storedAt: new Date(NOW).toISOString(),
    map: "Ragnarok",
    ...patch,
  });
}

/** A summary is a big record; only saveVersion matters to these helpers. */
function withVersion(saveVersion: number, patch: Partial<StoredProfile> = {}) {
  return profile({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summary: { saveVersion } as any,
    ...patch,
  });
}

function player(patch: Partial<Player> = {}): Player {
  return { ...newPlayer("p1"), ...patch };
}

describe("PlayerDataSettingsSchema", () => {
  it("defaults to flagging without archiving", () => {
    const s = defaultPlayerDataSettings();
    expect(s.staleAfterDays).toBe(90);
    expect(s.autoArchiveStale).toBe(false);
    expect(s.warnOnSaveVersion).toBe(true);
  });

  it("fills in defaults for a project saved before the policy existed", () => {
    expect(PlayerDataSettingsSchema.parse({})).toEqual(defaultPlayerDataSettings());
  });
});

describe("profileAgeDays", () => {
  it("counts whole days since storage", () => {
    expect(profileAgeDays(profile(), NOW)).toBe(0);
    expect(profileAgeDays(profile(), NOW + 5 * DAY)).toBe(5);
    // Part of a day does not round up.
    expect(profileAgeDays(profile(), NOW + 5 * DAY + 23 * 60 * 60 * 1000)).toBe(5);
  });

  it("never reports a negative age for a clock that has drifted", () => {
    expect(profileAgeDays(profile(), NOW - 3 * DAY)).toBe(0);
  });

  it("returns null when no date was recorded", () => {
    expect(profileAgeDays(profile({ storedAt: "" }), NOW)).toBeNull();
  });
});

describe("profileIsStale", () => {
  const settings = defaultPlayerDataSettings();

  it("turns over exactly at the threshold", () => {
    expect(profileIsStale(profile(), settings, NOW + 89 * DAY)).toBe(false);
    expect(profileIsStale(profile(), settings, NOW + 90 * DAY)).toBe(true);
  });

  it("is off entirely at zero days", () => {
    const off = { ...settings, staleAfterDays: 0 };
    expect(profileIsStale(profile(), off, NOW + 5000 * DAY)).toBe(false);
  });

  it("never calls an undated profile stale", () => {
    expect(profileIsStale(profile({ storedAt: "" }), settings, NOW + 500 * DAY)).toBe(
      false,
    );
  });
});

describe("profileIsArchived", () => {
  const settings = defaultPlayerDataSettings();

  it("honours a hand-archived save whatever the policy says", () => {
    const archived = profile({ archivedAt: new Date(NOW).toISOString() });
    expect(profileIsArchived(archived, settings, NOW)).toBe(true);
  });

  it("only auto-archives stale saves when asked to", () => {
    const old = NOW + 200 * DAY;
    expect(profileIsArchived(profile(), settings, old)).toBe(false);
    expect(
      profileIsArchived(profile(), { ...settings, autoArchiveStale: true }, old),
    ).toBe(true);
  });

  it("leaves a fresh save alone even with auto-archiving on", () => {
    expect(
      profileIsArchived(profile(), { ...settings, autoArchiveStale: true }, NOW),
    ).toBe(false);
  });
});

describe("saveVersionWarning", () => {
  const settings = defaultPlayerDataSettings();

  it("flags a pre-Lost-Colony save as having no skill tree data", () => {
    const warning = saveVersionWarning(withVersion(5), settings);
    expect(warning?.label).toContain("v5");
    expect(warning?.detail).toContain("skill tree");
  });

  it("says nothing about a current save", () => {
    expect(
      saveVersionWarning(withVersion(SKILL_TREE_SAVE_VERSION), settings),
    ).toBeNull();
  });

  it("flags a profile stored before the app could read save data", () => {
    expect(saveVersionWarning(profile({ summary: null }), settings)?.label).toBe(
      "Save format unknown",
    );
  });

  it("stays quiet when the warning is switched off", () => {
    const off = { ...settings, warnOnSaveVersion: false };
    expect(saveVersionWarning(withVersion(5), off)).toBeNull();
    expect(saveVersionWarning(profile({ summary: null }), off)).toBeNull();
  });
});

describe("storedProfiles", () => {
  it("skips players who have no save", () => {
    const roster = [player({ id: "a", profile: profile() }), player({ id: "b" })];
    expect(storedProfiles(roster).map((s) => s.player.id)).toEqual(["a"]);
  });
});

describe("rosterHealth", () => {
  const settings = defaultPlayerDataSettings();

  it("counts each concern independently", () => {
    const roster = [
      player({ id: "a", profile: withVersion(7) }),
      player({ id: "b", profile: withVersion(5) }),
      player({
        id: "c",
        profile: withVersion(7, { archivedAt: new Date(NOW).toISOString() }),
      }),
      player({ id: "d" }),
    ];
    const health = rosterHealth(roster, settings, NOW);
    expect(health).toEqual({ stale: 0, archived: 1, outdatedFormat: 1 });
  });

  it("counts a save as both stale and archived once auto-archiving is on", () => {
    const roster = [player({ id: "a", profile: withVersion(7) })];
    const health = rosterHealth(
      roster,
      { ...settings, autoArchiveStale: true },
      NOW + 200 * DAY,
    );
    expect(health.stale).toBe(1);
    expect(health.archived).toBe(1);
  });
});
