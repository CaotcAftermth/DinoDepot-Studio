import { describe, expect, it } from "vitest";
import {
  EXTERNAL_LINKS,
  isConfiguredLink,
  unconfiguredHint,
} from "./externalLinks";

/**
 * These are the only URLs the app sends anybody to, and every one of them
 * is the kind that rots - an invite expires, a donation page changes host. The
 * contract worth pinning down is what happens while one is *not* set: the
 * control that would open it has to know, rather than opening nothing and
 * looking broken.
 */

describe("external links", () => {
  it("says a link with no address is not configured", () => {
    expect(isConfiguredLink({ url: "", label: "x" })).toBe(false);
    expect(isConfiguredLink({ url: "   ", label: "x" })).toBe(false);
  });

  /**
   * `openExternal` refuses anything that is not http(s), so a placeholder that
   * looks like a link - "TODO", a bare domain - must not read as configured.
   */
  it("only counts an http(s) address", () => {
    expect(isConfiguredLink({ url: "https://example.com", label: "x" })).toBe(true);
    expect(isConfiguredLink({ url: "http://example.com", label: "x" })).toBe(true);
    expect(isConfiguredLink({ url: "discord.gg/abc", label: "x" })).toBe(false);
    expect(isConfiguredLink({ url: "TODO", label: "x" })).toBe(false);
  });

  it("names the link and the file to edit when one is unset", () => {
    const hint = unconfiguredHint(EXTERNAL_LINKS.dinoDepotDiscord);
    expect(hint).toContain("Dino Depot Discord");
    expect(hint).toContain("externalLinks.ts");
  });

  /** Every entry carries a label, because the label is what the hint says. */
  it("gives every link a label", () => {
    for (const [key, link] of Object.entries(EXTERNAL_LINKS)) {
      expect(link.label.trim(), key).not.toBe("");
    }
  });
});
