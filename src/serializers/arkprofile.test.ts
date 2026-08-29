import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ArkProfileError,
  cloneProfile,
  findPath,
  findProp,
  hex,
  isTagged,
  parseArkProfile,
  readArrayCount,
  readObjectArray,
  readString,
  readUint64,
  serializeArkProfile,
  writeString,
} from "./arkprofile";

/**
 * A real Scorched Earth profile with the personal data replaced by same-length
 * stand-ins, so every byte offset and structure is exactly as the game wrote
 * it. Nothing about this format is documented - a fixture the game produced is
 * the only thing that makes these tests worth anything.
 */
const SAMPLE = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./__fixtures__/sample.arkprofile", import.meta.url))),
);

/**
 * A real Lost Colony profile, scrubbed the same way. This is save version 7 -
 * the Unreal 5.5 tag format - which the first reader could not open at all.
 */
const SAMPLE_V7 = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./__fixtures__/sample-v7.arkprofile", import.meta.url))),
);

describe("parseArkProfile", () => {
  it("reads the object table", () => {
    const profile = parseArkProfile(SAMPLE);
    expect(profile.saveVersion).toBe(5);
    expect(profile.objects).toHaveLength(2);
    expect(profile.objects[0].className).toContain("PrimalPlayerDataBP_C");
    expect(profile.objects[0].names).toContain("ScorchedEarth_WP");
    // The player data object references the persistent buff object.
    expect(profile.objects[0].objectRefs).toHaveLength(1);
    expect(profile.objects[1].className).toContain("HeatStroke");
  });

  it("reads identity out of the nested structs", () => {
    const props = parseArkProfile(SAMPLE).objects[0].properties;
    expect(readString(findPath(props, ["MyData", "PlayerName"]))).toBe("testplayer1");
    expect(
      readString(
        findPath(props, ["MyData", "MyPlayerCharacterConfig", "PlayerCharacterName"]),
      ),
    ).toBe("Test Dino");
    expect(readUint64(findPath(props, ["MyData", "PlayerDataID"]))).toBe(1234567890n);
  });

  it("keeps the EOS id as the trailing 16 bytes of the net id struct", () => {
    const props = parseArkProfile(SAMPLE).objects[0].properties;
    const uniqueId = findPath(props, ["MyData", "UniqueID"]);
    expect(hex(uniqueId!.data!.slice(-16))).toBe("000211223344556677889900aabbccdd");
  });

  it("reads sparse repeated properties without collapsing their indices", () => {
    const props = parseArkProfile(SAMPLE).objects[0].properties;
    const config = findPath(props, ["MyData", "MyPlayerCharacterConfig"]);
    const bones = config!.children!.filter((p) => p.name === "RawBoneModifiers");
    // The game omits sliders left at their default, so index 3 is simply absent.
    expect(bones.map((p) => p.index)).not.toContain(3);
    expect(bones.length).toBeLessThan(Math.max(...bones.map((p) => p.index)) + 1);
  });

  it("reads the engram and explorer-note arrays", () => {
    const props = parseArkProfile(SAMPLE).objects[0].properties;
    const stats = findPath(props, ["MyData", "MyPersistentCharacterStats"]);
    const engrams = findProp(stats!.children, "PlayerState_EngramBlueprints");
    expect(readArrayCount(engrams)).toBe(61);
    const paths = readObjectArray(engrams);
    expect(paths).toHaveLength(61);
    expect(paths[0]).toContain("PrimalItemSkin_BowlerHat");
  });

  it("refuses files that are not profiles", () => {
    expect(() => parseArkProfile(new Uint8Array([1, 2, 3]))).toThrow(ArkProfileError);
    expect(() => parseArkProfile(new Uint8Array(64))).toThrow(ArkProfileError);
  });
});

describe("serializeArkProfile", () => {
  it("round-trips a real profile byte for byte", () => {
    const out = serializeArkProfile(parseArkProfile(SAMPLE));
    expect(out.length).toBe(SAMPLE.length);
    // A mismatch anywhere means some part of the file was not understood, and
    // rewriting a profile would corrupt it. Report where, not just that.
    const at = out.findIndex((b, i) => b !== SAMPLE[i]);
    expect(at, `first differing byte at 0x${at.toString(16)}`).toBe(-1);
  });

  it("re-points object offsets when an edit changes a length", () => {
    const profile = cloneProfile(parseArkProfile(SAMPLE));
    const name = findPath(profile.objects[0].properties, ["MyData", "PlayerName"])!;
    writeString(name, "a-much-longer-account-name");

    const reparsed = parseArkProfile(serializeArkProfile(profile));
    expect(readString(findPath(reparsed.objects[0].properties, ["MyData", "PlayerName"]))).toBe(
      "a-much-longer-account-name",
    );
    // The second object sits after the one that grew - if its offset were not
    // recomputed, this would read garbage.
    expect(reparsed.objects[1].className).toContain("HeatStroke");
    expect(
      readString(findProp(reparsed.objects[1].properties, "ForPrimalBuffClassString")),
    ).toContain("Heatstroke");
  });

  it("survives a shorter value too", () => {
    const profile = cloneProfile(parseArkProfile(SAMPLE));
    writeString(
      findPath(profile.objects[0].properties, [
        "MyData",
        "MyPlayerCharacterConfig",
        "PlayerCharacterName",
      ])!,
      "Ug",
    );
    const reparsed = parseArkProfile(serializeArkProfile(profile));
    expect(
      readString(
        findPath(reparsed.objects[0].properties, [
          "MyData",
          "MyPlayerCharacterConfig",
          "PlayerCharacterName",
        ]),
      ),
    ).toBe("Ug");
    expect(readArrayCount(
      findProp(
        findPath(reparsed.objects[0].properties, ["MyData", "MyPersistentCharacterStats"])!.children,
        "PlayerState_EngramBlueprints",
      ),
    )).toBe(61);
  });

  it("does not disturb the profile it was given", () => {
    const profile = parseArkProfile(SAMPLE);
    const edited = cloneProfile(profile);
    writeString(findPath(edited.objects[0].properties, ["MyData", "PlayerName"])!, "other");
    expect(serializeArkProfile(profile)).toEqual(SAMPLE);
  });
});

describe("save version 7 (Unreal 5.5 tags)", () => {
  it("reads the container, including the engine versions", () => {
    const profile = parseArkProfile(SAMPLE_V7);
    expect(profile.saveVersion).toBe(7);
    expect(profile.unrealVersions).toEqual([522, 1013]);
    expect(isTagged(profile)).toBe(true);
    expect(isTagged(parseArkProfile(SAMPLE))).toBe(false);
    // Four persistent buff objects ride along with the player data.
    expect(profile.objects).toHaveLength(5);
    expect(profile.objects[0].names).toContain("LostColony_WP");
  });

  it("round-trips byte for byte", () => {
    const out = serializeArkProfile(parseArkProfile(SAMPLE_V7));
    expect(out.length).toBe(SAMPLE_V7.length);
    const at = out.findIndex((b, i) => b !== SAMPLE_V7[i]);
    expect(at, `first differing byte at 0x${at.toString(16)}`).toBe(-1);
  });

  it("reads the same fields out of the new tag format", () => {
    const props = parseArkProfile(SAMPLE_V7).objects[0].properties;
    expect(readString(findPath(props, ["MyData", "PlayerName"]))).toBe("testplyr07");
    expect(
      readString(findPath(props, ["MyData", "MyPlayerCharacterConfig", "PlayerCharacterName"])),
    ).toBe("Human");
    expect(readUint64(findPath(props, ["MyData", "PlayerDataID"]))).toBe(1234567890n);
    const uniqueId = findPath(props, ["MyData", "UniqueID"]);
    expect(hex(uniqueId!.data!.slice(-16))).toBe("0002bbccddeeff001122334455667788");
  });

  it("takes a bool's value from the tag flags, not the payload", () => {
    const props = parseArkProfile(SAMPLE_V7).objects[0].properties;
    expect(findPath(props, ["MyData", "bFirstSpawned"])?.boolValue).toBe(true);
  });

  it("keeps array element counts inside the payload, as version 5 does", () => {
    const stats = findPath(
      parseArkProfile(SAMPLE_V7).objects[0].properties,
      ["MyData", "MyPersistentCharacterStats"],
    );
    expect(readArrayCount(findProp(stats!.children, "PerMapExplorerNoteUnlocks"))).toBe(42);
    const engrams = findProp(stats!.children, "PlayerState_EngramBlueprints");
    expect(readArrayCount(engrams)).toBe(65);
    expect(readObjectArray(engrams)[0]).toContain("ItemDinoball");
  });

  it("re-points offsets across five objects when an edit changes a length", () => {
    const profile = cloneProfile(parseArkProfile(SAMPLE_V7));
    writeString(
      findPath(profile.objects[0].properties, ["MyData", "PlayerName"])!,
      "a-considerably-longer-account-name",
    );
    const reparsed = parseArkProfile(serializeArkProfile(profile));
    expect(readString(findPath(reparsed.objects[0].properties, ["MyData", "PlayerName"]))).toBe(
      "a-considerably-longer-account-name",
    );
    // Every later object has to still be findable at its recorded offset.
    expect(reparsed.objects.map((o) => o.className)).toEqual(
      parseArkProfile(SAMPLE_V7).objects.map((o) => o.className),
    );
    expect(
      readString(findProp(reparsed.objects[4].properties, "ForPrimalBuffClassString")),
    ).toContain("Buff_GSA");
  });

  it("adds the array-index flag when a new repeat is written", () => {
    const profile = cloneProfile(parseArkProfile(SAMPLE_V7));
    const stats = findPath(profile.objects[0].properties, [
      "MyData",
      "MyPersistentCharacterStats",
    ])!;
    const template = stats.children!.find(
      (p) => p.name === "CharacterStatusComponent_NumberOfLevelUpPointsApplied",
    )!;
    stats.children!.push({ ...template, index: 9, data: new Uint8Array([7]) });

    const reparsed = parseArkProfile(serializeArkProfile(profile));
    const added = findPath(reparsed.objects[0].properties, [
      "MyData",
      "MyPersistentCharacterStats",
    ])!.children!.find(
      (p) =>
        p.name === "CharacterStatusComponent_NumberOfLevelUpPointsApplied" && p.index === 9,
    );
    expect(added?.data?.[0]).toBe(7);
  });
});
