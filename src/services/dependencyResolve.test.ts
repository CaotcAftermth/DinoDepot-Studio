import { beforeEach, describe, expect, it, vi } from "vitest";
import { PackageDependencySchema } from "../model/dependency";
import { PackageContentSchema, PackageManifestSchema } from "../model/package";
import type { InstalledPackage } from "./packageManager";

/**
 * Resolution order for one exact dependency.
 *
 * Everything local must be tried before the network: the library, then the
 * package this build ships with, then a folder on this machine. GitHub is how
 * a new version is distributed, not how an already-pinned one is found - so
 * local development and a first offline launch must never depend on it.
 */

const library = new Map<string, InstalledPackage>();
const calls: string[] = [];

function installed(
  kind: "modpack" | "official",
  packageId: string,
  version: string,
  integrity = "",
): InstalledPackage {
  return {
    manifest: PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 2,
      kind,
      packageId,
      version,
      meta: { name: packageId },
      content: { path: "content.json", sha256: "1".repeat(64), size: 1 },
    }),
    manifestIntegrity: integrity,
    content: PackageContentSchema.parse({
      format: "dinodepot.package-content",
      schemaVersion: 1,
    }),
    info: {
      kind,
      packageId,
      version,
      path: `C:\\appdata\\content\\${kind}\\${packageId}\\${version}`,
      installedAt: "installed",
    },
  };
}

const key = (kind: string, packageId: string, version: string) =>
  `${kind}:${packageId}:${version}`;

vi.mock("./packageManager", () => ({
  readInstalledPackage: async (
    kind: "modpack" | "official",
    packageId: string,
    version: string,
  ) => {
    calls.push("library");
    return library.get(key(kind, packageId, version)) ?? null;
  },
  installBundledOfficialPackage: async (version: string) => {
    calls.push("bundled");
    if (version !== "1.0.0") return null;
    const value = installed("official", "official-asa", version, "b".repeat(64));
    library.set(key("official", "official-asa", version), value);
    return value;
  },
  installLocalPackageManifest: async (path: string) => {
    calls.push(`local:${path}`);
    if (!path.includes("good")) throw new Error("no such manifest");
    const value = installed("modpack", "dev-pack", "1.0.0-dev.1");
    library.set(key("modpack", "dev-pack", "1.0.0-dev.1"), value);
    return { downloaded: { manifest: value.manifest }, installed: value.info };
  },
  downloadRegistryPackage: async () => {
    calls.push("github");
    throw new Error("network is unavailable");
  },
  downloadPackageFromManifestUrl: async () => {
    calls.push("github");
    throw new Error("network is unavailable");
  },
  installDownloadedPackage: async () => {
    throw new Error("not reached");
  },
}));

const { ensureProjectDependencies } = await import("./dependencyManager");

const official = (version = "1.0.0", integrity = "b".repeat(64)) =>
  PackageDependencySchema.parse({
    kind: "official",
    packageId: "official-asa",
    version,
    integrity,
    mode: "linked",
    locator: {
      owner: "CaotcAftermth",
      repo: "DinoDepot-Studio",
      branch: "main",
      path: "Public_Content/Official_Icons",
      manifest: `versions/${version}/manifest.json`,
    },
  });

describe("offline-first dependency resolution", () => {
  beforeEach(() => {
    library.clear();
    calls.length = 0;
  });

  it("bootstraps the official package from the bundle without any network call", async () => {
    const result = await ensureProjectDependencies([official()]);

    expect(result.available).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(calls).not.toContain("github");
    expect(calls).toContain("bundled");
  });

  it("reuses the installed library and never reaches the bundle or GitHub", async () => {
    library.set(
      key("official", "official-asa", "1.0.0"),
      installed("official", "official-asa", "1.0.0", "b".repeat(64)),
    );

    const result = await ensureProjectDependencies([official()]);

    expect(result.available).toHaveLength(1);
    expect(calls).toEqual(["library"]);
  });

  it("installs a machine-local development manifest before trying GitHub", async () => {
    const dependency = PackageDependencySchema.parse({
      kind: "modpack",
      packageId: "dev-pack",
      version: "1.0.0-dev.1",
      mode: "linked",
      locator: { manifestUrl: "https://example.test/manifest.json" },
    });

    const result = await ensureProjectDependencies([dependency], {
      "dev-pack@1.0.0-dev.1": "C:\\dev-packages\\good\\manifest.json",
    });

    expect(result.available).toHaveLength(1);
    expect(calls).not.toContain("github");
  });

  it("degrades to default icons rather than failing when nothing resolves", async () => {
    const result = await ensureProjectDependencies([official("9.9.9", "")]);

    expect(result.available).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ severity: "warning" });
    expect(result.diagnostics[0].message).toContain("default icons");
  });

  it("refuses a bundled package that does not match the project integrity pin", async () => {
    const result = await ensureProjectDependencies([
      official("1.0.0", "c".repeat(64)),
    ]);

    expect(result.available).toEqual([]);
    expect(calls).toContain("bundled");
  });
});
