import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newPlayer, type Player } from "../model/players";
import {
  applyProfileEdits,
  ProfileSummarySchema,
  type ProfileSummary,
} from "../model/profileData";
import { parseArkProfile, serializeArkProfile } from "../serializers/arkprofile";
import {
  applySummaryToPlayer,
  chooseProfileFiles,
  groupProfileFiles,
  isProfileFileName,
  matchPlayer,
  planImport,
  profileStorageKey,
  readProfileFile,
  storedProfileFor,
} from "./profileImport";

const SAMPLE = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("../serializers/__fixtures__/sample.arkprofile", import.meta.url)),
  ),
);

const player = (patch: Partial<Player> = {}): Player => ({
  ...newPlayer(patch.id ?? "p1"),
  ...patch,
});

const summary = (patch: Partial<ProfileSummary> = {}): ProfileSummary =>
  ProfileSummarySchema.parse({
    eosId: "000211223344556677889900aabbccdd",
    accountName: "testplayer1",
    characterName: "Test Dino",
    playerDataId: "1234567890",
    map: "Scorched Earth",
    ...patch,
  });

describe("readProfileFile", () => {
  it("summarises a real profile", () => {
    const result = readProfileFile({ fileName: "x.arkprofile", bytes: SAMPLE });
    expect(result.error).toBeUndefined();
    expect(result.summary?.characterName).toBe("Test Dino");
  });

  it("reports an unreadable file instead of throwing", () => {
    const result = readProfileFile({
      fileName: "notes.arkprofile",
      bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    });
    expect(result.summary).toBeNull();
    expect(result.error).toBeTruthy();
  });
});

describe("matchPlayer", () => {
  it("matches on the EOS id first", () => {
    const roster = [
      player({ id: "a", gameName: "Test Dino" }),
      player({ id: "b", eosId: "000211223344556677889900AABBCCDD" }),
    ];
    expect(matchPlayer(roster, summary())).toMatchObject({
      matchedBy: "eosId",
      player: { id: "b" },
    });
  });

  it("falls back to the player id, then the survivor name", () => {
    expect(
      matchPlayer([player({ id: "a", playerId: "1234567890" })], summary()),
    ).toMatchObject({ matchedBy: "playerId" });
    expect(
      matchPlayer([player({ id: "a", gameName: "test dino" })], summary()),
    ).toMatchObject({ matchedBy: "characterName" });
  });

  it("refuses to guess between two survivors with the same name", () => {
    const roster = [
      player({ id: "a", gameName: "Test Dino" }),
      player({ id: "b", gameName: "Test Dino" }),
    ];
    expect(matchPlayer(roster, summary())).toBeNull();
  });

  it("does not match on a blank identifier", () => {
    expect(matchPlayer([player({ id: "a" })], summary({ eosId: "" }))).toBeNull();
  });

  it("never falls back past a known, different EOS ID", () => {
    // Two accounts sharing a Player ID is normal — a generated profile inherits
    // its template's — and survivors are routinely called the same thing.
    // Neither may override the EOS ID saying they are different people.
    const roster = [
      player({
        id: "a",
        eosId: "0002ffffffffffffffffffffffffffff",
        playerId: "1234567890",
        gameName: "Test Dino",
      }),
    ];
    expect(matchPlayer(roster, summary())).toBeNull();
  });

  it("still falls back for a roster entry that has no EOS ID yet", () => {
    // A roster typed in by hand before any profile was imported.
    const roster = [player({ id: "a", playerId: "1234567890" })];
    expect(matchPlayer(roster, summary())).toMatchObject({ matchedBy: "playerId" });
  });
});

describe("applySummaryToPlayer", () => {
  it("fills blank fields", () => {
    const { player: next, filled } = applySummaryToPlayer(player(), summary());
    expect(next.eosId).toBe("000211223344556677889900aabbccdd");
    expect(next.playerId).toBe("1234567890");
    expect(next.gameName).toBe("Test Dino");
    expect(next.accountName).toBe("testplayer1");
    expect(filled).toEqual(["eosId", "playerId", "accountName", "gameName"]);
  });

  it("never overwrites what the admin typed, and says what disagreed", () => {
    const existing = player({ gameName: "Dirty Dan", playerId: "1234567890" });
    const { player: next, conflicts, filled } = applySummaryToPlayer(existing, summary());
    expect(next.gameName).toBe("Dirty Dan");
    expect(conflicts).toEqual([
      {
        key: "gameName",
        label: "Game name",
        existing: "Dirty Dan",
        incoming: "Test Dino",
      },
    ]);
    // A value that already agrees is neither filled nor a conflict.
    expect(filled).not.toContain("playerId");
  });

  it("ignores fields the profile has nothing to say about", () => {
    const { filled } = applySummaryToPlayer(player(), summary({ accountName: "" }));
    expect(filled).not.toContain("accountName");
  });
});

describe("planImport", () => {
  const file = (fileName: string) => ({ fileName, bytes: SAMPLE });

  it("creates a roster entry for a profile nobody claims", () => {
    const { players, results } = planImport([], [file("a.arkprofile")]);
    expect(players).toHaveLength(1);
    expect(players[0].gameName).toBe("Test Dino");
    expect(results[0].matchedBy).toBe("new");
    expect(results[0].playerName).toBe("Test Dino");
  });

  it("updates the existing entry instead of adding a duplicate", () => {
    const roster = [player({ id: "a", discordName: "dan", eosId: "000211223344556677889900aabbccdd" })];
    const { players, results } = planImport(roster, [file("a.arkprofile")]);
    expect(players).toHaveLength(1);
    expect(players[0].id).toBe("a");
    expect(players[0].gameName).toBe("Test Dino");
    expect(results[0].matchedBy).toBe("eosId");
  });

  it("lands both copies of one account on the same entry", () => {
    // Dropping a whole SavedArks folder means the same account can appear twice.
    const { players, results } = planImport([], [file("a.arkprofile"), file("b.arkprofile")]);
    expect(players).toHaveLength(1);
    expect(results[1].matchedBy).toBe("eosId");
  });

  it("keeps going past a file it cannot read", () => {
    const bad = { fileName: "bad.arkprofile", bytes: new Uint8Array(8) };
    const { players, results } = planImport([], [bad, file("a.arkprofile")]);
    expect(results[0].error).toBeTruthy();
    expect(results[1].summary).toBeTruthy();
    expect(players).toHaveLength(1);
  });

  it("keeps accounts apart when their files share a Player ID", () => {
    // Every profile this app generates inherits its template's Player ID, so a
    // batch of them collides on that field while being different accounts.
    const withEos = (eos: string, name: string) =>
      serializeArkProfile(
        applyProfileEdits(parseArkProfile(SAMPLE), { eosId: eos, characterName: name })
          .profile,
      );
    const { players, results } = planImport([], [
      { fileName: "a.arkprofile", bytes: withEos("0002000000000000000000000000aaa1", "Zara") },
      { fileName: "b.arkprofile", bytes: withEos("0002000000000000000000000000aaa2", "Alice") },
      { fileName: "c.arkprofile", bytes: withEos("0002000000000000000000000000aaa3", "Mike") },
    ]);
    expect(players).toHaveLength(3);
    expect(players.map((p) => p.gameName)).toEqual(["Zara", "Alice", "Mike"]);
    expect(results.every((r) => r.matchedBy === "new")).toBe(true);
    // Distinct roster ids, or they would overwrite each other's stored file.
    expect(new Set(players.map((p) => p.id)).size).toBe(3);
  });

  it("leaves the stored-profile record for the caller to attach", () => {
    // The file does not exist yet, so pointing a record at it here would create
    // exactly the broken reference the roster warns about.
    const { players } = planImport([], [file("a.arkprofile")]);
    expect(players[0].profile).toBeNull();
  });

  it("does not modify the roster it was given", () => {
    const roster = [player({ id: "a" })];
    planImport(roster, [file("a.arkprofile")]);
    expect(roster).toHaveLength(1);
    expect(roster[0].gameName).toBe("");
  });
});

describe("storedProfileFor", () => {
  it("records the map and keeps the summary for later", () => {
    const stored = storedProfileFor(summary(), "1234567890.arkprofile", new Date(0));
    expect(stored).toMatchObject({
      fileName: "1234567890.arkprofile",
      map: "Scorched Earth",
      backedUpAt: null,
      generated: false,
    });
    expect(stored.summary?.characterName).toBe("Test Dino");
  });
});

describe("groupProfileFiles", () => {
  /** Same account, but rewritten so the Player ID differs. */
  const withPlayerId = (id: string) => {
    const profile = parseArkProfile(SAMPLE);
    const { profile: edited } = applyProfileEdits(profile, { playerDataId: id });
    return serializeArkProfile(edited);
  };

  it("groups by EOS ID regardless of the survivor name", () => {
    const a = serializeArkProfile(
      applyProfileEdits(parseArkProfile(SAMPLE), { characterName: "Alice" }).profile,
    );
    const b = serializeArkProfile(
      applyProfileEdits(parseArkProfile(SAMPLE), { characterName: "Bob" }).profile,
    );
    const { groups } = groupProfileFiles([
      { fileName: "a.arkprofile", bytes: a, modifiedAt: 1000 },
      { fileName: "b.arkprofile", bytes: b, modifiedAt: 2000 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates).toHaveLength(2);
    // Same Player ID, so the newest simply wins — no question to ask.
    expect(groups[0].needsChoice).toBe(false);
    expect(groups[0].candidates[0].fileName).toBe("b.arkprofile");
  });

  it("asks when one account has files with different Player IDs", () => {
    const { groups } = groupProfileFiles([
      { fileName: "old.arkprofile", bytes: withPlayerId("111"), modifiedAt: 1000 },
      { fileName: "new.arkprofile", bytes: withPlayerId("222"), modifiedAt: 5000 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].needsChoice).toBe(true);
    // Newest first, so the default pick is the one usually wanted.
    expect(groups[0].candidates.map((c) => c.fileName)).toEqual([
      "new.arkprofile",
      "old.arkprofile",
    ]);
    expect(groups[0].candidates[0].summary.playerDataId).toBe("222");
  });

  it("keeps separate accounts apart and reports unreadable files", () => {
    const other = serializeArkProfile(
      applyProfileEdits(parseArkProfile(SAMPLE), {
        eosId: "0002ffffffffffffffffffffffffffff",
      }).profile,
    );
    const { groups, unreadable } = groupProfileFiles([
      { fileName: "a.arkprofile", bytes: SAMPLE },
      { fileName: "b.arkprofile", bytes: other },
      { fileName: "bad.arkprofile", bytes: new Uint8Array(8) },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.needsChoice)).toBe(true);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].fileName).toBe("bad.arkprofile");
  });
});

describe("chooseProfileFiles", () => {
  const file = (name: string, at: number, playerId: string) => ({
    fileName: name,
    bytes: serializeArkProfile(
      applyProfileEdits(parseArkProfile(SAMPLE), { playerDataId: playerId }).profile,
    ),
    modifiedAt: at,
  });

  it("defaults to the newest file of each account", () => {
    const files = [file("old.arkprofile", 1000, "111"), file("new.arkprofile", 9000, "222")];
    const { groups } = groupProfileFiles(files);
    const { chosen, superseded } = chooseProfileFiles(files, groups);
    expect(chosen.map((f) => f.fileName)).toEqual(["new.arkprofile"]);
    expect(superseded.map((c) => c.fileName)).toEqual(["old.arkprofile"]);
  });

  it("honours an explicit pick", () => {
    const files = [file("old.arkprofile", 1000, "111"), file("new.arkprofile", 9000, "222")];
    const { groups } = groupProfileFiles(files);
    const older = groups[0].candidates.find((c) => c.fileName === "old.arkprofile")!;
    const { chosen } = chooseProfileFiles(files, groups, {
      [groups[0].eosId]: older.fileIndex,
    });
    expect(chosen.map((f) => f.fileName)).toEqual(["old.arkprofile"]);
  });
});

describe("profileStorageKey", () => {
  it("names a stored profile after the EOS id, as the game does", () => {
    expect(profileStorageKey(player({ playerId: "999" }), summary())).toBe(
      "000211223344556677889900aabbccdd",
    );
  });

  it("does not let two entries sharing a Player ID collide", () => {
    // A generated profile inherits its template's Player ID, so keying on that
    // alone would overwrite the template owner's stored file.
    const a = player({ id: "a", eosId: "aaaa", playerId: "1234567890" });
    const b = player({ id: "b", eosId: "bbbb", playerId: "1234567890" });
    expect(profileStorageKey(a)).not.toBe(profileStorageKey(b));
  });

  it("falls back through Player ID to the roster id", () => {
    expect(profileStorageKey(player({ id: "p1", playerId: "112233" }))).toBe("112233");
    expect(profileStorageKey(player({ id: "p1" }))).toBe("p1");
  });
});

describe("isProfileFileName", () => {
  it("accepts only .arkprofile", () => {
    expect(isProfileFileName("0002abcd.arkprofile")).toBe(true);
    expect(isProfileFileName("0002abcd.ARKPROFILE")).toBe(true);
    expect(isProfileFileName("Ragnarok.ark")).toBe(false);
    expect(isProfileFileName("notes.txt")).toBe(false);
  });
});
