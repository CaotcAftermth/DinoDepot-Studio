# Public-history remediation report

## Finding

The public repository contained nine live Anomalocaris image binaries and thirteen unique historical mod-art paths. They entered through commits `99869b3` and `c96b2ac`, with merge `cc2a04c`. The official tree contained 4,209 tracked images. No repository or indexed-web CDN reference was found during the audit; external CDN, cache, clone, and download logs were unavailable and remain unverified.

The current-tree binaries are removed only as a recoverable Git change. Public Git history still contains prior bytes.

## Not authorized or performed

- `git filter-repo`, BFG, or another history rewrite
- force-push or tag rewrite
- GitHub release or Pages deletion
- CDN, R2, or browser-cache purge
- contacting authors, hosts, or downstream clone owners

## Later remediation, if explicitly approved

1. Confirm legal/owner scope and the exact paths/commits to remove.
2. Inventory branches, tags, releases, Pages artifacts, forks, mirrors, and known CDN URLs.
3. Create an offline mirror backup and rehearse the rewrite in a disposable clone.
4. Coordinate a freeze and downstream re-clone instructions.
5. Rewrite all authorized refs, verify content/data survival, and scan object reachability.
6. Force-push coordinated refs, delete authorized release/Pages artifacts, and request host cache cleanup.
7. Purge known CDN URLs, verify placeholders, and preserve an auditable remediation record.

Nothing in this report is permission to execute those actions.
