import { describe, expect, it } from "vitest";
import { playersToPublished, playersToText } from "./players";
import { newPlayer, StoredProfileSchema, type PlayersFile } from "../model/players";

const file = (patch: Partial<ReturnType<typeof newPlayer>> = {}): PlayersFile => ({
  schemaVersion: 1,
  players: [{ ...newPlayer("p1"), ...patch }],
  cleanSlates: [],
});

const AT = new Date("2026-08-03T12:00:00.000Z");

describe("playersToPublished", () => {
  it("carries every identifier through", () => {
    const out = playersToPublished(
      file({
        discordName: "survivor",
        discordId: "218450941836787712",
        steamName: "JoeS",
        steamId: "76561198000000000",
        gameName: "Joe the Bold",
        playerId: "112233445",
        eosId: "0002abcd",
      }),
      AT,
    );
    expect(out.players[0]).toMatchObject({
      discordName: "survivor",
      discordId: "218450941836787712",
      steamId: "76561198000000000",
      gameName: "Joe the Bold",
      playerId: "112233445",
      eosId: "0002abcd",
    });
  });

  it("reduces a stored profile to its map and date", () => {
    const out = playersToPublished(
      file({
        profile: StoredProfileSchema.parse({
          fileName: "112233445.arkprofile",
          storedAt: "2026-05-01T00:00:00.000Z",
          map: "Ragnarok",
        }),
      }),
      AT,
    );
    expect(out.players[0].profile).toEqual({
      map: "Ragnarok",
      storedAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("never publishes the local profile file name", () => {
    const text = playersToText(
      file({
        profile: StoredProfileSchema.parse({
          fileName: "112233445.arkprofile",
          storedAt: "2026-05-01T00:00:00.000Z",
          map: "Ragnarok",
        }),
      }),
      AT,
    );
    expect(text).not.toContain("arkprofile");
  });

  it("publishes null for a player with no profile", () => {
    expect(playersToPublished(file(), AT).players[0].profile).toBeNull();
  });

  it("stamps the generation time", () => {
    expect(playersToPublished(file(), AT).generatedAt).toBe(
      "2026-08-03T12:00:00.000Z",
    );
  });

  it("handles an empty roster", () => {
    const out = playersToPublished({ schemaVersion: 1, players: [], cleanSlates: [] }, AT);
    expect(out.players).toEqual([]);
    expect(out.version).toBe(1);
  });

  // The Publish page's "unpublished changes" flag hashes the output. Because
  // `generatedAt` moves on every call, that flag can only mean anything if it
  // hashes the roster at a fixed timestamp - which is what the page does.
  // These two pin the property the page depends on.
  it("produces different text on every call, thanks to generatedAt", () => {
    const roster = file({ gameName: "Rockwell" });
    expect(playersToText(roster, new Date(1))).not.toBe(
      playersToText(roster, new Date(2)),
    );
  });

  it("is byte-identical for an unchanged roster at a fixed timestamp", () => {
    const roster = file({ gameName: "Rockwell" });
    const epoch = new Date(0);
    expect(playersToText(roster, epoch)).toBe(playersToText(roster, epoch));
    // …and still moves when the roster actually changes.
    expect(playersToText(file({ gameName: "Helena" }), epoch)).not.toBe(
      playersToText(roster, epoch),
    );
  });
});
