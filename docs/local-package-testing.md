# Testing packages locally

How to build, install and verify a content package on one machine, without
publishing anything and without needing GitHub.

This is a developer document. Administrators using a release build never see
any of it — they never choose an icon folder, and the official package is
already installed.

## What resolves a package, and in what order

A project pins each dependency by package ID, exact version and manifest
SHA-256. Resolving one tries, in order:

1. **the installed library** — `%APPDATA%/com.ggfizz.dinodepotstudio/content/`,
   laid out as `official/asa/<version>/` and `modpacks/<packageId>/<version>/`;
2. **the bundled official package** — shipped as a Tauri resource under
   `official-package/<version>/`, installed through the same verification the
   downloaded path uses;
3. **a machine-local manifest folder** — recorded per project in local state
   when you install from disk;
4. **GitHub** — the pinned immutable manifest URL.

GitHub is therefore how a *new* version is distributed, not how an already
pinned one is found. Opening a project, and a first launch, work offline.

If none of them resolve, the dependency degrades to a visible diagnostic and
the affected entries use their default glyphs. The project still opens.

## Official Core Content

The bundled package is whatever `Public_Content/Official_Icons/index.json`
names. To change it:

```bash
node scripts/build-official-package.mjs
```

That reads `Public_Content/Official_Icons/official.json` for the version and
packages every `.webp`/`.png` under `creatures/`, `items/` and `maps/`,
matching creature and item files to the bundled catalog by name. Versions are
immutable: to change bytes, bump `version` in `official.json` and rebuild.

`npm run tauri dev` picks the new resource up on the next start. Nothing is
uploaded.

## Development modpacks

Build a package that cannot reach the published registry:

```bash
node scripts/build-package-v2.mjs --dev Public_Content/ModPacks/987274-Additions_Ascended_Anomalocaris
```

`--dev` writes to `dev-packages/<packageId>/<version>/` (gitignored) and
**does not touch `Public_Content/ModPacks/index.json`**, so a local iteration
can never become the version other administrators are offered. Without
`--dev`, the build writes the immutable published artifact and updates the
production index — that is the release path.

Immutability still applies in dev mode. Changed bytes need a new version, so
give development builds a distinct one such as `1.0.1-dev.1` in
`modpack.json`.

## The loop

1. Edit `modpack.json` and the icons beside it.
2. Bump `meta.version` to a fresh development version.
3. `node scripts/build-package-v2.mjs --dev <pack dir>` — it prints the
   manifest path.
4. In the app: **Content Sources → Add modpack → From file**, and pick that
   printed `manifest.json`.
5. Confirm the WebP icons appear on the mod's creatures and items.
6. Restart with the network off. Both the official icons and the development
   pack must still resolve, from the library and the bundle.

Step 4 records the manifest folder in **this machine's** local state only. It
is never written to `project.json` or `catalog.mods.json` — a shared project
file must not carry one administrator's drive letter.

## Images

Only verified WebP and PNG are accepted, WebP preferred. Signatures are
checked at every boundary — the package builders, the Rust installer, and the
download path — so a `.png` that is really a GIF is rejected rather than
installed. An image that fails verification is omitted; the entry uses its
glyph and the install still succeeds.

## What to check when icons do not appear

- **`<package>@<version> is unavailable`** in Content Sources means no layer
  resolved. Offline with no bundled resource and nothing in the library is the
  usual cause.
- **Icons resolve but render blank**: the path is outside the asset-protocol
  scope. Installed packages must sit under `$APPDATA/content/**`, which
  `src-tauri/tauri.conf.json` allows.
- **The published registry 404s**: `Public_Content` has not been committed and
  pushed. That only affects distribution to other machines — local development
  does not need it.
