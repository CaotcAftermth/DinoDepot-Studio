# Dino Depot Passive Production Studio

Desktop admin studio for managing Dino Depot server configuration for ASA
clusters (first project: GG Fizz). Structured editors, validation, simulation,
and independent GitHub RAW publishing for three output families:

| Output | Format | Section |
| --- | --- | --- |
| Passive production | strict JSON `{version: 2, production: []}` | Production Rules |
| Creature type remaps | JSON `{dinoMappings: []}` | Creature Remaps |
| Custom Cosmetic Mod list | pipe-delimited `modId\|1\|1\|,…` | CurseForge |

Built with **Tauri 2 + React + TypeScript** (Vite, Tailwind 4, Zustand, zod).

## Running

```sh
npm install
npm run tauri dev      # desktop app (full functionality)
npm run dev            # browser-only UI preview (mock backend, no publishing/scraping)
npm run tauri build    # production installer
npx vitest run         # unit tests (serializers, validation, simulator)
```

Requires: Node 22+, Rust toolchain, Google Chrome (for the CurseForge scraper).

## First-time setup

1. Create a project (Home screen) - pick an empty folder, e.g.
   `Documents\DinoDepot Studio\GG Fizz`.
2. **Settings** → set the GitHub repository owner/repo/branch and the three
   output paths, and store a fine-grained personal access token
   (Contents: Read and write). The token lives in Windows Credential Manager,
   never in project files.
3. Import your live files:
   - Production Rules → *Import live file…* (passive production JSON)
   - Creature Remaps → *Import live file…* (remap JSON)
   - CurseForge → Collector tab → *Import CCM file…* (pipe-delimited list)
   Unknown blueprint paths are auto-added to an "Imported / unsorted" content
   source so pickers and validation can see them.

## Sections

- **Overview** - project health: validation status, unpublished changes,
  watcher alerts, quick navigation.
- **Production Rules** - visual editor for creature production (cycles, items,
  alternates, consumed items, caps) with live strict-JSON preview and
  validation. Never hand-write the published JSON.
- **Simulator** - expected-value output estimates per item/creature/cycle over
  a chosen time window, with cap behavior and balance warnings. Thresholds are
  configurable in Settings.
- **Content Sources** - the catalog of creatures/items the pickers use.
  Adding a mod by hand starts from its CurseForge project ID: the page link is
  derived from it, and *Look up name* reads the mod's own name off that page
  (desktop app + Chrome). The name is always yours to override.
  Bundled official ASA data (538 creatures / 1,628 items) plus your own mod
  sources with bulk paste import. Mark a source *disabled* or *being removed*
  to get warnings wherever its content is referenced.
- **Creature Remaps** - remap creature types before removing creatures/mods;
  validates destinations exist, flags chained remaps and removed-mod sources.
- **CurseForge** - two automations (both need the desktop app + Chrome):
  - *Custom Cosmetics Collector*: sweeps the ASA custom-cosmetics category,
    then shows an added/updated/missing diff you review before applying.
    New entries default to `|1|1|`.
  - *Mod Update Watcher*: checks watched mod pages for new update dates and
    flags mods as *needs review* until you mark them reviewed.
- **Publish** - validates and publishes the public site as one atomic GitHub
  commit: viewer page, viewer data, assets, and manifest always stay in sync.
  Outputs with independent consumers and destinations keep their own publish
  cards, remote comparison, history, and copyable RAW URLs. The public Cluster
  Viewer lets members look up what creatures produce, what produces each item,
  and administrator-written taming or utility information. Enable GitHub Pages
  from the configured branch and `/docs` folder after the first site publish.

## Icons

Catalog data and artwork rights are separate. Official and mod artwork resolves
through the rights registry only when the exact asset is active and approved
for distribution. Verified 160x160 WebP files are cached outside the project;
denied, revoked, replaced, disabled, or corrupt records are purged. The app
fails closed to bundled placeholder artwork when permission cannot be proven.

Legacy v1 and package v2/v3 content remains readable, but its artwork references
are quarantined compatibility data and do not display or publish by themselves.

Resolution order for an entry:

1. a project-owned override imported or selected from the project's own
   `images/` folder;
2. rights-approved official or mod artwork for the entry's canonical icon key;
3. the bundled missing-creature or missing-item placeholder.

When you catalogue a mod through **Discover installed**, each entry in the
review list has an icon box: it opens the mod's own artwork, read straight out
of the copy installed on this machine, and whatever you pick is saved into the
project as a 160x160 lossless WebP. Nothing links icons to entries
automatically - across the local mod corpus only 5.5% of items have a
name-matching icon - so the choice is yours to make and yours to change.

That reader is a .NET sidecar built from `sidecar-assets/`
(`npm run build:assets`). It needs the ARK install Discovery already points at,
and fetches Epic's Oodle decompression library on first use, since UE5 links
Oodle statically into the game and there is no copy to borrow.

Project-owned images go in `<project folder>/images`. **WebP is preferred and
PNG is the only fallback** - file signatures are checked, so an image is read
by its actual bytes rather than its extension. Anything else is ignored.
Registry artwork never copies into that folder. It stays in the verified
machine-wide cache, while project-owned images stay with the project.

A missing, unreadable, or malformed icon is never fatal: the entry falls back
to bundled placeholder artwork, and mods still add, export and publish normally.

Building or testing packages locally? See
[docs/local-package-testing.md](docs/local-package-testing.md).

## Project data

Everything lives as JSON in the project folder you chose: `project.json`
(settings), `*.draft.json` (editor drafts), `catalog.mods.json`,
`watchlist.json`, `history.json`, and `backups/` (last 20 versions of each
file, rotated automatically on every change). Drafts autosave ~1s after edits.

## Repo layout

```
src/model/         TypeScript types + zod schemas for all data
src/serializers/   internal model ⇄ published formats (round-trip tested)
src/validation/    semantic validation rules (production, remaps)
src/simulator/     pure expected-value math engine
src/pages/         one folder/file per app section
src/services/      IPC layer (mockable in browser), importers, publishing
src-tauri/         Rust backend: project IO+backups, keyring secrets,
                   GitHub Contents API, scraper process runner
sidecar/           Node/Puppeteer CurseForge scraper (NDJSON events)
scripts/           catalog, package, and maintenance tooling
StructureExample/  published-format reference fixtures
```
