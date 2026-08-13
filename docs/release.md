# Releasing DinoDepot Studio

Windows 10/11 x64 is the only supported platform for release one.

Everything here is done by a person, deliberately. Nothing in this document is
automated by the application, and the private signing key never touches the
repository.

---

## Two kinds of signing, and they are not the same thing

These get confused, and the confusion is expensive.

| | Tauri updater signing | Windows Authenticode |
|---|---|---|
| **What it protects** | that an *update* came from you | that the *installer* came from you |
| **Who checks it** | DinoDepot Studio, before installing an update | Windows SmartScreen, when the installer is run |
| **Key** | a key pair you generate yourself, free | a code-signing certificate bought from a CA |
| **If missing** | updates fail to verify and are refused | SmartScreen warns on first download |
| **Set up below** | yes | no — see the note at the end |

Updater signing is **required**: without it every existing install refuses the
update. Authenticode is optional and costs money.

---

## One-time setup

**This section is done.** The key pair exists, the public half is in the app,
and both Actions secrets are set. It is kept as the record of how, and as the
instructions for the one situation that would need it again — a lost or
compromised private key. Read the warning in step 1 before acting on any of it.

### 1. Generate the updater key pair

On the maintainer's machine, once, ever. In PowerShell, from the repository
root:

```powershell
$keyPath = Join-Path $env:USERPROFILE ".tauri\dinodepot-updater.key"
& ".\node_modules\.bin\tauri.cmd" signer generate --write-keys "$keyPath"
```

The binary is invoked directly because `npm run tauri signer generate -- -w …`
does not work on this setup — npm mangles the argument handoff and the command
fails before the generator runs.

It writes two files and prints the public half:

- `%USERPROFILE%\.tauri\dinodepot-updater.key` — the **private** key
- `%USERPROFILE%\.tauri\dinodepot-updater.key.pub` — the public key

Note the path: `~\.tauri\`, outside the repository entirely, so no `.gitignore`
rule has to be right for the private key to stay out of Git.

You are asked for a password. Use one, and keep it — the workflow needs it.

> **Do not run this again.** A new key pair is a *different* key pair. Every
> install already carrying the current public key would refuse every update
> signed by the new one, permanently and silently, and the only fix is for each
> user to download and run a fresh installer by hand. Rotate only if the private
> key is lost or believed to have leaked, and expect that cost.

> **The private key is the whole security model.** Anybody holding it can sign
> an update that every DinoDepot Studio install in the world will accept and
> run. Treat it exactly as you would a signing certificate: it never goes in the
> repository, never in a chat message, never in a screenshot.
>
> `.gitignore` excludes `*.key`, but do not rely on that — keeping the key
> outside the repository folder is what actually protects it.

### 2. Put the public key in the app

Copy the contents of `dinodepot-updater.key.pub` into
`src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "pubkey": "PASTE_THE_PUBLIC_KEY_HERE"
  }
}
```

It ships in the binary, which is the point — the running app uses it to check
that an update was signed by the matching private key.

**Done.** The real public key was merged in
[#3](https://github.com/CaotcAftermth/DinoDepot-Studio/pull/3); `pubkey` no
longer holds a placeholder. Changing that value is the same decision as
regenerating the key pair — see the warning above — because an install checks
updates against whatever public key its own binary was built with.

### 3. Add the GitHub Actions secrets

In the repository, under *Settings → Secrets and variables → Actions*:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the whole contents of `dinodepot-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password from step 1 |

`GITHUB_TOKEN` is provided by Actions; nothing to add.

**Done.** Both secrets are configured. Neither has been exercised yet — the
Release workflow has not run (see *What has and has not been proven* below).

### 4. Keep a backup of the private key

Losing it means no existing install can ever be updated again — you would have
to ship a new public key, which every user would have to install by hand.
Keep an offline copy somewhere you would keep a password.

**Done.** The key is backed up.

---

## What has and has not been proven

Two workflows, and only one of them has ever run. Worth being precise about,
because the setup above being finished does not mean the release path works.

| | Trigger | Status |
|---|---|---|
| `ci.yml` | pull request, push | **Run, and passing.** Version check, `tsc`, frontend tests, Rust tests, production build all green on merged PRs. |
| `release.yml` | `v*.*.*` tag | **Never run.** No tag has been pushed. |

So what is currently unverified is everything CI does not touch: `tauri-action`
itself, signing in the runner with the secrets, whether the draft release is
created with the assets step 6 expects, and whether `latest.json` is generated
and uploaded. A local `npm run tauri build` has produced a signed installer on
the maintainer's machine, which is evidence about the bundler and the key — not
about the workflow.

Expect to have to look hard at the first tagged run.

---

## Cutting a release

1. Decide the version. SemVer: patch for fixes, minor for features, major for a
   change that breaks projects.

2. Set it everywhere at once:

   ```bash
   node scripts/check-versions.mjs --set 0.3.0
   ```

   That writes `package.json`, `src-tauri/Cargo.toml`,
   `src-tauri/tauri.conf.json` and `STUDIO_VERSION` in `src/model/studio.ts`.

3. Check it agrees:

   ```bash
   node scripts/check-versions.mjs
   ```

4. Commit, then tag with a leading `v`:

   ```bash
   git commit -am "Release 0.3.0"
   git tag v0.3.0
   git push origin main --tags
   ```

5. The **Release** workflow runs. It re-checks the versions *and* that the tag
   matches, runs the whole suite, builds on Windows, signs, and opens a **draft**
   release.

6. Look at the draft. It should carry exactly three assets:

   - `DinoDepot Studio_0.3.0_x64-setup.exe` — the installer, which is also the
     updater artifact; they are the same file
   - `DinoDepot Studio_0.3.0_x64-setup.exe.sig` — its detached signature
   - `latest.json` — the manifest the updater reads

   **There is no `.nsis.zip`.** With `createUpdaterArtifacts: true`, Tauri v2
   signs the installer itself, and what the updater downloads *is* the
   installer. The zipped artifact and its `.nsis.zip.sig` belong to
   `createUpdaterArtifacts: "v1Compatible"`, which exists so that installs made
   by Tauri v1 can still be updated. This project has never shipped a v1 build,
   so that mode is not set and should not be — turning it on would change the
   asset names for no one's benefit.

   **`latest.json` is generated by `tauri-action`, not by the bundler.** After
   the build, the action reads the version, the release's asset URL and the
   `.sig` file the bundler just produced, and writes the manifest from them —
   which is why `uploadUpdaterJson: true` is set in the workflow, and why the
   manifest and the file it describes cannot disagree. Nothing writes
   `latest.json` locally, so a local `npm run tauri build` produces the
   installer and the `.sig` and nothing more. That is the expected local
   result, not a missing step.

7. Publish the draft. Existing installs are offered the update from that moment.

The draft step is deliberate: publishing is what makes every install in the
world see it, and that should take a click from somebody who looked.

---

## What the updater does

`tauri.conf.json` points at:

```
https://github.com/CaotcAftermth/DinoDepot-Studio/releases/latest/download/latest.json
```

`latest/download/…` always resolves to the newest **published** release, which
is why the draft step matters.

The application then:

1. fetches `latest.json`;
2. verifies its signature against the built-in public key — an unsigned or
   wrongly-signed update is **refused**, never installed;
3. refuses anything that is not strictly newer than the running version, so a
   mistagged release cannot roll everybody backwards;
4. shows the administrator the version and waits for them to say go;
5. downloads, installs, and relaunches.

No step is silent, and there is no automatic install.

---

## Rolling a release back

Do not delete the release or retag. Existing installs may already have it.

Cut a **new** version with the fix. That is the only mechanism the updater has,
and it is the honest one — going forwards to something known-good rather than
pretending the bad version never happened.

If the bad release is actively harmful, un-publish it back to draft first: the
`latest/download` URL then resolves to the previous release, and installs that
have not updated yet stop being offered it.

---

## Windows Authenticode (optional, not set up)

Without it, Windows SmartScreen shows a warning the first time somebody runs the
installer. It does not affect updates — those are covered by the updater
signature above.

To add it later you need a code-signing certificate from a CA (an EV
certificate clears SmartScreen immediately; an OV one builds reputation over
time), then Tauri's `bundle.windows.certificateThumbprint` plus the certificate
in the runner. That is a separate purchase and a separate key, and none of it is
configured here.
