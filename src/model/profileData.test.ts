import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseArkProfile,
  serializeArkProfile,
  type ArkProfile,
} from "../serializers/arkprofile";
import {
  applyProfileEdits,
  isValidEosId,
  mapFromPackage,
  packageForMap,
  profileFileNameFor,
  readNetworkAddress,
  readProfileSummary,
} from "./profileData";

const SAMPLE = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("../serializers/__fixtures__/sample.arkprofile", import.meta.url)),
  ),
);

const SAMPLE_V7 = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("../serializers/__fixtures__/sample-v7.arkprofile", import.meta.url)),
  ),
);

const sample = (): ArkProfile => parseArkProfile(SAMPLE);
const sampleV7 = (): ArkProfile => parseArkProfile(SAMPLE_V7);

/** Round-trips through the codec, which is what the app actually writes out. */
const rewrite = (profile: ArkProfile) => parseArkProfile(serializeArkProfile(profile));

describe("readProfileSummary", () => {
  const summary = readProfileSummary(sample());
  const profile = sample();

  it("reads the identity fields", () => {
    expect(summary.eosId).toBe("000211223344556677889900aabbccdd");
    expect(summary.platform).toBe("RedpointEOS");
    expect(summary.accountName).toBe("testplayer1");
    expect(summary.characterName).toBe("Test Dino");
    expect(summary.playerDataId).toBe("1234567890");
    expect(summary.tribeId).toBe("1122334455");
    expect(readNetworkAddress(profile)).toBe("203.0.113.42");
  });

  it("reads the map the save belongs to", () => {
    expect(summary.mapPackage).toBe("ScorchedEarth_WP");
    expect(summary.map).toBe("Scorched Earth");
  });

  it("reads progression, converting the stored level to the displayed one", () => {
    expect(summary.extraLevel).toBe(21);
    expect(summary.level).toBe(22);
    expect(summary.experience).toBeCloseTo(2502.9, 0);
    expect(summary.engramPoints).toBe(232);
    expect(summary.engramsLearned).toBe(61);
    expect(summary.deaths).toBe(13);
  });

  it("reads allocated stat points against their stat, not their position", () => {
    const points = Object.fromEntries(summary.statPoints.map((s) => [s.label, s.points]));
    expect(points.Health).toBe(11);
    expect(points.Stamina).toBe(5);
    expect(points.Fortitude).toBe(5);
    expect(points.Weight).toBe(0);
    // One point per level is the default rate; a mismatch would mean the
    // server hands out more, which is worth the admin seeing.
    expect(summary.spentPoints).toBe(summary.extraLevel);
  });

  it("lists persistent buffs the survivor logged out with", () => {
    expect(summary.activeBuffs).toEqual(["Heatstroke"]);
  });
});

describe("readProfileSummary on a save version 7 profile", () => {
  const summary = readProfileSummary(sampleV7());

  it("reads identity and map the same way", () => {
    expect(summary.saveVersion).toBe(7);
    expect(summary.eosId).toBe("0002bbccddeeff001122334455667788");
    expect(summary.accountName).toBe("testplyr07");
    expect(summary.characterName).toBe("Human");
    expect(summary.playerDataId).toBe("1234567890");
    expect(summary.tribeId).toBe("1122334455");
    expect(summary.mapPackage).toBe("LostColony_WP");
    expect(summary.map).toBe("Lost Colony");
  });

  it("reads progression", () => {
    expect(summary.level).toBe(72);
    expect(summary.engramsLearned).toBe(65);
    expect(summary.engramPoints).toBe(1584);
    expect(summary.deaths).toBe(17);
    const points = Object.fromEntries(summary.statPoints.map((s) => [s.label, s.points]));
    expect(points.Health).toBe(24);
    expect(points.Stamina).toBe(15);
    expect(points.Weight).toBe(16);
    expect(points["Crafting Speed"]).toBe(10);
    expect(summary.spentPoints).toBe(71);
  });

  it("reads the skill tree, which only the newer maps have", () => {
    expect(summary.skillTrees).toEqual([
      { name: "Global", level: 0, index: 8 },
      { name: "LostColony", level: 0, index: 23 },
    ]);
    expect(summary.completedMilestones).toBe(4);
    expect(summary.currentMilestones).toBe(1);
    // Version 5 maps have no skill tree at all.
    expect(readProfileSummary(sample()).skillTrees).toEqual([]);
  });

  it("names buffs from the blueprint they declare, not their generic class", () => {
    // Every v7 buff object shares one class name, so the class alone would
    // report four buffs all called "PrimalBuffPersistentData".
    expect(summary.activeBuffs).toEqual([
      "MissionData",
      "SprinklesWeightAdjuster",
      "SprinklesHelper",
      "GSA",
    ]);
  });

  it("reports ascension as unknown rather than zero when the field is absent", () => {
    expect(summary.ascension).toBeNull();
    expect(summary.ascensionProp).toBe("");
    expect(readProfileSummary(sample()).ascension).toBeNull();
  });
});

describe("map packages", () => {
  it("maps package names to the names used on the Maps setting", () => {
    expect(mapFromPackage("ScorchedEarth_WP")).toBe("Scorched Earth");
    expect(mapFromPackage("theisland_wp")).toBe("The Island");
    expect(mapFromPackage("SomeMod_WP")).toBe("");
    expect(packageForMap("Aberration")).toBe("Aberration_WP");
    expect(packageForMap("Not A Map")).toBe("");
  });
});

describe("profile file naming", () => {
  it("names a profile after the EOS id, which is what the game looks for", () => {
    expect(profileFileNameFor("000211223344556677889900AABBCCDD")).toBe(
      "000211223344556677889900aabbccdd.arkprofile",
    );
  });

  it("validates EOS ids", () => {
    expect(isValidEosId("000211223344556677889900aabbccdd")).toBe(true);
    expect(isValidEosId("00021122")).toBe(false);
    expect(isValidEosId("000211223344556677889900aabbccdz")).toBe(false);
  });
});

describe("applyProfileEdits", () => {
  it("rewrites identity and reports every change", () => {
    const { profile, changes, skipped } = applyProfileEdits(sample(), {
      eosId: "0002ffeeddccbbaa99887766554433221",
      accountName: "newaccount",
      characterName: "Rebuilt Survivor",
      playerDataId: "987654321",
      tribeId: "42",
    });
    // The EOS id above is 33 characters - deliberately malformed.
    expect(skipped).toContain("EOS ID");

    const summary = readProfileSummary(rewrite(profile));
    expect(summary.accountName).toBe("newaccount");
    expect(summary.characterName).toBe("Rebuilt Survivor");
    expect(summary.playerDataId).toBe("987654321");
    expect(summary.tribeId).toBe("42");
    expect(changes.map((c) => c.field)).toContain("Character name");
    expect(changes.find((c) => c.field === "Player ID")).toMatchObject({
      from: "1234567890",
      to: "987654321",
    });
  });

  it("writes a valid EOS id in place", () => {
    const { profile } = applyProfileEdits(sample(), {
      eosId: "0002FFEEDDCCBBAA99887766554433221".slice(0, 32),
    });
    expect(readProfileSummary(rewrite(profile)).eosId).toBe(
      "0002ffeeddccbbaa9988776655443322",
    );
  });

  it("moves the highest-level mark up with the level", () => {
    const { profile } = applyProfileEdits(sample(), { extraLevel: 80 });
    const summary = readProfileSummary(rewrite(profile));
    expect(summary.level).toBe(81);
    expect(summary.highestLevel).toBe(81);
  });

  it("does not drag the highest-level mark down", () => {
    const { profile } = applyProfileEdits(sample(), { extraLevel: 5 });
    const summary = readProfileSummary(rewrite(profile));
    expect(summary.level).toBe(6);
    expect(summary.highestLevel).toBe(22);
  });

  it("edits an existing stat and adds one the template left at zero", () => {
    const { profile, changes } = applyProfileEdits(sample(), {
      statPoints: { 0: 30, 7: 12 },
    });
    const summary = readProfileSummary(rewrite(profile));
    const points = Object.fromEntries(summary.statPoints.map((s) => [s.label, s.points]));
    expect(points.Health).toBe(30);
    // Weight was absent from the template, so the property had to be created.
    expect(points.Weight).toBe(12);
    expect(points.Stamina).toBe(5);
    expect(changes.map((c) => c.field)).toContain("Weight points");
  });

  it("retargets the save to another map", () => {
    const { profile, changes } = applyProfileEdits(sample(), {
      mapPackage: "Aberration_WP",
    });
    const rewritten = rewrite(profile);
    const summary = readProfileSummary(rewritten);
    expect(summary.mapPackage).toBe("Aberration_WP");
    expect(summary.map).toBe("Aberration");
    // The full package path names the level too, and must move with it.
    expect(rewritten.objects[0].names.some((n) => n.includes("ScorchedEarth_WP"))).toBe(false);
    expect(changes).toContainEqual({
      field: "Map",
      from: "ScorchedEarth_WP",
      to: "Aberration_WP",
    });
  });

  it("clears the recorded IP on request", () => {
    const { profile } = applyProfileEdits(sample(), { clearNetworkAddress: true });
    expect(readNetworkAddress(rewrite(profile))).toBe("");
  });

  it("leaves everything it was not asked to change alone", () => {
    const { profile } = applyProfileEdits(sample(), { characterName: "Someone Else" });
    const before = readProfileSummary(sample());
    const after = readProfileSummary(rewrite(profile));
    expect({ ...after, characterName: before.characterName }).toEqual(before);
  });

  it("clears every allocated stat point so the player can spend them", () => {
    const { profile, changes } = applyProfileEdits(sample(), {
      clearStatPoints: true,
      extraLevel: 60,
    });
    const summary = readProfileSummary(rewrite(profile));
    expect(summary.spentPoints).toBe(0);
    expect(summary.level).toBe(61);
    expect(changes.map((c) => c.field)).toContain("Health points");
  });

  it("sets the explorer note count", () => {
    const { profile, changes } = applyProfileEdits(sample(), { explorerNotes: 40 });
    expect(readProfileSummary(rewrite(profile)).explorerNotes).toBe(40);
    expect(changes).toContainEqual({ field: "Explorer notes", from: "2", to: "40" });
  });

  it("clamps a note count to the bits the map actually has", () => {
    const { profile } = applyProfileEdits(sample(), { explorerNotes: 99999 });
    // 39 words of 32 bits on this map.
    expect(readProfileSummary(rewrite(profile)).explorerNotes).toBe(39 * 32);
  });

  it("writes skill tree progress on a version 7 profile", () => {
    const { profile, changes } = applyProfileEdits(sampleV7(), {
      skillTrees: { Global: { level: 2, index: 30 }, LostColony: { level: 1, index: 44 } },
    });
    expect(readProfileSummary(rewrite(profile)).skillTrees).toEqual([
      { name: "Global", level: 2, index: 30 },
      { name: "LostColony", level: 1, index: 44 },
    ]);
    expect(changes).toContainEqual({
      field: "Global skill tree",
      from: "0/8",
      to: "2/30",
    });
  });

  it("reports a skill tree the template does not have instead of inventing one", () => {
    const { skipped } = applyProfileEdits(sampleV7(), {
      skillTrees: { Aberration: { level: 1, index: 1 } },
    });
    expect(skipped).toContain("Aberration skill tree");
  });

  it("reports ascension as unavailable rather than writing a guess", () => {
    const { profile, skipped, changes } = applyProfileEdits(sampleV7(), { ascension: 3 });
    expect(skipped).toContain("Ascension");
    expect(changes.some((c) => c.field === "Ascension")).toBe(false);
    // Nothing else moved either.
    expect(serializeArkProfile(profile)).toEqual(SAMPLE_V7);
  });

  it("edits a version 7 profile without changing its save version", () => {
    const { profile } = applyProfileEdits(sampleV7(), {
      characterName: "Colonist",
      extraLevel: 90,
      clearStatPoints: true,
    });
    const summary = readProfileSummary(rewrite(profile));
    expect(summary.saveVersion).toBe(7);
    expect(summary.characterName).toBe("Colonist");
    expect(summary.level).toBe(91);
    expect(summary.spentPoints).toBe(0);
    // The engram list and skill tree ride along untouched.
    expect(summary.engramsLearned).toBe(65);
    expect(summary.skillTrees).toHaveLength(2);
  });

  it("adds a missing stat property on a version 7 profile too", () => {
    const { profile } = applyProfileEdits(sampleV7(), { statPoints: { 9: 12 } });
    const summary = readProfileSummary(rewrite(profile));
    const points = Object.fromEntries(summary.statPoints.map((s) => [s.label, s.points]));
    expect(points["Movement Speed"]).toBe(12);
    expect(points.Health).toBe(24);
  });

  it("does not modify the template it was given", () => {
    const template = sample();
    applyProfileEdits(template, { characterName: "Mutated", extraLevel: 99 });
    expect(serializeArkProfile(template)).toEqual(SAMPLE);
  });
});
