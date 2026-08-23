import { githubConfigComplete } from "../services/publish";
import { standaloneOutputs, type OutputState } from "./outputs";
import type { GithubConfig } from "./project";

/**
 * How close the project is to being able to publish.
 *
 * Three separate questions, which Overview used to collapse into one and get
 * wrong: a destination being *filled in* is not the same as publishing being
 * *possible*, and neither is the same as the repository having been *reached*.
 * Claiming health on the first alone is how "Project healthy" ended up on
 * projects that could not publish a single file.
 */

/** Whether the repository has actually been contacted, and how it went. */
export type ConnectionState = "unknown" | "ok" | "failed";

export interface GithubReadiness {
  /** Owner, repository and branch are all filled in. */
  destinationConfigured: boolean;
  /** Every applicable output has a repository path to write to. */
  pathsConfigured: boolean;
  /** A token is in the credential store. Null while the check is in flight. */
  tokenPresent: boolean | null;
  /** Publishing goes through the desktop backend. */
  desktop: boolean;
  connection: ConnectionState;
  /** Everything needed for a publish to be attempted at all. */
  ready: boolean;
  /** Ready, and the repository answered when it was last tried. */
  verified: boolean;
  /** What is missing, in the order it should be fixed. */
  blockers: string[];
  /** `owner/repo@branch`, or empty when the destination is incomplete. */
  target: string;
}

export interface ReadinessInput {
  github: GithubConfig | null;
  outputs: OutputState[];
  tokenPresent: boolean | null;
  desktop: boolean;
  connection: ConnectionState;
}

export function githubReadiness(input: ReadinessInput): GithubReadiness {
  const { github, outputs, tokenPresent, desktop, connection } = input;
  const destinationConfigured = github ? githubConfigComplete(github) : false;

  // Only outputs the project actually publishes need a path; a blank path for
  // a disabled Player Data output is not a problem worth reporting.
  const missingPaths = github
    ? standaloneOutputs(outputs)
        .filter((o) => !github.paths[o.family]?.trim())
        .map((o) => o.label)
    : [];
  const pathsConfigured = Boolean(github) && missingPaths.length === 0;

  const blockers: string[] = [];
  if (!destinationConfigured) {
    blockers.push("Repository owner, name and branch are not all set");
  }
  if (missingPaths.length > 0) {
    blockers.push(`No repository path for ${missingPaths.join(", ")}`);
  }
  // Unknown is not reported as a blocker: the check is asynchronous, and
  // flashing "no token" before it resolves would be its own kind of lie.
  if (tokenPresent === false) {
    blockers.push("No GitHub token stored");
  }
  if (!desktop) {
    blockers.push("Publishing only runs in the desktop app");
  }

  const ready =
    destinationConfigured && pathsConfigured && tokenPresent === true && desktop;

  return {
    destinationConfigured,
    pathsConfigured,
    tokenPresent,
    desktop,
    connection,
    ready,
    verified: ready && connection === "ok",
    blockers,
    target: destinationConfigured
      ? `${github!.owner}/${github!.repo}@${github!.branch}`
      : "",
  };
}
