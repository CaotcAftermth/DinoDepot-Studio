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

`Public_Content/Asset_Registry` contains the public registry structure. It
currently publishes no eligible artwork and is not an approval source.

Real permission records and immutable permission terms are private inputs maintained outside this repository. This repository contains only a schema and an intentionally unusable redacted example. The tool does not generate or edit legal wording.

## Deployment

The managed registry uses the private `dinodepot-assets` bucket and the
`assets.dinodepot-studio.app` custom domain. Direct `r2.dev` access remains
disabled. Public GET/HEAD, CORS, ETag/304, and CDN cache behavior must be
verified after configuration changes.

## Maintainer CLI

`npm run rights:assets` is the supported entry point. Private records and exact immutable terms files remain outside this repository. Preparation performs rights validation before image processing, creates a transparently padded lossless 160×160 WebP, merges the sanitized fragment into a complete staging registry, increments registry versions, and validates asset→manifest→index ordering. It does not upload.

Prepare a mod creature or item:

```text
npm run rights:assets -- mod prepare <record.json> <DDS-ICON-PERMISSION-vN.N.md> <source-image> <creature|item> <asset-id> <asset-version> <output-dir> --rights-status <author-approved|license-approved>
```

Prepare an official creature, item, or map under a separately reviewed official reference policy:

```text
npm run rights:assets -- official prepare <policy.json> <DDS-OFFICIAL-REFERENCE-POLICY-vN.N.md> <source-image> <creature|item|map> <asset-id> <asset-version> <output-dir>
```

The private input schemas are `schemas/private-permission-record.schema.json` and `schemas/private-official-reference-policy.schema.json`. Their redacted examples are intentionally unusable as evidence.
For mod preparation, `--rights-status` must exactly match the private record's `approvalBasis`; the CLI will not relabel author evidence as license evidence or vice versa. Official `policyId` values must identify an immutable reviewed policy version.

Prepare fail-closed metadata changes without manufacturing approval:

```text
npm run rights:assets -- mod status <ModID> <output-dir> --rights-status <state> --asset <creature:slug=state>
npm run rights:assets -- official status <output-dir> --review-state <state> --distribution-eligible <true|false> --asset <creature:slug=state>
```

Status commands may preserve or reduce existing approval. Elevation to approved/eligible must come from a validated `prepare` command using private evidence. Denied rights automatically demote active assets to `disabled` or `withdrawn`.

Dry-run any generated plan:

```text
npm run rights:assets -- publish <output-dir>/publish-plan.json
```

In a separately authorized maintainer/CI environment, upload with:

```text
CLOUDFLARE_API_TOKEN=<secret> CLOUDFLARE_ACCOUNT_ID=<account> npm run rights:assets -- publish <output-dir>/publish-plan.json --execute
```

The execute path uses the repository-pinned Wrangler and explicit remote R2 operations. It refuses absent credentials; neither credential is compiled into the desktop or viewer. Existing `publish:rights-assets` and the Rust `prepare` form remain compatible.

To prepare - but not execute - a metadata-first revocation:

```text
npm run rights:assets -- mod revoke <ModID> <output-dir>
npm run rights:assets -- official revoke <output-dir>
```

This emits a revoked/withdrawn manifest and an ordered denied-metadata-to-delete-to-purge-to-placeholder-verification plan. Remote deletion and CDN purge still require separate explicit authorization.

## External Cloudflare setup

These are maintainer/CI steps; they are not performed by the desktop app.

- Bucket: `dinodepot-assets`.
- Direct R2 custom domain: `assets.dinodepot-studio.app`. Keep `r2.dev` disabled.
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

Schema 4 migration does not move or delete a user's project files. Reverting
application code restores prior readers. Do not publish artwork-bearing
exports without a current rights review.
