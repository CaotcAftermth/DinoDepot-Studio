# Rights-aware assets

DinoDepot Studio now treats content identity and artwork delivery as separate systems. Catalogs, modpacks, and package format 4 carry `iconKey` values and data only. They never grant artwork rights.

## Runtime rules

- `dds:`, `official:`, `mod:`, and `project:` are the only canonical namespaces.
- Project artwork remains project-local and may publish only with the project-custom warning.
- Official artwork resolves only under an approved, distribution-eligible `official-reference-policy`.
- Mod artwork resolves only when the relevant manifest says `author-approved` or `license-approved`, includes the requested asset scope, and marks that exact version `active`.
- The client fetches the registry index and only relevant manifests. Metadata refreshes after 15 minutes and fails closed after 24 hours offline.
- A cache hit is unusable until rights metadata is verified. Denied, revoked, withdrawn, replaced, disabled, or corrupt records purge the matching cache entry.
- Legacy v1 and package v2/v3 content remains readable. Its image references are quarantined compatibility data and do not publish or display by themselves.

The desktop cache lives in app data under `asset-cache/` and `registry-cache/`, outside projects and modpacks. Downloads are promoted atomically only after WebP signature, 160×160 dimensions, version, and SHA-256 verification.

## Public repository boundary

`Public_Content/Asset_Registry` contains disabled public registry identities. Every currently known image is `not-reviewed` and `publishEligible: false`; these files are not an approval source. The full audit is in `legacy-asset-inventory.json`.

Real permission records and immutable permission terms are private inputs maintained outside this repository. This repository contains only a schema and an intentionally unusable redacted example. The tool does not generate or edit legal wording.

## Maintainer preparation

Store the exact external terms file as `DDS-ICON-PERMISSION-vN.N.md`. Its filename must equal the permission record's `terms.version` plus `.md`, and its SHA-256 must equal `terms.sha256`.

```text
cargo run --bin rights_asset_publisher -- prepare <record.json> <terms.md> <source-image> <creature|item> <asset-id> <asset-version> <output-dir>
```

Preparation default-denies before image processing. It checks permission lifecycle, authority, desktop and web scope, asset type, terms identifier/hash, format conversion, and 160×160 limit. Success writes a transparently padded lossless WebP, a redacted registry fragment, and an asset→manifest→index publish plan. The command does not upload and does not accept credentials.

Merge `metadata/sanitized-fragment.json` into a fully reviewed staged manifest at `registry/mods/<ModID>.json`, and stage the updated public index at `registry/index.json`. Then validate the complete staging tree with a dry run:

```text
npm ci
npm run publish:rights-assets -- <output-dir>/publish-plan.json
```

The dry run rechecks the bucket/domain, approval and scope, public-field redaction, active state, version/hash-qualified path, file SHA-256, Cache-Control, and asset-to-manifest-to-index ordering. In a separately authorized maintainer/CI environment, upload with:

```text
CLOUDFLARE_API_TOKEN=<secret> CLOUDFLARE_ACCOUNT_ID=<account> npm run publish:rights-assets -- <output-dir>/publish-plan.json --execute
```

The execute path uses the repository-pinned Wrangler and explicit remote R2 operations. It refuses absent credentials; neither credential is compiled into the desktop or viewer.

To prepare—but not execute—a metadata-first revocation:

```text
npm run prepare:rights-revocation -- <approved-mod-manifest.json> <output-dir>
```

This emits a revoked/withdrawn manifest and an ordered denied-metadata-to-delete-to-purge-to-placeholder-verification plan. Remote deletion and CDN purge still require separate explicit authorization.

## External Cloudflare setup

These are maintainer/CI steps; they are not performed by the desktop app.

- Bucket: `dinodepot-assets`.
- Direct R2 custom domain: `assets.dinodepot.app`. Keep `r2.dev` development-only.
- Object prefixes: `registry/`, `official/`, `mods/<ModID>/`, and `metadata/schema/`.
- Public CORS: origins needed by official viewers (or `*` for credential-free public reads), methods `GET` and `HEAD`, no credentials, allow request header `If-None-Match`, and expose `ETag` and `Cache-Control`.
- Apply the committed policy with `npx wrangler r2 bucket cors set dinodepot-assets --file docs/rights-assets/r2-cors.json --force`.
- `Cache-Control`: registry metadata `public, max-age=300`; artwork `public, max-age=604800`.
- Use version/hash-qualified artwork paths. Never overwrite an asset version at the same URL.
- Upload an approved asset first, then its manifest, then `registry/index.json` last.
- For revocation, publish denied metadata first, delete the object, purge every affected custom-domain URL, then verify desktop/viewer placeholders. R2 deletion alone does not purge an already cached response.

Cloudflare credentials belong only in the maintainer environment or CI secret store. Desktop and public-viewer builds receive none. Existing `dinodepot-feedback-attachments` configuration is unrelated and must remain unchanged.

References: [Wrangler R2 object commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/), [R2 public buckets and custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/), and [R2 consistency/cache deletion note](https://developers.cloudflare.com/r2/reference/consistency/).

## Rollback

Schema 4 migration does not move or delete a user's project files. Reverting application code restores prior readers; Git can restore removed repository binaries. Do not restore artwork-bearing exports without a new rights review. History rewriting, force-pushing, release deletion, Pages cleanup, and CDN purges require separate explicit authorization.
