# DinoDepot Feedback API

Turns reports from DinoDepot Studio into GitHub issues.

It exists so the desktop application never holds a credential. The app sends a
report over HTTPS with no authentication of any kind; this service
authenticates to GitHub as a GitHub App using a key that never leaves it.

The architecture, the diagnostics allowlist and the security model are
documented in [`docs/architecture/feedback.md`](../../docs/architecture/feedback.md).
This file is the deployment guide.

---

## What you need

- A GitHub account that can create a GitHub App in the `CaotcAftermth`
  organisation (or wherever the Studio repository lives).
- A Cloudflare account on the free plan. Nothing here needs a paid feature
  except the optional attachment bucket.
- Node 22 and `npx`.

Total setup is about fifteen minutes, most of it waiting for GitHub's forms.

---

## 1. Create the GitHub App

**Settings → Developer settings → GitHub Apps → New GitHub App**

| Field | Value |
| --- | --- |
| Name | `DinoDepot Feedback` (must be unique across GitHub) |
| Homepage URL | `https://github.com/CaotcAftermth/DinoDepot-Studio` |
| Webhook | **Uncheck Active.** This service is never called by GitHub. |

**Repository permissions** — exactly two, and no more:

| Permission | Access |
| --- | --- |
| Issues | Read and write |
| Metadata | Read-only (GitHub adds this automatically) |

Leave every other permission at *No access*. In particular **not** Contents:
this service files issues and does nothing else, and a key that could also push
code is a key worth stealing.

Under **Where can this GitHub App be installed?** choose *Only on this account*.

Create it, then note the **App ID** from the top of the page.

### Generate a private key

On the same page: **Private keys → Generate a private key**. A `.pem` file
downloads. It is shown once.

Both PKCS#1 (`BEGIN RSA PRIVATE KEY`, which is what GitHub gives you) and
PKCS#8 (`BEGIN PRIVATE KEY`) are accepted — no conversion needed.

### Install it

**Install App** in the left sidebar → your account → **Only select
repositories** → `DinoDepot-Studio` → Install.

The URL you land on ends in the **installation id**:

```text
https://github.com/settings/installations/87654321
                                          ^^^^^^^^
```

---

## 2. Deploy

```bash
cd services/feedback-api
npm install          # wrangler only; the service itself has no dependencies
```

Edit `wrangler.toml` if the repository is not `CaotcAftermth/DinoDepot-Studio`.

Set the secrets. These are never written to a file:

```bash
npx wrangler secret put GITHUB_APP_ID           # e.g. 123456
npx wrangler secret put GITHUB_INSTALLATION_ID  # e.g. 87654321
npx wrangler secret put GITHUB_APP_PRIVATE_KEY  # paste the whole .pem, newlines and all
npx wrangler secret put IDENTITY_SALT           # any long random string
```

Generate the salt with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then:

```bash
npx wrangler deploy
```

Wrangler prints the URL, of the form
`https://dinodepot-feedback.<your-subdomain>.workers.dev`.

Check it:

```bash
curl https://dinodepot-feedback.<your-subdomain>.workers.dev/api/health
```

```json
{ "ok": true, "repository": "CaotcAftermth/DinoDepot-Studio", "accepts": [1], "attachments": false }
```

If a required secret is missing you get a 503 naming which one.

---

## 3. Create the labels

The service drops labels the repository does not have and names them in its
reply, so this is not required — but issues arrive unsorted without it.

With the `gh` CLI authenticated:

```bash
node -e "
const { labelSetupCommands } = await import('../../src/model/feedback/labels.ts');
console.log(labelSetupCommands('CaotcAftermth/DinoDepot-Studio').join('\n'));
" --input-type=module
```

Or copy them out of `MANAGED_LABELS` in `src/model/feedback/labels.ts` by hand.
The set is: `bug`, `suggestion`, `feature-request`, `source:in-app`,
`needs-triage`, `confirmed`, `in-progress`, `planned`, `fixed`, `wont-fix`,
`duplicate`, one `area:*` per section, and four `severity:*`.

---

## 4. Point the app at it

For official builds, set the address at build time:

```bash
VITE_FEEDBACK_API_URL=https://dinodepot-feedback.example.workers.dev npm run build
```

That managed address is fixed for the release and cannot be replaced in the
app. Development and self-hosted builds that omit it retain **Settings →
Feedback → Feedback service address** and **Test**, which confirms the service
answers *and* files into the repository this build belongs to.

---

## Optional: durable rate limiting

Without a KV namespace, counters live in each isolate's memory. A platform may
run several, so the limit is approximate — it raises the cost of abuse without
eliminating it.

```bash
npx wrangler kv namespace create FEEDBACK_KV
```

Uncomment the `[[kv_namespaces]]` block in `wrangler.toml`, paste the id, and
deploy again.

## Optional: attachments

GitHub has no supported API for uploading an attachment to an issue, so images
need somewhere to live.

```bash
npx wrangler r2 bucket create dinodepot-feedback-attachments
```

Uncomment `[[r2_buckets]]` in `wrangler.toml` and deploy again. Keep the bucket
private: the Worker serves only validated screenshot keys through
`/api/attachments/`. `ATTACHMENTS_BASE_URL` remains an optional override when a
production custom domain is preferred.

Without the binding, attachments are refused — the report is still filed, and
the reporter is told the screenshot was not kept.

---

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Repository, accepted schema versions, attachment support |
| `GET` | `/api/attachments/:report/:file` | One stored screenshot |
| `POST` | `/api/feedback` | File a report. `409` means it was already filed |
| `POST` | `/api/feedback/search-duplicates` | Candidate existing issues |
| `GET` | `/api/feedback/issues/:number` | One issue's state |
| `POST` | `/api/feedback/issues/lookup` | Up to fifty issues at once |

There is no "list what this installation reported" endpoint, and that is
deliberate — answering it would require storing who filed what.

---

## Configuration

Every variable is listed with its shape in [`.env.example`](.env.example).
Required: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`,
`GITHUB_OWNER`, `GITHUB_REPO`. Recommended: `IDENTITY_SALT`.

### About `FEEDBACK_SHARED_KEY`

Leave it unset for a public deployment.

A key compiled into an application anybody can download is not a secret, and
setting one would make the endpoint *look* protected without protecting it. Use
it only when the service is private and the key can be handed out separately.
Rate limiting is what actually holds the line.

---

## Local development

```bash
npx wrangler dev
```

Reads `.dev.vars` in the same format as `.env.example`. That file is
gitignored; never commit a filled-in one.

The browser build of the app can talk to it directly — `ipc.ts` makes a real
`fetch` in mock mode, because a browser has no content-security-policy
restriction to route around.

---

## Tests

Run from the repository root, under the same runner as the application:

```bash
npx vitest run services/feedback-api
```

GitHub is stubbed. The RSA key is generated when the suite starts rather than
committed — a private key in a repository is one somebody eventually copies
into a real deployment.

Type check:

```bash
npm run typecheck --prefix services/feedback-api
```

---

## Portability

Only `wrangler.toml` is Cloudflare-specific. `src/index.ts` is a standard
`fetch(request, env)` handler over the Fetch API, and the two optional
bindings are described as interfaces this service defines rather than imported
platform types.

To run it elsewhere, write an entry file for that platform and pass its
environment through:

```ts
// Deno Deploy
import worker from "./src/index.ts";
Deno.serve((request) => worker.fetch(request, Deno.env.toObject()));
```

```ts
// Node 18+, via any framework that hands you a Request
import worker from "./src/index.js";
export const handler = (request: Request) => worker.fetch(request, process.env);
```

Without the bindings, rate limiting falls back to memory and attachments are
refused — both stated at runtime rather than failing quietly.
