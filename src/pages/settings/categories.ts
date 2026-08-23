import type { ProjectSettings } from "../../model/project";

/**
 * The Settings page split by subject.
 *
 * Nine cards in one grid had become a scroll, and the two links to this page
 * from Overview both concern GitHub — which sat halfway down it. Categories are
 * routed (`/settings/publishing`) so a link can name one.
 *
 * `keys` is what makes hiding a card safe. The page keeps a single draft and a
 * single Save, so edits on a category the administrator has navigated away from
 * are still pending; the rail marks those categories rather than leaving the
 * header to say "unsaved changes" with nothing on screen changed.
 */
export interface SettingsCategory {
  /** Path segment: `/settings/<slug>`. */
  slug: string;
  label: string;
  /** One line under the label in the rail. */
  blurb: string;
  /**
   * How many card columns the category gets.
   *
   * The rail costs 208px, so two columns leave about 370px each — enough for a
   * card of short fields, not for one holding repository paths or a post
   * template beside its preview. Those take the full width instead of being
   * squeezed into half of it.
   */
  columns: 1 | 2;
  /** Project-settings keys the cards in this category edit. */
  keys: readonly (keyof ProjectSettings)[];
}

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    slug: "project",
    label: "Project",
    blurb: "Names, maps, optional pages",
    columns: 2,
    keys: ["name", "cluster", "maps", "modules"],
  },
  {
    // Its own entry rather than a card inside Publishing: the sign-in flow is
    // by far the tallest thing on this page, and both links here from Overview
    // are about it.
    slug: "github",
    label: "GitHub",
    blurb: "Account and repository",
    columns: 1,
    // Nothing here is project data — it is all machine-local and saves as it
    // is set — so this category never carries an unsaved marker.
    keys: [],
  },
  {
    slug: "publishing",
    label: "Publishing",
    blurb: "Where published files land",
    columns: 1,
    keys: ["outputPaths"],
  },
  {
    slug: "defaults",
    label: "Defaults",
    blurb: "New rules and the simulator",
    columns: 2,
    keys: ["defaults", "simulator"],
  },
  {
    slug: "discord",
    label: "Discord",
    blurb: "Webhook and post format",
    columns: 1,
    keys: ["discord"],
  },
  {
    // Machine-local, like GitHub: the service address and the report history
    // belong to this computer, so this category never carries a dirty marker.
    slug: "feedback",
    label: "Feedback",
    blurb: "Bug reports and suggestions",
    columns: 1,
    keys: [],
  },
];

export const DEFAULT_CATEGORY = "project";

/** The category a URL names, falling back rather than showing nothing. */
export function categoryFor(slug: string | undefined): SettingsCategory {
  return (
    SETTINGS_CATEGORIES.find((category) => category.slug === slug) ??
    (SETTINGS_CATEGORIES.find(
      (category) => category.slug === DEFAULT_CATEGORY,
    ) as SettingsCategory)
  );
}

/**
 * Which categories hold unsaved edits.
 *
 * Compared key by key with the same serialization the page uses for its own
 * dirty check, so the rail and the header can never disagree about whether
 * something is pending.
 *
 * A key no category claims — `packageDependencies`, written by Content
 * Sources — deliberately marks nothing. It still counts as dirty for the
 * header, which is what the Save button acts on.
 */
export function dirtyCategories(
  draft: ProjectSettings | null,
  saved: ProjectSettings | null,
): Set<string> {
  const dirty = new Set<string>();
  if (!draft || !saved) return dirty;
  for (const category of SETTINGS_CATEGORIES) {
    const changed = category.keys.some(
      (key) => JSON.stringify(draft[key]) !== JSON.stringify(saved[key]),
    );
    if (changed) dirty.add(category.slug);
  }
  return dirty;
}
