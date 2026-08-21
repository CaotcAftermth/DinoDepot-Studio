import { Link } from "react-router-dom";
import { cx } from "../../components/ui";
import { SETTINGS_CATEGORIES } from "./categories";

/**
 * The category rail down the left of Settings.
 *
 * A rail rather than a tab strip: it has room for a line of description per
 * category, and it grows downwards, so adding a sixth category later costs
 * nothing. Styled to echo the application sidebar without competing with it —
 * the accent bar sits on the left here, on the right there.
 */
export function SettingsNav({
  /** Slug of the category on screen, already resolved from the URL. */
  active,
  /** Category slugs holding unsaved edits. */
  dirty,
}: {
  active: string;
  dirty: ReadonlySet<string>;
}) {
  return (
    <nav className="w-52 shrink-0 flex flex-col gap-0.5">
      {SETTINGS_CATEGORIES.map((category) => (
        <Link
          key={category.slug}
          to={`/settings/${category.slug}`}
          // Not a NavLink: `/settings` with no slug still shows a category,
          // and route matching alone would leave the rail with nothing lit.
          className={cx(
            "block px-3 py-2 rounded-md border-l-2 transition-colors",
            category.slug === active
              ? "bg-ink-800 border-accent-500 text-white"
              : "border-transparent text-ink-300 hover:text-white hover:bg-ink-850",
          )}
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            {category.label}
            {dirty.has(category.slug) && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-amber-400"
                // The header badge says something is unsaved; this says where.
                title="Unsaved changes in this section"
                aria-label="Unsaved changes"
              />
            )}
          </span>
          <span className="block text-xs text-ink-400">{category.blurb}</span>
        </Link>
      ))}
    </nav>
  );
}
