import { describe, expect, it, vi } from "vitest";
import { emptyCatalog, normalizeBpPath } from "../model/catalog";
import type { ViewerData } from "../serializers/viewer";

vi.mock("./ipc", () => ({
  ipc: async (_command: string, args: { path: string }) => {
    if (args.path.includes("Gone")) throw new Error("missing on disk");
    return btoa(`bytes:${args.path}`);
  },
}));

vi.mock("./packageHttp", () => ({
  packageHttpGet: async () => ({
    status: 200,
    contentType: "image/png",
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  }),
  packageBytesToBase64: (bytes: Uint8Array) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  },
}));

const { packageRootKey } = await import("./dependencyManager");
const { vendorViewerAssets } = await import("./viewerAssets");

describe("viewer asset vendoring", () => {
  it("embeds project images but never package images", async () => {
    const creature = "/Game/Mods/Test/Dino.Test_C";
    const item = "/Game/Mods/Test/Item.Item";
    const viewer = {
      cluster: "Test",
      logo: "logo.png",
      creatures: [{ id: creature, img: null, icon: "🦖" }],
      items: [{ id: item, img: "items/Item.png", icon: "📦" }],
    } as ViewerData;

    const result = await vendorViewerAssets(viewer, {
      catalog: emptyCatalog(),
      packageAssets: {
        [normalizeBpPath(creature)]: {
          origin: "package",
          packageId: "test-pack",
          version: "1.0.0",
          path: "assets/Dino.png",
        },
      },
      packageRoots: {
        [packageRootKey("modpack", "test-pack", "1.0.0")]: "C:\\package",
      },
      projectImagesDir: "C:\\project\\images",
    });

    expect(result.creatures[0].img).toBeNull();
    expect(result.items[0].img).toMatch(/^data:image\/png;base64,/);
    expect(result.logo).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(result)).not.toContain("C:\\");
  });

  it("does not embed remote compatibility refs", async () => {
    const creature = "/Game/Mods/Test/Dino.Test_C";
    const catalog = emptyCatalog();
    catalog.icons[normalizeBpPath(creature)] =
      "https://cdn.example.test/Dino.png";
    const viewer = {
      cluster: "Test",
      logo: null,
      creatures: [{ id: creature, img: null, icon: "dino" }],
      items: [],
    } as unknown as ViewerData;

    const result = await vendorViewerAssets(viewer, {
      catalog,
      packageAssets: {},
      packageRoots: {},
      projectImagesDir: "C:\\project\\images",
    });

    expect(result.creatures[0].img).toBeNull();
    expect(JSON.stringify(result)).not.toContain("https://");
  });

  it("does not embed managed official-package artwork", async () => {
    const creature = "/Game/PrimalEarth/Dinos/Achatina/Achatina_Character_BP";
    const viewer = {
      cluster: "Test",
      logo: null,
      creatures: [{ id: creature, img: null, icon: "🐌" }],
      items: [],
    } as unknown as ViewerData;

    const result = await vendorViewerAssets(viewer, {
      catalog: emptyCatalog(),
      packageAssets: {
        [normalizeBpPath(creature)]: {
          origin: "official",
          packageVersion: "1.0.0",
          path: "assets/creatures/Achatina.webp",
        },
      },
      packageRoots: {
        [packageRootKey("official", "official-asa", "1.0.0")]:
          "C:\\content\\official\\asa\\1.0.0",
      },
      projectImagesDir: "C:\\project\\images",
    });

    expect(result.creatures[0].img).toBeNull();
    expect(JSON.stringify(result)).not.toContain("C:\\");
  });

  it("ignores a package root pinned to a different version", async () => {
    const creature = "/Game/PrimalEarth/Dinos/Achatina/Achatina_Character_BP";
    const viewer = {
      cluster: "Test",
      logo: null,
      creatures: [{ id: creature, img: null, icon: "🐌" }],
      items: [],
    } as unknown as ViewerData;

    const result = await vendorViewerAssets(viewer, {
      catalog: emptyCatalog(),
      packageAssets: {
        [normalizeBpPath(creature)]: {
          origin: "official",
          packageVersion: "1.0.0",
          path: "assets/creatures/Achatina.webp",
        },
      },
      packageRoots: {
        [packageRootKey("official", "official-asa", "2.0.0")]:
          "C:\\content\\official\\asa\\2.0.0",
      },
      projectImagesDir: "C:\\project\\images",
    });

    expect(result.creatures[0].img).toBeNull();
  });

  it("skips unreadable images instead of failing the whole publication", async () => {
    const viewer = {
      cluster: "Test",
      logo: "logo.png",
      creatures: [{ id: "/Game/A.A", img: "creatures/Gone.png", icon: "🦖" }],
      items: [{ id: "/Game/B.B", img: "items/Kept.png", icon: "📦" }],
    } as unknown as ViewerData;
    const skipped: string[] = [];

    const result = await vendorViewerAssets(viewer, {
      catalog: emptyCatalog(),
      packageAssets: {},
      packageRoots: {},
      projectImagesDir: "C:\\project\\images",
      onSkipped: (path, reason) => skipped.push(`${path}|${reason}`),
    });

    expect(result.creatures[0].img).toBeNull();
    expect(result.items[0].img).toMatch(/^data:image\/png;base64,/);
    expect(result.logo).toMatch(/^data:image\/png;base64,/);
    expect(skipped).toEqual(["creatures/Gone.png|missing on disk"]);
  });
});

describe("official icon assignments in a published viewer", () => {
  it("leaves official art for runtime rights-aware resolution", async () => {
    const creature = "/Game/Mods/Test/Dino.Test_C";
    const catalog = emptyCatalog();
    catalog.icons[normalizeBpPath(creature)] = "official:creatures/Rex.webp";
    const viewer = {
      cluster: "Test",
      creatures: [{ id: creature, img: null, icon: "🦖" }],
      items: [],
    } as unknown as ViewerData;

    const skipped: string[] = [];
    const result = await vendorViewerAssets(viewer, {
      catalog,
      packageAssets: {},
      packageRoots: {
        [packageRootKey("official", "official-asa", "1.1.0")]: "C:/lib/official",
      },
      officialVersion: "1.1.0",
      projectImagesDir: "C:/project/images",
      onSkipped: (path, reason) => skipped.push(`${path}: ${reason}`),
    });

    expect(skipped).toEqual([]);
    expect(result.creatures[0].img).toBeNull();
  });

  it("still publishes when no official package is pinned", async () => {
    // Nonfatal by design: the entry keeps its glyph and the cluster publishes.
    const creature = "/Game/Mods/Test/Dino.Test_C";
    const catalog = emptyCatalog();
    catalog.icons[normalizeBpPath(creature)] = "official:creatures/Rex.webp";
    const viewer = {
      cluster: "Test",
      creatures: [{ id: creature, img: null, icon: "🦖" }],
      items: [],
    } as unknown as ViewerData;

    const result = await vendorViewerAssets(viewer, {
      catalog,
      packageAssets: {},
      packageRoots: {},
      projectImagesDir: "C:/project/images",
    });
    expect(result.creatures[0].img).toBeFalsy();
    expect(result.creatures[0].icon).toBe("🦖");
  });
});
