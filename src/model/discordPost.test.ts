import { describe, expect, it } from "vitest";
import {
  DISCORD_MENTION_KINDS,
  DISCORD_LIMIT_NITRO,
  DISCORD_LIMIT_STANDARD,
  DISCORD_WEBHOOK_LIMIT,
  discordLimit,
  mentionNeedsId,
  renderDiscordPost,
  renderMention,
  splitDiscordPost,
  type PostMod,
} from "./discordPost";
import { DiscordFormatSchema } from "./project";

const format = (patch: Partial<ReturnType<typeof DiscordFormatSchema.parse>> = {}) =>
  DiscordFormatSchema.parse(patch);

const mods: PostMod[] = [
  { name: "Hat Pack", projectId: "111", url: "https://cf/hat", updated: "2 days ago" },
  { name: "Cape Pack", projectId: "222", url: "https://cf/cape", updated: "" },
];

describe("renderDiscordPost", () => {
  /**
   * The stock line is the mod name linked to its page and nothing else. The
   * project id and the updated date are both for the administrator
   * reconciling a CCM list, not for the channel reading the announcement, and
   * they crowded out the name they followed.
   */
  it("renders the stock format", () => {
    const out = renderDiscordPost(format(), mods);
    expect(out).toBe(
      "**🆕 New Custom Cosmetic Mods (2)**\n" +
        "- [Hat Pack](<https://cf/hat>)\n" +
        "- [Cape Pack](<https://cf/cape>)",
    );
  });

  it("still renders the id and the updated date when asked for", () => {
    const out = renderDiscordPost(
      format({ header: "", line: "- [{name}](<{url}>) - `{id}`{updatedSuffix}" }),
      mods,
    );
    expect(out).toBe(
      "- [Hat Pack](<https://cf/hat>) - `111` (updated 2 days ago)\n" +
        "- [Cape Pack](<https://cf/cape>) - `222`",
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

describe("splitDiscordPost", () => {
  const lines = (n: number, width = 60) =>
    Array.from({ length: n }, (_, i) => `${String(i).padStart(3, "0")}`.padEnd(width, "x"));

  it("leaves a post that fits as one message", () => {
    expect(splitDiscordPost("short post", 2000)).toEqual(["short post"]);
  });

  it("yields nothing for an empty post", () => {
    expect(splitDiscordPost("", 2000)).toEqual([]);
    expect(splitDiscordPost("   \n  ", 2000)).toEqual([]);
  });

  it("splits on line boundaries and keeps every line whole", () => {
    const post = lines(100).join("\n");
    const segments = splitDiscordPost(post, 2000);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) expect(segment.length).toBeLessThanOrEqual(2000);
    expect(segments.join("\n").split("\n")).toEqual(post.split("\n"));
  });

  it("fits more into a message at the Nitro limit", () => {
    const post = lines(100).join("\n");
    expect(splitDiscordPost(post, DISCORD_LIMIT_NITRO).length).toBeLessThan(
      splitDiscordPost(post, DISCORD_LIMIT_STANDARD).length,
    );
  });

  it("never cuts a rendered mod line in half", () => {
    const mods: PostMod[] = Array.from({ length: 200 }, (_, i) => ({
      name: `Cosmetic Pack Number ${i}`,
      projectId: String(900000 + i),
      url: `https://www.curseforge.com/ark-survival-ascended/mods/pack-${i}`,
      updated: "2 days ago",
    }));
    const segments = splitDiscordPost(renderDiscordPost(format(), mods), 2000);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(2000);
      for (const line of segment.split("\n")) {
        if (line.startsWith("- ")) expect(line).toMatch(/^- \[.+\]\(<.+>\)$/);
      }
    }
  });

  it("closes and reopens a code fence that spans a boundary", () => {
    const post = ["```ini", ...lines(20, 40), "```"].join("\n");
    const segments = splitDiscordPost(post, 300);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(300);
      // Balanced: every message opens and closes its own block.
      expect((segment.match(/```/g) ?? []).length % 2).toBe(0);
      expect(segment.startsWith("```ini")).toBe(true);
      expect(segment.endsWith("```")).toBe(true);
    }
  });

  it("cuts a single over-long line at a space", () => {
    const post = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const segments = splitDiscordPost(post, 60);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(60);
      expect(segment).toMatch(/^word\d+/);
    }
    expect(segments.join(" ")).toBe(post);
  });

  it("cuts an over-long line with no spaces rather than overflowing", () => {
    const segments = splitDiscordPost("x".repeat(250), 100);
    expect(segments.map((s) => s.length)).toEqual([100, 100, 50]);
  });

  it("does not cut between the halves of a surrogate pair", () => {
    // The emoji lands exactly on the 20-character boundary.
    const post = "a".repeat(19) + "🦖" + "b".repeat(40);
    for (const segment of splitDiscordPost(post, 20)) {
      expect(segment.length).toBeLessThanOrEqual(20);
      expect(segment).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(segment).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
  });
});

describe("discordLimit", () => {
  it("is 2000 without Nitro and 4000 with it", () => {
    expect(discordLimit(false)).toBe(DISCORD_LIMIT_STANDARD);
    expect(discordLimit(true)).toBe(DISCORD_LIMIT_NITRO);
    expect(DISCORD_WEBHOOK_LIMIT).toBe(2000);
  });
});

/**
 * The four mention syntaxes differ by a character or two, and getting one
 * wrong either silently fails to ping or pings the entire server. The whole
 * point of choosing the kind from a list is that this table decides the
 * syntax, so this is where it is pinned down.
 */
describe("renderMention", () => {
  it("writes each kind the way Discord reads it", () => {
    expect(renderMention({ kind: "role", id: "123" })).toBe("<@&123>");
    expect(renderMention({ kind: "user", id: "456" })).toBe("<@456>");
    expect(renderMention({ kind: "here", id: "" })).toBe("@here");
    expect(renderMention({ kind: "everyone", id: "" })).toBe("@everyone");
    expect(renderMention({ kind: "none", id: "" })).toBe("");
  });

  it("ignores an id the kind has no use for", () => {
    expect(renderMention({ kind: "here", id: "123" })).toBe("@here");
    expect(renderMention({ kind: "everyone", id: "123" })).toBe("@everyone");
  });

  /**
   * Half a mention is not a ping - Discord renders `<@&>` as literal text in
   * the middle of an announcement, which is worse than pinging nobody.
   */
  it("renders nothing for a role or user with no id", () => {
    expect(renderMention({ kind: "role", id: "   " })).toBe("");
    expect(renderMention({ kind: "user", id: "" })).toBe("");
  });

  it("trims an id pasted with whitespace around it", () => {
    expect(renderMention({ kind: "role", id: "  123  " })).toBe("<@&123>");
  });

  it("agrees with the table the dropdown is built from", () => {
    for (const k of DISCORD_MENTION_KINDS) {
      const rendered = renderMention({ kind: k.kind, id: "123" });
      expect(rendered).toBe(k.syntax.replace("ID", "123"));
      expect(mentionNeedsId(k.kind)).toBe(k.needsId);
    }
  });
});

describe("a mention inside the post", () => {
  it("goes below the footer", () => {
    const out = renderDiscordPost(
      format({
        header: "",
        line: "{name}",
        footer: "Add these before the restart.",
        mention: { kind: "role", id: "789" },
      }),
      mods,
    );
    expect(out).toBe(
      "Hat Pack\nCape Pack\nAdd these before the restart.\n<@&789>",
    );
  });

  it("goes below the list when there is no footer", () => {
    const out = renderDiscordPost(
      format({ header: "", line: "{name}", mention: { kind: "here", id: "" } }),
      mods,
    );
    expect(out).toBe("Hat Pack\nCape Pack\n@here");
  });

  it("adds nothing by default", () => {
    expect(renderDiscordPost(format({ header: "", line: "{name}" }), mods)).toBe(
      "Hat Pack\nCape Pack",
    );
  });
});
