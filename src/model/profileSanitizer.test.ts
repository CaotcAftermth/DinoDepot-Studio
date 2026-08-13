import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isStudioError, StudioError } from "./errors";
import {
  findIpAddresses,
  hashBytes,
  isUnsupportedVersion,
  sanitizeProfile,
  SANITIZER_VERSION,
  SUPPORTED_SAVE_VERSIONS,
} from "./profileSanitizer";
import {
  applyProfileEdits,
  readNetworkAddress,
  readProfileSummary,
} from "./profileData";
import {
  findPath,
  parseArkProfile,
  serializeArkProfile,
  writeString,
} from "../serializers/arkprofile";

/** Real profiles the game wrote, with the personal data replaced same-length. */
const SAMPLE_V5 = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("../serializers/__fixtures__/sample.arkprofile", import.meta.url)),
  ),
);
const SAMPLE_V7 = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("../serializers/__fixtures__/sample-v7.arkprofile", import.meta.url)),
  ),
);

/** RFC 5737 documentation address. Belongs to nobody. */
const TEST_IP = "198.51.100.77";

/** The same profile with an address written into it. */
function withIp(bytes: Uint8Array, ip = TEST_IP): Uint8Array {
  const profile = parseArkProfile(bytes);
  const address = findPath(profile.objects[0].properties, [
    "MyData",
    "SavedNetworkAddress",
  ]);
  if (!address) throw new Error("fixture has no SavedNetworkAddress to set");
  writeString(address, ip);
  return serializeArkProfile(profile);
}

describe("sanitizing a profile", () => {
  it("removes the address from a version 5 save", () => {
    const input = withIp(SAMPLE_V5);
    expect(readNetworkAddress(parseArkProfile(input))).toBe(TEST_IP);

    const result = sanitizeProfile(input);
    expect(readNetworkAddress(parseArkProfile(result.bytes))).toBe("");
    expect(result.hadNetworkAddress).toBe(true);
  });

  it("removes the address from a version 7 save", () => {
    const input = withIp(SAMPLE_V7);
    const result = sanitizeProfile(input);
    expect(readNetworkAddress(parseArkProfile(result.bytes))).toBe("");
    expect(result.saveVersion).toBe(7);
  });

  /** The whole point: the address must not survive anywhere in the bytes. */
  it("leaves the address nowhere in the uploaded bytes", () => {
    const result = sanitizeProfile(withIp(SAMPLE_V5));
    const asText = new TextDecoder("latin1").decode(result.bytes);
    expect(asText).not.toContain(TEST_IP);
    expect(findIpAddresses(asText)).not.toContain(TEST_IP);
  });

  it("does the same for a version 7 save", () => {
    const result = sanitizeProfile(withIp(SAMPLE_V7));
    const asText = new TextDecoder("latin1").decode(result.bytes);
    expect(asText).not.toContain(TEST_IP);
  });

  /** The fixtures are real saves, so they arrive with an address of their own. */
  it("reports the fixtures as having carried an address", () => {
    expect(sanitizeProfile(SAMPLE_V5).hadNetworkAddress).toBe(true);
    expect(sanitizeProfile(SAMPLE_V7).hadNetworkAddress).toBe(true);
  });

  it("is happy with a profile that has already been cleaned", () => {
    const once = sanitizeProfile(SAMPLE_V5).bytes;
    const twice = sanitizeProfile(once);
    expect(readNetworkAddress(parseArkProfile(twice.bytes))).toBe("");
    expect(twice.hadNetworkAddress).toBe(false);
  });

  it("never returns the bytes it was given", () => {
    const input = withIp(SAMPLE_V5);
    const result = sanitizeProfile(input);
    expect(result.bytes).not.toBe(input);
    // And the caller's copy is untouched — the original stays readable locally.
    expect(readNetworkAddress(parseArkProfile(input))).toBe(TEST_IP);
  });

  it("reports the sanitizer version, so a project can be re-swept later", () => {
    expect(sanitizeProfile(SAMPLE_V5).sanitizerVersion).toBe(SANITIZER_VERSION);
  });

  it("hashes both sides, so a redundant upload can be skipped", () => {
    const result = sanitizeProfile(withIp(SAMPLE_V5));
    expect(result.originalHash).toMatch(/^[0-9a-f]{8}$/);
    expect(result.sanitizedHash).toMatch(/^[0-9a-f]{8}$/);
    expect(result.originalHash).not.toBe(result.sanitizedHash);
  });
});

describe("what sanitizing must not disturb", () => {
  /**
   * A save that comes back with the right field cleared and the wrong level is
   * not a success — it is a corrupted character the administrator will restore
   * from one day.
   */
  it("preserves identity and progression exactly", () => {
    const input = withIp(SAMPLE_V5);
    const before = readProfileSummary(parseArkProfile(input));
    const after = readProfileSummary(parseArkProfile(sanitizeProfile(input).bytes));

    for (const field of [
      "eosId",
      "accountName",
      "characterName",
      "playerDataId",
      "tribeId",
      "mapPackage",
      "level",
      "extraLevel",
      "highestLevel",
      "experience",
      "engramPoints",
      "engramsLearned",
      "explorerNotes",
      "deaths",
      "spentPoints",
      "saveVersion",
    ] as const) {
      expect(after[field], field).toEqual(before[field]);
    }
  });

  it("preserves the stat point allocation", () => {
    const input = withIp(SAMPLE_V5);
    const before = readProfileSummary(parseArkProfile(input));
    const after = readProfileSummary(parseArkProfile(sanitizeProfile(input).bytes));
    expect(after.statPoints).toEqual(before.statPoints);
  });

  it("preserves persistent buffs and skill trees", () => {
    const input = withIp(SAMPLE_V7);
    const before = readProfileSummary(parseArkProfile(input));
    const after = readProfileSummary(parseArkProfile(sanitizeProfile(input).bytes));
    expect(after.activeBuffs).toEqual(before.activeBuffs);
    expect(after.skillTrees).toEqual(before.skillTrees);
  });

  /**
   * A profile with no address to remove should come out byte-identical: there
   * was nothing to change, so any difference is the serializer drifting.
   */
  /**
   * Sanitizing something already sanitized must be a no-op down to the byte.
   * Any difference is the serializer drifting, which would mean every backup
   * looked like a change and re-uploaded forever.
   */
  it("is byte-identical the second time", () => {
    const clean = sanitizeProfile(SAMPLE_V5).bytes;
    expect(sanitizeProfile(clean).bytes).toEqual(clean);
  });

  it("is byte-identical the second time for a version 7 save", () => {
    const clean = sanitizeProfile(SAMPLE_V7).bytes;
    expect(sanitizeProfile(clean).bytes).toEqual(clean);
  });

  it("reports the same hash for an unchanged profile", () => {
    const clean = sanitizeProfile(SAMPLE_V5).bytes;
    const again = sanitizeProfile(clean);
    expect(again.sanitizedHash).toBe(again.originalHash);
  });
});

describe("refusing to sanitize", () => {
  /** Not uploading is always the safe answer. */
  it("refuses a file that is not a profile", () => {
    try {
      sanitizeProfile(new TextEncoder().encode("this is not a profile at all"));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isStudioError(e) && e.code).toBe("profile.unsanitizable");
      expect(isStudioError(e) && e.message).toContain("not uploaded");
    }
  });

  it("refuses an empty file", () => {
    expect(() => sanitizeProfile(new Uint8Array(0))).toThrow();
  });

  it("refuses a truncated profile", () => {
    const truncated = SAMPLE_V5.slice(0, Math.floor(SAMPLE_V5.length / 2));
    try {
      sanitizeProfile(truncated);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isStudioError(e) && e.code).toBe("profile.unsanitizable");
    }
  });

  /**
   * A save version nobody has looked at may keep the address somewhere else
   * entirely. Uploading because the one known field happened to be empty would
   * be luck, not safety.
   */
  /**
   * A file claiming a version this build has never met is refused. Note that a
   * *bogus* version byte fails at the parser first — the version gate is what
   * catches a future format that parses but may keep the address somewhere
   * this build does not look.
   */
  it("refuses a file claiming a version it has never met", () => {
    const future = Uint8Array.from(SAMPLE_V5);
    new DataView(future.buffer, future.byteOffset).setInt32(0, 12, true);
    try {
      sanitizeProfile(future);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isStudioError(e) && e.code).toBe("profile.unsanitizable");
      expect(isStudioError(e) && /not (been )?uploaded/.test(e.message)).toBe(true);
    }
  });

  it("tells an unsupported version apart from an unreadable file", () => {
    expect(
      isUnsupportedVersion(
        new StudioError("profile.unsanitizable", "x", {
          detail: "unsupported saveVersion 12",
        }),
      ),
    ).toBe(true);
    try {
      sanitizeProfile(new TextEncoder().encode("rubbish"));
    } catch (e) {
      expect(isUnsupportedVersion(e)).toBe(false);
    }
  });

  it("only claims to support the versions it has fixtures for", () => {
    expect([...SUPPORTED_SAVE_VERSIONS]).toEqual([5, 7]);
    expect(parseArkProfile(SAMPLE_V5).saveVersion).toBe(5);
    expect(parseArkProfile(SAMPLE_V7).saveVersion).toBe(7);
  });

  it("always says the file was not uploaded", () => {
    for (const bad of [
      new Uint8Array(0),
      new TextEncoder().encode("nope"),
      SAMPLE_V5.slice(0, 40),
    ]) {
      try {
        sanitizeProfile(bad);
      } catch (e) {
        expect(isStudioError(e) && /not (been )?uploaded/.test(e.message)).toBe(true);
      }
    }
  });
});

describe("the clearNetworkAddress edit the sanitizer relies on", () => {
  it("reports the address as a change when there was one", () => {
    const profile = parseArkProfile(withIp(SAMPLE_V5));
    const result = applyProfileEdits(profile, { clearNetworkAddress: true });
    expect(result.changes.some((c) => c.field === "Last known IP")).toBe(true);
  });

  it("does not touch the profile it was given", () => {
    const profile = parseArkProfile(withIp(SAMPLE_V5));
    applyProfileEdits(profile, { clearNetworkAddress: true });
    expect(readNetworkAddress(profile)).toBe(TEST_IP);
  });
});

describe("findIpAddresses", () => {
  it("finds IPv4", () => {
    expect(findIpAddresses(`last seen from ${TEST_IP} yesterday`)).toContain(TEST_IP);
  });

  it("finds IPv6, including compressed forms", () => {
    expect(findIpAddresses("addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toHaveLength(1);
    expect(findIpAddresses("addr 2001:db8::8a2e:370:7334").length).toBeGreaterThan(0);
    expect(findIpAddresses("addr ::1234:5678").length).toBeGreaterThan(0);
  });

  it("finds several at once", () => {
    expect(findIpAddresses("192.0.2.1 and 198.51.100.2")).toHaveLength(2);
  });

  it("does not invent addresses out of ordinary text", () => {
    expect(findIpAddresses("no addresses in this sentence")).toEqual([]);
    expect(findIpAddresses("ratio 1:2")).toEqual([]);
  });

  it("rejects octets that cannot be an address", () => {
    expect(findIpAddresses("999.999.999.999")).toEqual([]);
  });

  /**
   * A four-part version is indistinguishable from an address, and is treated as
   * one. A false positive costs a moment's confusion; a false negative
   * publishes somebody's home address.
   */
  it("errs towards flagging rather than missing", () => {
    expect(findIpAddresses("version 1.2.3.4")).toContain("1.2.3.4");
  });
});

describe("hashBytes", () => {
  it("is stable for the same bytes", () => {
    expect(hashBytes(SAMPLE_V5)).toBe(hashBytes(SAMPLE_V5));
  });

  it("differs when a byte differs", () => {
    const changed = Uint8Array.from(SAMPLE_V5);
    changed[changed.length - 1] ^= 0xff;
    expect(hashBytes(changed)).not.toBe(hashBytes(SAMPLE_V5));
  });

  it("handles an empty input", () => {
    expect(hashBytes(new Uint8Array(0))).toMatch(/^[0-9a-f]{8}$/);
  });
});
