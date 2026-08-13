import { describe, expect, it } from "vitest";
import {
  compareVersions,
  parseSemVer,
  STUDIO_REPO,
  STUDIO_VERSION,
  studioRepoPath,
  studioRepoSlug,
  studioRepoUrl,
  studioSatisfies,
  studioUpdaterEndpoint,
} from "./studio";

describe("studio repository reference", () => {
  it("names the renamed repository, not the old one", () => {
    expect(STUDIO_REPO.repo).toBe("DinoDepot-Studio");
    expect(studioRepoSlug()).toBe("CaotcAftermth/DinoDepot-Studio");
    expect(studioRepoUrl()).toBe("https://github.com/CaotcAftermth/DinoDepot-Studio");
  });

  /**
   * The old slug only resolves because GitHub redirects renames, and that
   * redirect dies the moment anybody registers the freed-up name. Nothing may
   * depend on it.
   */
  it("never mentions the pre-rename slug", () => {
    const surfaces = [
      studioRepoSlug(),
      studioRepoUrl(),
      studioRepoPath("issues"),
      studioUpdaterEndpoint(),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain("DinoDepot_Production_Studio");
    }
  });

  it("builds repository sub-paths without doubling the slash", () => {
    expect(studioRepoPath("issues")).toBe(
      "https://github.com/CaotcAftermth/DinoDepot-Studio/issues",
    );
    expect(studioRepoPath("/issues")).toBe(studioRepoPath("issues"));
  });

  it("points the updater at the release asset", () => {
    expect(studioUpdaterEndpoint()).toBe(
      "https://github.com/CaotcAftermth/DinoDepot-Studio/releases/latest/download/latest.json",
    );
  });

  it("carries a parseable version", () => {
    expect(parseSemVer(STUDIO_VERSION)).not.toBeNull();
  });
});

describe("parseSemVer", () => {
  it("reads the three numbers", () => {
    expect(parseSemVer("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it("splits pre-release identifiers, keeping numbers numeric", () => {
    expect(parseSemVer("1.0.0-beta.2")?.prerelease).toEqual(["beta", 2]);
  });

  it("ignores build metadata", () => {
    expect(parseSemVer("1.0.0+20260809")?.patch).toBe(0);
  });

  it("rejects anything that is not a version", () => {
    for (const bad of ["", "1", "1.2", "v1.2.3", "1.2.3.4", "banana"]) {
      expect(parseSemVer(bad), bad).toBeNull();
    }
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("sorts a pre-release below its release", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta")).toBe(1);
  });

  it("orders pre-release identifiers", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    // Numeric identifiers sort below alphanumeric ones.
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    // Fewer identifiers sorts first when the shared ones match.
    expect(compareVersions("1.0.0-beta", "1.0.0-beta.1")).toBe(-1);
  });

  /**
   * A project written by a future Studio could carry a version string this
   * build cannot read. Treating that as "older" opens the project; treating it
   * as newer would lock the admin out over someone else's typo.
   */
  it("treats an unparseable version as the oldest", () => {
    expect(compareVersions("banana", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "banana")).toBe(1);
    expect(compareVersions("banana", "kiwi")).toBe(0);
  });
});

describe("studioSatisfies", () => {
  it("accepts an equal or newer build", () => {
    expect(studioSatisfies("1.0.0", "1.0.0")).toBe(true);
    expect(studioSatisfies("1.0.0", "1.1.0")).toBe(true);
  });

  it("rejects a build older than the project demands", () => {
    expect(studioSatisfies("2.0.0", "1.9.9")).toBe(false);
  });
});
