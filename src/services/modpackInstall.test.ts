import { describe, expect, it } from "vitest";
import { ModpackSchema } from "../model/modpack";
import { preparePackIcons, validatePackIcons } from "./modpackInstall";

const png = "iVBORw0KGgo=";

function pack(icon = "file:Creature.png") {
  return ModpackSchema.parse({
    meta: { id: "pack", name: "Pack" },
    icons: { "/m/c.c": icon },
  });
}

describe("transactional modpack icon validation", () => {
  it("accepts a complete, referenced image set", () => {
    expect(
      validatePackIcons(pack(), {
        icons: [{ name: "Creature.png", contentB64: png }],
        missing: [],
      }),
    ).toHaveLength(1);
  });

  it("omits a missing referenced image so the mod uses its fallback", () => {
    const prepared = preparePackIcons(pack(), {
      icons: [],
      missing: ["Creature.png"],
    });
    expect(prepared.icons).toEqual([]);
    expect(prepared.pack.icons).toEqual({});
    expect(prepared.skipped).toEqual(["Creature.png"]);
  });

  it("omits contextual traversal in a legacy file reference", () => {
    const prepared = preparePackIcons(pack("file:../Creature.png"), {
      icons: [{ name: "Creature.png", contentB64: png }],
      missing: [],
    });
    expect(prepared.pack.icons).toEqual({});
  });

  it("accepts only PNG or WebP and omits extension/content mismatches", () => {
    expect(
      preparePackIcons(pack("file:Creature.jpg"), {
        icons: [{ name: "Creature.jpg", contentB64: png }],
        missing: [],
      }).pack.icons,
    ).toEqual({});
    expect(
      preparePackIcons(pack(), {
        icons: [{ name: "Creature.png", contentB64: "UklGRgAAAABXRUJQ" }],
        missing: [],
      }).pack.icons,
    ).toEqual({});
  });
});
