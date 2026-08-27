import { describe, expect, it } from "vitest";
import { buildViewerHtml } from "./template";

describe("public viewer rights boundary", () => {
  const html = buildViewerHtml({
    clusterName: "Test",
    dataUrl: "data/viewer.json",
    imagesUrl: "images",
  });

  it("ships fail-closed refresh and conditional registry logic", () => {
    expect(html).toContain("15 * 60 * 1000");
    expect(html).toContain("24 * 60 * 60 * 1000");
    expect(html).toContain("If-None-Match");
    expect(html).toContain('response.status === 304');
    expect(html).toContain('row.manifest !== expectedManifest');
  });

  it("requires rights, scope, official review, state, hash, and dimensions", () => {
    expect(html).toContain('author-approved');
    expect(html).toContain('license-approved');
    expect(html).toContain('manifest.rights.reviewState !== "approved"');
    expect(html).toContain('manifest.rights.distributionEligible !== true');
    expect(html).toContain('record.status !== "active"');
    expect(html).toContain('asset SHA-256 mismatch');
    expect(html).toContain('bitmap.width === 160 && bitmap.height === 160');
  });

  it("revokes prior object URLs before every rights refresh", () => {
    expect(html).toContain('URL.revokeObjectURL(oldUrl)');
    expect(html).toContain('node.img = placeholderData(parsed.type)');
  });
});
