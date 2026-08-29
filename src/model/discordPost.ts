import type { DiscordFormat, DiscordMention, DiscordMentionKind } from "./project";

/**
 * Rendering of the Custom Cosmetic Mod announcement from the template in
 * Settings, so the post's wording lives with the cluster rather than in code.
 */

export interface PostMod {
  name: string;
  projectId: string;
  url: string;
  /** Last-updated string as scraped from CurseForge, may be empty. */
  updated?: string;
}

/** Tokens usable in the templates, with a one-line explanation each. */
export const DISCORD_TOKENS: { token: string; scope: string; means: string }[] = [
  { token: "{count}", scope: "anywhere", means: "number of new mods" },
  { token: "{cluster}", scope: "anywhere", means: "cluster name from Settings" },
  { token: "{date}", scope: "anywhere", means: "today's date" },
  { token: "{name}", scope: "line", means: "mod name" },
  { token: "{url}", scope: "line", means: "CurseForge page URL" },
  { token: "{id}", scope: "line", means: "CurseForge project ID" },
  { token: "{updated}", scope: "line", means: "last-updated date, may be blank" },
  {
    token: "{updatedSuffix}",
    scope: "line",
    means: '" (updated …)" - collapses to nothing when unknown',
  },
  { token: "{index}", scope: "line", means: "1-based position in the list" },
];

function applyTokens(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? values[name] : whole,
  );
}

/** What each mention kind is called in the dropdown, and what it renders as. */
export const DISCORD_MENTION_KINDS: {
  kind: DiscordMentionKind;
  label: string;
  /** True when the kind needs an id typed in beside it. */
  needsId: boolean;
  /** What the post ends up carrying, with `ID` standing in for the id. */
  syntax: string;
}[] = [
  { kind: "none", label: "No notification", needsId: false, syntax: "" },
  { kind: "role", label: "Role", needsId: true, syntax: "<@&ID>" },
  { kind: "user", label: "User", needsId: true, syntax: "<@ID>" },
  { kind: "here", label: "Here", needsId: false, syntax: "@here" },
  { kind: "everyone", label: "Everyone", needsId: false, syntax: "@everyone" },
];

/** Whether this kind is one the administrator has to supply an id for. */
export function mentionNeedsId(kind: DiscordMentionKind): boolean {
  return kind === "role" || kind === "user";
}

/**
 * The mention line, or "" when there is nothing to ping.
 *
 * A `role` or `user` with no id renders as nothing rather than as a broken
 * `<@&>`: half a mention is not a ping, and Discord shows it as literal text
 * in the middle of an announcement.
 */
export function renderMention(mention: DiscordMention | undefined): string {
  if (!mention) return "";
  const id = mention.id.trim();
  switch (mention.kind) {
    case "role":
      return id ? `<@&${id}>` : "";
    case "user":
      return id ? `<@${id}>` : "";
    case "here":
      return "@here";
    case "everyone":
      return "@everyone";
    default:
      return "";
  }
}

export interface PostContext {
  cluster?: string;
  /** Injectable for tests; defaults to today. */
  date?: Date;
}

/** Renders the announcement. Blank header/footer/mention lines are dropped. */
export function renderDiscordPost(
  format: DiscordFormat,
  mods: PostMod[],
  { cluster = "", date = new Date() }: PostContext = {},
): string {
  const shared = {
    count: String(mods.length),
    cluster,
    date: date.toLocaleDateString(),
  };

  const lines = mods.map((mod, i) =>
    applyTokens(format.line, {
      ...shared,
      name: mod.name,
      url: mod.url,
      id: mod.projectId,
      updated: mod.updated ?? "",
      updatedSuffix: mod.updated ? ` (updated ${mod.updated})` : "",
      index: String(i + 1),
    }),
  );

  return [
    applyTokens(format.header, shared).trim(),
    lines.join("\n"),
    applyTokens(format.footer, shared).trim(),
    // Last, so the ping is the thing the reader's eye lands on after the
    // list rather than a line they scroll past on the way into it.
    renderMention(format.mention),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Two fake mods so the Settings preview shows something realistic. */
export const SAMPLE_POST_MODS: PostMod[] = [
  {
    name: "Aesthetic Armor Pack",
    projectId: "912345",
    url: "https://www.curseforge.com/ark-survival-ascended/mods/aesthetic-armor-pack",
    updated: "2 days ago",
  },
  {
    name: "Cosmetic Hats Deluxe",
    projectId: "912346",
    url: "https://www.curseforge.com/ark-survival-ascended/mods/cosmetic-hats-deluxe",
    updated: "",
  },
];

// ---------------------------------------------------------------------------
// Splitting a post into messages
// ---------------------------------------------------------------------------

/**
 * Discord's message length limits, counted the way Discord counts them: in
 * UTF-16 code units, which is what `String.length` gives us.
 *
 * A post that goes over the limit is not truncated - Discord's client turns
 * the whole thing into a `message.txt` attachment, which is not an
 * announcement anybody reads. So it gets split instead.
 */
export const DISCORD_LIMIT_STANDARD = 2000;
export const DISCORD_LIMIT_NITRO = 4000;

/**
 * A webhook is capped at 2000 whatever the administrator's own plan is -
 * Nitro raises the limit for messages a *person* sends, and a webhook is not
 * a person. The Nitro setting therefore governs the copy-and-paste path, and
 * "Post to Discord" always splits at 2000.
 */
export const DISCORD_WEBHOOK_LIMIT = 2000;

export function discordLimit(nitro: boolean): number {
  return nitro ? DISCORD_LIMIT_NITRO : DISCORD_LIMIT_STANDARD;
}

/** A ``` fence at the start of a line, with or without a language tag. */
const FENCE_LINE = /^\s*```/;
const FENCE_CLOSE = "```";

/**
 * Cuts a single over-long line into pieces of at most `budget` characters,
 * preferring a space so a word - or a URL - survives the cut where possible.
 */
function cutLine(line: string, budget: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > budget) {
    let cut = rest.lastIndexOf(" ", budget);
    // No space, or one so early the piece would be mostly empty: cut square.
    if (cut < budget / 2) cut = budget;
    // Never between the halves of a surrogate pair - that is not a character.
    const before = rest.charCodeAt(cut - 1);
    const after = rest.charCodeAt(cut);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      cut -= 1;
    }
    cut = Math.max(1, cut);
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Splits one rendered post into messages that each fit `limit`.
 *
 * Every split lands on a line boundary, so a mod's line is never cut in half
 * and a masked link never loses its closing bracket. A fenced code block that
 * spans a boundary is closed at the end of one message and reopened - with its
 * language tag - at the start of the next, because half a fence renders as
 * literal backticks. A single line longer than a whole message is the one case
 * that gets cut mid-line, and it is cut at a space where there is one.
 *
 * An empty post yields no messages at all, rather than one empty one.
 */
export function splitDiscordPost(
  post: string,
  limit: number = DISCORD_LIMIT_STANDARD,
): string[] {
  const text = post ?? "";
  if (!text.trim()) return [];
  if (text.length <= limit) return [text];

  const segments: string[] = [];
  let current: string[] = [];
  let length = 0;
  /** The opening line of a fence still open here, e.g. "```json". */
  let fence: string | null = null;

  /** True when the segment holds more than a reopened fence line. */
  const hasBody = () => current.length > (fence && current[0] === fence ? 1 : 0);

  function close() {
    if (!hasBody()) return;
    const body = current.join("\n");
    segments.push(fence ? `${body}\n${FENCE_CLOSE}` : body);
    current = fence ? [fence] : [];
    length = fence ? fence.length : 0;
  }

  function add(line: string) {
    if (current.length > 0) length += 1;
    current.push(line);
    length += line.length;
  }

  for (const line of text.split("\n")) {
    const next: string | null = FENCE_LINE.test(line) ? (fence ? null : line.trimEnd()) : fence;
    // Room kept for the "\n```" that closes a fence carried over a boundary.
    const reserve = next ? FENCE_CLOSE.length + 1 : 0;
    const fits = () =>
      length + (current.length > 0 ? 1 : 0) + line.length + reserve <= limit;

    if (!fits()) close();

    if (!fits()) {
      const budget = Math.max(
        1,
        limit - length - (current.length > 0 ? 1 : 0) - reserve,
      );
      cutLine(line, budget).forEach((piece, i) => {
        if (i > 0) close();
        add(piece);
      });
      fence = next;
      continue;
    }

    add(line);
    fence = next;
  }

  close();
  return segments;
}
