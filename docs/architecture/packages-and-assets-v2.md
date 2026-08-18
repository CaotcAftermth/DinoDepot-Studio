# Packages and assets v2/v3 architecture

This document is the implementation record for moving DinoDepot Studio from
copy-on-import modpacks and contextual icon strings to immutable packages,
exact project dependencies, and origin-aware assets.

It is deliberately a migration, not a replacement. The existing project and
version-1 modpack formats are permanent compatibility inputs.

## Decisions

### Canonical identity

The numeric CurseForge project ID is the cross-system mod identity. Installed
ASA folders normally provide it as `<projectId>_<fileId>`; `.uplugin`
`cf_ugcID` is the fallback when that folder convention is unavailable. Display
names are never identity.

Custom Cosmetic Mods are classified from the project's own Cosmetics list.
Only active entries that are included in the published list suppress Discovery
by default. The Discovery screen retains an explicit option to show them.

### Authoritative layers

The target effective catalog resolves, in order, from:

1. the bundled official/core catalog plus its exact managed `official-asa`
   icon package;
2. exact modpack dependencies;
3. Discovery-only content;
4. project-owned custom content;
5. project overrides.

Package data and project overrides remain distinguishable. A resolved catalog
may be cached, but it is derived data rather than a second authority.

Existing projects remain materialized until an explicit migration can identify
which fields are package data and which are local edits. Their current data is
also the offline recovery fallback if an exact package is unavailable.

### Packages

Package versions are immutable and coexist in the platform application-data
directory. V2 assets are ordinary files. V3 logical files are hard links to a
single verified blob whenever the filesystem supports them:

```text
content/
  blobs/sha256/<prefix>/<sha256>.<webp|png>
  official/asa/<version>/
  modpacks/<package-id>/<version>/
    manifest.json
    content.json
    assets/
```

Published v3 packages keep metadata per version and bytes per package:

```text
<package-root>/
  assets/sha256/<prefix>/<sha256>.<webp|png>
  versions/<version>/
    manifest.json
    content.json
```

The manifest maps each human-readable logical `assets/...` path to a canonical
blob. Blob names are derived from the declared hash and image type, so an old
version cannot be changed by overwriting a friendly filename.

The package library is reconstructable. Deleting it must never delete project
custom data or overrides.

A project dependency pins package ID, exact version, CurseForge ID, and
integrity. `latest` is a UI recommendation, never a dependency version.

The application library is checked first, followed by the dependency's pinned
immutable registry locator. Retained legacy materialized data remains readable
when a pre-v2 pack has no immutable locator.

For modpacks, the numeric CurseForge ID is the dependency identity whenever it
is present. `packageId` is the immutable package slug and storage coordinate;
changing that slug cannot let one ASA mod enter a project twice.

There was no `.ddpack` reader or writer in the codebase before this migration.
A ZIP transport remains a possible convenience, not a storage authority and
not a compatibility requirement. The implemented offline export is the
ordinary package root (`versions/<version>/` plus `assets/sha256/`) alongside
the permanent v1 compatibility alias. Adding archive transport later therefore
does not change either schema or URL resolution.

Opening that offline `manifest.json` verifies and installs the same immutable
folder. It records an exact linked dependency without inventing a remote
locator; a second machine can use the retained source snapshot until it is
given the same folder or a published immutable URL.

### Assets

New asset references carry their origin rather than relying on context:

```ts
type AssetRef =
  | { origin: "official"; packageVersion: string; path: string }
  | { origin: "package"; packageId: string; version: string; path: string }
  | { origin: "project"; path: string }
  | { origin: "remote"; url: string };
```

Structured references are used in the resolved dependency layer; project
schema 3 continues to persist legacy project icon strings as overrides. The
resolver must always
read legacy emoji, `file:`, HTTP(S), and inferred-name references. Project
custom assets remain project-owned. Package and official assets do not need to
be copied into every project.

The same resolver contract serves Studio, package previews, export, and the
published viewer.

### Current storage inventory

| Data | Current permanent location/reference | Migration status |
|---|---|---|
| Application artwork | `src/assets/` and installer artwork in `src-tauri/icons/` | Application-owned; unchanged |
| Project custom artwork | Project `images/`, or the machine-local `imagesDir` override | `file:` remains the schema-1 compatibility encoding for project-owned references |
| Legacy per-mod source folders | Deprecated machine-local `sourceIconDirs[sourceId]` | Read only for compatibility; there is no folder-selection UI and managed packages never use them |
| Installed package artwork | Logical paths below each exact version; v3 bytes in app data `content/blobs/sha256/` | V2 remains readable; v3 is deduplicated and integrity checked |
| Official ASA artwork | Publication source `Public_Content/Official_Icons/`; installed at app data `content/official/asa/<version>/assets/` | Automatically exact-pinned and resolved; no folder setting |
| Remote previews | App-data icon cache | Disposable; never becomes package or project authority implicitly |
| Legacy public pack artwork | `Public_Content/ModPacks/<ModID-name>/icons/` or historical `Icons/` | Permanent v1 compatibility input |
| Immutable v2 pack artwork | `Public_Content/ModPacks/<ModID-name>/versions/<version>/assets/` | Permanent compatibility artifact |
| Immutable v3 pack artwork | `Public_Content/ModPacks/<ModID-name>/assets/sha256/` | Shared by every new exact version |
| Published viewer artwork | Generated `data:` URLs in viewer data | Exact delivery bytes; no local path or private repository dependency |

`Public_Content/Official_Icons/assets.json` is the authoritative logical-name
map for Core Content. Its blobs include only PNG and WebP assets. The generated
manifest matches creature/item names to the bundled official catalog and may
also carry convention-mapped artwork for supported official maps.

## Compatibility matrix

| Existing input | During migration | Long-term behavior |
|---|---|---|
| Project schema 1 | Existing schema migration and snapshot | Remains readable |
| Project schema 2 with materialized sources | Opens unchanged; package adoption is explicit | Materialized data remains recovery fallback |
| Folder `modpack.json` plus `icons/` | Version-1 adapter | Remains importable |
| Legacy single JSON pack | Version-1 adapter | Remains importable |
| Current unversioned registry URL | Latest compatibility alias | Remains downloadable |
| Emoji icon | Legacy asset adapter | Remains renderable |
| `file:<path>` icon | Resolved in explicit legacy project/pack context | Remains renderable |
| HTTP(S) icon | Native download plus disposable cache | Remains renderable |
| Absolute `ContentSource.iconsDir` | Read as deprecated fallback and copied to local state | No longer written to shared JSON |

## Implemented responsibility boundaries

| Responsibility | Code boundary | Owns |
|---|---|---|
| Asset Resolver | `model/assetRef.ts`, `services/assetResolver.ts`, `services/viewerAssets.ts` | Origin-aware path validation, local/remote/package resolution, legacy adapters, self-contained viewer assets |
| Package Manager | `model/package.ts`, `services/packageManager.ts`, Rust `package_http`, `package_files`, and `package_library` commands | Download, size/hash verification, staging, immutable installation, exact-version reads |
| Dependency Manager | `model/dependency.ts`, `services/dependencyManager.ts`, project schema 3, drafts-store reconciliation | Exact project pins, restore-on-another-machine, deterministic layer precedence, collision diagnostics, project override extraction |

Publication is a Package Manager producer: it emits immutable v3 metadata and
content-addressed blobs plus the v1 alias, then updates `index.json`. Discovery remains an input
adapter. It does not own package installation or asset paths.

## Implemented migration behavior

- Schema 1 still migrates through schema 2; adjacent migrations no longer use
  the moving "current schema" constant.
- Schema 2 migrates to schema 3 and records every source with a known
  `modpackId` and `modpackVersion` as an exact **materialized** dependency.
  No attempt is made to guess which old values came from the pack.
- New v2 and v3 installs are **linked** dependencies. Package defaults are resolved
  below project-owned maps, and only values differing from package defaults
  are written back as project overrides.
- Discovery snapshots and hand-added structural rows are stored separately
  from package membership. Resolution forms one path-keyed source: curated
  package names and additions enrich the locally discovered classes, and a
  package update can remove its own obsolete rows without deleting Discovery
  or project-owned rows.
- Package creature/item membership and INI definitions are read-only in the
  editor. Cluster policy (enabled/removing), source notes, and per-entry
  overrides remain project-owned.
- If a linked package is absent on a second machine, only its pinned manifest
  is downloaded. No `latest` substitution occurs. Failure is visible and
  blocks publication, but the project remains open.
- Published viewer images are embedded as data URLs. Delivery no longer relies
  on an administrator's package cache or a private source repository.
- Discovery checks the registry by numeric Mod ID and displays installed,
  available, missing, and update states. Applying reviewed local content always
  succeeds independently; package installation is a separate optional action.
- A pasted GitHub immutable-version folder or `manifest.json` URL creates the
  same exact linked dependency as an indexed package. Legacy folders and
  `modpack.json` links are deterministically normalized into local v3 packages;
  their original URL plus generated manifest hash reconstructs and verifies the
  exact dependency without copying assets into the project.
- Official and modpack icon roots are derived from exact package identity and
  version. Administrators never select those folders. Project-owned overrides
  always use the project's managed `images/` location; an old `imagesDir`
  override is read only for compatibility.
- WebP is preferred and PNG is the only fallback image format. Missing,
  unsupported, or malformed optional icons are omitted at import/publication;
  the entry uses its category/default glyph and the mod remains addable.
- Existing project image files are never deleted automatically. Files copied by
  pre-v0.4 compatibility installs remain project-owned until an administrator
  deliberately removes them; all new imports keep package bytes in app data.

## Safety invariants

- Opening an existing project never requires a successful network request;
  installed and materialized layers remain fully offline.
- An unavailable dependency degrades visibly; it does not make the project
  unreadable.
- No migration silently deletes a source, entry, image, note, INI value, or
  override.
- Package install is resolve, stage, validate, integrity-check, then commit.
- Shared project files contain no machine-absolute paths.
- Package and asset paths are relative, normalized, and traversal-safe.
- Network access runs through native Tauri commands in the desktop build.
- Existing v1 pack URLs and readers are not removed.

## Delivery phases

1. Stabilize Discovery identity, CCM classification, registry discovery, and
   transactional version-1 imports.
2. Add the legacy-compatible Asset Resolver and localize `iconsDir`.
3. Add version-2 package schemas, immutable registry versions, native download,
   staging, and the application package library.
4. Add exact project dependencies, layered catalog resolution, and
   Discovery/package reconciliation.
5. Add explicit existing-project migration.
6. Use the resolver in publication and make delivery artifacts self-contained.
7. Revisit archive transport and project-level package vendoring only when a
   real offline-distribution requirement justifies them.
8. Add package v3 content-addressed publication and installation without
   changing project schema 3 or rewriting any published v2 version.

Every phase must pass the full frontend suite, production build, and Rust checks
before the next phase becomes authoritative.
