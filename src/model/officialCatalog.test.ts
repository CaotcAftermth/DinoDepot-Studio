import { describe, expect, it } from "vitest";
import {
  effectiveOfficialSource,
  isBundledOfficialId,
  officialCategories,
  officialSource,
  officialStackSizes,
  officialWithAbsent,
} from "./officialCatalog";
import { emptyCatalog, normalizeBpPath } from "./catalog";

describe("official ASA overlay", () => {
  it("returns the bundled source untouched when there are no additions", () => {
    expect(effectiveOfficialSource(emptyCatalog())).toBe(officialSource);
  });

  it("appends admin-added creatures and items", () => {
    const catalog = emptyCatalog();
    catalog.official.creatures.push({
      id: "user-1",
      name: "Newly Released Dino",
      bpPath: "/Game/ASA/Dinos/New/New_Character_BP.New_Character_BP",
    });
    catalog.official.items.push({
      id: "user-2",
      name: "New Resource",
      bpPath: "/Game/ASA/Items/PrimalItemResource_New.PrimalItemResource_New",
    });

    const source = effectiveOfficialSource(catalog);
    expect(source.creatures).toHaveLength(officialSource.creatures.length + 1);
    expect(source.items).toHaveLength(officialSource.items.length + 1);
    expect(source.creatures[source.creatures.length - 1].name).toBe(
      "Newly Released Dino",
    );
    // The bundled dataset itself must not be mutated.
    expect(officialSource.creatures.some((c) => c.id === "user-1")).toBe(false);
  });

  it("carries the reference links through", () => {
    const catalog = emptyCatalog();
    catalog.official.docsUrl = "https://ark.wiki.gg/wiki/Server_configuration";
    catalog.official.iniNotes = "[ServerSettings]\nXPMultiplier=2.0";

    const source = effectiveOfficialSource(catalog);
    expect(source.docsUrl).toContain("ark.wiki.gg");
    expect(source.iniNotes).toContain("XPMultiplier");
  });

  it("distinguishes bundled ids from admin-added ones", () => {
    expect(isBundledOfficialId("offc-12")).toBe(true);
    expect(isBundledOfficialId("offi-340")).toBe(true);
    expect(isBundledOfficialId(crypto.randomUUID())).toBe(false);
  });
});

describe("ASA availability review", () => {
  const outlet = officialSource.items.find(
    (i) => i.name === "Electrical Outlet",
  )!;

  it("hides entries reviewed as not in ASA", () => {
    const catalog = emptyCatalog();
    catalog.official.asaReview[normalizeBpPath(outlet.bpPath)] = "absent";

    const source = effectiveOfficialSource(catalog);
    expect(source.items).toHaveLength(officialSource.items.length - 1);
    expect(source.items.some((i) => i.name === "Electrical Outlet")).toBe(false);
  });

  it("keeps entries reviewed as present", () => {
    const catalog = emptyCatalog();
    catalog.official.asaReview[normalizeBpPath(outlet.bpPath)] = "confirmed";
    expect(effectiveOfficialSource(catalog).items).toHaveLength(
      officialSource.items.length,
    );
  });

  it("still lists absent entries for the review screen", () => {
    const catalog = emptyCatalog();
    catalog.official.asaReview[normalizeBpPath(outlet.bpPath)] = "absent";
    expect(
      officialWithAbsent(catalog).items.some(
        (i) => i.name === "Electrical Outlet",
      ),
    ).toBe(true);
  });

  it("does not mutate the bundled dataset", () => {
    const catalog = emptyCatalog();
    catalog.official.asaReview[normalizeBpPath(outlet.bpPath)] = "absent";
    effectiveOfficialSource(catalog);
    expect(
      officialSource.items.some((i) => i.name === "Electrical Outlet"),
    ).toBe(true);
  });
});

describe("bundled item facts", () => {
  it("carries a stack size for every bundled item", () => {
    const missing = officialSource.items.filter(
      (i) => !officialStackSizes.has(normalizeBpPath(i.bpPath)),
    );
    expect(missing).toHaveLength(0);
  });

  it("keys categories so a trailing _C still matches", () => {
    const rex = officialSource.creatures.find((c) => c.name === "Rex")!;
    expect(officialCategories.get(normalizeBpPath(`${rex.bpPath}_C`))).toBe(
      "Dinosaurs",
    );
  });
});
