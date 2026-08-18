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

Requires: Node 18+, Rust toolchain, Google Chrome (for the CurseForge scraper).

## First-time setup

1. Create a project (Home screen) — pick an empty folder, e.g.
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

- **Overview** — project health: validation status, unpublished changes,
  watcher alerts, quick navigation.
- **Production Rules** — visual editor for creature production (cycles, items,
  alternates, consumed items, caps) with live strict-JSON preview and
  validation. Never hand-write the published JSON.
- **Simulator** — expected-value output estimates per item/creature/cycle over
  a chosen time window, with cap behavior and balance warnings. Thresholds are
  configurable in Settings.
- **Content Sources** — the catalog of creatures/items the pickers use.
  Bundled official ASA data (538 creatures / 1,628 items from ark.wiki.gg;
  refresh with `node scripts/build-official-catalog.mjs`) plus your own mod
  sources with bulk paste import. Mark a source *disabled* or *being removed*
  to get warnings wherever its content is referenced.
- **Creature Remaps** — remap creature types before removing creatures/mods;
  validates destinations exist, flags chained remaps and removed-mod sources.
- **CurseForge** — two automations (both need the desktop app + Chrome):
  - *Custom Cosmetics Collector*: sweeps the ASA custom-cosmetics category,
    then shows an added/updated/missing diff you review before applying.
    New entries default to `|1|1|`.
  - *Mod Update Watcher*: checks watched mod pages for new update dates and
    flags mods as *needs review* until you mark them reviewed.
- **Publish** — each output publishes independently: validation gate (errors
  block, warnings need acknowledgement), remote comparison, commit message,
  publish history, and copyable RAW URLs for the server INI. Also publishes
  the **Cluster Viewer**: a public, Ark-themed lookup page for members
  (creature → produces, item → produced-by, plus admin-written taming/utility
  info from Content Sources → Info…). Publish the page once to `docs/index.html`
  and enable GitHub Pages (deploy from branch, `/docs`); republish only the
  viewer *data* when rules change.

## Icons

Icons are resolved from managed packages. There is no icon folder to
configure — official and modpack artwork is installed automatically from
immutable, integrity-checked packages, and the app ships with the official
package so it works on a first launch with no network.

Package format v3 stores each unique image once by SHA-256 and reuses it across
exact package versions. Previously published v2 packages remain supported.

Resolution order for an entry:

1. a project override — click any entry icon in Content Sources to set an
   emoji, an image URL, or a file from the project's own `images/` folder;
2. the exact official or modpack package asset pinned by this project;
3. an `images/` match by name (e.g. `Achatina.webp`), then the parent
   creature's icon for variants;
4. the category glyph.

Project-owned images go in `<project folder>/images`. **WebP is preferred and
PNG is the only fallback** — file signatures are checked, so an image is read
by its actual bytes rather than its extension. Anything else is ignored.
Package-owned images never copy into that folder: immutable and legacy
modpacks are both normalized into the shared managed package library.

A missing, unreadable, or malformed icon is never fatal: the entry falls back
to its glyph, and mods still add, export and publish normally.

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
scripts/           official-catalog builder (ark.wiki.gg)
StructureExample/  original format reference documents
```
