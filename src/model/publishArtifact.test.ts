import { describe, expect, it } from "vitest";
import {
  artifactPaths,
  buildArtifact,
  BuildManifestSchema,
  describeViolation,
  isDeployed,
  PUBLIC_OUTPUT_VERSION,
  PUBLIC_ROOT,
  scanPublicBoundary,
  type PublicFiles,
} from "./publishArtifact";
import { STUDIO_VERSION } from "./studio";

const INPUT = {
  projectId: "11111111-2222-4333-8444-555555555555",
  sourceRevision: "abc1234def5678",
  publishOperationId: "op-9f3c",
  indexHtml: "<html><body>Cluster</body></html>",
  data: { "viewer.json": '{"creatures":[]}' },
  now: new Date("2026-08-10T12:00:00.000Z"),
};

describe("building the artifact", () => {
  it("lays the tree out the way Pages expects", () => {
    const { files } = buildArtifact(INPUT);
    expect(Object.keys(files).sort()).toEqual([
      ".nojekyll",
      "data/viewer.json",
      "dinodepot-build.json",
      "index.html",
    ]);
  });

  /**
   * Without it, Pages runs the output through Jekyll, which silently drops any
   * file or folder beginning with an underscore.
   */
  it("always includes .nojekyll", () => {
    expect(buildArtifact({ ...INPUT, data: {} }).files[".nojekyll"]).toBe("");
  });

  it("stamps the manifest with everything needed to trace the build", () => {
    const { manifest } = buildArtifact(INPUT);
    expect(manifest.projectId).toBe(INPUT.projectId);
    expect(manifest.sourceRevision).toBe(INPUT.sourceRevision);
    expect(manifest.publishOperationId).toBe(INPUT.publishOperationId);
    expect(manifest.outputVersion).toBe(PUBLIC_OUTPUT_VERSION);
    expect(manifest.generatedAt).toBe("2026-08-10T12:00:00.000Z");
    expect(manifest.studioVersion).toBe(STUDIO_VERSION);
  });

  it("writes the manifest as a file a viewer can fetch", () => {
    const { files, manifest } = buildArtifact(INPUT);
    expect(BuildManifestSchema.parse(JSON.parse(files["dinodepot-build.json"]))).toEqual(
      manifest,
    );
  });

  /** The source revision is the link back to the private side. */
  it("refuses to build without a source revision", () => {
    expect(() => buildArtifact({ ...INPUT, sourceRevision: "" })).toThrow();
    expect(() => buildArtifact({ ...INPUT, projectId: "" })).toThrow();
    expect(() => buildArtifact({ ...INPUT, publishOperationId: "" })).toThrow();
  });

  it("puts data files under data/", () => {
    const { files } = buildArtifact({
      ...INPUT,
      data: { "viewer.json": "{}", "mods.json": "[]" },
    });
    expect(files["data/viewer.json"]).toBe("{}");
    expect(files["data/mods.json"]).toBe("[]");
  });

  it("reports the paths as they sit in the delivery repository", () => {
    expect(artifactPaths(buildArtifact(INPUT).files)).toContain(
      `${PUBLIC_ROOT}/dinodepot-build.json`,
    );
  });

  it("is deterministic apart from the timestamp", () => {
    expect(buildArtifact(INPUT).files).toEqual(buildArtifact(INPUT).files);
  });
});

// ---------------------------------------------------------------------------

const clean = (): PublicFiles => buildArtifact(INPUT).files;

describe("the public boundary scan", () => {
  it("passes a clean artifact", () => {
    expect(scanPublicBoundary(clean())).toEqual([]);
  });

  it("catches a profile save by its name", () => {
    const violations = scanPublicBoundary({
      ...clean(),
      "data/0002abcd.arkprofile": "anything",
    });
    expect(violations.map((v) => v.kind)).toContain("profile");
  });

  it("catches anything under a profiles folder", () => {
    const violations = scanPublicBoundary({ ...clean(), "profiles/x.bin": "" });
    expect(violations.map((v) => v.kind)).toContain("profile");
  });

  it("catches the roster by its name", () => {
    expect(
      scanPublicBoundary({ ...clean(), "data/players.json": "[]" }).map((v) => v.kind),
    ).toContain("roster");
  });

  /**
   * Renaming the file does not make it public data — the private fields are
   * what matter, so the scan reads the content too.
   */
  it("catches roster fields whatever the file is called", () => {
    const violations = scanPublicBoundary({
      ...clean(),
      "data/viewer.json": '{"players":[{"discordId":"218450941836787712"}]}',
    });
    expect(violations.map((v) => v.kind)).toContain("roster");
    expect(violations[0].evidence).toBe('"discordId":');
  });

  it("catches every private roster field", () => {
    for (const field of [
      "discordId",
      "discordName",
      "steamId",
      "steamName",
      "eosId",
      "accountName",
      "playerDataId",
      "lastKnownIp",
      "SavedNetworkAddress",
    ]) {
      const violations = scanPublicBoundary({
        ...clean(),
        "data/viewer.json": `{"${field}":"x"}`,
      });
      expect(violations.map((v) => v.kind), field).toContain("roster");
    }
  });

  /** A creature called "accountName" in prose is not a roster leak. */
  it("does not flag a private field name appearing as prose", () => {
    expect(
      scanPublicBoundary({
        ...clean(),
        "data/viewer.json": '{"notes":"set the accountName in game"}',
      }),
    ).toEqual([]);
  });

  it("catches an IP address", () => {
    const violations = scanPublicBoundary({
      ...clean(),
      "data/viewer.json": '{"note":"seen from 198.51.100.7"}',
    });
    expect(violations.map((v) => v.kind)).toContain("ip-address");
    expect(violations[0].evidence).toBe("198.51.100.7");
  });

  it("catches a Windows path from somebody's computer", () => {
    const violations = scanPublicBoundary({
      ...clean(),
      "data/viewer.json": '{"iconsDir":"C:\\\\Users\\\\admin\\\\Pictures"}',
    });
    expect(violations.map((v) => v.kind)).toContain("local-path");
  });

  it("catches a credential, without repeating it", () => {
    const violations = scanPublicBoundary({
      ...clean(),
      "index.html": "<!-- github_pat_11ABCDEFG0abcdefghij -->",
    });
    expect(violations.map((v) => v.kind)).toContain("credential");
    expect(violations[0].evidence).toBe("a credential");
    expect(JSON.stringify(violations)).not.toContain("github_pat_");
  });

  it("catches temporary and internal files", () => {
    for (const path of ["data/viewer.json.tmp", "index.html.bak", ".git/config"]) {
      expect(scanPublicBoundary({ [path]: "" }).map((v) => v.kind), path).toContain(
        "temporary",
      );
    }
  });

  it("reports every violation, not just the first", () => {
    const violations = scanPublicBoundary({
      "data/a.arkprofile": "x",
      "data/b.json": '{"steamId":"765"}',
      "data/c.json": "addr 192.0.2.9",
    });
    expect(violations).toHaveLength(3);
  });

  it("does not report the same thing twice", () => {
    const violations = scanPublicBoundary({
      "data/a.json": "192.0.2.9 and 192.0.2.9 again",
    });
    expect(violations.filter((v) => v.kind === "ip-address")).toHaveLength(1);
  });

  it("describes each violation in a sentence", () => {
    const violations = scanPublicBoundary({
      "data/a.arkprofile": "x",
      "data/b.json": '{"steamId":"765"}',
    });
    for (const violation of violations) {
      expect(describeViolation(violation)).toContain(violation.path);
    }
  });
});

// ---------------------------------------------------------------------------

describe("recognising the deployed build", () => {
  const { manifest } = buildArtifact(INPUT);

  it("matches on the operation id", () => {
    expect(isDeployed(manifest, manifest)).toBe(true);
  });

  /** The commit is known at push; "is it live" only the served file can answer. */
  it("does not match an older build", () => {
    expect(
      isDeployed({ ...manifest, publishOperationId: "op-earlier" }, manifest),
    ).toBe(false);
  });

  it("does not match rubbish", () => {
    expect(isDeployed(null, manifest)).toBe(false);
    expect(isDeployed({}, manifest)).toBe(false);
    expect(isDeployed("not json", manifest)).toBe(false);
  });
});
