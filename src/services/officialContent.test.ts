import { describe, expect, it } from "vitest";
import officialIndex from "../../Public_Content/Official_Icons/index.json";
import {
  managedOfficialDependency,
  withManagedOfficialDependency,
} from "./officialContent";

// Read from the index rather than hardcoding a version: publishing a new
// official package is a routine act, and a test that has to be edited every
// time teaches people to edit tests to make them pass.
const release = officialIndex.package;

describe("managed Official ASA content", () => {
  it("pins the published exact version without a local folder", () => {
    const dependency = managedOfficialDependency();
    expect(dependency).toMatchObject({
      kind: "official",
      packageId: "official-asa",
      version: release.version,
      mode: "linked",
      locator: {
        path: "Public_Content/Official_Icons",
        manifest: `versions/${release.version}/manifest.json`,
      },
    });
    expect(dependency.integrity).toMatch(/^[a-f0-9]{64}$/);
    expect(dependency.integrity.toLowerCase()).toBe(
      release.integrity.toLowerCase(),
    );
  });

  it("advertises a version that actually has an immutable entry", () => {
    expect(
      release.versions.some((entry) => entry.version === release.version),
    ).toBe(true);
  });

  it("never advertises a development build to other administrators", () => {
    // A dev package is installed by pointing the app at its manifest, never
    // by being the version the registry offers.
    expect(release.version).not.toMatch(/-dev\./);
    for (const entry of release.versions) {
      expect(entry.version).not.toMatch(/-dev\./);
    }
  });

  it("adds Core Content first but preserves an existing exact pin", () => {
    const managed = managedOfficialDependency();
    const mod = { ...managed, kind: "modpack" as const, packageId: "mod" };
    expect(withManagedOfficialDependency([mod])).toEqual([managed, mod]);
    expect(withManagedOfficialDependency([managed, mod])).toEqual([managed, mod]);
  });
});
