# The Feedback Center

Bug reports, suggestions and feature requests, filed from inside DinoDepot
Studio and turned into GitHub issues by a service that holds the credential.

The design is shaped by two constraints that were already true of this
application before any of it was written.

**The webview cannot reach the network.** `tauri.conf.json` sets
`connect-src 'self' ipc: http://ipc.localhost asset: http://asset.localhost`
and nothing else. Every outbound request goes through Rust, exactly as package
downloads and the wiki importer already do.

**The frontend cannot read a credential.** There is deliberately no
`secret_get` command — see `src-tauri/src/commands/secrets.rs`. That is what
makes "a report can never contain a GitHub token" a structural fact rather than
a promise about redaction.

---

## Data flow

```text
DinoDepot Studio (webview)
  │  a report: user text + an allowlisted diagnostic bundle
  │  no credential of any kind
  ▼
feedback_api_request  (src-tauri/src/commands/feedback.rs)
  │  HTTPS. The only thing in this app that may reach the service.
  ▼
DinoDepot Feedback API  (services/feedback-api)
  │  GitHub App private key lives here and only here
  │  exchanged for a short-lived installation token per request batch
  ▼
GitHub Issues · CaotcAftermth/DinoDepot-Studio
```

Nothing in the desktop binary can file an issue, and nothing in it needs to. An
installation that was fully compromised gains the ability to POST text to a
rate-limited public endpoint — which is the ability it already had.

---

## Where the code lives

| Path | What it is |
| --- | --- |
| `src/model/feedback/` | Pure logic: types, the target registry, the diagnostics allowlist, the sanitizer, the issue formatter, labels, duplicate ranking, status mapping, the record state machine. No side effects, all node-testable. |
| `src/services/feedback/` | The parts that touch something: the API client, local persistence, diagnostic collection, attachments. |
| `src/stores/feedbackStore.ts` | The state machine every entry point calls into. |
| `src/components/feedback/` | Thin renderers over that store, plus the inspector and the context menu. |
| `src/components/ErrorBoundary.tsx` | The error screen, with a one-click report. |
| `src-tauri/src/commands/feedback.rs` | State on disk, the HTTP client, attachment decoding. |
| `services/feedback-api/` | The service. |

Behaviour lives in the store and the model, not in components. This project's
test runner has `environment: "node"` and no DOM, so anything that needs a
renderer to exercise is effectively untested — putting the decisions where they
can be tested is what makes the coverage real.

---

## The payload

`FeedbackReport`, in `src/model/feedback/types.ts`, versioned with
`FEEDBACK_SCHEMA_VERSION`. The service declares which versions it accepts at
`GET /api/health`, so an old installation is told plainly rather than failing
oddly.

The same Zod schemas validate the request on both sides — the service imports
them through `services/feedback-api/src/shared.ts`. Client and server cannot
disagree about the shape, because there is only one declaration of it.

---

## Diagnostics: an allowlist, not a redactor

`src/model/feedback/diagnostics.ts` builds the bundle from named fields.
Anything nobody wrote a line for is simply not collected. The other
arrangement — gather everything, then redact — fails the first time a field is
added, because the redactor does not know about the field added yesterday.

Collected:

- application version and whether this is the desktop or browser build
- operating system, version, architecture, webview, window size
- the route, with identifying segments replaced (`/production/:id`)
- the selected component, when enabled: stable id and area plus the visible
  control label used by the element picker
- up to 50 sanitized log entries
- **opt-in, off by default:** project *shape* — counts and schema version

Never collected or accepted:

- credentials from the app, because the frontend has no command that returns
  one; credential-shaped text pasted by the reporter is blocked by both the
  client and service
- project entity context: no rule, creature, item, player or cluster name is
  added as target metadata (a control's visible label can be included only
  when the reporter explicitly selects that area)
- file paths, which are stripped from every log line
- the reporter's name, email or account

`EXCLUDED_ROWS` in that module is the list shown to the reporter. It says only
what the implementation actually guarantees.

### Log sanitization

`src/model/feedback/log.ts` holds a 100-entry ring in memory, never on disk.
Sanitization happens **on the way out**, not on the way in — the developer
console should still show the real path while somebody is debugging, and only
the copy that travels is reduced.

Removed: GitHub tokens in every shape GitHub issues them, credentials in remote
URLs, Discord webhooks, the value of any `token`/`password`/`secret`-shaped
assignment, absolute paths on all three platforms, and email addresses.

The Windows path rule carries a lookbehind that is load-bearing: without it the
`s:` of `https://` reads as a drive letter and every URL in the log becomes
`http«path»`. There is a test for exactly that.

---

## Semantic targets

A report that says "the dropdown doesn't work" costs a maintainer an afternoon.
One that says `content-source-creature-editor` costs them a grep.

Every reportable part of the interface is registered in
`src/model/feedback/targets.ts`. Ids never describe where something sits on
screen — `div:nth-child(4) > input` identifies a position in a layout, which is
the thing that changes when somebody fixes the bug being reported.

### Adding a target

1. Add an entry to `FEEDBACK_TARGETS`:

   ```ts
   "spawn-command-color-selector": {
     name: "Spawn Command Color Selector",
     area: "spawn-commands",
   },
   ```

2. Spread it onto the element:

   ```tsx
   <div {...feedbackTarget("spawn-command-color-selector")}>
   ```

   On a `Card` or `CollapsibleCard`, use the prop instead — it avoids a wrapper
   element that could move the layout:

   ```tsx
   <CollapsibleCard feedback={feedbackTarget("github-account")} …>
   ```

TypeScript rejects an unregistered id. `targets.test.ts` also checks the naming
rules for every entry, that every area has at least one target, and — the one
that matters most in practice — that **every registered id has a call site**.

That last check exists because the opposite failure is invisible: an id in the
registry with nothing spreading it promises coverage the interface does not
have, can never appear in a report, and makes the duplicate search look for
issues about a component nobody can select. It caught 27 such entries the first
time it ran.

`labels.test.ts` checks that every area has a matching GitHub label.

### Naming rules

lowercase kebab-case, ASCII, prefixed with its area, no indices, no ordinals,
no ids of project entities. A rule's own id is volatile context, not part of a
component's identity.

### Context

Dynamic detail travels separately:

```tsx
<CollapsibleCard
  feedback={feedbackTarget("production-rule-cycle-editor", { index })}
>
```

Context is not an arbitrary object that gets serialized. Keys must be on
`ALLOWED_CONTEXT_KEYS`; values must be scalars, are trimmed to 60 characters,
and are **dropped entirely** if they look like a path, a URL, a token or a
credential — because a value shaped like a drive path is a variable somebody
passed by mistake, and losing one line of context is cheaper than publishing an
administrator's folder layout.

### Resolution

`findFeedbackTarget` walks *up* from the element under the pointer. A semantic
control such as a button, link, input, tab or section is highlighted precisely;
its nearest registered ancestor supplies the stable component id and area.
This avoids making every nested control a registry entry while preventing a
page-sized wrapper from swallowing its buttons. Input values are never used to
name a target. The resolver is written against a small `TargetNode` interface
rather than `HTMLElement`, which is why it can be tested without a DOM.

Subtrees marked `data-feedback-ignore` are skipped — that is how the Feedback
Center avoids offering to file a bug against its own Cancel button.

---

## Area labels

The area on the selected target becomes `area:<slug>`.
`labelsForReport` in `src/model/feedback/labels.ts` produces the full set:

```text
bug | suggestion | feature-request
source:in-app
needs-triage
area:<slug>          when a component was selected
severity:<level>     bugs only
```

A label the repository does not have is dropped by the service and named in the
reply, rather than failing the submission. Losing a label is a much smaller
problem than losing a report.

`MANAGED_LABELS` is the full list with colours, and `labelSetupCommands()`
generates the `gh label create` lines.

---

## Duplicate detection

Deterministic. No model, nothing that has to be running for a report to be
submitted.

Two searches, in `src/model/feedback/duplicates.ts`:

1. `repo:o/r is:issue in:body "<component-id>"` — nearly an identity match,
   because reports filed from the app carry the id in the body.
2. `repo:o/r is:issue in:title,body <top keywords>`

Neither filters by `area:` label: a repository whose labels have not been
created yet would otherwise return nothing at all. Closed issues are included —
"fixed in 1.3.9" is often the answer the reporter wanted.

Ranking happens on the client, against the full text of the draft, which the
service therefore never needs. A search failure is absorbed: nobody is stopped
from reporting a bug because the search for similar bugs did not work.
When component diagnostics are switched off, the selected component is also
omitted from duplicate-search input.

---

## Idempotency

The report id is generated once, on the client, before the first attempt, and
is reused by every retry. The service writes it into the issue body as
`<!-- dinodepot-report-id: … -->` and searches for that marker before creating
anything.

GitHub is the record; there is no database. The one caveat is that GitHub's
search index lags creation by seconds, so a retry inside that window could in
principle file twice — which is why the client also refuses to submit while a
submission is in flight, and why that guard is claimed *before* the first
`await` rather than after it.

Failure of the marker lookup itself is different from optional duplicate
detection: submission stops before issue creation, because treating an unknown
lookup result as “not found” would knowingly risk a duplicate.

An HTML comment in a reporter's own words cannot forge a marker:
`escapeUserText` neutralizes `<!--` before it reaches the body.

---

## My Reports and status

Records live in `%APPDATA%/com.ggfizz.dinodepotstudio/feedback/reports.json`,
written by `feedback_state_set`. Machine-local, like the project records beside
them, and never inside a project — a bug report is about the application, and
putting it in the project would synchronize one administrator's complaints to
everybody on the cluster.

There is deliberately **no** "list everything this installation reported"
endpoint. Answering that would mean the service keeping a report-to-installation
mapping — a database of exactly the kind this design avoids. The app knows its
own issue numbers and asks about those.

Refresh happens on opening My Reports, and only if the last one was more than
five minutes ago. GitHub is never polled.

`src/model/feedback/status.ts` translates labels:

```text
needs-triage → Submitted      in-progress → In progress
confirmed    → Confirmed      planned     → Planned
fixed        → Fixed          wont-fix    → Won't fix
duplicate    → Duplicate
```

A closed issue with no progress label reads as **Closed** and nothing more.
Saying "Fixed" there would tell somebody their bug was solved when it may have
been closed as stale or by mistake.

A fix version is read from a milestone named `v1.4.2` or a `fixed-in:1.4.2`
label, if the repository uses either. It does not assume one.

---

## Offline and failure

Feedback is non-critical and is built so it cannot take anything else down.

- The local record is written **before** the network call, so a crash mid-submit
  leaves something to retry rather than nothing.
- If that write fails, nothing is sent and the UI says the report is still open
  but not saved; it never claims an in-memory draft is safe on disk.
- A failed submission stays as `submission_failed`, keeps its text, and offers
  Retry, Edit and Open on GitHub.
- Nothing is ever resubmitted automatically. A pending report says it is pending
  and waits to be told.
- Every store action catches its own failures.
- `loadFeedbackState` returns an empty history rather than throwing, so a
  corrupt feedback file cannot stop the app starting.
- User-entered credential-shaped text is neither sent nor saved as a draft.

### The GitHub fallback

With no service configured — or when one cannot be reached — the report opens
in the browser at the repository's new-issue page with everything filled in
except the diagnostics.

The diagnostics are left out on purpose. They would travel through a URL, and a
URL is the one place a payload is guaranteed to be logged by everything it
passes through.

---

## Attachments

Images only, and never attached silently.

At most three one-megabyte images may be attached. The client, Zod schema,
Rust image command and service enforce the same limit; the serialized request
is capped at six megabytes. Local history has a larger ceiling so several
unsent reports can coexist safely.

The picked file is decoded and re-encoded to lossless WebP **in Rust**
(`feedback_read_image`). Re-encoding is the point: it proves the file really is
an image — an executable renamed to `.png` fails to decode and is refused — and
it drops every scrap of metadata, including the EXIF GPS position that phone
screenshots routinely carry.

The service checks the magic bytes again before storing, because a declared
content type is something the client chose.

Storage is behind `AttachmentService`. The bundled implementation writes to an
object store (R2 or equivalent). Without one bound, attachments are refused,
the report is still filed, and both the reply and the issue say the screenshot
was not kept.

There is no automatic screen capture. Tauri 2 has no window-capture command,
and adding a plugin would make the whole application request screen-recording
permission at install time — a poor trade for a bug reporting feature. The seam
is there: an `AttachmentSource` that captures a window drops in without
touching anything above it.

---

## Security model

| Concern | How it is handled |
| --- | --- |
| GitHub credential in the app | There is none. The service authenticates as a GitHub App. |
| Private key exposure | Lives in the service's secret store. Never in a response body — asserted by a test. |
| Token in a report | The frontend has no command that returns a secret. Logs are sanitized, and credential-shaped reporter text is rejected on both sides. |
| Project data leaking | Collection reads counts only and is off by default. Target metadata excludes entity names; an explicitly selected control may contribute its visible label. |
| Reporter identity | A random `dd-install-<uuid>`, generated locally, deletable. No hardware, MAC, serial or IP fingerprinting. |
| Rate-limit keys | Installation id and source address are salted and SHA-256 hashed. Only the digest is used, and it is useless outside the deployment. |
| Markdown injection | HTML comments, `<details>`/`<summary>` and unclosed fences are neutralized. Users may still write Markdown. |
| Request forgery | Nothing is authenticated by cookie or origin, so there is no session to ride. Abuse is a rate-limiting problem and is treated as one. |
| Redirects | The Rust client sets `redirect: none` — the service has no reason to issue one, and following one would send a report somewhere the administrator did not name. |

### GitHub App permissions

Two, and no more:

```text
Issues:   Read & write
Metadata: Read-only
```

No Contents, no Actions, no Administration. Repository-scoped to the
application repository.

---

## Deploying the service

See `services/feedback-api/README.md` for the full sequence. In outline:

1. Create a GitHub App with the two permissions above, install it on
   `CaotcAftermth/DinoDepot-Studio`.
2. `wrangler secret put` the app id, private key, installation id and identity
   salt.
3. Optionally bind a KV namespace (durable rate limiting) and an R2 bucket
   (attachments).
4. `wrangler deploy`.
5. Create the labels — `labelSetupCommands()` prints the commands.
6. Ship the URL as `VITE_FEEDBACK_API_URL`. Development and self-hosted builds
   without a packaged URL may instead set one in **Settings › Feedback**.

Only `wrangler.toml` is Cloudflare-specific. The service is a standard `fetch`
handler; the two optional bindings are described as interfaces it defines
rather than imported platform types.

---

## Configuration

`src/model/feedback/config.ts`. `FEEDBACK_CONFIG.enabled` is the feature flag;
turning it off renders no feedback panels, installs no feedback shortcuts or
context menu, and hides every visible entry point.

The API address resolves in this order: `VITE_FEEDBACK_API_URL` at build time,
then the administrator's setting only when the build has no managed address,
then empty. Empty is a working configuration — the browser fallback needs no
service at all. A managed build shows connection status but does not expose an
address editor, because changing it would redirect diagnostics and screenshots.

An address must be HTTPS with no credentials and no query string, checked in
both TypeScript and Rust.

---

## Entry points

| Route in | Where |
| --- | --- |
| Sidebar | **Help & feedback**, above Close project |
| Welcome screen | "Report a problem or suggest an improvement" |
| Settings | **Settings › Feedback** |
| Keyboard | `Ctrl+Shift+F`, anywhere |
| Right-click | Any non-editable part of the app |
| Error boundary | **Report this error** |
| Programmatic | `useFeedback()` / the `feedback` object in `useFeedback.ts` |

The right-click menu deliberately does **not** appear over text fields, over a
selection, or over the Feedback Center's own surfaces. Somebody who
right-clicks an input wants Paste, and taking that away would break something
that works today for something that is only ever a shortcut.

---

## Troubleshooting

**"No feedback service is set up for this build."** No address configured.
Reports are still written and kept; use Open on GitHub, or set an address in
Settings › Feedback.

**Test says "files into owner/other".** The service is pointed at a different
repository. Check `GITHUB_OWNER` and `GITHUB_REPO`.

**Everything returns 503 `not_configured`.** A required secret is unset; the
response body names which one.

**Issues arrive with no labels.** They have not been created. Run the commands
from `labelSetupCommands()`; the reply already lists the missing ones.

**A retry filed a second issue.** The retry landed inside GitHub's search-index
lag. Rare, and only possible if the client was restarted mid-submission.

**Rate limited immediately.** Without a KV binding, counters are per isolate and
approximate. Bind one.

**Inspector highlights nothing.** Nothing registered is under the pointer.
Add a target, or report without one — the area is always optional.
