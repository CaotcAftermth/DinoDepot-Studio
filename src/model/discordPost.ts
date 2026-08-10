import type { DiscordFormat } from "./project";

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
    means: '" (updated …)" — collapses to nothing when unknown',
  },
  { token: "{index}", scope: "line", means: "1-based position in the list" },
];

function applyTokens(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? values[name] : whole,
  );
}

export interface PostContext {
  cluster?: string;
  /** Injectable for tests; defaults to today. */
  date?: Date;
}

/** Renders the full announcement. Blank header/footer lines are dropped. */
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
