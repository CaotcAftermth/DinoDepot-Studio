# Public-history remediation report

## Finding

The public repository contained nine live Anomalocaris image binaries and thirteen unique historical mod-art paths. They entered through commits `99869b3` and `c96b2ac`, with merge `cc2a04c`. The official tree contained 4,209 tracked images. No repository or indexed-web CDN reference was found during the audit; external CDN, cache, clone, and download logs were unavailable and remain unverified.

## Executed remediation

Maintainer authorization was received and remediation ran on 2026-08-27.

- A complete pre-rewrite Git bundle was created outside OneDrive and verified with `git bundle verify`. Size: 43,996,850 bytes. SHA-256: `597dc63474c1b463dd22c6b6173115630fab78fd97592174d32e6c43ce629a8e`.
- `git-filter-repo` 2.47.0 removed `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, and `.svg` paths below `Public_Content/Official_Icons` and `Public_Content/ModPacks` from all local refs.
- Local verification found zero matching paths across `git rev-list --objects --all`. The original artwork commits are unreachable from rewritten local refs, and the repacked object database reports zero loose or garbage objects.
- All seven artwork-bearing GitHub Releases (`v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.0`, `v0.5.0`, `v0.7.0`, and `v0.8.0`) and their uploaded assets were deleted. GitHub permanently locks immutable-release tag names against reuse, so the seven remote tags were deleted rather than recreated.
- The GitHub Pages API returned `404`; no repository Pages site was available to delete.
- Sanitized `main` was force-pushed with lease protection in the same atomic transaction that deleted the seven remote tags. Repository-level release immutability was verified restored and enabled.

## GitHub-managed pull-request refs

A fresh post-push mirror found sixteen affected read-only `refs/pull/*/head` references (pull requests 1-15 and 19). GitHub does not permit repository owners to rewrite these refs. The remote branch/tag surface is otherwise clean: only sanitized `main` remains, with zero releases, zero tags, and zero visible forks.

GitHub Support must dereference the sixteen affected pull requests, run server garbage collection, and remove cached views. The filter-repo first-changed mappings are `487329eb6de505726fb3af31e798cbce4d8b5e60` → `17268375a201f437d4a373cc4ad9fa19daefbcd4` and `4e6d7b365f90a8d3756ebf1515f868c08407699b` → `bd5e80aed09f15ac6af439a9b2af51fae2de91ad`. No orphaned LFS object report was generated.

## R2 and CDN status

The `dinodepot-assets` R2 bucket was created without changing `dinodepot-feedback-attachments`. Public credential-free GET/HEAD CORS was applied. Only the disabled registry metadata was uploaded, with `registry/index.json` last and `Cache-Control: public, max-age=300`; no artwork objects were uploaded.

The authenticated Cloudflare account contains only the `gg-pandatools.com` zone, not `dinodepot.app`. Consequently `assets.dinodepot.app` could not be attached, no production CDN URL exists, and there was no matching Cloudflare cache hostname to purge. Domain attachment, cache rules, and purge remain pending until `dinodepot.app` is active in the same account.

## Residual exposure

History rewriting cannot remove existing clones, downloads, caches, or release copies already held by third parties. The recovery bundle intentionally contains the prior bytes and must remain private. The GitHub Support purge above remains required; any later discovery of another cached public URL requires targeted host/CDN removal.
