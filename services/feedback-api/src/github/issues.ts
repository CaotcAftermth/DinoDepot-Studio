import { ApiError } from "../http";
import { repoSlug, type Settings } from "../env";
import { installationToken } from "./app";
import type { DuplicateCandidate, IssueSummary } from "../shared";

/**
 * Everything this service does to GitHub, in one place.
 *
 * Kept apart from the feedback logic on purpose: the rules about what makes a
 * good issue, which labels a report gets and how duplicates are ranked are the
 * interesting part, and none of it should have to know about pagination,
 * installation tokens or the search index.
 *
 * Nothing here throws a raw GitHub error upward. Statuses become the failures
 * the client already knows how to read, and no response body is ever included
 * in a message — an error body can carry request headers back with it.
 */

const API = "https://api.github.com";

/** GitHub's search index lags issue creation by seconds to a minute. */
export const SEARCH_INDEX_LAG_NOTE =
  "GitHub's search index is not immediate; a very fast retry may not find the issue it filed.";

interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  labels: (string | { name?: string })[];
  milestone: { title?: string } | null;
  updated_at: string;
}

function labelNames(labels: GithubIssue["labels"]): string[] {
  return (labels ?? [])
    .map((label) => (typeof label === "string" ? label : (label?.name ?? "")))
    .filter(Boolean);
}

function toSummary(issue: GithubIssue): IssueSummary {
  return {
    number: issue.number,
    url: issue.html_url,
    title: issue.title ?? "",
    state: issue.state,
    labels: labelNames(issue.labels),
    milestone: issue.milestone?.title ?? "",
    updatedAt: issue.updated_at ?? "",
  };
}

/** Only the opening of a body is needed for scoring, and it keeps replies small. */
const CANDIDATE_BODY_CHARS = 1500;

function toCandidate(issue: GithubIssue): DuplicateCandidate {
  return {
    number: issue.number,
    title: issue.title ?? "",
    body: (issue.body ?? "").slice(0, CANDIDATE_BODY_CHARS),
    state: issue.state,
    labels: labelNames(issue.labels),
    url: issue.html_url,
    updatedAt: issue.updated_at ?? "",
  };
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels: string[];
}

export interface CreateIssueResult {
  issue: IssueSummary;
  /** Labels the repository does not have, so the caller can say so. */
  missingLabels: string[];
}

/**
 * The GitHub half of the feedback service.
 *
 * Constructed per request. The token cache and the label cache are module
 * scope behind it, so building one is free.
 */
export class GitHubFeedbackService {
  constructor(
    private readonly settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await installationToken(this.settings, this.fetchImpl);
    return this.fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "DinoDepotFeedback",
        "x-github-api-version": "2022-11-28",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  /**
   * Turns a GitHub status into something the desktop app can act on.
   *
   * A rate limit has to be told apart from a refusal, because one is worth
   * retrying and the other is worth telling somebody about. The body is
   * deliberately not carried through.
   */
  private fail(status: number, what: string): ApiError {
    if (status === 401 || status === 403) {
      return new ApiError(
        502,
        "github_auth",
        `The feedback service could not authenticate with GitHub while ${what}.`,
      );
    }
    if (status === 404) {
      return new ApiError(
        502,
        "github_missing",
        "The feedback service is pointed at a repository it cannot see.",
      );
    }
    if (status === 422) {
      return new ApiError(400, "github_rejected", `GitHub refused the request while ${what}.`);
    }
    if (status === 429) {
      return new ApiError(429, "github_rate_limited", "GitHub is rate limiting the feedback service.");
    }
    return new ApiError(502, "github_error", `GitHub did not answer while ${what}.`);
  }

  // -- reading ------------------------------------------------------------

  /**
   * Runs a search, returning nothing rather than failing.
   *
   * Duplicate detection is a convenience. A search that errors — a rate limit,
   * an index hiccup — must not stop somebody filing a report, so the failure
   * is absorbed and the caller sees an empty list.
   */
  async search(query: string, limit = 10): Promise<DuplicateCandidate[]> {
    const url = `/search/issues?q=${encodeURIComponent(query)}&per_page=${limit}&sort=updated&order=desc`;
    const response = await this.request(url).catch(() => null);
    if (!response?.ok) return [];
    const body = (await response.json().catch(() => null)) as
      | { items?: GithubIssue[] }
      | null;
    return (body?.items ?? []).map(toCandidate);
  }

  /**
   * The issue carrying a given report marker, if one exists.
   *
   * This is what makes submission idempotent without a database: the marker is
   * in the issue body, so GitHub itself is the record of what has already been
   * filed.
   */
  async findByMarker(term: string): Promise<IssueSummary | null> {
    const query = `repo:${repoSlug(this.settings)} in:body "${term}"`;
    const response = await this.request(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=5`,
    );
    if (!response.ok) {
      throw this.fail(response.status, "checking whether this report was already filed");
    }
    let body: { items?: GithubIssue[] };
    try {
      body = (await response.json()) as { items?: GithubIssue[] };
    } catch {
      throw new ApiError(
        502,
        "github_error",
        "GitHub did not answer while checking whether this report was already filed.",
      );
    }
    const found = (body.items ?? []).find((issue) =>
      (issue.body ?? "").includes(term),
    );
    return found ? toSummary(found) : null;
  }

  async getIssue(number: number): Promise<IssueSummary | null> {
    const response = await this.request(
      `/repos/${repoSlug(this.settings)}/issues/${number}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw this.fail(response.status, "reading an issue");
    return toSummary((await response.json()) as GithubIssue);
  }

  /**
   * Several issues, fetched one at a time.
   *
   * GitHub has no batch endpoint for issues by number, and listing every issue
   * to filter locally would cost far more requests than a handful of direct
   * reads. One that has been deleted is skipped rather than failing the set.
   */
  async getIssues(numbers: number[]): Promise<IssueSummary[]> {
    const results = await Promise.all(
      numbers.map((number) => this.getIssue(number).catch(() => null)),
    );
    return results.filter((issue): issue is IssueSummary => issue !== null);
  }

  // -- labels -------------------------------------------------------------

  /**
   * The labels the repository actually has.
   *
   * Cached for the life of the isolate: labels change on the order of never,
   * and this is read on every submission.
   */
  private async existingLabels(): Promise<Set<string>> {
    const key = repoSlug(this.settings);
    const cached = labelCache.get(key);
    if (cached && cached.at > Date.now() - LABEL_CACHE_MS) return cached.labels;

    const labels = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const response = await this.request(
        `/repos/${key}/labels?per_page=100&page=${page}`,
      ).catch(() => null);
      if (!response?.ok) break;
      const body = (await response.json().catch(() => [])) as { name?: string }[];
      for (const label of body) if (label.name) labels.add(label.name);
      if (body.length < 100) break;
    }
    labelCache.set(key, { labels, at: Date.now() });
    return labels;
  }

  // -- writing ------------------------------------------------------------

  /**
   * Files the issue.
   *
   * Labels that do not exist are dropped rather than created or sent anyway.
   * GitHub creates unknown labels silently when they are supplied at creation
   * time, which would let a typo in this code quietly populate the repository
   * with labels nobody chose — and losing a label is a much smaller problem
   * than losing the report, which is what sending an invalid set would risk.
   */
  async createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
    const available = await this.existingLabels();
    const labels = input.labels.filter((label) => available.has(label));
    const missingLabels =
      available.size === 0
        ? []
        : input.labels.filter((label) => !available.has(label));

    const response = await this.request(`/repos/${repoSlug(this.settings)}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        // An empty array is sent as no field at all; GitHub treats `[]` as
        // "remove every label", which is meaningless at creation but noisy.
        ...(labels.length > 0 ? { labels } : {}),
      }),
    });

    if (!response.ok) throw this.fail(response.status, "filing the report");
    return {
      issue: toSummary((await response.json()) as GithubIssue),
      missingLabels,
    };
  }
}

const LABEL_CACHE_MS = 10 * 60 * 1000;
const labelCache = new Map<string, { labels: Set<string>; at: number }>();

/** For tests, so one does not inherit another's cached labels. */
export function resetLabelCache(): void {
  labelCache.clear();
}
