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

### 1. Generate the updater key pair

On the maintainer's machine, once, ever:

```bash
npm run tauri signer generate -- -w dinodepot-updater.key
```

It writes two things and prints the public half:

- `dinodepot-updater.key` — the **private** key
- `dinodepot-updater.key.pub` — the public key

You are asked for a password. Use one, and keep it — the workflow needs it.

> **The private key is the whole security model.** Anybody holding it can sign
> an update that every DinoDepot Studio install in the world will accept and
> run. Treat it exactly as you would a signing certificate: it never goes in the
> repository, never in a chat message, never in a screenshot.
>
> `.gitignore` already excludes `*.key`, but do not rely on that — keep it
> outside the repository folder entirely.

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

The placeholder is currently `REPLACE_WITH_UPDATER_PUBLIC_KEY`. Until it is
replaced, the app builds and runs, but **update checks will fail** — which is
the safe way round.

### 3. Add the GitHub Actions secrets

In the repository, under *Settings → Secrets and variables → Actions*:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the whole contents of `dinodepot-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password from step 1 |

`GITHUB_TOKEN` is provided by Actions; nothing to add.

### 4. Keep a backup of the private key

Losing it means no existing install can ever be updated again — you would have
to ship a new public key, which every user would have to install by hand.
Keep an offline copy somewhere you would keep a password.

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

6. Look at the draft. It should carry:

   - `DinoDepot Studio_0.3.0_x64-setup.exe` — the installer
   - `DinoDepot Studio_0.3.0_x64-setup.nsis.zip` — the updater artifact
   - `DinoDepot Studio_0.3.0_x64-setup.nsis.zip.sig` — the signature
   - `latest.json` — the manifest the updater reads

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
