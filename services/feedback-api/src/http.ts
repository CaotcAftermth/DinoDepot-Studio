/**
 * Request and response plumbing.
 *
 * Nothing here is specific to a hosting platform: it is the Fetch API, which
 * Cloudflare Workers, Deno Deploy, Netlify Edge and Node 18 all implement. The
 * platform-specific part of this service is `wrangler.toml` and nothing else.
 */

/** Whole-request ceiling. A report with three screenshots is well under this. */
export const MAX_BODY_BYTES = 6 * 1024 * 1024;

export interface ApiFailure {
  status: number;
  error: string;
  message: string;
}

export class ApiError extends Error implements ApiFailure {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

export function tooLarge(message: string): ApiError {
  return new ApiError(413, "too_large", message);
}

export function rateLimited(message: string, retryAfterSeconds: number): ApiError {
  const error = new ApiError(429, "rate_limited", message);
  (error as ApiError & { retryAfterSeconds?: number }).retryAfterSeconds =
    retryAfterSeconds;
  return error;
}

/**
 * Permissive CORS, on purpose.
 *
 * The endpoint carries no credential and sets no cookie, so there is no
 * session for another origin to ride on — which is what the same-origin policy
 * exists to protect. Restricting the origin would buy nothing and would break
 * the browser build the interface is developed against. Abuse is a rate
 * limiting problem, and it is handled as one.
 */
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept",
  "access-control-max-age": "86400",
};

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // A report is never cacheable and neither is an issue's state.
      "cache-control": "no-store",
      ...CORS,
      ...headers,
    },
  });
}

export function failure(error: unknown): Response {
  if (error instanceof ApiError) {
    const retryAfter = (error as ApiError & { retryAfterSeconds?: number })
      .retryAfterSeconds;
    return json(
      { error: error.error, message: error.message },
      error.status,
      retryAfter ? { "retry-after": String(retryAfter) } : {},
    );
  }
  // Never the underlying message: it may name an internal host, a header, or
  // in the worst case part of a credential the GitHub client echoed back.
  return json(
    {
      error: "server_error",
      message: "The feedback service could not complete that request.",
    },
    500,
  );
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Reads a JSON body, with the size checked before it is parsed.
 *
 * The declared length is checked first so an oversized request is refused
 * without being read, and the actual text is checked afterwards because a
 * declared length is something the client chose.
 */
export async function readJson(request: Request): Promise<unknown> {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw tooLarge("That report is too large to send.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw tooLarge("That report is too large to send.");
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("The request body was not valid JSON.");
  }
}

/**
 * The address the request came from.
 *
 * `CF-Connecting-IP` where the platform sets it, falling back to the first
 * entry of `X-Forwarded-For`. Only ever hashed — see `security/identity.ts` —
 * and never stored, logged or put in an issue.
 */
export function clientAddress(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct) return direct;
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() ?? "";
}
