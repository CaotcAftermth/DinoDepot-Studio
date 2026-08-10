import { describe, expect, it } from "vitest";
import { renderDiscordPost, type PostMod } from "./discordPost";
import { DiscordFormatSchema } from "./project";

const format = (patch: Partial<ReturnType<typeof DiscordFormatSchema.parse>> = {}) =>
  DiscordFormatSchema.parse(patch);

const mods: PostMod[] = [
  { name: "Hat Pack", projectId: "111", url: "https://cf/hat", updated: "2 days ago" },
  { name: "Cape Pack", projectId: "222", url: "https://cf/cape", updated: "" },
];

describe("renderDiscordPost", () => {
  it("renders the stock format", () => {
    const out = renderDiscordPost(format(), mods);
    expect(out).toBe(
      "**🆕 New Custom Cosmetic Mods (2)**\n" +
        "- [Hat Pack](<https://cf/hat>) — `111` (updated 2 days ago)\n" +
        "- [Cape Pack](<https://cf/cape>) — `222`",
    );
  });

  it("collapses updatedSuffix when the date is unknown", () => {
    const out = renderDiscordPost(format({ header: "", line: "{name}{updatedSuffix}" }), [
      mods[1],
    ]);
    expect(out).toBe("Cape Pack");
  });

  it("drops an empty header and footer", () => {
    const out = renderDiscordPost(format({ header: "", line: "{name}" }), mods);
    expect(out).toBe("Hat Pack\nCape Pack");
  });

  it("includes a footer when one is set", () => {
    const out = renderDiscordPost(
      format({ header: "", line: "{name}", footer: "{count} total" }),
      mods,
    );
    expect(out).toBe("Hat Pack\nCape Pack\n2 total");
  });

  it("substitutes cluster, index and id tokens", () => {
    const out = renderDiscordPost(
      format({ header: "{cluster}", line: "{index}. {name} ({id})" }),
      mods,
      { cluster: "GG Fizz" },
    );
    expect(out).toBe("GG Fizz\n1. Hat Pack (111)\n2. Cape Pack (222)");
  });

  it("leaves unknown tokens untouched rather than blanking them", () => {
    const out = renderDiscordPost(format({ header: "", line: "{nope}" }), [mods[0]]);
    expect(out).toBe("{nope}");
  });

  it("renders header and footer only when there are no mods", () => {
    const out = renderDiscordPost(format({ footer: "done" }), []);
    expect(out).toBe("**🆕 New Custom Cosmetic Mods (0)**\ndone");
  });
});
