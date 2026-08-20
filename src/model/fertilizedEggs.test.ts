import { describe, expect, it } from "vitest";
import {
  officialSource,
  officialStackSizes,
  officialVariantParents,
} from "./officialCatalog";
import { normalizeBpPath } from "./catalog";
// @ts-expect-error — plain .mjs build script, no type declarations
import { FERTILIZED_PAIRS } from "../../scripts/fertilized-eggs.mjs";

/**
 * The generated fertilized eggs, checked against the shipped dataset rather
 * than a fixture — the point of generating them is that they are really there.
 */
describe("fertilized eggs in the bundled catalog", () => {
  const items = officialSource.items;
  const byPath = new Map(
    items.map((item) => [normalizeBpPath(item.bpPath), item]),
  );

  it("adds only eggs that exist in the game", () => {
    // The pairs come from ARK's own containers, so every added path is real.
    // A naming rule produced sixteen wrong entries out of eighty: six Tek eggs
    // where `_Fertilized` goes *before* `_Bionic`, and ten generic eggs that
    // have no fertilized form at all.
    const added = items.filter((item) => /^Fertilized /.test(item.name));
    expect(added.length).toBeGreaterThan(60);
    for (const egg of added) {
      const cls = egg.bpPath.split(".").pop()!.replace(/_C$/, "");
      expect(Object.values(FERTILIZED_PAIRS), egg.name).toContain(cls);
    }
  });

  it("puts the suffix before a variant qualifier, not after", () => {
    const tek = items.find((item) => item.name === "Fertilized Tek Rex Egg");
    expect(tek?.bpPath).toContain("Egg_Rex_Fertilized_Bionic");
    expect(tek?.bpPath).not.toContain("Bionic_Fertilized");
  });

  it("invents nothing for an egg with no fertilized form", () => {
    // Small/Medium/Large, Titanoboa and Pachyrhino have none in the game.
    for (const name of ["Small Egg", "Large Egg", "Titanoboa Egg", "Pachyrhino Egg"]) {
      expect(items.some((item) => item.name === `Fertilized ${name}`), name).toBe(
        false,
      );
    }
  });

  it("files each derived egg under the egg it came from", () => {
    const fertilized = items.filter((item) =>
      /^Fertilized /.test(item.name),
    );
    expect(fertilized.length).toBeGreaterThan(50);
    for (const egg of fertilized) {
      const parent = officialVariantParents[normalizeBpPath(egg.bpPath)];
      expect(parent, egg.name).toBeTruthy();
      // The parent has to be a real entry, or the picker cannot collapse onto
      // it and the icon has nothing to inherit.
      expect(byPath.has(normalizeBpPath(parent)), parent).toBe(true);
    }
  });

  it("leaves the irregularly named ones exactly as ARK ships them", () => {
    // ARK puts the variant after the suffix on these, so the naive rule would
    // have produced a second, wrong entry beside each.
    for (const cls of [
      "PrimalItemConsumable_Egg_Wyvern_Fertilized_Fire",
      "PrimalItemConsumable_Egg_RockDrake_Fertilized",
      "PrimalItemConsumable_Egg_CrystalWyvern_Fertilized_Bloodfall",
    ]) {
      const matches = items.filter((item) => item.bpPath.includes(cls));
      expect(matches.length, cls).toBe(1);
      expect(matches[0].bpPath).not.toMatch(/_Fertilized_Fertilized/);
    }
  });

  it("gives each derived egg the stack size a fertilized egg has", () => {
    // The plain egg stacks to 100; the fertilized one does not stack, which is
    // what the nine the wiki does list all report.
    const rex = items.find((item) => item.name === "Fertilized Allosaurus Egg")!;
    expect(officialStackSizes.get(normalizeBpPath(rex.bpPath))).toBe(1);
  });

  it("adds no duplicate paths", () => {
    const seen = new Set(items.map((item) => normalizeBpPath(item.bpPath)));
    expect(seen.size).toBe(items.length);
  });
});
