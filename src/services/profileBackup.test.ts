import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlayersFileSchema, type PlayersFile } from "../model/players";
import { ProfileSummarySchema } from "../model/profileData";
import { findIpAddresses } from "../model/profileSanitizer";
import {
  findPath,
  parseArkProfile,
  serializeArkProfile,
  writeString,
} from "../serializers/arkprofile";
import { playersToText } from "../serializers/players";
import { defaultOutputPaths } from "../model/project";

/**
 * The privacy boundary, end to end.
 *
 * The question these answer is the only one that matters: can a player's IP
 * address reach a repository? Every route it could take - the profile bytes,
 * the roster JSON, the stored summary - is checked for the same address.
 */

/** RFC 5737 documentation address. Belongs to nobody. */
const TEST_IP = "203.0.113.99";

const SAMPLE = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("../serializers/__fixtures__/sample.arkprofile", import.meta.url)),
  ),
);

function withIp(bytes: Uint8Array, ip: string): Uint8Array {
  const profile = parseArkProfile(bytes);
  const address = findPath(profile.objects[0].properties, [
    "MyData",
    "SavedNetworkAddress",
  ]);
  if (!address) throw new Error("fixture has no SavedNetworkAddress");
  writeString(address, ip);
  return serializeArkProfile(profile);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Everything the fake backend was asked to upload. */
let uploaded: { path: string; contentB64: string }[] = [];
/** What `read_player_profile_b64` hands back. */
let stored: Record<string, string> = {};

vi.mock("./ipc", () => ({
  isTauri: false,
  ipc: async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "read_player_profile_b64": {
        const content = stored[args.fileName as string];
        if (!content) throw new Error("No stored profile found for that player");
        return content;
      }
      case "github_put_file_b64":
        uploaded.push({
          path: args.path as string,
          contentB64: args.contentB64 as string,
        });
        return { commit_sha: "c1", content_sha: "b1" };
      case "github_get_file_b64":
        return stored["__remote__"] ?? null;
      case "write_player_profile_b64":
        stored["__restored__"] = args.contentB64 as string;
        return 0;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  },
}));

const { backupProfile, restoreProfile, decodeBase64, encodeBase64 } = await import(
  "./profileBackup"
);

const config = {
  accountId: "9",
  owner: "ggfizz",
  repo: "cluster-source",
  branch: "main",
  paths: defaultOutputPaths(),
};

beforeEach(() => {
  uploaded = [];
  stored = {};
});

describe("backing a profile up", () => {
  it("uploads a copy with the address removed", async () => {
    stored["player.arkprofile"] = toBase64(withIp(SAMPLE, TEST_IP));

    const result = await backupProfile(config, "C:\\proj", "player.arkprofile", "Backup");
    expect(result.sanitized.hadNetworkAddress).toBe(true);
    expect(uploaded).toHaveLength(1);

    const sent = decodeBase64(uploaded[0].contentB64);
    const asText = new TextDecoder("latin1").decode(sent);
    expect(asText).not.toContain(TEST_IP);
  });

  /** The bytes that went to GitHub are not the bytes on disk. */
  it("never uploads the original bytes", async () => {
    const original = withIp(SAMPLE, TEST_IP);
    stored["player.arkprofile"] = toBase64(original);

    await backupProfile(config, "C:\\proj", "player.arkprofile", "Backup");
    expect(uploaded[0].contentB64).not.toBe(toBase64(original));
  });

  it("leaves the original on disk untouched", async () => {
    const original = toBase64(withIp(SAMPLE, TEST_IP));
    stored["player.arkprofile"] = original;
    await backupProfile(config, "C:\\proj", "player.arkprofile", "Backup");
    expect(stored["player.arkprofile"]).toBe(original);
  });

  it("puts it under the project's profiles path", async () => {
    stored["player.arkprofile"] = toBase64(SAMPLE);
    await backupProfile(config, "C:\\proj", "player.arkprofile", "Backup");
    expect(uploaded[0].path).toBe("dinodepot/profiles/player.arkprofile");
  });

  /**
   * Skipping the player is the administrator's decision, not a fallback - so a
   * profile that cannot be cleaned stops the backup rather than going up raw.
   */
  it("uploads nothing when the profile cannot be read", async () => {
    stored["broken.arkprofile"] = toBase64(new TextEncoder().encode("not a profile"));
    await expect(
      backupProfile(config, "C:\\proj", "broken.arkprofile", "Backup"),
    ).rejects.toMatchObject({ code: "profile.unsanitizable" });
    expect(uploaded).toEqual([]);
  });

  it("uploads nothing when the file is missing", async () => {
    await expect(
      backupProfile(config, "C:\\proj", "gone.arkprofile", "Backup"),
    ).rejects.toMatchObject({ code: "profile.unsanitizable" });
    expect(uploaded).toEqual([]);
  });

  it("uploads nothing when the stored content is not base64", async () => {
    stored["odd.arkprofile"] = "!!!! not base64 !!!!";
    await expect(
      backupProfile(config, "C:\\proj", "odd.arkprofile", "Backup"),
    ).rejects.toMatchObject({ code: "profile.unsanitizable" });
    expect(uploaded).toEqual([]);
  });
});

describe("restoring a profile", () => {
  it("writes a clean backup back to disk", async () => {
    stored["__remote__"] = toBase64(SAMPLE);
    expect(await restoreProfile(config, "C:\\proj", "player.arkprofile")).toBe(true);
    expect(stored["__restored__"]).toBeDefined();
  });

  it("reports when there is no backup", async () => {
    expect(await restoreProfile(config, "C:\\proj", "player.arkprofile")).toBe(false);
  });

  /**
   * Checked on the way in as well as out. A backup taken by an older build, or
   * edited by hand, does not get to put an address back on this disk unnoticed.
   */
  it("refuses a backup that will not parse", async () => {
    stored["__remote__"] = toBase64(new TextEncoder().encode("not a profile"));
    await expect(
      restoreProfile(config, "C:\\proj", "player.arkprofile"),
    ).rejects.toMatchObject({ code: "profile.unsanitizable" });
    expect(stored["__restored__"]).toBeUndefined();
  });
});

describe("the roster that synchronizes", () => {
  /** There is no field left for an address to sit in. */
  it("has no place to keep an IP address", () => {
    const summary = ProfileSummarySchema.parse({});
    expect(Object.keys(summary)).not.toContain("lastKnownIp");
    // Even if one is fed in, the schema drops it.
    expect(
      JSON.stringify(ProfileSummarySchema.parse({ lastKnownIp: TEST_IP })),
    ).not.toContain(TEST_IP);
  });

  it("drops an address smuggled into a stored profile record", () => {
    const roster: PlayersFile = PlayersFileSchema.parse({
      schemaVersion: 1,
      players: [
        {
          id: "p1",
          discordName: "survivor",
          profile: {
            fileName: "player.arkprofile",
            storedAt: "2026-08-01",
            map: "Ragnarok",
            summary: { characterName: "Rex Wrangler", lastKnownIp: TEST_IP },
          },
        },
      ],
      cleanSlates: [],
    });
    expect(JSON.stringify(roster)).not.toContain(TEST_IP);
    expect(roster.players[0].profile?.summary?.characterName).toBe("Rex Wrangler");
  });

  it("keeps it out of the serialized roster too", () => {
    const roster = PlayersFileSchema.parse({
      schemaVersion: 1,
      players: [
        {
          id: "p1",
          discordName: "survivor",
          profile: {
            fileName: "player.arkprofile",
            summary: { lastKnownIp: TEST_IP },
          },
        },
      ],
      cleanSlates: [],
    });
    const text = playersToText(roster);
    expect(text).not.toContain(TEST_IP);
    expect(findIpAddresses(text)).toEqual([]);
  });
});

describe("nothing synchronized carries the address", () => {
  /**
   * The whole boundary in one assertion: the profile bytes that go up, the
   * roster JSON that goes up, and the summary kept beside it.
   */
  it("holds for every route at once", async () => {
    stored["player.arkprofile"] = toBase64(withIp(SAMPLE, TEST_IP));
    await backupProfile(config, "C:\\proj", "player.arkprofile", "Backup");

    const roster = PlayersFileSchema.parse({
      schemaVersion: 1,
      players: [
        {
          id: "p1",
          discordName: "survivor",
          profile: {
            fileName: "player.arkprofile",
            summary: { characterName: "Rex Wrangler", lastKnownIp: TEST_IP },
          },
        },
      ],
      cleanSlates: [],
    });

    const everythingUploaded = [
      new TextDecoder("latin1").decode(decodeBase64(uploaded[0].contentB64)),
      playersToText(roster),
      JSON.stringify(roster),
    ].join("\n");

    expect(everythingUploaded).not.toContain(TEST_IP);
    expect(findIpAddresses(everythingUploaded)).toEqual([]);
  });
});

describe("base64 round trip", () => {
  it("survives a profile-sized payload", () => {
    expect(decodeBase64(encodeBase64(SAMPLE))).toEqual(SAMPLE);
  });

  it("tolerates whitespace, which GitHub inserts", () => {
    const wrapped = encodeBase64(SAMPLE).replace(/(.{76})/g, "$1\n");
    expect(decodeBase64(wrapped)).toEqual(SAMPLE);
  });

  it("survives a payload past the fromCharCode argument limit", () => {
    const big = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 251);
    expect(decodeBase64(encodeBase64(big))).toEqual(big);
  });
});
