import { describe, expect, it } from "vitest";
import { emptyCatalog, normalizeBpPath } from "../model/catalog";
import {
  PackageDependencySchema,
  upsertDependency,
} from "../model/dependency";
import {
  PackageContentSchema,
  PackageManifestSchema,
} from "../model/package";
import {
  packageRootKey,
  projectOverridesFromResolved,
  resolveDependencyLayers,
} from "./dependencyManager";

const path = "/Game/Mods/Test/Dino.Test_C";
const key = normalizeBpPath(path);

function dependency(version = "1.0.0") {
  return PackageDependencySchema.parse({
    kind: "modpack",
    packageId: "test-pack",
    version,
    integrity: "1".repeat(64),
    curseforgeId: "123",
    sourceId: "source-1",
    mode: "linked",
  });
}

function available(version = "1.0.0", note = "Package note") {
  const dep = dependency(version);
  const manifest = PackageManifestSchema.parse({
    format: "dinodepot.package",
    formatVersion: 2,
    kind: "modpack",
    packageId: dep.packageId,
    version,
    curseforgeId: dep.curseforgeId,
    meta: { name: "Test Pack" },
    content: {
      path: "content.json",
      sha256: "2".repeat(64),
      size: 1,
    },
  });
  const content = PackageContentSchema.parse({
    format: "dinodepot.package-content",
    schemaVersion: 1,
    creatures: [{ id: "test", name: "Test", bpPath: path }],
    icons: { [path]: "file:assets/Test.png" },
    notes: { [path]: note },
  });
  return {
    dependency: dep,
    installed: {
      manifest,
      manifestIntegrity: dep.integrity,
      content,
      info: {
        kind: "modpack" as const,
        packageId: dep.packageId,
        version,
        path: `C:\\packages\\${version}`,
        installedAt: "installed",
      },
    },
  };
}

describe("dependency manager", () => {
  it("resolves package defaults below project overrides and keeps asset origin", () => {
    const project = emptyCatalog();
    project.notes[key] = "Project note";

    const resolved = resolveDependencyLayers(project, [available()]);

    expect(resolved.catalog.sources[0]).toMatchObject({
      id: "source-1",
      modpackId: "test-pack",
      modpackVersion: "1.0.0",
    });
    expect(resolved.catalog.notes[key]).toBe("Project note");
    expect(resolved.packageAssets[key]).toMatchObject({
      origin: "package",
      packageId: "test-pack",
      version: "1.0.0",
      path: "assets/Test.png",
    });
  });

  it("persists only values that differ from package defaults", () => {
    const resolved = resolveDependencyLayers(emptyCatalog(), [available()]);
    const project = projectOverridesFromResolved(
      resolved.catalog,
      resolved.defaults,
    );

    expect(project.notes).toEqual({});
    const changed = {
      ...resolved.catalog,
      notes: { ...resolved.catalog.notes, [key]: "My note" },
    };
    expect(
      projectOverridesFromResolved(changed, resolved.defaults).notes,
    ).toEqual({ [key]: "My note" });
  });

  it("reports deterministic collisions and lets the later dependency win", () => {
    const later = available("2.0.0", "Later");
    later.dependency = PackageDependencySchema.parse({
      ...later.dependency,
      packageId: "other-pack",
      integrity: "3".repeat(64),
    });
    later.installed.manifest = PackageManifestSchema.parse({
      ...later.installed.manifest,
      packageId: "other-pack",
    });

    const resolved = resolveDependencyLayers(emptyCatalog(), [available(), later]);

    expect(resolved.catalog.notes[key]).toBe("Later");
    expect(resolved.diagnostics.some((item) => /both/.test(item.message))).toBe(true);
  });

  it("keeps only one exact dependency per package identity", () => {
    expect(upsertDependency([dependency("1.0.0")], dependency("2.0.0"))).toMatchObject([
      { packageId: "test-pack", version: "2.0.0" },
    ]);
  });

  it("uses CurseForge identity even if a package slug changes", () => {
    const renamed = PackageDependencySchema.parse({
      ...dependency("2.0.0"),
      packageId: "renamed-pack",
    });
    expect(upsertDependency([dependency("1.0.0")], renamed)).toMatchObject([
      { packageId: "renamed-pack", version: "2.0.0", curseforgeId: "123" },
    ]);
  });

  it("resolves official icons from the managed Core Content root", () => {
    const dep = PackageDependencySchema.parse({
      kind: "official",
      packageId: "official-asa",
      version: "1.0.0",
      integrity: "4".repeat(64),
      mode: "linked",
    });
    const manifest = PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 2,
      kind: "official",
      packageId: "official-asa",
      version: "1.0.0",
      meta: { name: "Official ASA" },
      content: {
        path: "content.json",
        sha256: "5".repeat(64),
        size: 1,
      },
    });
    const content = PackageContentSchema.parse({
      format: "dinodepot.package-content",
      schemaVersion: 1,
      icons: { [path]: "file:assets/creatures/Test.webp" },
    });

    const resolved = resolveDependencyLayers(emptyCatalog(), [
      {
        dependency: dep,
        installed: {
          manifest,
          manifestIntegrity: dep.integrity,
          content,
          info: {
            kind: "official",
            packageId: "official-asa",
            version: "1.0.0",
            path: "C:\\packages\\official\\1.0.0",
            installedAt: "installed",
          },
        },
      },
    ]);

    expect(resolved.packageAssets[key]).toEqual({
      origin: "official",
      packageVersion: "1.0.0",
      path: "assets/creatures/Test.webp",
    });
    expect(
      resolved.packageRoots[packageRootKey("official", "official-asa", "1.0.0")],
    ).toContain("official");
    expect(
      resolved.packageRoots[packageRootKey("official", "official-asa", "9.9.9")],
    ).toBeUndefined();
    expect(resolved.officialVersion).toBe("1.0.0");
    expect(resolved.catalog.sources).toEqual([]);
  });

  it("does not report a collision between two different domains", () => {
    const path = "/Game/Mods/Two/Thing.Thing";
    const key = normalizeBpPath(path);
    const layer = (packageId: string, icons = false) => ({
      dependency: PackageDependencySchema.parse({
        kind: "official" as const,
        packageId: "official-asa",
        version: packageId,
      }),
      installed: {
        manifest: PackageManifestSchema.parse({
          format: "dinodepot.package",
          formatVersion: 2,
          kind: "official",
          packageId: "official-asa",
          version: packageId,
          meta: { name: "Core" },
          content: { path: "content.json", sha256: "5".repeat(64), size: 1 },
        }),
        manifestIntegrity: "",
        content: PackageContentSchema.parse({
          format: "dinodepot.package-content",
          schemaVersion: 1,
          ...(icons ? { icons: { [path]: "🦖" } } : { notes: { [path]: "n" } }),
        }),
        info: {
          kind: "official" as const,
          packageId: "official-asa",
          version: packageId,
          path: `C:\\packages\\official\\${packageId}`,
          installedAt: "installed",
        },
      },
    });

    const resolved = resolveDependencyLayers(emptyCatalog(), [
      layer("1.0.0", true),
      layer("1.0.1"),
    ]);

    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.defaults.icons[key]).toBe("🦖");
    expect(resolved.defaults.notes[key]).toBe("n");
  });
});
