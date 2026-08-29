# Testing packages locally

Current package exports are format 4 and data-only. They contain catalog data
and canonical `iconKey` identities, never artwork bytes, remote image URLs, or
machine-local paths. Artwork is a separate, rights-aware service described in
[Rights-aware assets](rights-assets/README.md).

## Official data

The bundled official package is selected by
`Public_Content/Official_Icons/index.json`. After changing official catalog or
creature information, update the package version in `official.json`, then run:

```bash
npm run build:official-data
npm run stage:official
```

The builder writes an immutable format-4 version with zero assets. Staging
verifies the manifest and content hashes before copying only the current
version into the ignored Tauri resource directory. `npm run dev` and
`npm run build` stage it automatically.

## Modpacks

The supported path is **Content Sources > the mod > Export modpack**. Studio
writes the data-only compatibility alias and immutable version files:

```text
<curseforgeId>-<Mod_Name>/
  modpack.json
  versions/<exact-version>/
    manifest.json
    content.json
```

Install the resulting local `manifest.json` through **Content Sources > Add
modpack > From file**. The local folder is recorded only on that computer; no
drive path is written into shared project files.

Run the repository boundary checks before committing package changes:

```bash
npm run scan:modpacks
npm run scan:public-assets
```

Both checks reject artwork in data-only public packages. With no eligible
registry artwork, entries use bundled placeholders and the package remains
fully usable.

## Artwork testing

Use `npm run rights:assets` for new approved artwork, status changes, and
revocations. Preparation validates private evidence, normalizes the image, and
creates a publish plan; it does not upload by itself. See
[Rights-aware assets](rights-assets/README.md) for the exact commands,
deployment boundary, and rollback rules.
