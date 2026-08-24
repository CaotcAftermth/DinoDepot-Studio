import { attachmentServiceFor, storeAttachments } from "../attachments";
import { repoSlug, type Env, type Settings } from "../env";
import { GitHubFeedbackService } from "../github/issues";
import { clientAddress, json, readJson } from "../http";
import { enforce } from "../security/rateLimit";
import { hashIdentifier } from "../security/identity";
import {
  duplicateQueries,
  issueBody,
  issueTitle,
  labelsForReport,
  markerSearchTerm,
  type DuplicateSubject,
} from "../shared";
import {
  parseDuplicateQuery,
  parseIssueLookup,
  parseIssueNumber,
  parseSubmit,
  ACCEPTED_SCHEMA_VERSIONS,
} from "../validation/request";

/**
 * What the service actually does.
 *
 * Three operations, and the order of the work inside each one is the part
 * worth reading. Submission in particular checks for an existing issue before
 * it does anything else, because that is the whole of the idempotency story:
 * a retry after a timeout finds the issue the first attempt filed and returns
 * it, rather than filing a second one.
 */

export interface RouteContext {
  request: Request;
  env: Env;
  settings: Settings;
  github: GitHubFeedbackService;
}

// ---------------------------------------------------------------------------

export async function handleHealth(context: RouteContext): Promise<Response> {
  const attachments = attachmentServiceFor(
    context.settings,
    context.env.ATTACHMENTS,
    new URL(context.request.url).origin,
  );
  return json({
    ok: true,
    repository: repoSlug(context.settings),
    accepts: ACCEPTED_SCHEMA_VERSIONS,
    attachments: attachments.available,
  });
}

// ---------------------------------------------------------------------------

export async function handleSubmit(context: RouteContext): Promise<Response> {
  const body = await readJson(context.request);
  const report = parseSubmit(body);

  // Rate limiting comes after validation and before anything that costs a
  // GitHub request, so a flood of malformed requests is refused at the cheapest
  // point and a flood of well-formed ones never reaches the API.
  await applyRateLimits(context, report.reporterId);

  const github = context.github;

  // Already filed? Then this is a retry, and the answer is the issue that
  // exists rather than a second one. GitHub's own search index is the record;
  // no database is needed for this and none is kept.
  const marker = markerSearchTerm(report.id);
  const existing = await github.findByMarker(marker);
  if (existing) {
    return json({ issue: existing, alreadyFiled: true, missingLabels: [] }, 409);
  }

  const attachmentService = attachmentServiceFor(
    context.settings,
    context.env.ATTACHMENTS,
    new URL(context.request.url).origin,
  );
  const outcome = await storeAttachments(attachmentService, report);

  // The report the formatter sees carries URLs rather than bytes, so the
  // shared formatter never has to know how an attachment was stored.
  const linked = {
    ...report,
    attachments: outcome.stored.map((stored) => ({
      id: stored.id,
      fileName: stored.fileName,
      contentType: "image/webp" as const,
      sizeBytes: 1,
      dataB64: "",
      url: stored.url,
    })),
  };

  let body_ = issueBody(linked, { marker: true });
  if (outcome.rejected.length > 0) {
    // Said in the issue as well as in the reply, so a maintainer reading it
    // knows a screenshot was offered and does not go looking for it.
    body_ += `\n\n> Attachments not stored: ${outcome.rejected
      .map((entry) => `${entry.fileName} — ${entry.reason}`)
      .join("; ")}`;
  }

  const created = await github.createIssue({
    title: issueTitle(report),
    body: body_,
    labels: labelsForReport(report),
  });

  return json({
    issue: created.issue,
    alreadyFiled: false,
    missingLabels: created.missingLabels,
    storedAttachments: outcome.stored.length,
    rejectedAttachments: outcome.rejected,
  });
}

// ---------------------------------------------------------------------------

export async function handleDuplicates(context: RouteContext): Promise<Response> {
  const body = await readJson(context.request);
  const query = parseDuplicateQuery(body);

  // A cheaper limit than submission's, and a separate one: searching is not
  // filing, and somebody editing their report re-runs this several times.
  const address = await hashIdentifier(
    clientAddress(context.request),
    context.settings.identitySalt,
  );
  await enforce(
    `search:${address}`,
    context.settings.perAddressPerHour * 4,
    context.env.FEEDBACK_KV,
    "this network",
  );

  const subject: DuplicateSubject = {
    type: query.type,
    title: query.title,
    description: query.description,
    target: query.componentId
      ? {
          id: query.componentId,
          name: query.componentId,
          area: query.area,
          hierarchy: [],
          context: {},
        }
      : null,
  };

  const queries = duplicateQueries(subject, repoSlug(context.settings));
  const seen = new Set<number>();
  const candidates = [];
  for (const search of queries) {
    for (const candidate of await context.github.search(search, 10)) {
      if (seen.has(candidate.number)) continue;
      seen.add(candidate.number);
      candidates.push(candidate);
    }
  }

  // Ranking happens on the client, against the full text of the draft — which
  // the client has and this service deliberately does not need.
  return json({ candidates: candidates.slice(0, 20) });
}

// ---------------------------------------------------------------------------

export async function handleGetIssue(
  context: RouteContext,
  segment: string,
): Promise<Response> {
  const number = parseIssueNumber(segment);
  const issue = await context.github.getIssue(number);
  if (!issue) return json({ error: "not_found", message: "No such issue." }, 404);
  return json({ issues: [issue] });
}

export async function handleIssueLookup(context: RouteContext): Promise<Response> {
  const body = await readJson(context.request);
  const { numbers } = parseIssueLookup(body);
  const issues = await context.github.getIssues(numbers);
  return json({ issues });
}

// ---------------------------------------------------------------------------

/**
 * Two limits, both required to pass.
 *
 * Per installation catches one person retrying in frustration. Per address
 * catches a script, and catches somebody who realised the installation id is
 * theirs to change — which it is, because it is generated locally and there is
 * deliberately no way to tie it to a person.
 */
async function applyRateLimits(context: RouteContext, reporterId: string): Promise<void> {
  const salt = context.settings.identitySalt;
  const installation = await hashIdentifier(reporterId, salt);
  const address = await hashIdentifier(clientAddress(context.request), salt);

  if (installation) {
    await enforce(
      `submit:install:${installation}`,
      context.settings.perInstallationPerHour,
      context.env.FEEDBACK_KV,
      "this installation",
    );
  }
  if (address) {
    await enforce(
      `submit:addr:${address}`,
      context.settings.perAddressPerHour,
      context.env.FEEDBACK_KV,
      "this network",
    );
  }
}
