# Manual test matrix

The automated suite runs frontend tests, Rust tests, type checks, and a
production build on every pull request. None of it proves the thing that
actually matters here: that two
people on two machines can edit one cluster's configuration all week without
losing work or leaking a player's address.

That needs real installs, real repositories, and in places two computers. This
document is the list.

## How to use this

Work top to bottom. Later sections assume the earlier ones passed - there is no
point testing conflict resolution if a single machine cannot save a file.

Each test states what it *proves*, not just what to click, because a test whose
purpose is unclear gets "fixed" by loosening it. Where a failure has a
recognisable shape, it is written down under **Fails as**, so a real failure is
not mistaken for a slow network.

Record for each: pass / fail / blocked, the build tested, the date, and for a
failure the exact message shown. "It didn't work" six weeks later is not
actionable.

> **Use throwaway repositories and a throwaway project.** Several tests
> deliberately corrupt files, force conflicts, and publish. None of it should
> happen to the live GG Fizz cluster configuration. Make a private test source
> repository and a test site repository, and copy a project into it.

---

## 0. Before starting

| | |
|---|---|
| **0.1** | Two Windows machines, or one machine and one Windows VM. Several tests cannot be faked with two folders - they need two installs, two locks and two clocks. |
| **0.2** | Two GitHub accounts, or one account and one collaborator, so "somebody else changed it" is genuinely somebody else. |
| **0.3** | A fine-grained PAT per administrator: **Metadata read**, **Contents read/write**, on the test repositories only. No Administration, no Workflows. |
| **0.4** | A private test **source** repository and a separate test **site** repository. |
| **0.5** | A test project with a handful of production rules, a few remaps, a cosmetics list, and at least two players - enough that a merge has something to merge. |
| **0.6** | At least one real `.arkprofile` that still contains a network address. The privacy tests are meaningless against a file that never had one. |

---

## A. Single machine - functional

Everything here is one install, one administrator. If any of it fails, stop.

### A1 - A new project reaches a repository

**Proves** the onboarding path works end to end for somebody who has never used
the app.

1. Fresh install, no stored credentials. Settings → connect a GitHub account,
   paste the PAT.
2. Confirm the account shows as connected and the token is **not** displayed
   back anywhere.
3. Bind the project to the test source repository.
4. Make one edit. Sync.

**Expect** the repository receives a commit; status returns to
**Synchronized**.

**Fails as** a status stuck on *Cannot sync yet* with no stated reason, or any
screen showing the token after it was saved.

### A2 - The credential never reaches the web layer

**Proves** the boundary the whole design rests on: the frontend may learn a
credential exists, never what it is.

1. With an account connected, open the developer tools console.
2. Search the app's own storage - `localStorage`, `sessionStorage`, IndexedDB -
   for the token.
3. Trigger a sync and watch the network and IPC traffic.

**Expect** the token appears nowhere. Rust looks it up from Windows Credential
Manager by account id; there is no command that returns it.

**Fails as** any occurrence of the token string. Treat a single hit as a
release blocker, not a bug to schedule.

### A3 - Edits survive a restart

1. Edit a production rule. Do **not** sync.
2. Close the app. Reopen it.

**Expect** the edit is there, and status says **Local changes** - it knows the
work has not been shared.

### A4 - Two instances cannot fight over one project

**Proves** the advisory lock. Two instances autosaving one folder is a
lost-work problem, not a merge problem.

1. Open the project. Leave it open.
2. Start a second instance on the same machine, open the same project.

**Expect** the second refuses, and names what holds it - machine and instance,
not just "locked".

**Fails as** the second instance opening happily. Both then hold the project in
memory and the last debounce to fire wins the file outright.

### A5 - A stale lock does not strand the project

1. With the project open, kill the app (Task Manager, End Task).
2. Reopen.

**Expect** it opens - the lock is recognised as its own and stale. It must not
require deleting a file by hand.

### A6 - Every editor page round-trips

For each of Production Rules, Remaps, Content Sources, Cosmetics, Player Data,
Simulator: make one change, save, sync, close, reopen.

**Expect** the value survives, and the generated output files under
`dinodepot/` match what the page shows.

### A7 - Recent Activity reads as English

**Proves** the structured commit trailers are doing their job.

1. Make three different kinds of change across three syncs.
2. Open Overview → Recent Activity.

**Expect** one readable line per change - what changed, who, when. Shas only
under advanced details.

**Fails as** raw commit subjects, or an entry counted as *undescribed* for a
change this build wrote itself.

### A8 - No Git vocabulary reaches the normal UI

Walk the app with the source repository **renamed** on GitHub so every sync
fails.

**Expect** plain statements: *Repository unavailable*, *Access expired*. Words
like push, pull, rebase, fast-forward, HEAD, detached, merge conflict must
appear only behind **Show advanced details**.

---

## B. Single machine - recovery

The tests nobody runs until the day they need them.

### B1 - A corrupted project file is quarantined, not eaten

1. Close the app. Open `players.json` in a text editor and truncate it
   mid-object. Save.
2. Open the project.

**Expect** the app reports the file as damaged and moves it to the project's
`recovery/` folder with a timestamped name. The original bytes are still there
to inspect.

**Fails as** a silent rebuild from nothing - that is a roster deleted without
anybody being told.

### B2 - A damaged file can be restored from history

1. After B1, use the restore path to bring the file back from the repository.

**Expect** the roster returns as it was at the last sync.

### B3 - An interrupted sync leaves a recoverable state

1. Start a sync on a large change and kill the app mid-operation, or pull the
   network cable at the moment it sends.
2. Reopen.

**Expect** the app notices the incomplete operation, and either finishes it or
reports what was left. Nothing on disk is half-written.

### B4 - A project from an older schema migrates

1. Take a project written by an older build (schema v1 or v2).
2. Open it in this build.

**Expect** it migrates through each adjacent step to v3, keeps its repository
binding and materialized content, and says what it did. Sources that already
carry an exact modpack ID and version become materialized exact dependencies;
their existing content remains the offline fallback. In particular the binding
must survive - an empty `githubId` on a migrated project must not silently
discard the repository connection.

### B5 - A project from a *newer* schema is refused

1. Hand-edit a project's schema version to one higher than this build knows.
2. Open it.

**Expect** a clear refusal. It must not open and quietly drop fields it does
not understand.

---

## C. Two machines - synchronization and conflict

The heart of it. Machine **A** and machine **B**, two accounts, one repository.

### C1 - Straight handoff

1. A edits a rule, syncs.
2. B syncs.

**Expect** B has A's change, without being asked anything.

### C2 - Both edited, different things

1. Both A and B start from the same state.
2. A edits rule X. B edits rule Y. Neither syncs yet.
3. A syncs. Then B syncs.

**Expect** B ends with both changes, and is asked nothing. This is the case
that must never become a conflict - it is the ordinary week.

### C3 - Both edited the same thing

1. A and B both edit **the same field of the same rule** to different values.
2. A syncs. B syncs.

**Expect** B is told a decision is needed, sees both values side by side in
plain language, and picks. Status reads **Needs your decision**.

**Fails as** a merge that silently keeps one side, or any resolution screen
showing conflict markers or diff hunks.

### C4 - Both added something new

1. A adds a creature. B adds a *different* creature with the same name.
2. Sync both.

**Expect** the add-vs-add case offers **Keep both** - B's is added alongside
A's - as well as choosing one.

### C5 - Bulk resolution

With several conflicts pending, use **Keep all of mine** and **Keep all of
theirs**.

**Expect** they apply to every pending conflict, and the result is what was
chosen - verified by reopening on the other machine.

### C6 - Identity survives a rename

**Proves** merging is by stable id, never by name or position.

1. A renames a rule. B edits that same rule's values.
2. Sync both.

**Expect** one rule, renamed, with B's values. Not two rules, and not a
conflict.

### C7 - Reordering is not a change

1. A reorders the rule list. B edits an unrelated rule.
2. Sync both.

**Expect** no conflict.

### C8 - Only they changed things

1. B makes no local edits. A syncs several changes.
2. B syncs.

**Expect** B fast-forwards silently and reports **Synchronized** - not
*integrated*, since B integrated nothing.

### C9 - An outside edit is handled

1. Edit a file directly on GitHub's web interface.
2. Sync from A.

**Expect** the change is integrated and appears in Recent Activity marked as
not written by Studio.

### C10 - Offline, then back

1. Disconnect A's network. Make edits. Observe status.
2. Reconnect. Sync.

**Expect** **Offline** while disconnected, edits kept locally, and a clean sync
on reconnection. No lost edits, no duplicate commits.

### C11 - Expired access

1. Revoke A's PAT on GitHub.
2. Sync.

**Expect** **Access expired**, pointing at reconnecting the account. Not a
generic failure, and not the token in the error text.

---

## D. Privacy

The tests that decide whether this app is safe to point at a real cluster.
**A single failure here blocks release.**

### D1 - An address never reaches the repository

1. Import a `.arkprofile` that contains a real `SavedNetworkAddress`.
2. Back it up. Sync.
3. Clone the source repository fresh and search the *bytes* of the stored
   profile for the address.

**Expect** absent. Search the raw file, not the app's rendering of it.

### D2 - The local file is untouched

After D1, check the profile still on disk.

**Expect** it still contains the address. Sanitizing is for what leaves the
machine; the administrator's own copy stays complete.

### D3 - The roster carries no address

Search `dinodepot/players.json` in the clone for the address, and for any
IP-shaped string.

**Expect** none. The summary schema has no field for one and drops it if fed.

### D4 - A profile that cannot be cleaned is not uploaded

1. Corrupt a `.arkprofile` so it will not parse.
2. Attempt a backup.

**Expect** a refusal naming the player, and **nothing uploaded**. Skipping a
player is the administrator's decision; uploading raw bytes is never the
fallback.

### D5 - Restore checks on the way in

1. Hand-edit a backed-up profile in the repository to put an address back.
2. Restore it.

**Expect** refusal. A backup taken by an older build does not get to put an
address on this disk unnoticed.

### D6 - The whole repository is clean

With everything synced, clone the source repository and search all of it for:
the test address, any IP-shaped string, the PAT, and the word `token`.

**Expect** nothing.

---

## E. Publishing

### E1 - A publish produces the expected tree

Publish to the test site repository.

**Expect** under `docs/`: `.nojekyll`, `index.html`,
`dinodepot-build.json`, `data/`, `assets/icons/`. Nothing else.

### E2 - The public boundary holds

Search the entire published `docs/` tree for: any player's real name, any IP
address, the roster file, and any `.arkprofile`.

**Expect** nothing. The site is world-readable forever once pushed; this is the
test that matters.

### E3 - The build manifest points home

Open `dinodepot-build.json`.

**Expect** a `sourceRevision` that matches an actual commit in the source
repository, a unique `publishOperationId`, the output version, and the Studio
version that built it.

### E4 - The site renders

Enable Pages on the test site repository, serving `main:/docs`. Open the URL.

**Expect** the viewer loads, creature icons appear, and the data shown matches
the project. Check the browser console for blocked requests - the page must not
depend on anything it cannot fetch.

### E5 - Republishing is clean

Change one rule and publish again.

**Expect** one new commit, the change visible, no orphaned files left from the
previous publish, and a new `publishOperationId`.

### E6 - Publishing is refused when it should be

Try to publish with no site repository bound, and with a revoked token.

**Expect** a clear refusal in each case, and nothing partially written.

---

## F. The updater

This section needs two fresh test versions: `<baseline>` installed locally and
`<candidate>` published as the newer release.

> **Order matters.** Install `<baseline>` first. The endpoint is
> `releases/latest/download/latest.json`, so once `<candidate>` is
> published it becomes what an install is offered. Installing the baseline
> after that still works, but you lose the chance to see *Up to date* behave
> correctly first.

### F1 - Baseline installs

1. On a clean machine, download and run the `<baseline>` installer.
2. Expect a SmartScreen "unknown publisher" prompt - the installer is
   updater-signed but not Authenticode-signed. **This is the known, accepted
   state, not a defect.** Choose *More info* → *Run anyway*.
3. Launch. Confirm Help/About or the title reports `<baseline>`.

### F2 - Up to date, when it is

With `<baseline>` still the latest release, check for updates.

**Expect** **Up to date**. Nothing offered, nothing downloaded.

### F3 - An update is offered, never silently

With `<candidate>` published, check for updates from the baseline install.

**Expect** the banner names the version and waits. Nothing installs on its own,
and nothing restarts without being told to.

### F4 - Update and restart

Accept the update.

**Expect** it downloads, installs, and relaunches into `<candidate>`. The project
opens afterwards with its settings, its repository binding and its account
still in place - an update that loses the binding is a failed update.

Confirm the new **app icon** is what Windows shows in the taskbar, the Start
menu and the window.

### F5 - Signature rejection

**Proves** the only thing making an update trustworthy.

1. On a copy, edit the `latest.json` the install will fetch, or stand up a
   local endpoint, so the download is a build **not signed by the real key** -
   or leave the signature field intact but corrupt one byte of the installer it
   points at.
2. Check for updates and accept.

**Expect** refusal with a verification failure. Nothing is run.

**Fails as** the update installing. That is a total failure of the update
security model and blocks any further release.

> Do this against a *test* endpoint or a copied install. Do not modify the
> published candidate release. Published releases are immutable and are what
> real installs receive.

### F6 - Downgrade prevention

1. On the candidate install, point the check at a manifest advertising the
   baseline version.
2. Check for updates.

**Expect** refusal. The plugin declines same-version updates but not older
ones; the extra rule in `appUpdate.ts` is what stops a mistagged release
rolling everybody backwards.

### F7 - The endpoint itself

Fetch `https://github.com/CaotcAftermth/DinoDepot-Studio/releases/latest/download/latest.json`
in a browser.

**Expect** HTTP 200, the newest published version, platform `windows-x86_64`, a
URL resolving to that release's installer, and a populated signature.

---

## G. Project repositories and administrators

### G1 - A second administrator can be added

Give the second account access to the test source repository, have them create
their own PAT and connect it on their own machine.

**Expect** they can open, edit and sync. No credential is shared between the
two people at any point.

### G2 - Least privilege actually suffices

Confirm the PAT has only Metadata read and Contents read/write.

**Expect** every normal operation works. If anything demands more, that is a
finding - record exactly which operation and what it asked for rather than
widening the token.

### G3 - Removing an administrator

Revoke the second account's repository access.

**Expect** their next sync reports **Access expired** or **Repository
unavailable**, their local project still opens and their work is still on their
disk.

## H. Managed icons and exact content packages

### H1 - No icon folder setup

Create or open a project without configuring any image path. Open Content
Sources and Settings.

**Expect** there is no official/modpack icon-folder picker. The project records
an exact `official-asa` dependency. Artwork renders only when the rights
registry marks that exact asset eligible; every other entry uses a bundled
placeholder.

### H2 - Missing artwork does not block a mod

Import a compatibility pack whose data references one absent image, or use
Discovery and choose **Add without pack**.

**Expect** the mod and all discovered content are added. The missing assignment
is omitted, its entry displays the default icon, and the success message reports
the fallback rather than an installation failure.

### H3 - Registry artwork is verified

Prepare an approved WebP, then test a wrong hash, wrong dimensions, malformed
bytes, and a withdrawn registry entry.

**Expect** only the approved 160x160 WebP with the matching SHA-256 displays.
Every invalid or withdrawn case purges the cache entry and uses a placeholder.

### H4 - Published versions remain immutable

Open projects pinned to two different versions of the same package on one
machine.

**Expect** both versions coexist. Neither project silently changes its exact
dependency.

### H5 - Content-addressed package versions reuse bytes

Install two format-3 compatibility package versions that reference at least
one identical image,
then inspect `%APPDATA%/com.ggfizz.dinodepotstudio/content/`.

**Expect** each version retains its logical `assets/...` path, both render
offline, and only one verified image exists below `blobs/sha256/`. A filesystem
that supports hard links does not allocate a second copy for either logical
path. V2 package folders continue to render without conversion.

### H6 - Compatibility imports do not populate project images

Add the same compatibility `modpack.json` through the registry, a pasted HTTPS link,
and a local file. Test once with complete icons and once with one missing icon.

**Expect** valid icons render from the managed package library and repeated
bytes reuse `content/blobs/sha256/`. `<project>/images` is not created or
modified. Missing icons use the default glyph, and existing custom project
images remain untouched.

---

## What a pass means

All of A through H passing means the release is sound for the cluster it was
built for. It does not mean the app is finished, and it does not cover
Authenticode - the SmartScreen prompt in F1 is deliberate and deferred, not a
defect to be reported here.
