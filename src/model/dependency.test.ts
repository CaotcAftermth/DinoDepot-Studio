import { describe, expect, it } from "vitest";
import {
  dependencyKey,
  mergeDependencies,
  PackageDependencySchema,
  upsertDependency,
} from "./dependency";

const official = (version = "1.0.0") =>
  PackageDependencySchema.parse({
    kind: "official",
    packageId: "official-asa",
    version,
    mode: "linked",
  });

const modpack = (version = "1.0.0", curseforgeId = "987274") =>
  PackageDependencySchema.parse({
    kind: "modpack",
    packageId: "additions-ascended-anomalocaris",
    version,
    curseforgeId,
    mode: "linked",
  });

describe("dependency merging", () => {
  it("keeps both rows when two operations each add their own", () => {
    // The shape of the old race: each caller starts from the same list and
    // writes back its own edit. Merging by identity means neither is lost.
    const before = [modpack()];
    const openingProject = mergeDependencies(before, [official()]);
    const installingPack = mergeDependencies(before, [modpack("1.0.1")]);

    const combined = mergeDependencies(openingProject, installingPack);

    expect(combined.map(dependencyKey).sort()).toEqual([
      "modpack:curseforge:987274",
      "official:official-asa",
    ]);
    expect(combined.find((d) => d.kind === "modpack")?.version).toBe("1.0.1");
  });

  it("never upgrades an existing pin when merging defaults", () => {
    const pinned = [official("1.0.0")];

    const merged = mergeDependencies(pinned, [official("2.0.0")], {
      asDefaults: true,
    });

    expect(merged).toHaveLength(1);
    expect(merged[0].version).toBe("1.0.0");
  });

  it("adds a default only when the identity is absent", () => {
    const merged = mergeDependencies([modpack()], [official()], {
      asDefaults: true,
    });

    expect(merged.map((d) => d.kind).sort()).toEqual(["modpack", "official"]);
  });

  it("replaces by identity when not merging defaults", () => {
    const merged = mergeDependencies([official("1.0.0")], [official("2.0.0")]);

    expect(merged).toHaveLength(1);
    expect(merged[0].version).toBe("2.0.0");
  });

  it("treats a renamed package slug with the same CurseForge ID as one row", () => {
    const renamed = PackageDependencySchema.parse({
      ...modpack("1.0.1"),
      packageId: "anomalocaris-renamed",
    });

    expect(mergeDependencies([modpack()], [renamed])).toHaveLength(1);
    expect(upsertDependency([modpack()], renamed)).toHaveLength(1);
  });

  it("does not mutate the list it was given", () => {
    const before = [modpack()];

    mergeDependencies(before, [official()]);

    expect(before).toHaveLength(1);
  });
});
