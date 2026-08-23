import { ConfigError, readSettings, type Env } from "./env";
import { GitHubFeedbackService } from "./github/issues";
import { ApiError, failure, json, preflight } from "./http";
import { sharedKeyAccepted } from "./security/identity";
import {
  handleDuplicates,
  handleGetIssue,
  handleHealth,
  handleIssueLookup,
  handleSubmit,
  type RouteContext,
} from "./routes/feedback";

/**
 * The DinoDepot Feedback service.
 *
 * A single `fetch` handler over the standard Request and Response, which is
 * what makes it portable: Cloudflare Workers is what `wrangler.toml` deploys
 * to, and Deno Deploy, Netlify Edge Functions and Node 18 all run the same
 * module with a different entry file and nothing else changed. Only the two
 * optional bindings — KV for rate limiting, R2 for attachments — are
 * Cloudflare-shaped, and both are described as interfaces this service defines
 * rather than imported types.
 *
 * ```text
 * DinoDepot Studio
 *        │  HTTPS, no credentials
 *        ▼
 * DinoDepot Feedback API      ← the GitHub App key lives here and only here
 *        │  installation token
 *        ▼
 * GitHub Issues · CaotcAftermth/DinoDepot-Studio
 * ```
 */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return preflight();

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      const settings = readSettings(env);

      // Checked before anything else reads the body, so an unauthorized
      // request costs nothing. Off unless the deployment sets a key — see the
      // note in env.ts about why a key in a downloadable app is not a secret.
      const presented =
        request.headers.get("x-feedback-key") ?? url.searchParams.get("key") ?? "";
      if (!sharedKeyAccepted(presented, settings.sharedKey)) {
        throw new ApiError(401, "unauthorized", "This feedback service is not open.");
      }

      const context: RouteContext = {
        request,
        env,
        settings,
        github: new GitHubFeedbackService(settings),
      };

      if (path === "/api/health" && request.method === "GET") {
        return await handleHealth(context);
      }
      if (path === "/api/feedback" && request.method === "POST") {
        return await handleSubmit(context);
      }
      if (path === "/api/feedback/search-duplicates" && request.method === "POST") {
        return await handleDuplicates(context);
      }
      if (path === "/api/feedback/issues/lookup" && request.method === "POST") {
        return await handleIssueLookup(context);
      }

      const single = /^\/api\/feedback\/issues\/([^/]+)$/.exec(path);
      if (single && request.method === "GET") {
        return await handleGetIssue(context, single[1]);
      }

      return json({ error: "not_found", message: "No such endpoint." }, 404);
    } catch (error) {
      if (error instanceof ConfigError) {
        // The names of what is missing, never the values. An operator reading
        // their own logs needs to know which variable to set.
        return json(
          {
            error: "not_configured",
            message: "This feedback service has not been set up yet.",
            detail: error.message,
          },
          503,
        );
      }
      return failure(error);
    }
  },
};
