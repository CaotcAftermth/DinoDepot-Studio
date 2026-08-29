import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { resetAuthCache } from "./github/app";
import { resetLabelCache } from "./github/issues";
import { resetMemoryCounters } from "./security/rateLimit";
import {
  readSettings,
  ConfigError,
  type BlobStore,
  type Env,
  type KeyValueStore,
} from "./env";
import { hashIdentifier, sharedKeyAccepted } from "./security/identity";
import { consume } from "./security/rateLimit";
import { decodeAttachment, AttachmentRejected } from "./attachments";
import { derFromPem } from "./github/app";
import { FeedbackReportSchema, findReportMarker } from "./shared";

/**
 * The service, exercised end to end against a stubbed GitHub.
 *
 * These are the tests that matter for a service nobody can easily poke at once
 * it is deployed: that a malformed request is refused, that an oversized one
 * is, that a retry does not file a second issue, that rate limits hold, and
 * that no configuration value ever reaches a response body.
 */

/**
 * A throwaway RSA key, generated when the suite starts.
 *
 * Generated rather than committed: a private key checked into a repository is
 * one somebody eventually copies into a real deployment, and this one only
 * ever signs assertions against a fetch stub.
 */
let privateKeyPem = "";

beforeEach(async () => {
  resetAuthCache();
  resetLabelCache();
  resetMemoryCounters();
  vi.restoreAllMocks();
  if (!privateKeyPem) privateKeyPem = await makeKeyPem();
});

/** A real RSA key, made fresh so nothing usable is committed. */
async function makeKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const body = btoa(String.fromCharCode(...new Uint8Array(pkcs8)))
    .replace(/(.{64})/g, "$1\n")
    .trim();
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_INSTALLATION_ID: "87654321",
    GITHUB_OWNER: "CaotcAftermth",
    GITHUB_REPO: "DinoDepot-Studio",
    IDENTITY_SALT: "test-salt",
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return FeedbackReportSchema.parse({
    id: "11111111-2222-4333-8444-555555555555",
    type: "bug",
    title: "[Bug] Quantity of zero deletes the creature",
    description: "Setting the quantity to zero removed the creature from the rule.",
    severity: "moderate",
    target: {
      id: "production-rule-cycle-quantity",
      name: "Production Cycle Quantity",
      area: "production-rules",
      hierarchy: ["Production Rules", "Production Cycle Quantity"],
      context: {},
    },
    diagnostics: {
      app: { version: "0.6.0", runtime: "desktop" },
      environment: { os: "Windows 11", osVersion: "", architecture: "", webview: "", viewport: "" },
      navigation: { route: "/production/:id", page: "Production Rules" },
      component: null,
      project: null,
      logs: [],
    },
    createdAt: "2026-08-22T09:00:00.000Z",
    appVersion: "0.6.0",
    reporterId: "dd-install-11111111-2222-4333-8444-555555555555",
    ...overrides,
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://feedback.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * A GitHub stub.
 *
 * Records every call so the tests can assert on what the service asked for,
 * which is where the interesting behaviour is - the order of the marker search
 * and the create, and whether labels were filtered.
 */
function stubGithub(options: {
  existingIssue?: unknown;
  labels?: string[];
  createStatus?: number;
  markerSearchStatus?: number;
} = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchStub = vi.fn(async function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    // Cloudflare's native fetch throws "Illegal invocation" when detached
    // from the global object. Keep the stub equally strict so that portability
    // bug cannot silently return.
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (url.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: "ghs_stub", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        { status: 201 },
      );
    }
    if (url.includes("/search/issues")) {
      if (options.markerSearchStatus && options.markerSearchStatus >= 400) {
        return new Response("{}", { status: options.markerSearchStatus });
      }
      return new Response(
        JSON.stringify({ items: options.existingIssue ? [options.existingIssue] : [] }),
        { status: 200 },
      );
    }
    if (url.includes("/labels")) {
      return new Response(
        JSON.stringify((options.labels ?? []).map((name) => ({ name }))),
        { status: 200 },
      );
    }
    if (url.endsWith("/issues") && init?.method === "POST") {
      if (options.createStatus && options.createStatus >= 400) {
        return new Response("{}", { status: options.createStatus });
      }
      return new Response(
        JSON.stringify({
          number: 184,
          title: "[Bug] Quantity of zero deletes the creature",
          body: "",
          html_url: "https://github.com/o/r/issues/184",
          state: "open",
          labels: [{ name: "bug" }],
          milestone: null,
          updated_at: "2026-08-22T09:00:01Z",
        }),
        { status: 201 },
      );
    }
    const single = /\/issues\/(\d+)$/.exec(url);
    if (single) {
      return new Response(
        JSON.stringify({
          number: Number(single[1]),
          title: "x",
          body: "",
          html_url: `https://github.com/o/r/issues/${single[1]}`,
          state: "closed",
          labels: [{ name: "fixed" }],
          milestone: { title: "v0.7.0" },
          updated_at: "2026-08-22T09:00:01Z",
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return calls;
}

// ---------------------------------------------------------------------------

describe("routing", () => {
  it("answers a preflight without touching configuration", async () => {
    const response = await worker.fetch(
      new Request("https://feedback.example.com/api/feedback", { method: "OPTIONS" }),
      {} as Env,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("refuses an unknown endpoint", async () => {
    stubGithub();
    const response = await worker.fetch(
      new Request("https://feedback.example.com/api/nope"),
      env(),
    );
    expect(response.status).toBe(404);
  });

  it("reports its repository and the versions it accepts", async () => {
    stubGithub();
    const response = await worker.fetch(
      new Request("https://feedback.example.com/api/health"),
      env(),
    );
    const body = (await response.json()) as { repository: string; accepts: number[]; attachments: boolean };
    expect(body.repository).toBe("CaotcAftermth/DinoDepot-Studio");
    expect(body.accepts).toContain(1);
    expect(body.attachments).toBe(false);
  });
});

describe("configuration", () => {
  it("names what is missing and refuses to run", async () => {
    const response = await worker.fetch(
      new Request("https://feedback.example.com/api/health"),
      { GITHUB_OWNER: "o" } as Env,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { detail: string };
    expect(body.detail).toContain("GITHUB_APP_ID");
  });

  /** A configuration error must never carry the value it was reading. */
  it("never repeats a configured value back", async () => {
    const response = await worker.fetch(
      new Request("https://feedback.example.com/api/health"),
      { GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----secret" } as Env,
    );
    const text = await response.text();
    expect(text).not.toContain("BEGIN RSA");
    expect(text).not.toContain("secret");
  });

  it("falls back to sensible limits", () => {
    const settings = readSettings(env({ RATE_LIMIT_PER_HOUR: "not a number" }));
    expect(settings.perInstallationPerHour).toBeGreaterThan(0);
  });

  it("refuses rather than half-starting", () => {
    expect(() => readSettings({ GITHUB_OWNER: "o" } as Env)).toThrow(ConfigError);
  });
});

describe("submitting", () => {
  it("files the issue and answers with it", async () => {
    const calls = stubGithub({ labels: ["bug", "source:in-app", "needs-triage"] });
    const response = await worker.fetch(post("/api/feedback", { report: report() }), env());
    expect(response.status).toBe(200);

    const body = (await response.json()) as { issue: { number: number }; alreadyFiled: boolean };
    expect(body.issue.number).toBe(184);
    expect(body.alreadyFiled).toBe(false);

    const create = calls.find((call) => call.method === "POST" && call.url.endsWith("/issues"));
    expect(create).toBeTruthy();
    expect((create?.body as { title: string }).title).toBe(
      "[Bug] Quantity of zero deletes the creature",
    );
  });

  it("writes the report marker, so a retry can find the issue", async () => {
    const calls = stubGithub();
    await worker.fetch(post("/api/feedback", { report: report() }), env());
    const create = calls.find((call) => call.method === "POST" && call.url.endsWith("/issues"));
    const issueBody = (create?.body as { body: string }).body;
    expect(findReportMarker(issueBody)).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("puts the component id in the issue where a grep will find it", async () => {
    const calls = stubGithub();
    await worker.fetch(post("/api/feedback", { report: report() }), env());
    const create = calls.find((call) => call.method === "POST" && call.url.endsWith("/issues"));
    const issueBody = (create?.body as { body: string }).body;
    expect(issueBody).toContain("`production-rule-cycle-quantity`");
    expect(issueBody).toContain("**Area:** Production Rules");
  });

  it("drops legacy project entity context sent by an older client", async () => {
    const calls = stubGithub();
    const legacy = report();
    const response = await worker.fetch(
      post("/api/feedback", {
        report: {
          ...legacy,
          target: {
            ...legacy.target,
            context: { creature: "Argentavis", field: "quantity" },
          },
        },
      }),
      env(),
    );
    expect(response.status).toBe(200);
    const create = calls.find((call) => call.method === "POST" && call.url.endsWith("/issues"));
    const issueBody = (create?.body as { body: string }).body;
    expect(issueBody).not.toContain("Argentavis");
    expect(issueBody).toContain("- field: quantity");
  });

  /** The whole idempotency story, with no database behind it. */
  it("returns the existing issue instead of filing a second one", async () => {
    const calls = stubGithub({
      existingIssue: {
        number: 184,
        title: "already there",
        body: "<!-- dinodepot-report-id: 11111111-2222-4333-8444-555555555555 -->",
        html_url: "https://github.com/o/r/issues/184",
        state: "open",
        labels: [],
        milestone: null,
        updated_at: "2026-08-22T09:00:00Z",
      },
    });
    const response = await worker.fetch(post("/api/feedback", { report: report() }), env());
    expect(response.status).toBe(409);
    const body = (await response.json()) as { alreadyFiled: boolean; issue: { number: number } };
    expect(body.alreadyFiled).toBe(true);
    expect(body.issue.number).toBe(184);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/issues"))).toBe(false);
  });

  it("does not risk a duplicate when the idempotency lookup fails", async () => {
    const calls = stubGithub({ markerSearchStatus: 500 });
    const response = await worker.fetch(post("/api/feedback", { report: report() }), env());
    expect(response.status).toBe(502);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/issues"))).toBe(false);
  });

  /**
   * Losing a label is a small problem; losing the report over one is not. The
   * missing ones are named in the reply so nothing looks silently wrong.
   */
  it("drops a label the repository does not have and says which", async () => {
    const calls = stubGithub({ labels: ["bug", "needs-triage"] });
    const response = await worker.fetch(post("/api/feedback", { report: report() }), env());
    const body = (await response.json()) as { missingLabels: string[] };
    expect(body.missingLabels).toContain("source:in-app");
    const create = calls.find((call) => call.method === "POST" && call.url.endsWith("/issues"));
    expect((create?.body as { labels: string[] }).labels).toEqual(["bug", "needs-triage"]);
  });

  it("still files when the repository has no labels at all", async () => {
    stubGithub({ labels: [] });
    const response = await worker.fetch(post("/api/feedback", { report: report() }), env());
    expect(response.status).toBe(200);
  });

  it("turns a GitHub failure into something the app can act on", async () => {
    stubGithub({ createStatus: 500 });
    const response = await worker.fetch(post("/api/feedback", { report: report() }), env());
    expect(response.status).toBe(502);
    const body = (await response.json()) as { message: string };
    expect(body.message).not.toContain("500");
  });
});

describe("validation", () => {
  it("refuses a body that is not JSON", async () => {
    stubGithub();
    const response = await worker.fetch(
      new Request("https://feedback.example.com/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      env(),
    );
    expect(response.status).toBe(400);
  });

  it("refuses a report with nothing in it", async () => {
    stubGithub();
    for (const body of [{}, { report: {} }, { report: { type: "bug" } }]) {
      const response = await worker.fetch(post("/api/feedback", body), env());
      expect(response.status).toBe(400);
    }
  });

  it("refuses a report from a schema version it does not know", async () => {
    stubGithub();
    const response = await worker.fetch(
      post("/api/feedback", { report: { ...report(), schemaVersion: 99 } }),
      env(),
    );
    expect(response.status).toBe(400);
  });

  it("refuses a report that did not come from DinoDepot Studio", async () => {
    stubGithub();
    const response = await worker.fetch(
      post("/api/feedback", { report: { ...report(), submissionSource: "curl" } }),
      env(),
    );
    expect(response.status).toBe(400);
  });

  it("refuses credential-like text before it reaches GitHub", async () => {
    const calls = stubGithub();
    const response = await worker.fetch(
      post("/api/feedback", {
        report: report({
          description: "I accidentally pasted ghp_abcdefghijklmnopqrstuvwxyz012345 here.",
        }),
      }),
      env(),
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses an oversized request before reading it", async () => {
    stubGithub();
    const request = new Request("https://feedback.example.com/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(9 * 1024 * 1024) },
      body: JSON.stringify({ report: report() }),
    });
    const response = await worker.fetch(request, env());
    expect(response.status).toBe(413);
  });

  it("refuses a lookup asking for too many issues", async () => {
    stubGithub();
    const numbers = Array.from({ length: 80 }, (_, index) => index + 1);
    const response = await worker.fetch(
      post("/api/feedback/issues/lookup", { numbers }),
      env(),
    );
    expect(response.status).toBe(400);
  });

  it("refuses an issue number that is not one", async () => {
    stubGithub();
    const response = await worker.fetch(
      new Request("https://feedback.example.com/api/feedback/issues/abc"),
      env(),
    );
    expect(response.status).toBe(400);
  });
});

describe("rate limiting", () => {
  it("refuses once an installation is over its hourly limit", async () => {
    stubGithub();
    const limited = env({ RATE_LIMIT_PER_HOUR: "2" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await worker.fetch(
        post("/api/feedback", { report: report({ id: `1111111${attempt}-2222-4333-8444-555555555555` }) }),
        limited,
      );
      expect(response.status).toBe(200);
    }
    const refused = await worker.fetch(
      post("/api/feedback", { report: report({ id: "99999999-2222-4333-8444-555555555555" }) }),
      limited,
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
  });

  it("counts a fixed window and resets with it", async () => {
    const decision = await consume("k", 2, undefined, 0);
    expect(decision.allowed).toBe(true);
    expect((await consume("k", 2, undefined, 0)).allowed).toBe(true);
    expect((await consume("k", 2, undefined, 0)).allowed).toBe(false);
    // An hour later, a new window.
    expect((await consume("k", 2, undefined, 3_600_001)).allowed).toBe(true);
  });

  it("uses a KV namespace when one is bound", async () => {
    const store = new Map<string, string>();
    const kv: KeyValueStore = {
      async get(key) {
        return store.get(key) ?? null;
      },
      async put(key, value) {
        store.set(key, value);
      },
    };
    await consume("k", 1, kv, 0);
    expect((await consume("k", 1, kv, 0)).allowed).toBe(false);
    expect(store.size).toBe(1);
  });
});

describe("identity", () => {
  it("hashes, so an installation id is never stored as it arrived", async () => {
    const digest = await hashIdentifier("dd-install-abc", "salt");
    expect(digest).not.toContain("dd-install");
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(await hashIdentifier("dd-install-abc", "salt")).toBe(digest);
  });

  it("gives a different digest under a different deployment salt", async () => {
    expect(await hashIdentifier("x", "salt-a")).not.toBe(
      await hashIdentifier("x", "salt-b"),
    );
  });

  it("accepts everything when no shared key is set", () => {
    expect(sharedKeyAccepted("", "")).toBe(true);
    expect(sharedKeyAccepted("anything", "")).toBe(true);
  });

  it("checks a shared key when one is set", async () => {
    expect(sharedKeyAccepted("right", "right")).toBe(true);
    expect(sharedKeyAccepted("wrong", "right")).toBe(false);
    expect(sharedKeyAccepted("", "right")).toBe(false);

    stubGithub();
    const refused = await worker.fetch(
      post("/api/feedback", { report: report() }),
      env({ FEEDBACK_SHARED_KEY: "secret" }),
    );
    expect(refused.status).toBe(401);

    const accepted = await worker.fetch(
      post("/api/feedback", { report: report() }, { "x-feedback-key": "secret" }),
      env({ FEEDBACK_SHARED_KEY: "secret" }),
    );
    expect(accepted.status).toBe(200);
  });
});

describe("duplicate search", () => {
  it("asks about the component and returns what it finds", async () => {
    const calls = stubGithub({
      existingIssue: {
        number: 143,
        title: "Quantity field removes production entry",
        body: "production-rule-cycle-quantity",
        html_url: "https://github.com/o/r/issues/143",
        state: "open",
        labels: [{ name: "bug" }],
        milestone: null,
        updated_at: "2026-08-01T00:00:00Z",
      },
    });
    const response = await worker.fetch(
      post("/api/feedback/search-duplicates", {
        type: "bug",
        title: "Quantity of zero removes the creature",
        description: "the quantity removes the creature entry",
        componentId: "production-rule-cycle-quantity",
        area: "production-rules",
      }),
      env(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { candidates: { number: number }[] };
    expect(body.candidates[0].number).toBe(143);
    expect(
      calls.some((call) => call.url.includes("production-rule-cycle-quantity")),
    ).toBe(true);
  });

  it("returns nothing rather than failing when GitHub does not answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/access_tokens")
          ? new Response(JSON.stringify({ token: "ghs_stub" }), { status: 201 })
          : new Response("nope", { status: 503 }),
      ),
    );
    const response = await worker.fetch(
      post("/api/feedback/search-duplicates", {
        type: "bug",
        title: "something",
        description: "quantity creature removes",
      }),
      env(),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { candidates: unknown[] }).toEqual({ candidates: [] });
  });
});

describe("issue lookup", () => {
  it("returns the current state of several issues", async () => {
    stubGithub();
    const response = await worker.fetch(
      post("/api/feedback/issues/lookup", { numbers: [184, 176] }),
      env(),
    );
    const body = (await response.json()) as { issues: { number: number; milestone: string }[] };
    expect(body.issues.map((issue) => issue.number)).toEqual([184, 176]);
    expect(body.issues[0].milestone).toBe("v0.7.0");
  });

  it("skips an issue that has been deleted rather than failing the set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/access_tokens")) {
          return new Response(JSON.stringify({ token: "ghs_stub" }), { status: 201 });
        }
        if (url.endsWith("/999")) return new Response("{}", { status: 404 });
        return new Response(
          JSON.stringify({
            number: 184,
            title: "x",
            body: "",
            html_url: "u",
            state: "open",
            labels: [],
            milestone: null,
            updated_at: "",
          }),
          { status: 200 },
        );
      }),
    );
    const response = await worker.fetch(
      post("/api/feedback/issues/lookup", { numbers: [184, 999] }),
      env(),
    );
    expect(((await response.json()) as { issues: unknown[] }).issues.length).toBe(1);
  });
});

describe("attachments", () => {
  const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function base64(bytes: number[]): string {
    return btoa(String.fromCharCode(...bytes));
  }

  it("accepts an image whose bytes match what it claims to be", () => {
    const decoded = decodeAttachment({
      contentType: "image/png",
      dataB64: base64([...PNG_HEADER, 1, 2, 3]),
    });
    expect(decoded.type).toBe("image/png");
  });

  /** A declared content type is something the client chose. */
  it("refuses something that is not an image at all", () => {
    expect(() =>
      decodeAttachment({ contentType: "image/png", dataB64: base64([0x4d, 0x5a, 0x90, 0x00]) }),
    ).toThrow(AttachmentRejected);
  });

  it("refuses an image that is not the kind it claims", () => {
    expect(() =>
      decodeAttachment({ contentType: "image/webp", dataB64: base64([...PNG_HEADER, 1]) }),
    ).toThrow(AttachmentRejected);
  });

  it("refuses a type that is not an image type", () => {
    expect(() =>
      decodeAttachment({ contentType: "application/zip" as never, dataB64: "AAAA" }),
    ).toThrow(AttachmentRejected);
  });

  it("refuses something that is not base64", () => {
    expect(() =>
      decodeAttachment({ contentType: "image/png", dataB64: "!!! not base64 !!!" }),
    ).toThrow(AttachmentRejected);
  });

  /** A screenshot that cannot be stored must not cost somebody their report. */
  it("files the report anyway and says the attachment was not kept", async () => {
    const calls = stubGithub();
    const withImage = report({
      attachments: [
        {
          id: "a1",
          fileName: "shot.webp",
          contentType: "image/webp",
          sizeBytes: 12,
          dataB64: base64([...PNG_HEADER, 1]),
          url: "",
        },
      ],
    });
    const response = await worker.fetch(post("/api/feedback", { report: withImage }), env());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rejectedAttachments: { fileName: string }[] };
    expect(body.rejectedAttachments[0].fileName).toBe("shot.webp");
    const create = calls.find((call) => call.method === "POST" && call.url.endsWith("/issues"));
    expect((create?.body as { body: string }).body).toContain("Attachments not stored");
  });

  it("stores screenshots privately and streams them through the Worker", async () => {
    const calls = stubGithub();
    const objects = new Map<string, { bytes: Uint8Array; type: string }>();
    const bucket: BlobStore = {
      async put(key, value, options) {
        objects.set(key, {
          bytes: new Uint8Array(value),
          type: options?.httpMetadata?.contentType ?? "application/octet-stream",
        });
      },
      async get(key) {
        const stored = objects.get(key);
        if (!stored) return null;
        return {
          body: new Response(stored.bytes).body!,
          httpEtag: '"test-etag"',
          writeHttpMetadata(headers) {
            headers.set("content-type", stored.type);
          },
        };
      },
    };
    const bytes = [...PNG_HEADER, 1, 2, 3];
    const withImage = report({
      attachments: [
        {
          id: "a1",
          fileName: "shot.png",
          contentType: "image/png",
          sizeBytes: bytes.length,
          dataB64: base64(bytes),
          url: "",
        },
      ],
    });

    const submitted = await worker.fetch(
      post("/api/feedback", { report: withImage }),
      env({ ATTACHMENTS: bucket }),
    );
    expect(submitted.status).toBe(200);
    const result = (await submitted.json()) as {
      storedAttachments: number;
      rejectedAttachments: unknown[];
    };
    expect(result.storedAttachments).toBe(1);
    expect(result.rejectedAttachments).toEqual([]);

    const url =
      "https://feedback.example.com/api/attachments/11111111-2222-4333-8444-555555555555/a1.png";
    const create = calls.find((call) => call.method === "POST" && call.url.endsWith("/issues"));
    expect((create?.body as { body: string }).body).toContain(url);

    // Public by design: GitHub's image renderer has no feedback-service key.
    const served = await worker.fetch(
      new Request(url),
      env({ ATTACHMENTS: bucket, FEEDBACK_SHARED_KEY: "private" }),
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("etag")).toBe('"test-etag"');
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual(bytes);

    const health = await worker.fetch(
      new Request("https://feedback.example.com/api/health"),
      env({ ATTACHMENTS: bucket }),
    );
    expect(((await health.json()) as { attachments: boolean }).attachments).toBe(true);
  });

  it("does not expose arbitrary or missing bucket keys", async () => {
    const bucket: BlobStore = {
      async put() {},
      async get() {
        return null;
      },
    };
    const missing = await worker.fetch(
      new Request("https://feedback.example.com/api/attachments/report/image.png"),
      env({ ATTACHMENTS: bucket }),
    );
    expect(missing.status).toBe(404);

    const traversal = await worker.fetch(
      new Request("https://feedback.example.com/api/attachments/report/%2e%2e%2fsecret.png"),
      env({ ATTACHMENTS: bucket }),
    );
    expect(traversal.status).toBe(404);
  });
});

describe("key handling", () => {
  it("reads a PKCS#8 key", () => {
    expect(derFromPem(privateKeyPem).pkcs1).toBe(false);
  });

  it("recognises the PKCS#1 key GitHub actually hands out", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${btoa("not a real key")}\n-----END RSA PRIVATE KEY-----`;
    expect(derFromPem(pem).pkcs1).toBe(true);
  });

  it("refuses anything that is not a private key", () => {
    expect(() => derFromPem("hello")).toThrow();
    expect(() =>
      derFromPem("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"),
    ).toThrow();
  });

  /** Environment variables routinely carry the key with escaped newlines. */
  it("accepts a key whose newlines were escaped for an environment variable", () => {
    const escaped = privateKeyPem.replace(/\n/g, "\\n");
    expect(derFromPem(escaped).pkcs1).toBe(false);
  });

  it("signs an assertion with the key it was given", async () => {
    const calls = stubGithub();
    await worker.fetch(post("/api/feedback", { report: report() }), env());
    const tokenCall = calls.find((call) => call.url.includes("/access_tokens"));
    expect(tokenCall).toBeTruthy();
  });
});

describe("what never leaves the service", () => {
  it("keeps the private key and the installation token out of every response", async () => {
    stubGithub({ createStatus: 500 });
    const response = await worker.fetch(post("/api/feedback", { report: report() }), env());
    const text = await response.text();
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(text).not.toContain("ghs_stub");
    expect(text).not.toContain("test-salt");
    expect(text).not.toContain("87654321");
  });

  it("never echoes the reporter's address back", async () => {
    stubGithub();
    const response = await worker.fetch(post("/api/feedback", { report: report() }), env());
    expect(await response.text()).not.toContain("203.0.113.9");
  });

  it("does not cache anything", async () => {
    stubGithub();
    const response = await worker.fetch(post("/api/feedback", { report: report() }), env());
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
