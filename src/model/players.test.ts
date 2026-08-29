import { describe, expect, it } from "vitest";
import {
  comparePlayers,
  hasPlayerDetails,
  newPlayer,
  rosterMaps,
  playerChoices,
  PlayersFileSchema,
  playerLabel,
  playerMatches,
  profileIsBroken,
  StoredProfileSchema,
  PLAYER_ROWS,
  type Player,
} from "./players";

const player = (patch: Partial<Player> = {}): Player => ({
  ...newPlayer("p1"),
  ...patch,
});

describe("playerLabel", () => {
  it("prefers the Discord name", () => {
    expect(
      playerLabel(player({ discordName: "survivor", steamName: "steamy" })),
    ).toBe("survivor");
  });

  it("falls through the identifiers in order", () => {
    expect(playerLabel(player({ gameName: "Joe the Bold" }))).toBe(
      "Joe the Bold",
    );
    expect(playerLabel(player({ steamName: "steamy" }))).toBe("steamy");
    expect(playerLabel(player({ playerId: "12345" }))).toBe("12345");
    expect(playerLabel(player({ eosId: "0002abcd" }))).toBe("0002abcd");
  });

  it("prefers the game name over the Steam name", () => {
    expect(
      playerLabel(player({ gameName: "Joe the Bold", steamName: "steamy" })),
    ).toBe("Joe the Bold");
  });

  it("has a fallback when every field is blank", () => {
    expect(playerLabel(player())).toBe("(unnamed player)");
  });

  it("ignores whitespace-only fields", () => {
    expect(playerLabel(player({ discordName: "  ", steamName: "steamy" }))).toBe(
      "steamy",
    );
  });
});

describe("playerMatches", () => {
  const p = player({
    discordName: "Survivor",
    steamName: "SteamGuy",
    gameName: "Joe the Bold",
    eosId: "0002ABCD",
    playerId: "112233",
    notes: "Tribe Alpha",
  });

  it("matches an empty query", () => {
    expect(playerMatches(p, "  ")).toBe(true);
  });

  it("searches every identifier, case-insensitively", () => {
    for (const q of ["surv", "steamguy", "the bold", "0002abcd", "1122", "alpha"]) {
      expect(playerMatches(p, q)).toBe(true);
    }
  });

  it("rejects something that appears nowhere", () => {
    expect(playerMatches(p, "zzz")).toBe(false);
  });
});

describe("searching and ordering", () => {
  const stored = (map: string) =>
    StoredProfileSchema.parse({ fileName: "x.arkprofile", storedAt: "x", map });

  it("finds a player by the map their profile came from", () => {
    const p = player({ discordName: "Survivor", profile: stored("Scorched Earth") });
    expect(playerMatches(p, "scorched")).toBe(true);
    expect(playerMatches(p, "ragnarok")).toBe(false);
  });

  it("orders by the label each row shows, ignoring case", () => {
    const roster = [
      player({ id: "c", gameName: "zeta" }),
      player({ id: "a", discordName: "Alpha" }),
      player({ id: "b", steamName: "beta" }),
    ];
    expect([...roster].sort(comparePlayers).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("lists the maps the roster has profiles for", () => {
    const roster = [
      player({ id: "a", profile: stored("Ragnarok") }),
      player({ id: "b", profile: stored("Scorched Earth") }),
      player({ id: "c", profile: stored("Ragnarok") }),
      player({ id: "d" }),
    ];
    expect(rosterMaps(roster)).toEqual(["Ragnarok", "Scorched Earth"]);
  });
});

describe("PLAYER_ROWS", () => {
  it("pairs each platform's name with its own id", () => {
    expect(PLAYER_ROWS.map((r) => [r.label, r.nameKey, r.idKey])).toEqual([
      ["Discord", "discordName", "discordId"],
      ["Steam", "steamName", "steamId"],
      ["Game", "gameName", "playerId"],
      ["Account", "accountName", "eosId"],
    ]);
  });
});

describe("playerChoices", () => {
  const roster = [
    player({
      id: "a",
      discordName: "zoe",
      gameName: "Zoe the Swift",
      playerId: "999",
    }),
    player({ id: "b", gameName: "Alan", steamName: "AlanS", playerId: "111" }),
    player({ id: "c", discordName: "NoIdHere" }),
  ];

  it("offers only players that have the requested identifier", () => {
    const choices = playerChoices(roster, "playerId");
    expect(choices.map((c) => c.value)).toEqual(["111", "999"]);
  });

  it("sorts by the shown name", () => {
    expect(playerChoices(roster, "playerId").map((c) => c.label)).toEqual([
      "Alan",
      "zoe",
    ]);
  });

  it("labels with Discord first, then game, then Steam", () => {
    const choices = playerChoices(roster, "playerId");
    expect(choices.find((c) => c.value === "999")?.label).toBe("zoe");
    expect(choices.find((c) => c.value === "111")?.label).toBe("Alan");
  });

  it("carries the other names so any of them can be searched", () => {
    const zoe = playerChoices(roster, "playerId").find((c) => c.value === "999");
    expect(zoe?.aka).toBe("Zoe the Swift");
    const alan = playerChoices(roster, "playerId").find((c) => c.value === "111");
    expect(alan?.aka).toBe("AlanS");
  });

  it("is empty when nobody has that identifier", () => {
    expect(playerChoices(roster, "eosId")).toEqual([]);
  });

  it("ignores a whitespace-only value", () => {
    expect(playerChoices([player({ playerId: "   " })], "playerId")).toEqual([]);
  });
});

describe("hasPlayerDetails", () => {
  it("is false for a brand-new record", () => {
    expect(hasPlayerDetails(player())).toBe(false);
  });

  it("is true once any identifier is filled in", () => {
    expect(hasPlayerDetails(player({ gameName: "Joe" }))).toBe(true);
    expect(hasPlayerDetails(player({ eosId: "0002abcd" }))).toBe(true);
  });

  it("counts notes on their own", () => {
    expect(hasPlayerDetails(player({ notes: "banned once" }))).toBe(true);
  });

  it("ignores whitespace-only values", () => {
    expect(hasPlayerDetails(player({ discordName: "   " }))).toBe(false);
  });
});

describe("PlayersFile schema", () => {
  it("defaults a player's optional fields", () => {
    const parsed = PlayersFileSchema.parse({
      schemaVersion: 1,
      players: [{ id: "p1" }],
    });
    expect(parsed.players[0].profile).toBeNull();
    expect(parsed.players[0].eosId).toBe("");
  });

  it("round-trips a stored profile", () => {
    const parsed = PlayersFileSchema.parse({
      schemaVersion: 1,
      players: [
        {
          id: "p1",
          profile: {
            fileName: "112233.arkprofile",
            storedAt: "2026-05-01T00:00:00.000Z",
          },
        },
      ],
    });
    expect(parsed.players[0].profile?.fileName).toBe("112233.arkprofile");
    expect(parsed.players[0].profile?.storedAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("drops the size and source a previous version wrote", () => {
    const parsed = PlayersFileSchema.parse({
      schemaVersion: 1,
      players: [
        {
          id: "p1",
          profile: {
            fileName: "112233.arkprofile",
            storedAt: "2026-05-01T00:00:00.000Z",
            sizeBytes: 4096,
            sourcePath: "C:/old/path.arkprofile",
          },
        },
      ],
    });
    expect(parsed.players[0].profile).toEqual({
      fileName: "112233.arkprofile",
      storedAt: "2026-05-01T00:00:00.000Z",
      map: "",
      backedUpAt: null,
      // A profile stored before the app could read one has no summary.
      summary: null,
      generated: false,
      // Predates the archive flag, so it loads as current rather than hidden.
      archivedAt: null,
    });
  });

  /**
   * A Rust struct returning snake_case once wrote `fileName: undefined` into
   * every stored profile. JSON.stringify drops undefined keys, so the file
   * came back missing the name - and a strict schema threw away the entire
   * roster over it. The record must survive; only the file link is lost.
   */
  it("keeps the roster when a profile lost its file name", () => {
    const parsed = PlayersFileSchema.parse({
      schemaVersion: 1,
      players: [
        {
          id: "p1",
          discordName: "survivor",
          profile: { storedAt: "2026-05-01T00:00:00.000Z", map: "Ragnarok" },
        },
      ],
    });
    expect(parsed.players).toHaveLength(1);
    expect(parsed.players[0].discordName).toBe("survivor");
    expect(parsed.players[0].profile?.fileName).toBe("");
  });

  it("flags a profile with no file name as broken", () => {
    // Built through the schema so adding a stored-profile field does not mean
    // editing every literal in this file.
    const stored = (fileName: string) =>
      StoredProfileSchema.parse({ fileName, storedAt: "x" });
    expect(profileIsBroken(stored(""))).toBe(true);
    expect(profileIsBroken(stored("   "))).toBe(true);
    expect(profileIsBroken(stored("a.arkprofile"))).toBe(false);
    expect(profileIsBroken(null)).toBe(false);
  });

  it("treats a profile stored before backups existed as not backed up", () => {
    const parsed = PlayersFileSchema.parse({
      schemaVersion: 1,
      players: [
        {
          id: "p1",
          profile: {
            fileName: "x.arkprofile",
            storedAt: "2026-05-01T00:00:00.000Z",
          },
        },
      ],
    });
    expect(parsed.players[0].profile?.backedUpAt).toBeNull();
  });

  it("keeps the map a profile was taken from", () => {
    const parsed = PlayersFileSchema.parse({
      schemaVersion: 1,
      players: [
        {
          id: "p1",
          profile: {
            fileName: "x.arkprofile",
            storedAt: "2026-05-01T00:00:00.000Z",
            map: "Ragnarok",
          },
        },
      ],
    });
    expect(parsed.players[0].profile?.map).toBe("Ragnarok");
  });

  it("defaults fields added after a record was written", () => {
    const parsed = PlayersFileSchema.parse({
      schemaVersion: 1,
      players: [{ id: "p1", discordName: "survivor" }],
    });
    expect(parsed.players[0].gameName).toBe("");
    expect(parsed.players[0].discordId).toBe("");
    expect(parsed.players[0].steamId).toBe("");
  });
});
