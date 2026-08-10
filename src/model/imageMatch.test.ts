import { describe, expect, it } from "vitest";
import { buildImageIndex, freeIconName, matchImage } from "./imageMatch";
import { baseCreatureName } from "./variants";

// File layout mirroring the real images folder.
const FILES = [
  "creatures/Achatina.png",
  "creatures/Acrocanthosaurus (mod).png",
  "creatures/Anomalocaris (TSW).png",
  "creatures/Anomalocaris.png",
  "creatures/Woolly Rhino.png",
  "items/Cementing Paste.png",
  "logo.png",
  "favicon.png",
];

describe("image matching", () => {
  const index = buildImageIndex(FILES);

  it("matches creatures by display name", () => {
    expect(matchImage(index, "creatures", ["Achatina"])).toBe(
      "creatures/Achatina.png",
    );
  });

  it("matches names with spaces/case differences", () => {
    expect(matchImage(index, "creatures", ["woolly rhino"])).toBe(
      "creatures/Woolly Rhino.png",
    );
  });

  it("matches files with parenthetical suffixes", () => {
    expect(matchImage(index, "creatures", ["Acrocanthosaurus"])).toBe(
      "creatures/Acrocanthosaurus (mod).png",
    );
  });

  it("prefers the plain file over the parenthetical one", () => {
    expect(matchImage(index, "creatures", ["Anomalocaris"])).toBe(
      "creatures/Anomalocaris.png",
    );
  });

  it("scopes items to the items subfolder", () => {
    expect(matchImage(index, "items", ["Cementing Paste"])).toBe(
      "items/Cementing Paste.png",
    );
    expect(matchImage(index, "items", ["Achatina"])).toBeNull();
  });

  it("falls back through candidate lists", () => {
    expect(
      matchImage(index, "creatures", ["Aberrant Achatina", "Achatina"]),
    ).toBe("creatures/Achatina.png");
  });

  it("flat files match either kind", () => {
    const flat = buildImageIndex(["Hide.png"]);
    expect(matchImage(flat, "items", ["Hide"])).toBe("Hide.png");
    expect(matchImage(flat, "creatures", ["Hide"])).toBe("Hide.png");
  });

  it("detects missing-icon placeholders, tolerating odd names/locations", () => {
    // Real-world files: double extension, item placeholder in creatures folder.
    const idx = buildImageIndex([
      "creatures/Missing_Creature_Icon.png",
      "creatures/Missing_Item_Icon.png.png",
      "creatures/Achatina.png",
    ]);
    expect(idx.missing.creatures).toBe("creatures/Missing_Creature_Icon.png");
    expect(idx.missing.items).toBe("creatures/Missing_Item_Icon.png.png");
    // Placeholders never win a name match.
    expect(matchImage(idx, "creatures", ["Missing Creature Icon"])).toBeNull();
  });

  it("matches kebab-case item files", () => {
    const idx = buildImageIndex(["items/achatina-paste.webp"]);
    expect(matchImage(idx, "items", ["Achatina Paste"])).toBe(
      "items/achatina-paste.webp",
    );
  });
});

describe("variant base names for icon inheritance", () => {
  it.each([
    ["Aberrant Achatina", "Achatina"],
    ["Abyssal Rex", "Rex"],
    ["R-Snow Owl", "Snow Owl"],
    ["Tek Stryder", "Stryder"],
    ["Broodmother Lysrix (Gamma)", "Broodmother Lysrix"],
  ])("%s -> %s", (input, expected) => {
    expect(baseCreatureName(input)).toBe(expected);
  });
});

describe("naming an icon copied in from a mod's folder", () => {
  const existing = ["creatures/Rex.png", "items/Hide.png"];

  it("keeps the file's own name when nothing is in the way", () => {
    expect(freeIconName("icons/Gigantoraptor.png", "ARKOLOGY", existing)).toBe(
      "Gigantoraptor.png",
    );
  });

  it("never overwrites an image already in the folder", () => {
    // A second mod's Rex.png is a different picture — the first one must stay
    // exactly where the entries pointing at it expect to find it.
    expect(freeIconName("icons/Rex.png", "ARKOLOGY", existing)).toBe(
      "ARKOLOGY_Rex.png",
    );
    expect(freeIconName("icons/rex.PNG", "ARKOLOGY", existing)).toBe(
      "ARKOLOGY_rex.PNG",
    );
  });

  it("counts up when the mod's own name is taken too", () => {
    expect(
      freeIconName("Rex.png", "Prime Ark", [...existing, "Prime_Ark_Rex.png"]),
    ).toBe("Prime_Ark_Rex_2.png");
  });
});
