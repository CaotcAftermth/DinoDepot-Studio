# Public-history remediation report

## Finding

The public repository contained nine live Anomalocaris image binaries and thirteen unique historical mod-art paths. They entered through commits `99869b3` and `c96b2ac`, with merge `cc2a04c`. The official tree contained 4,209 tracked images. No repository or indexed-web CDN reference was found during the audit; external CDN, cache, clone, and download logs were unavailable and remain unverified.

## Executed remediation

Maintainer authorization was received and remediation ran on 2026-08-27.

- A complete pre-rewrite Git bundle was created outside OneDrive and verified with `git bundle verify`. Size: 43,996,850 bytes. SHA-256: `597dc63474c1b463dd22c6b6173115630fab78fd97592174d32e6c43ce629a8e`.
- `git-filter-repo` 2.47.0 removed `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, and `.svg` paths below `Public_Content/Official_Icons` and `Public_Content/ModPacks` from all local refs.
- Verification found zero matching paths across `git rev-list --objects --all`. The original artwork commits are unreachable, and the repacked object database reports zero loose or garbage objects.
- All seven artwork-bearing GitHub Releases (`v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.0`, `v0.5.0`, `v0.7.0`, and `v0.8.0`) and their uploaded assets were deleted. Sanitized tags were retained and rewritten.
- The GitHub Pages API returned `404`; no repository Pages site was available to delete.
- The sanitized `main` branch and all seven tags were force-pushed with lease protection after verification.

## R2 and CDN status

The `dinodepot-assets` R2 bucket was created without changing `dinodepot-feedback-attachments`. Public credential-free GET/HEAD CORS was applied. Only the disabled registry metadata was uploaded, with `registry/index.json` last and `Cache-Control: public, max-age=300`; no artwork objects were uploaded.

The authenticated Cloudflare account contains only the `gg-pandatools.com` zone, not `dinodepot.app`. Consequently `assets.dinodepot.app` could not be attached, no production CDN URL exists, and there was no matching Cloudflare cache hostname to purge. Domain attachment, cache rules, and purge remain pending until `dinodepot.app` is active in the same account.

## Residual exposure

History rewriting cannot remove existing clones, forks, downloads, caches, or release copies already held by third parties. The recovery bundle intentionally contains the prior bytes and must remain private. Any later discovery of a cached public URL requires targeted host/CDN removal.
