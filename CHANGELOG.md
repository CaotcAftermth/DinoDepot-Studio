# Changelog

Notable changes to Dino Depot Studio, newest first. Versions follow
[semantic versioning](https://semver.org): the middle number moves for new
features, the last for fixes.

## 0.5.0 — 2026-08-19

The mod artwork release. Icons can now come out of the mods themselves, the
app starts in a fraction of the time, and eggs finally have their fertilized
counterparts.

### Icons from your installed mods

Cataloguing a mod through **Discover installed** now lets you give each
creature and item a real icon, taken from the mod's own artwork as installed on
this machine.

- Every entry in the review list has an icon box beside it. Clicking it opens
  the mod's textures — searchable, with the plausible icons sorted to the top.
- Nothing is guessed. Matching artwork to entries by filename does not work
  (measured across the local mod library: only 5.5% of items have a
  name-matching icon), so you pick, and the app does the rest.
- **Material maps are filtered out** by default — normals, roughness, base
  colour and the rest, which outnumber real icons by an order of magnitude.
  The word list is a set of checkboxes you can untick, and you can add your own
  (Enter or *Add*). Your list is remembered between sessions.
- **Invert colours** for the icons mods ship as black silhouettes, which
  disappear against a dark panel. The preview shows exactly what gets saved.
- Whatever you pick is converted to a 160×160 lossless WebP, scaled to fit and
  centred so nothing is stretched.

Reading a large mod takes a few seconds — the biggest on the test library, at
3,294 assets, scans in about seven.

### Icons from anywhere else

**Content Sources → Edit → Entry data → Change icon** gained an import panel on
the right. Drop an image on it or choose a file, and it becomes a project icon
through exactly the same conversion — 160×160 WebP, optional inversion. WebP,
PNG and JPEG accepted.

The same dialog now offers **base game artwork**. Previously a mod's creature
could only be given a project image or an emoji; now it can borrow the stock
icon for whatever it is a variant of. The list is searchable and scoped to
creatures or items depending on what you are assigning.

The emoji palette has been retired for creatures and items in favour of that
artwork list. Maps still have their emoji, since there is no artwork library
for them.

### Missing icons look like missing icons

An entry with no icon anywhere now shows the placeholder artwork
(`Missing_Creature_Icon` / `Missing_Item_Icon`) rather than a category glyph.

### Icons are filed by mod

Project icons are now stored one folder deep — `images/AAHelicoprion/Rex.webp`
— so a project with hundreds of them stays navigable and two mods shipping a
"Rex" cannot overwrite each other. Existing flat files keep working; there is
nothing to migrate.

### Fertilized eggs

The catalog gained **70 fertilized egg entries**, so a production rule can
consume one without being flagged as referring to content that is not in the
catalog.

These were read from ARK's own game files rather than derived from a naming
rule, because the rule does not hold: `_Fertilized` is *inserted before* a
variant qualifier, so the Tek Parasaur egg is
`PrimalItemConsumable_Egg_Para_Fertilized_Bionic`, not `..._Bionic_Fertilized`.
Ten eggs — the generic Small/Medium/Large ones, Titanoboa, Pachyrhino and
others — have no fertilized form at all and were correctly left out.

Each one is filed as a variant of the egg it comes from, so it inherits that
egg's icon and **item pickers collapse the pair onto a single row**. Variant
collapsing previously worked for creatures only; it now works for items too,
with the same *Show variants* toggle.

### Adding a mod

- **CurseForge links now point at the current site.** Every installed mod's
  metadata carries a `legacy.curseforge.com` address; these are rewritten
  automatically. The same mod linked both ways is also now recognised as one
  page rather than two.
- **Add manually starts from the project ID.** The mod page link is derived
  from it, and *Look up name* reads the mod's real name off CurseForge —
  press Enter in the ID field to run it. The name stays yours to override.
  Pasting a mod page link instead of an ID is understood, and a link that has
  no ID in it says so rather than guessing.
- **Discovery warns when cosmetics have not been collected.** Until the
  CurseForge collector has run once, cosmetic mods cannot be told apart from
  content mods and clutter the list; there is now a notice with a link
  straight to the collector.
- Status tags moved to the right-hand side of each row, so a mod's name and
  folder sit together.
- Entries in the review list now show their class beneath the name, with the
  full blueprint path on hover — matching the Content Sources lists.
- **Search modpacks** became **Modpack library**, and Discovery is the tab that
  opens first. Pasting a link or opening a pack file works from any tab now.
- A mod with an available update can be updated straight from the Discovery
  list rather than through a full review.

### Faster

- **The app starts in a fraction of the time.** Everything used to load before
  the window could paint anything — every editor, the publisher, the whole
  official catalog, as one 1.5 MB script. Sections now load on demand and warm
  themselves in the background, cutting the first script to 544 kB.
- **Opening Content Sources for the first time is no longer a stall.** The
  bundled official package was being installed through thousands of round
  trips between the interface and the backend; it is now installed natively,
  with every file still verified against the manifest.
- Looking a mod up on CurseForge reports what it is doing rather than sitting
  silent, and an unknown project ID gives up sooner.

### Fixed

- Entries you untick while reviewing a mod stay unticked. They were being put
  back when the mod's published pack was installed in the same step, and again
  on every later dependency refresh.
- Icons assigned during a review survive re-reviewing the same mod.
- An icon assigned during a review now shows in the row instead of a generic
  symbol.
- A mod deleted from Content Sources no longer shows as installed in the
  Discovery list. The package remains in the machine-wide library — as it
  should, since that is a shared cache — but the list now says
  "downloaded, not in project" rather than claiming it is here.
- Updating a mod no longer overwrites a name you set yourself.
- Base game icons assigned to an entry now survive publishing. They were being
  silently dropped from the published viewer.
- Legacy modpacks no longer copy their icons into your project folder.

### For maintainers

- New `sidecar-assets/` .NET tool reads mod containers via CUE4Parse
  (Apache-2.0). Build with `npm run build:assets`. It fetches Oodle on first
  use; whether that library may be redistributed in an installer is unresolved,
  so it is not committed.
- `gamelist` mode on that tool lists base-game asset paths in about two
  seconds, index-only. It produced `scripts/data/fertilized-eggs.json`.
- `scripts/fertilized-eggs.mjs` adds the egg entries; runs inside
  `build-official-catalog.mjs` and standalone.
- `.claude/launch.json` gained a `studio-repo-dist` entry for measuring the
  production build.

## Earlier versions

Releases before 0.5.0 predate this file; see the git history and the
[release notes](docs/release.md).
