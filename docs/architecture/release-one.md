# DinoDepot Studio - release-one architecture

The plan for turning DinoDepot Studio from a single-administrator publishing
tool into something two administrators can share safely, and its current state.

This document is the implementation plan. It is updated as each phase lands.

> Package, icon, and project-schema-3 work added after this release-one plan is
> recorded in [packages-and-assets-v2.md](packages-and-assets-v2.md). Schema-2
> examples below remain as the historical contract that the 2→3 migration
> accepts; they are not the current write schema.

---

## Repository model

Three repository roles, none of which may ever be shared between projects.

| Role | Visibility | Holds | One per |
|---|---|---|---|
| **DinoDepot Studio** - `CaotcAftermth/DinoDepot-Studio` | public | Studio source, Windows releases, updater metadata, docs, public modpack registry | the product |
| **Project source** | private | portable project source, manifest, editable JSON, team-private `players.json`, IP-sanitized `.arkprofile` backups, assets, Git history | project |
| **Project delivery** | public | generated public viewer content only | project |

The separate source/delivery topology is the default and the recommendation: it
is the only arrangement that lets a GitHub Free user keep project source private
while publishing a public Pages site. A paid plan may instead use a single
private repository with Pages served from a staged `published/site` directory,
via a workflow the user installs themselves - DinoDepot never requests the
Workflows permission and never edits a workflow file.

Every reference to the Studio repository goes through `src/model/studio.ts`.
Nothing depends on GitHub's rename redirect from the old slug, because that
redirect stops working the moment somebody else claims the freed-up name.

---

## The seven version concepts

Keeping these distinct is what stops an updater shipping a downgrade and a
project claiming compatibility it does not have.

| # | Concept | Lives in | Shape |
|---|---|---|---|
| 1 | **Studio version** | `package.json`, `Cargo.toml`, `tauri.conf.json`, `STUDIO_VERSION` | SemVer |
| 2 | **Project schema** | root `project.json` | integer, sequential migrations |
| 3 | **Per-file schema** | each domain file | integer, only where a file migrates independently |
| 4 | **Source revision** | Git | source commit SHA - never a counter of our own |
| 5 | **Published build** | Git + manifest | delivery commit SHA plus a publish operation id |
| 6 | **Public output contract** | `dinodepot-build.json` | integer |
| 7 | **Modpack format/content** | `modpack.json` | separate from all of the above |

`scripts/check-versions.mjs` enforces that the four sources of concept 1 agree.
Run it before any release build; `--set <version>` updates all four at once.

---

## Phase order

Each phase depends on the ones above it.

1. **Foundation** - manifest v2, machine-local state, sequential migrations,
   persistence hardening, project lock, typed errors, secret boundary.
2. **Embedded Git** - Rust Git adapter, fetch/base tracking, commits,
   non-force push, recovery refs, structured commit actions.
3. **Multi-admin reconciliation** - semantic three-way merge, typed conflict
   model, conflict UI, push race retry, offline state.
4. **GitHub onboarding** - per-account credentials, browser-guided repository
   connection, source/delivery pairing by immutable id, rename/transfer/deletion
   handling.
5. **Private data** - players schema adjustment, mandatory profile sanitizer,
   private profile layout, restore, privacy tests.
6. **Publishing** - central validation, staged artifact, public-boundary scan,
   atomic delivery commit, Pages polling, Sync and Publish.
7. **Activity and caching** - Git-backed Recent Activity, restore-version flow,
   persistent icon cache.
8. **Releases** - version centralization, Windows CI, GitHub Releases, signed
   Tauri updater, release documentation.

---

## Phase 1 - Foundation (complete)

### Project identity

`project.json` remains the one and only manifest. It gains a header:

```json
{
  "format": "dinodepot.project",
  "projectId": "<uuid>",
  "schemaVersion": 2,
  "minimumStudioVersion": "0.2.0",
  "createdAt": "2026-08-09T…",
  "capabilities": {}
}
```

`projectId` is immutable and is the only thing anything is keyed by. Repository
names and folder paths both change; neither may serve as identity.

### The open sequence

The order is the design (`src/services/projectSession.ts`):

1. Read `project.json` as **raw JSON** and extract the header only.
2. Assess compatibility.
3. Take the project lock - *before* migrating.
4. Migrate, if the schema is older.
5. Only now hydrate through the current schema.

Reading the header first is what stops a project written by a newer Studio from
being mistaken for a corrupt one. Locking before migrating matters because a
migration is the one operation two instances would destroy outright.

| Header says | Outcome |
|---|---|
| schema == current, Studio requirement met | open |
| schema < current | migrate, then open |
| schema > current | **read-only**, unknown data preserved, no lock taken |
| `minimumStudioVersion` > this build | **read-only** |
| not a DinoDepot project, or unreadable | refuse |

An older Studio never writes to a newer schema. It cannot know what it would be
dropping, and the project is shared - the loss would land on someone else.

### Portable vs machine-local

| Portable (`project.json`, synchronizes) | Machine-local (app data, keyed by `projectId`) |
|---|---|
| name, cluster, maps, defaults, simulator | project folder path |
| `outputPaths` - the layout *inside* the repository | images folder, mods folder |
| Discord format, modules, player-data policy | GitHub account id and login |
| modpack registry, capabilities | source + delivery repository bindings |
| | last synchronized / published commits |
| | pending operation, for recovery |

A repository binding carries GitHub's **immutable numeric id**. Owner and name
are cached for display and rebuilt when the id shows a rename or transfer.
Remote URLs are stored without credentials - `isSafeRemoteUrl` refuses anything
carrying them, on the way in rather than on the way out.

**No credential is stored in this record**, and `local_state_set` refuses
content that looks like one.

### Migrations

`src/model/migrations/` - pure functions, one adjacent step at a time, no jumps.
The coordinator verifies that *each* step lands on its own target version, not
just that the end result parses; a broken middle step must not hide behind a
later one that happens to repair it.

`v1 → v2` does three things, all of them consequences of schema 1 storing things
that were never true of the project:

- gives the project a permanent `projectId`;
- moves the repository and both local folder paths into machine-local state;
- renames `github.paths` to `outputPaths`.

It also strips `lastKnownIp` from every stored profile summary - personal data a
shared project has no business carrying, removed at the last moment before the
roster starts synchronizing.

Unknown top-level keys are carried through. A migration is the worst possible
place to decide somebody else's field does not matter.

**On disk** (`commit_migrated_project` in Rust): snapshot the whole project →
stage every new file → read each back and compare → only then swap them in. A
failure before the swap leaves the project exactly as it was; a failure during
it leaves a full snapshot to restore from.

The v1 fixture in `__fixtures__/schema-v1.ts` is **permanent**, including its
drive letters, repository name and documentation-range IP addresses. Those are
the whole point of what the migration deals with.

### Persistence

- One write primitive: `write_atomic` - temp file, `sync_all`, rename. Without
  the explicit flush a rename can reach the disk before the contents do, and a
  power cut in that window leaves a correctly-named file full of zeroes.
- `flushPendingSaves` returns `{ ok, failures }`. It used to swallow rejections
  into a toast, which is how an administrator could publish work that had never
  reached the disk.
- `saveHealth` in the project store records which files are failing. Sync,
  Publish, migration and close all read it.
- A file that fails to parse is **quarantined** into `recovery/`, not hydrated as
  empty. The old behaviour left the store holding nothing where the roster was,
  and the first keystroke autosaved that nothing over the file. Quarantined files
  are also excluded from the flush, so nothing can write over them either way.
- `pagehide` is still wired up, but nothing depends on it - it cannot await an
  asynchronous write. Correctness comes from the short debounce and from every
  boundary operation flushing explicitly and checking the result.

### Project lock

`.dinodepot-lock` in the project folder: instance id, machine name, pid,
heartbeat. Advisory by design - a lock that stopped beating for five minutes
goes stale, and the administrator can always take it over. A read-only session
takes no lock at all, since it cannot collide and holding one would keep out the
administrator whose Studio *can* open the project.

The lock file starts with a dot, so `load_project` has never been able to see it.

### Typed errors

`src/model/errors.ts`. One `StudioError` with a code the app branches on, a
plain-English message for the administrator, and technical `detail` for Advanced
Details. HTTP status classification lives here too, including the case that
matters: a 403 carrying `Retry-After` is rate limiting, not a bad token - reading
it as the latter sends an administrator off regenerating a credential that was
fine.

`detail` is redacted on construction, not at the logging call site. The one place
a token leaks is the place somebody forgot to call the redactor.

### Secret boundary

`secret_get` **no longer exists as a command**. The webview - the part of the app
that renders untrusted project content - could previously ask for the GitHub
token and receive it. It can now learn only that a credential exists.

Credential keys are an allowlist, not a sanitizer: `github-account:<id>`,
`discord-webhook:<projectId>`, and the two legacy keys `github-token` and
`discord-webhook`. Credentials are filed per GitHub account and per project.

The GitHub legacy key is read as a fallback so an upgrade does not log everyone
out. The Discord one is **not**: a webhook points at one channel in one server,
which belongs to one cluster, so falling back to a machine-wide entry is what
made a freshly created project report a webhook it had never been given - and
post its announcements into somebody else's channel. It is offered once, in
Settings → Discord, and either moved into a named project or discarded. Neither
legacy key is ever written.

### Security hardening

**Content Security Policy** (was `null`). A project is untrusted input: its JSON
is authored elsewhere, its icon folder can point anywhere, and a modpack arrives
from a public registry.

- `script-src 'self'` with no `unsafe-inline` escape - no injected markup can run.
- `style-src` does carry `'unsafe-inline'`, which the styling in use requires.
- `connect-src` reaches nothing external. Every network call goes through Rust,
  where the credential lives; the webview never needs to reach GitHub and must
  not be able to.
- `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'`.

**Asset protocol scope** (was `**` - every file on the machine, including the
project's `.arkprofile` saves). Now the icon sources the app actually renders
from, with profiles and `players.json` denied explicitly.

**GitHub requests** pin `X-GitHub-Api-Version: 2022-11-28` and carry a 30-second
timeout. A Sync that hangs forever looks identical to a Sync that is working.

### Phase 1 test results

| Suite | Baseline | After Phase 1 | After Phase 2 |
|---|---|---|---|
| Frontend (`npx vitest run`) | 886 | 1005 | **1096** |
| Rust (`cargo test`) | 7 | 33 | **53** |
| `npx tsc --noEmit` | clean | clean | clean |
| `cargo build` warnings | - | 0 | 0 |
| `npm run build` | succeeds | succeeds | succeeds |
| `node scripts/check-versions.mjs` | - | agrees at 0.2.0 | agrees at 0.2.0 |

### Compatibility risk

- **Schema 1 projects migrate on first open.** The migration is one-way. A full
  snapshot is taken first, under `backups/snapshots/`.
- **The repository binding survives the migration by name only.** Schema 1 never
  knew GitHub's numeric id, so the binding starts incomplete and is completed the
  first time the repository is reached - which is also when a rename since the
  last session gets noticed. Inventing an id would create a binding that verifies
  against nothing.
- **`lastKnownIp` is gone from stored summaries.** It is still read from a
  `.arkprofile` for display; it no longer persists into the roster.
- **A project opened by this build cannot be opened by 0.1.x.** That is the
  `minimumStudioVersion` gate working as intended - every administrator on a
  project needs to update together.

---

## Phase 2 - Embedded Git and Sync (complete, bar the semantic merge)

### Library decision: `git2` (libgit2)

Decided by building both candidates on Windows against the actual requirement
set - fetch, tree access, commit creation, ref updates, credentials, packaging.

**`git2` with `default-features = false, features = ["https", "vendored-libgit2"]`:**

- Builds on this machine in **48 seconds**, vendored, so nothing on a build
  machine has to supply libgit2. No system Git is required at runtime either.
- `https` links Windows' own **Schannel** rather than bundling OpenSSL - no
  certificate bundle to ship and keep current.
- `RemoteCallbacks::credentials` supplies the token **per request, in memory**.
  That is the whole reason the stored remote URL can stay credential-free.
- Push reports per-ref status, so a non-fast-forward rejection is a
  distinguishable outcome rather than prose to pattern-match. (In practice it
  arrives *both* ways - as an `ErrorCode::NotFastForward` and as a
  `push_update_reference` status - and both are handled.)
- `git2::Version::get().https()` lets the app assert at runtime that the build it
  is actually running can talk HTTPS, which a test now enforces.

**`gix`** was the other candidate: pure Rust and appealing, but its push support
is still incomplete, and push with a non-force guarantee is the one operation
this design cannot compromise on.

All of libgit2 is confined to `src-tauri/src/commands/git/`. Everything else
talks to the types in that module, so swapping implementations later means
rewriting one module rather than the synchronization engine.

### What the adapter does

`git_capabilities`, `git_state`, `git_read_tree`, `git_commit`,
`git_set_remote`, `git_fetch`, `git_push`, `git_mark_recovery`,
`git_clear_recovery`.

Three properties are load-bearing and covered by tests against a **local bare
repository**, so the whole push path runs with no network and no credential:

1. **Push is never forced.** The refspec has no `+`. A push onto a branch that
   moved on returns `{ pushed: false, rejected: true }` and the other
   administrator's commit is still what the remote holds. This is the final race
   guard - everything upstream tries to avoid reaching it, and it is what makes
   losing a commit impossible when all of that fails.
2. **Fetch never touches the working tree.** Only the remote-tracking ref moves.
   Letting Git near the files is how conflict markers end up inside a JSON file
   the administrator then has to read.
3. **No credential reaches disk.** `git_set_remote` refuses any URL that is not
   plain HTTPS or that carries an `@`, and every string leaving the module goes
   through `redact`.

A bug the tests caught: a freshly initialised repository points `HEAD` at
libgit2's default branch name, which is rarely the project's. Left there, `HEAD`
is unborn relative to the branch being committed to and every file reports as a
pending addition forever. `git_commit` now sets `HEAD` to the project branch.

Deliberately **not** in this module: merging. A Git-level merge produces conflict
markers inside JSON, which is exactly what the administrator must never see.
Reconciliation is semantic and belongs to Phase 3.

### Structured commits

One successful Sync produces one commit. Subject for the person, trailers for
the app:

```
Updated creature and mod configuration

DinoDepot-Project: 11111111-2222-4333-8444-555555555555
DinoDepot-Schema: 2
DinoDepot-Operation: 8a7c…
DinoDepot-Actions-Version: 1
DinoDepot-Action: {"type":"creature.updated","id":"r1","fields":["displayName"]}
DinoDepot-Action: {"type":"mod.added","id":"1431447"}
```

Trailers rather than a JSON blob because they survive `git log --format`, the
GitHub UI and a cherry-pick, and because a reader who has never heard of
DinoDepot can still tell what the commit did.

`DinoDepot-Actions-Version` moves independently of the project schema. A reader
that finds a higher number keeps what it understands and says so, rather than
discarding a commit it could mostly read. An unknown *action type* is not an
error at all - it is shown as-is.

The **journal** (`pendingActions` in machine-local state) accumulates what has
been done since the last Sync, written on a two-second debounce so a crash
costs at most the description of the last change - never the change itself,
which the drafts store has already persisted. It is emptied only once the
commit describing it is provably on GitHub.

`collapseActions` turns an afternoon into readable history: twenty edits to one
name become one action with the union of changed fields; a create followed by
edits stays a create; a create followed by a delete disappears entirely, because
between one Sync and the next nobody else saw it exist.

If the working tree changed but the journal is empty, somebody edited the
project outside Studio and the commit says `project.external_changes_detected`
rather than claiming nothing happened.

### The Sync sequence

`src/services/sync.ts`. Order is load-bearing:

1. Flush - and **refuse** if any write failed. Syncing memory rather than disk
   is how an administrator shares work they later cannot recover.
2. Check the project may be written at all (schema, read-only, save health).
3. Get the credential.
4. Snapshot, and write a pending-operation record.
5. Fetch - remote-tracking ref only, never the files.
6. Compare last-agreed / local / remote. Four cases:
   - **neither moved** → already synchronized;
   - **only they moved** → fast-forward, which is safe precisely because there
     is nothing here to lose;
   - **only we moved** → one commit, push;
   - **both moved** → semantic reconciliation (Phase 3).
7. Commit once, with the collapsed journal as structured actions.
8. Push, **never forced**.
9. Rejected → back to the fetch. Note that the second pass is then a genuine
   reconciliation, because we now hold a commit and so does the remote. That is
   correct, and is why losing the race can never be resolved by forcing.
10. Record the synchronized point and empty the journal **only** after the push.

Without a reconciler wired up (Phase 3), a divergence stops with
`sync.conflictsPending` and an honest message. Committing on top of a remote
whose contents were never looked at would keep the other administrator's commit
in history while silently replacing every file in it.

Two bugs the tests caught and fixed:

- there was **no path for "only they changed things"** - the common case on a
  machine that has been closed for a week. `git_fast_forward` now handles it,
  and refuses over a dirty tree or a divergence rather than checking out over
  unsaved edits;
- a clean reconciliation that had nothing quotable to say about itself reported
  as `synchronized` rather than `integrated`.

### User-facing vocabulary

`src/model/syncState.ts` holds the complete set of words the normal UI may use -
*Saved locally*, *Checking for team changes*, *Integrating changes*, *Needs your
decision*, *Synchronized*, *Offline*, *Access expired*, *Repository
unavailable*. A test asserts that no phase label and no Sync outcome message
contains `merge base`, `rebase`, `force push`, `non-fast-forward`, `detached
head`, `refspec` or the rest. That guard exists because the failure mode is
somebody writing a helpful-sounding "the push was rejected, please rebase" into
a status line six months from now.

### The credential boundary, corrected

The first cut of the Git adapter took the token as a **command argument**, which
would have required the webview to read it - undoing the whole point of removing
`secret_get` in Phase 1. `git_fetch` and `git_push` now take a GitHub *account
id*, and Rust looks the credential up itself. A test in `gitRepo.test.ts`
inspects the arguments actually sent and fails if anything credential-shaped
appears, so this cannot come back unnoticed.

---

## Phase 3 - Semantic merge and conflict resolution (complete)

### Why not Git's merge

A line-based merge of JSON writes conflict markers *into* the file. The app then
cannot parse it, so a recoverable disagreement becomes a broken project. Nothing
in this phase touches Git's merge machinery; the parsed data is merged instead.

### The engine

`src/model/merge/core.ts` - three-way primitives over parsed data:

- **`mergeValue`** - the four cases that are the whole of three-way merging:
  nobody changed it, one of you did (twice), or you both did and disagreed. Only
  the last is a question for a person.
- **`mergeObject`** - field by field, so one administrator renaming a creature
  while another adjusts its interval is *not* a conflict. This is the behaviour
  that makes most of the feature invisible.
- **`mergeList`** - **by stable id, never by position.** Merged by index, one
  administrator inserting a rule at the top pairs every later rule against the
  wrong one, and a merge that looks clean rewrites the list into nonsense.
  Ordering is normalised (base order, then this computer's additions, then
  theirs) so two people reordering is not a disagreement, and either side
  syncing first produces the same file.
- **`mergeMap`** - for the string-keyed maps (icon assignments, notes, maps of
  origin), where two administrators most often touch the same file without
  touching the same entry.

A disputed value is held at **this computer's** version, so a half-answered
merge is still a complete, valid project.

### Domain rules

`src/model/merge/domains.ts`, one entry per file. The engine knows how to merge;
what it cannot know is which key identifies a thing, what a field should be
called when somebody is asked about it, and which fields are not disagreements.

The rule behind every choice: **identity is whatever survives a rename.**

| File | Identity | Notable |
|---|---|---|
| production rules | rule id → cycle id → item id | nests three levels; different cycles of one creature never conflict |
| remaps | entry id | labelled "Old → New", never by record id |
| cosmetics | **CurseForge id**, not the record id | the same mod added on two machines is one mod, not two |
| catalog | source id; icons/notes/maps by blueprint path | `iconsDir` ignored - a machine-local path |
| watchlist | CurseForge id | `lastCheckedAt`/`latestUpdated`/`needsReview` ignored - results of a check, not decisions |
| players | player id; clean slates by **map** | a differing stored profile is a whole-value conflict, not a field merge |
| manifest | - | `projectId`, `format`, `schemaVersion`, `createdAt` held out entirely |

`history.json` and `activity.json` are **not merged**: they are this install's
record of what it did, and the shared record is the Git history. A file with no
merger raises a conflict rather than silently keeping one side.

### The conflict model

`src/model/merge/conflicts.ts`. Four kinds - `field`, `delete-vs-edit`,
`add-vs-add`, `binary` - each naming the item, the field, and both values.
Conflict ids are stable across a re-run, so a half-finished decision survives
the administrator closing the dialog and coming back.

`describeConflict` and every phase label are covered by a test asserting they
contain none of `merge base`, `rebase`, `force push`, `non-fast-forward`,
`detached head`, `refspec`.

### Reconciliation and the UI

`src/services/reconcile.ts` reads the three trees, merges file by file, and
returns a merged project plus the outstanding questions. `applyAnswers` writes a
decision back by walking the parsed structure for the item's **id** - same
reasoning as the merge: a position is not an identity.

`ConflictResolutionModal` groups by domain, shows *Was …* where a base value
helps, offers bulk "keep all of mine/theirs" past two conflicts, and disables
**Continue** until every question is answered. `syncStore` drives it; `SyncStatus`
sits in the sidebar and is the only place in the app that mentions synchronizing.

### Two bugs the tests and the browser caught

- **`integrated` vs `synchronized`** - a reconciliation that merged cleanly but
  had nothing quotable to say reported as if nothing had been brought in.
- **A stale closure in Settings** - `updateSource` read the binding captured at
  render, so two edits landing before a re-render (typing quickly across Owner
  and Repository) lost the first. Confirmed in the browser before and after.

### Verified in the browser

- `project.json` after a save contains **no** `github` and **no** `imagesDir`;
  the repository binding is in the machine-local record. The Phase 1 split works
  end to end.
- Sidebar reads *Saved locally - waiting to sync* with Sync disabled until an
  account is bound - correct, since a repository name alone is not enough.
- The conflict dialog renders all four kinds, and Continue stays disabled until
  every question is answered.

### Phase 3 test results

| Suite | Phase 2 | **Phase 3** |
|---|---|---|
| Frontend | 1096 | **1205** |
| Rust | 53 | 53 |

---

## Phase 4 - GitHub onboarding and repository binding (complete)

### The credential, once

`github_connect_account` is the **only** command that accepts a token. It is
validated against GitHub before being stored - so a mistyped token fails at the
paste, not at the first Sync - and the account id comes from GitHub rather than
from anything typed. It is filed under `github-account:<id>` and never returned.
Everything afterwards names an account id.

The setup screen states the access required and, just as prominently, the access
**not** required:

| Required | Never requested |
|---|---|
| Repository access: only select repositories | **Administration** - DinoDepot never creates or deletes repositories |
| Contents: Read and write | **Workflows** - DinoDepot never edits GitHub Actions |
| Metadata: Read-only (GitHub adds this) | |

### Identity is the numeric id

Every binding carries GitHub's immutable repository id. Verification goes through
`/repositories/{id}`, which follows renames and transfers; the by-name endpoint
only works while GitHub's redirect lasts.

| What happened | What DinoDepot does |
|---|---|
| Renamed | Follows it, rebuilds the remote URL, mentions it once |
| Transferred to another owner | Same |
| Made public (source) | Raises a blocking issue; Sync switched off |
| Permission revoked | `no-access`; affected operations off; reconnect offered |
| Deleted | `unreachable`; binding **kept**, local data untouched, reconnect offered |
| Offline | Temporary; nothing disabled permanently, no reconnect offered |

Nothing here ever clears a binding, creates a replacement, or touches the
project on disk. `assertBoundIdentity` refuses when the id that answers is not
the id the project is bound to - the guard against an opened project pointing
credentials somewhere unrelated.

### Suitability, checked before binding

A public **project** repository is refused outright: it holds the roster and the
profile backups. A private **delivery** repository is refused on the free
topology, because Pages cannot serve one. A repository the token cannot write to
is refused. A non-empty repository is a *warning* - it may well be the right one.
The Studio's own repository is refused by name.

### Pairing

`checkPairing` requires the two repositories to differ **by id**, not by name -
a name can be made to match by renaming one of them. Publishing into the source
repository would leave the private roster one directory from a public site.

### Browser-guided, not API-driven

Repository creation opens `github.com/new` pre-filled with the name and the
right visibility. Collaborators open the repository's own access settings. Both
are things the administrator does on GitHub, where they can see what they are
agreeing to - and both are why the Administration permission is never needed.

### A shared failure vocabulary

`Failure` and `classify_status` moved out of the Git module into
`commands/failure.rs`, so the HTTP layer and the Git layer produce the same
codes. Both redact credentials on construction. The 403-with-`Retry-After` case
is classified as rate limiting rather than a bad token - reading it the other
way sends an administrator off regenerating a credential that was fine.

### A Phase 1 bug these tests caught

`RepoBindingSchema` demanded a non-empty `githubId`, but the v1→v2 migration
produces a binding with **no id** - schema 1 never knew one. So a migrated
project's local record failed to parse, `loadLocalState` rebuilt it from
nothing, and the repository binding vanished silently. `githubId` now defaults
to empty, and the operations that must not act on an unverified binding check
for it explicitly. A regression test parses the migration's output through
`LocalProjectStateSchema` and asserts the migrated project cannot sync until it
has been verified once.

### Phase 4 test results

| Suite | Phase 3 | **Phase 4** |
|---|---|---|
| Frontend | 1205 | **1283** |
| Rust | 53 | **71** |

### Verified in the browser

The checklist enforces its own order - repository fields stay disabled until an
account is connected. A failed lookup renders as an issue inside the repository
card rather than a toast that scrolls away. Zero console errors on a clean tab.

---

## Phase 5 - Private data and profile sanitization (complete)

### The rule

Nothing uploads an original `.arkprofile`. `sanitizeProfile` produces a cleaned
copy or it throws - there is no third outcome, and no second upload path.

An IP address has no business in a repository even a private one: *private* is a
setting somebody can change, and a repository's history keeps what was committed
to it forever.

### Verify, don't trust

Clearing the field and assuming it worked would be one bug away from uploading
an address anyway. So the sanitized bytes are **parsed back** and checked the
way anybody receiving the file would read them:

1. Parse. Unreadable → refuse.
2. Save version in `[5, 7]` → otherwise refuse. A format nobody has looked at may
   keep the address somewhere else; uploading because the one known field
   happened to be empty would be luck, not safety.
3. Clear `SavedNetworkAddress` on a **clone**.
4. Serialize.
5. Parse the result.
6. Assert the address is gone.
7. Assert 16 identity and progression fields are unchanged - a save that comes
   back with the right field cleared and the wrong level is not a success.

Records `sanitizerVersion` (1) and both content hashes, so a project can be
re-swept when a later version learns to remove something this one did not.

### `lastKnownIp` is gone from the roster

It sat in `ProfileSummary`, which is stored beside the roster - so it travelled
into `players.json` and, once the roster synchronized, into permanent history.
The field is removed from the schema entirely. The address is now read on demand
by `readNetworkAddress` and never stored; the Player Data page no longer shows a
stored one.

### Restore checks too

A backup taken by an older build, or edited by hand, does not get to put an
address back on this disk unnoticed - and a file that will not parse is not
written over a working profile.

### Structure

`profileBackup.ts` owns upload and restore. The unsanitized `backupProfile` /
`restoreProfile` were **deleted** from `publish.ts`, which now carries a comment
saying why: a profile-shaped function next to the generic file-upload layer
would eventually be the one somebody called.

### What the tests prove

`findIpAddresses` (IPv4 plus the eight-group and `::`-compressed IPv6 forms) is
run over the uploaded profile bytes, the serialized roster, and the roster JSON
together, asserting the test address appears in none of them. Plus: both save
versions, byte-identical re-sanitizing, unreadable/truncated/empty/unknown-version
refusals, and `uploaded === []` after every refusal.

### Phase 5 test results

| Suite | Phase 4 | **Phase 5** |
|---|---|---|
| Frontend | 1283 | **1333** |
| Rust | 71 | 71 |

---

## Phase 6 - Publishing pipeline (engine complete; page not yet switched over)

### Central validation

`src/validation/project.ts` runs every existing validator and gives one answer.
Publish used to decide per output, so a project could publish its production
rules while its catalog was broken - and the viewer reads both.

Errors block; warnings are acknowledged once and then allowed. Plenty of
warnings are "this looks unusual" rather than "this is wrong", and a cluster
with an unusual setup should still be able to publish. Issues carry an `area`,
so the UI can send the administrator to the right page, and the whole list is
returned at once rather than one problem at a time.

| Blocks | Warns |
|---|---|
| schema this build cannot publish from | source with no name |
| missing project id or name | profile reference with no file behind it |
| output path escaping the repository | icon not in the images folder |
| duplicate mod in the cosmetics list | icon that is not WebP or PNG |
| duplicate source or player id | |

### The artifact

Built into a staging map, never written straight out:

```
docs/
  .nojekyll            ← without it Pages runs Jekyll, which drops _-prefixed files
  index.html
  dinodepot-build.json
  data/
```

`dinodepot-build.json` carries `projectId`, `sourceRevision`,
`publishOperationId`, `outputVersion` (1), `generatedAt` and `studioVersion`.
The output contract version is independent of both the project schema and the
Studio version, because a viewer cached in somebody's browser has to keep
working across changes to either.

### The boundary scan

Runs over the staged files, so nothing has left the machine when it fires.
Deliberately content-based rather than trusting the generator - the generator is
what would have the bug.

Catches: `.arkprofile` by name, anything under `profiles/`, `players.json`,
nine private roster fields **matched as JSON keys** (so a creature called
"accountName" in prose is not a false positive), IP addresses, Windows and UNC
paths, credentials (reported as *"a credential"*, never the value), and
temporary or `.git` files.

### One commit, replaced not merged

`git_replace_dir` empties the published folder and rewrites it, so a creature
removed from the project disappears from the site and the single commit that
follows carries additions, changes and deletions together. Generated files are
never merged: they have no authorship to reconcile, and combining two machines'
output would produce a site neither of them built. A rejected push means fetch,
take the remote wholesale, regenerate - up to three rounds.

### Pages deployment

Polled by **operation id**, not by commit: the delivery commit is known the
moment it is pushed, while "is it live" is a question only the served manifest
answers. A timeout reports `timed-out` with the commit - published is still
published, and Pages being slow is not a failure. A 404 while polling is the
normal state of a site that has never been published.

### Both topologies

`source-and-delivery` publishes to `delivery`; `single-private` publishes to
`source`. One line, because everything above operates on a staged artifact and a
binding rather than on a topology.

### Phase 6 test results

| Suite | Phase 5 | **Phase 6** |
|---|---|---|
| Frontend | 1333 | **1400** |
| Rust | 71 | **77** |

### Still missing from Phase 6

The **Publish page still calls the old one-file Contents API path**. The engine,
the validation, the scan and the atomic commit all exist and are tested, but
`PublishPage.tsx` has not been switched over to `publishPipeline`, and there is
no "Sync and Publish" button yet. Until that lands, the old behaviour - several
commits, possible partial publish - is what an administrator actually gets.

Also not done: the delivery working copy is assumed to exist at
`deliveryDir`; nothing yet clones or initialises it.

---

## Phase 7 - Git-backed activity and icon cache (models complete; pages not switched over)

### Recent Activity from Git

`activity.json` was a shared append-only array kept in the project. Two
administrators fight over that array forever, and it lies the moment anybody
edits a file outside Studio. Git already records what happened, who did it and
when - `git_log` reads that, and the structured trailers Sync writes are what
make it readable rather than a list of shas.

A commit DinoDepot did *not* write still becomes a row: somebody editing through
the GitHub web UI is a real event, and hiding it would make the list disagree
with the repository. Changes described by a newer Studio in a way this build
cannot read are **counted**, so a row never claims less happened than did.

### Restore makes a new commit

`git_restore_files` writes an older version's files into the working tree and
leaves history alone. The next Sync commits that as an ordinary change. It never
resets or rewrites, because the history is shared and somebody may already have
pulled it - so the wording is *"Went back to the project as it was on…"*, which
is true, rather than pretending the intervening week never happened.

Not offered for the current version (nothing to do) or for a Publish commit
(that lives in the delivery repository, which is regenerated).

### The icon cache

Project icons load from the synchronized checkout and need none of this. This
cache is only for remote previews/legacy URLs; exact official and modpack icons
now load from their managed package roots.

- **Content-addressed**, by Git blob SHA where the registry publishes one. A
  changed image means a changed key, so a stale hit is impossible.
- **WebP preferred, PNG accepted**, checked by magic bytes. This folder is
  reachable through the asset protocol, so it must not hold arbitrary types.
- **ETag conditional requests.** A 304 transfers nothing and refreshes the
  copy's place in the eviction order.
- **Offline reads.** A cached icon works with no network; without one the icon
  falls back to its emoji rather than failing.
- **64 MB, least-recently-used**, evicting the ETag alongside its icon.
- **Self-repairing.** A truncated or mislabeled file reads as a miss and is
  deleted, so a half-written download from a previous session fixes itself
  rather than rendering broken forever.
- **Clearable**, always safe - everything in it is re-fetchable.

Deliberately not Git LFS and not a custom asset service: these are small WebP
or PNG files, and the cheapest correct thing is a folder with a size limit.

### A real bug the tests caught

`resolveIcon` checked its in-flight map *after* awaiting the cache lookup, so
simultaneous callers all slipped past before any registered - which is exactly
the case it exists for, a page rendering forty icons at once. The check now
happens before anything is awaited.

### Phase 7 test results

| Suite | Phase 6 | **Phase 7** |
|---|---|---|
| Frontend | 1400 | **1439** |
| Rust | 77 | **92** |

### Still missing from Phase 7

`OverviewPage` still reads `activity.json` through `useProjectOverview`; it has
not been switched to `buildHistory`. No restore button is wired up, and nothing
calls the icon cache yet - `EntityIcon` still resolves only local files. The
models and the Rust commands are complete and tested.

---

## Phase 8 - Release, CI, and signed updater (complete)

### Version centralization

Four files state the version. `scripts/check-versions.mjs` enforces that they
agree, and `--set <version>` writes all four at once. CI runs the check on every
push; the release workflow additionally checks that the **tag** matches, because
a build tagged `v0.3.0` shipping an installer that calls itself `0.2.0` would
offer every install the same "update" forever.

### CI

`.github/workflows/ci.yml`, Windows only - running the suite anywhere else would
prove something about a build nobody ships. Version check, `tsc --noEmit`,
frontend tests, Rust tests, production build.

### Release

`.github/workflows/release.yml`, triggered by a `v*.*.*` tag. A release is a
decision, not something that happens because somebody merged.

Publishes a **draft** carrying three assets: the NSIS installer - which under
`createUpdaterArtifacts: true` is itself the updater artifact, not a separate
`.nsis.zip` - its detached `.sig`, and `latest.json`. `latest.json` is written
by `tauri-action` from that same signature, so the manifest and the file it
describes cannot disagree.
Publishing the draft is what makes every install in the world see it, and that
should take a click from somebody who looked.

A separate job fails loudly when `TAURI_SIGNING_PRIVATE_KEY` is unset, rather
than silently shipping an unsigned build no existing install would accept.

### The updater

`tauri-plugin-updater`, `createUpdaterArtifacts: true`, endpoint at
`releases/latest/download/latest.json`.

On top of the plugin's signature check, `appUpdate.ts` adds two rules:

- **Never a downgrade.** The plugin refuses same-version updates but not older
  ones; a mistagged release would otherwise roll every install backwards. An
  unparseable version is refused rather than guessed at.
- **Never silent.** The administrator sees the version and says go. This app
  holds a cluster's configuration; restarting it mid-edit is not a decision to
  make on their behalf.

A signature failure says so plainly and sends the administrator to the releases
page - it means the file on the release is not one this build will trust, which
is either a broken upload or something worse.

### Documentation

`docs/release.md` covers key generation, the two GitHub secrets, cutting a
release, and what to do about a bad one (cut a new version forwards; never
delete or retag, because installs may already have it).

It opens by separating the two kinds of signing, because the confusion is
expensive:

| | Updater signing | Windows Authenticode |
|---|---|---|
| Protects | that an *update* came from you | that the *installer* came from you |
| Checked by | DinoDepot Studio | Windows SmartScreen |
| Key | generated free, by you | certificate bought from a CA |
| Required | **yes** - without it updates are refused | no, SmartScreen just warns |

### The key

Generated by the maintainer and backed up. The public half is merged into
`src-tauri/tauri.conf.json` (PR #3), so `pubkey` no longer carries a
placeholder, and `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are both set as Actions secrets.

The private half never entered this repository or this codebase - generating it
is a manual step on the maintainer's machine, documented in `docs/release.md`,
because it signs anything every install will run.

What that public key now fixes is the identity of every future update: an
install checks signatures against the key compiled into its own binary, so
swapping it and signing with a new private key strands every install already in
the field - their update checks fail verification and stay failed. Rotation is
possible only through a planned migration. A transition release signed with the
*old* key can carry the new public key across, but it helps only installations
that actually receive it; with the current static `latest.json` endpoint,
clients that miss the bridge can still be stranded by later new-key-only
releases. `docs/release.md` records the constraints. Treat it as a break, not a
maintenance task.

### Phase 8 test results

| Suite | Phase 7 | **Phase 8** |
|---|---|---|
| Frontend | 1439 | **1456** |
| Rust | 92 | 92 |

### Still missing from Phase 8

No update UI is wired up - `appUpdate.ts` is complete and tested, but nothing
calls `checkForUpdate`. Neither workflow has been run, because that needs a
push to GitHub.

---

## The last mile (complete)

The engines were finished and tested phase by phase; this closed the gap between
them and the pages.

### Change descriptions come from a diff, not a promise

`recordChange` is called from the **store setters**, not from the call sites.
Asking every place that edits a creature to describe its own change is a promise
nobody keeps - the twentieth one forgets, and the commit silently degrades to
"files changed". `changeDetection.ts` diffs before against after, by stable id,
in the one place every edit already passes through.

Verified in the browser: three edits to one creature collapse to a single
"Added creature Rex_Character_BP" with the subject "Updated creature
configuration".

### Publish All is gone

`PublishSiteCard` replaces it - one button, one commit, the whole generated tree,
with **Sync and publish** as the primary action. The old modal published each
output separately, so a failure halfway through left a site that was half last
week's. Validation errors and warnings are shown in place, grouped by area, and
warnings need one deliberate acknowledgement.

`delivery_dir` gives each project a working copy of its delivery repository in
application data - not beside the project, because it is generated output nobody
should be editing and a second repository inside the project folder would make
the project's own repository try to track it.

### Recent Activity reads Git

`historyStore` + the rewritten `RecentActivity`. Rows carry the commit subject
and the decoded actions; commits DinoDepot did not write are marked *outside
Studio* rather than hidden. **Go back to this** restores an older version into
the working tree and stops - the next Sync commits it as an ordinary change.

A project with no repository behind it now reads *"Nothing shared yet"* rather
than reporting an error, because that is the normal state of a new one.

### A CSP bug from Phase 1

The Content Security Policy set in Phase 1 blocks remote `img-src`, so **https
icons could not load in the desktop app at all** - the cache turned out to be
the fix rather than an optimisation. `icon_fetch` pulls the bytes in Rust
(HTTPS only, WebP/PNG verified before it is handed back), the cache stores them, and
`useRemoteIcon` serves them through the asset protocol. Icons now work offline
as a side effect.

`useIconSrc` deliberately no longer returns a remote URL: handing one back would
render a broken image.

### Keep both

Implemented for `add-vs-add` - two administrators adding different things that
collided on an id. *Theirs* is re-identified, never mine, so the ids on this
computer stay stable and nothing referring to them breaks. The new id is derived
from the original rather than random, because a merge that is not deterministic
shows a change on every sync. Not offered for a `binary` conflict: one profile
per player means "both" would need a second player record, which is a decision
about the roster rather than a merge.

### Signed updates

`UpdateBanner` in the sidebar. Checks once at start - not on a timer, because an
update arriving mid-session can wait for the next launch. Flushes the project
and the journal before installing, since installing restarts the application.

### Final test results

| Suite | Phase 8 | **Last mile** |
|---|---|---|
| Frontend | 1456 | **1487** |
| Rust | 92 | 92 |

---

## Still outstanding

The signing setup is finished: the key pair is generated and backed up, the
public key is merged (PR #3), and both Actions secrets are configured.

What remains is verification, and it is one item:

- **The Release workflow has never run.** CI (`ci.yml`) runs on pull requests
  and passes - version check, `tsc`, frontend tests, Rust tests, production
  build. But `release.yml` fires only on a `v*.*.*` tag, and no tag has been
  pushed, so nothing has yet exercised `tauri-action`, signing inside the
  runner, the draft release, or the generation and upload of `latest.json`.

  A local `npm run tauri build` has produced a signed installer and its `.sig`
  on the maintainer's machine. That is evidence about the bundler and the key.
  It is not evidence about the workflow, which runs on a different machine with
  the key arriving through a secret.

The first tagged release is therefore also the first test of the release path,
and should be watched rather than assumed.
