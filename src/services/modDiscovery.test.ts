import { describe, expect, it } from "vitest";
import { summarizeInstalledMod } from "./modDiscovery";

const uplugin = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    FriendlyName: "The Ports of Atlas",
    Description: "Adds ships.&cf_ugcID=945275",
    Category: "UGC",
    MarketplaceURL:
      "https://www.curseforge.com/ark-survival-ascended/mods/ports-of-atlas",
    ...over,
  });

const raw = (over: Partial<Parameters<typeof summarizeInstalledMod>[0]> = {}) => ({
  folderName: "945275_7802896",
  shortName: "PortsOfAtlas",
  uplugin: uplugin(),
  hasManifest: true,
  ...over,
});

describe("installed mod summaries", () => {
  it("reads the version marker out of the folder name", () => {
    const summary = summarizeInstalledMod(raw(), new Set());
    expect(summary.projectId).toBe("945275");
    expect(summary.fileId).toBe("7802896");
  });

  it("prefers the mod's friendly name over its plugin name", () => {
    expect(summarizeInstalledMod(raw(), new Set()).name).toBe(
      "The Ports of Atlas",
    );
  });

  it("falls back to the plugin name when the mod has no .uplugin", () => {
    expect(summarizeInstalledMod(raw({ uplugin: "" }), new Set()).name).toBe(
      "PortsOfAtlas",
    );
  });

  it("flags mods on the project's cosmetic list", () => {
    // Nothing in a mod's own files distinguishes a cosmetic reliably, so this
    // has to come from the list the project already maintains.
    expect(summarizeInstalledMod(raw(), new Set(["945275"])).cosmetic).toBe(true);
    expect(summarizeInstalledMod(raw(), new Set(["999"])).cosmetic).toBe(false);
  });

  it("never flags a mod whose id could not be determined", () => {
    const summary = summarizeInstalledMod(
      raw({ folderName: "weird", uplugin: uplugin({ Description: "no id" }) }),
      new Set([""]),
    );
    expect(summary.projectId).toBe("");
    expect(summary.cosmetic).toBe(false);
  });

  it("recovers the project id from the plugin when the folder is unusual", () => {
    const summary = summarizeInstalledMod(raw({ folderName: "weird" }), new Set());
    expect(summary.projectId).toBe("945275");
    expect(summary.fileId).toBe("");
  });

  it("carries the undiscoverable flag through", () => {
    expect(
      summarizeInstalledMod(raw({ hasManifest: false }), new Set()).hasManifest,
    ).toBe(false);
  });
});
