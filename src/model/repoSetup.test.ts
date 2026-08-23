import { describe, expect, it } from "vitest";
import { STUDIO_ERROR_CODES } from "./errors";
import { leaksGitTerms } from "./syncState";
import {
  LocalProjectStateSchema,
  newLocalProjectState,
  RepoBindingSchema,
  type LocalProjectState,
  type RepoBinding,
} from "./localState";
import {
  availabilityFor,
  bindingFor,
  blockingIssues,
  checkPairing,
  checkSuitability,
  collaboratorsUrl,
  currentStep,
  identityMatches,
  newRepoUrl,
  newTokenUrl,
  OPTIONAL_TOKEN_ACCESS,
  pagesSiteUrl,
  publicSourcePrivacyProblem,
  reconcileBinding,
  REQUIRED_TOKEN_ACCESS,
  setupSteps,
  UNNECESSARY_TOKEN_ACCESS,
  type RepoIdentity,
} from "./repoSetup";

function identity(over: Partial<RepoIdentity> = {}): RepoIdentity {
  return {
    githubId: "123456789",
    owner: "ggfizz",
    name: "cluster-source",
    isPrivate: true,
    defaultBranch: "main",
    canPush: true,
    isEmpty: true,
    hasPages: false,
    htmlUrl: "https://github.com/ggfizz/cluster-source",
    ...over,
  };
}

function binding(over: Partial<RepoBinding> = {}): RepoBinding {
  return RepoBindingSchema.parse({
    githubId: "123456789",
    owner: "ggfizz",
    name: "cluster-source",
    remoteUrl: "https://github.com/ggfizz/cluster-source.git",
    branch: "main",
    isPrivate: true,
    ...over,
  });
}

function state(over: Partial<LocalProjectState> = {}): LocalProjectState {
  return LocalProjectStateSchema.parse({
    ...newLocalProjectState("p1", "C:\\proj", "GG Fizz"),
    ...over,
  });
}

describe("checking a repository is suitable", () => {
  it("accepts a private, writable, empty repository as the project's", () => {
    expect(checkSuitability(identity(), "source", "source-and-delivery")).toEqual([]);
  });

  /**
   * The check that matters most. The project repository holds the roster and
   * the profile backups; a public one puts both on the open web the moment
   * anything synchronizes.
   */
  it("refuses a public repository for the project", () => {
    const issues = checkSuitability(
      identity({ isPrivate: false }),
      "source",
      "source-and-delivery",
    );
    expect(blockingIssues(issues)).toHaveLength(1);
    expect(issues[0].message).toContain("is public");
    expect(issues[0].fix).toContain("private project data");
  });

  it("accepts a public project repository on public-only", () => {
    expect(
      checkSuitability(identity({ isPrivate: false }), "source", "single-public"),
    ).toEqual([]);
  });

  it("refuses a private project repository on public-only", () => {
    const issues = checkSuitability(identity(), "source", "single-public");
    expect(blockingIssues(issues)).toHaveLength(1);
    expect(issues[0].fix).toContain("Make it public");
  });

  it("refuses a repository the token cannot write to", () => {
    const issues = checkSuitability(
      identity({ canPush: false }),
      "source",
      "source-and-delivery",
    );
    expect(blockingIssues(issues)).toHaveLength(1);
    expect(issues[0].fix).toContain("Contents: Read and write");
  });

  /** The opposite requirement: Pages cannot serve a private repo for free. */
  it("refuses a private repository for the public site", () => {
    const issues = checkSuitability(
      identity({ isPrivate: true }),
      "delivery",
      "source-and-delivery",
    );
    expect(blockingIssues(issues)).toHaveLength(1);
    expect(issues[0].message).toContain("is private");
  });

  it("accepts a public repository for the public site", () => {
    expect(
      checkSuitability(
        identity({ isPrivate: false, name: "cluster-site" }),
        "delivery",
        "source-and-delivery",
      ),
    ).toEqual([]);
  });

  /** On the paid topology there is no separate delivery repository to judge. */
  it("does not demand a public delivery repository on the paid topology", () => {
    expect(
      checkSuitability(identity({ isPrivate: true }), "delivery", "single-private"),
    ).toEqual([]);
  });

  it("refuses the Studio's own repository", () => {
    const issues = checkSuitability(
      identity({ owner: "CaotcAftermth", name: "DinoDepot-Studio", isPrivate: true }),
      "source",
      "source-and-delivery",
    );
    expect(blockingIssues(issues).some((i) => i.message.includes("Studio"))).toBe(true);
  });

  it("matches the Studio repository whatever the casing", () => {
    const issues = checkSuitability(
      identity({ owner: "caotcaftermth", name: "dinodepot-studio" }),
      "source",
      "source-and-delivery",
    );
    expect(blockingIssues(issues)).not.toHaveLength(0);
  });

  /** A repository with files might be the right one — so warn, do not refuse. */
  it("warns without blocking when the repository is not empty", () => {
    const issues = checkSuitability(
      identity({ isEmpty: false }),
      "source",
      "source-and-delivery",
    );
    expect(blockingIssues(issues)).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
  });

  it("always says what to do about a problem", () => {
    const issues = checkSuitability(
      identity({ isPrivate: false, canPush: false, isEmpty: false }),
      "source",
      "source-and-delivery",
    );
    expect(issues.length).toBeGreaterThan(1);
    for (const issue of issues) expect(issue.fix).not.toBe("");
  });
});

describe("building a binding", () => {
  it("takes the default branch when none is chosen", () => {
    expect(bindingFor(identity({ defaultBranch: "trunk" })).branch).toBe("trunk");
  });

  it("prefers an explicit branch", () => {
    expect(bindingFor(identity({ defaultBranch: "trunk" }), "main").branch).toBe("main");
  });

  it("builds the remote rather than taking one from anywhere", () => {
    expect(bindingFor(identity()).remoteUrl).toBe(
      "https://github.com/ggfizz/cluster-source.git",
    );
  });

  it("falls back to main when GitHub names no default branch", () => {
    expect(bindingFor(identity({ defaultBranch: "" })).branch).toBe("main");
  });
});

describe("keeping a binding current", () => {
  it("reports nothing when nothing moved", () => {
    const update = reconcileBinding(binding(), identity());
    expect(update.change).toBe("none");
    expect(update.note).toBe("");
  });

  /**
   * The id matched, so this is the same repository under a new name — applied
   * and mentioned, never treated as the repository having disappeared.
   */
  it("follows a rename", () => {
    const update = reconcileBinding(binding(), identity({ name: "cluster-config" }));
    expect(update.change).toBe("renamed");
    expect(update.binding.githubId).toBe("123456789");
    expect(update.binding.name).toBe("cluster-config");
    expect(update.binding.remoteUrl).toBe(
      "https://github.com/ggfizz/cluster-config.git",
    );
    expect(update.note).toContain("renamed");
  });

  it("follows a transfer to another owner", () => {
    const update = reconcileBinding(binding(), identity({ owner: "gg-fizz-org" }));
    expect(update.change).toBe("transferred");
    expect(update.binding.owner).toBe("gg-fizz-org");
    expect(update.note).toContain("transferred");
  });

  it("follows a rename and a transfer at once", () => {
    const update = reconcileBinding(
      binding(),
      identity({ owner: "gg-fizz-org", name: "cluster-config" }),
    );
    expect(update.change).toBe("transferred");
    expect(update.binding.remoteUrl).toBe(
      "https://github.com/gg-fizz-org/cluster-config.git",
    );
  });

  /** Schema-1 projects arrive bound by name only and learn their id here. */
  it("completes a binding that has never known its id", () => {
    const update = reconcileBinding(binding({ githubId: "" }), identity());
    expect(update.change).toBe("named");
    expect(update.binding.githubId).toBe("123456789");
  });

  it("keeps the chosen branch when it learns the id", () => {
    const update = reconcileBinding(
      binding({ githubId: "", branch: "production" }),
      identity({ defaultBranch: "main" }),
    );
    expect(update.binding.branch).toBe("production");
  });

  it("notices a repository that has become public", () => {
    const update = reconcileBinding(binding(), identity({ isPrivate: false }));
    expect(update.binding.isPrivate).toBe(false);
  });

  it("tracks whether Pages is enabled", () => {
    const update = reconcileBinding(binding(), identity({ hasPages: true }));
    expect(update.binding.hasPages).toBe(true);
  });
});

describe("identity matching", () => {
  /** The guard against a project file redirecting credentials elsewhere. */
  it("trusts only the id, never the name", () => {
    expect(identityMatches(binding(), identity())).toBe(true);
    expect(identityMatches(binding(), identity({ githubId: "999" }))).toBe(false);
    // Same name, different repository.
    expect(
      identityMatches(binding({ githubId: "111" }), identity({ githubId: "222" })),
    ).toBe(false);
  });

  it("does not trust a binding that has no id yet", () => {
    expect(identityMatches(binding({ githubId: "" }), identity())).toBe(false);
  });
});

describe("pairing the two repositories", () => {
  const paired = (over: Partial<LocalProjectState> = {}) =>
    state({
      source: binding(),
      delivery: binding({ githubId: "987654321", name: "cluster-site", isPrivate: false }),
      ...over,
    });

  it("is happy with a private project and a public site", () => {
    expect(checkPairing(paired())).toBeNull();
  });

  /**
   * Publishing into the source repository would leave the private roster one
   * directory away from a public Pages site.
   */
  it("refuses the same repository for both", () => {
    const problem = checkPairing(paired({ delivery: binding() }));
    expect(problem?.message).toContain("same repository");
  });

  it("compares by id, not by name", () => {
    // Different ids that happen to share a name are still two repositories.
    const problem = checkPairing(
      paired({ delivery: binding({ githubId: "987654321", isPrivate: false }) }),
    );
    expect(problem).toBeNull();
  });

  it("refuses a private site repository on the free topology", () => {
    const problem = checkPairing(
      paired({ delivery: binding({ githubId: "987654321", name: "cluster-site" }) }),
    );
    expect(problem?.message).toContain("private");
  });

  it("has nothing to say about the paid topology", () => {
    expect(checkPairing(paired({ topology: "single-private", delivery: binding() }))).toBeNull();
  });

  it("has nothing to say before both are chosen", () => {
    expect(checkPairing(state({ source: binding() }))).toBeNull();
  });
});

describe("when a repository cannot be reached", () => {
  /** The promise: local work is never at risk, whatever GitHub says. */
  it("always reports the administrator's work as safe", () => {
    for (const code of STUDIO_ERROR_CODES) {
      const result = availabilityFor(code, "source", "ggfizz/cluster-source");
      expect(result.workIsSafe, code).toBe(true);
    }
  });

  it("switches off both operations when the project repository is gone", () => {
    const result = availabilityFor("repo.unavailable", "source", "ggfizz/cluster-source");
    expect(result.availability).toBe("unreachable");
    expect(result.disabled).toEqual(["sync", "publish"]);
    expect(result.offerReconnect).toBe(true);
  });

  /** Sync is unaffected by the site repository being unreachable. */
  it("switches off only publishing when the site repository is gone", () => {
    const result = availabilityFor("repo.unavailable", "delivery", "ggfizz/cluster-site");
    expect(result.disabled).toEqual(["publish"]);
  });

  it("treats being offline as temporary, with no reconnect offered", () => {
    const result = availabilityFor("network.offline", "source", "x/y");
    expect(result.availability).toBe("offline");
    expect(result.offerReconnect).toBe(false);
    expect(result.message).toContain("saved on this computer");
  });

  it("separates a revoked permission from a deleted repository", () => {
    expect(availabilityFor("auth.forbidden", "source", "x/y").availability).toBe("no-access");
    expect(availabilityFor("repo.unavailable", "source", "x/y").availability).toBe("unreachable");
  });

  it("asks for a sign-in when the credential is the problem", () => {
    for (const code of ["auth.missing", "auth.expired"]) {
      expect(availabilityFor(code, "source", "x/y").availability).toBe("signed-out");
    }
  });

  it("never speaks in Git terms", () => {
    for (const code of STUDIO_ERROR_CODES) {
      const { message } = availabilityFor(code, "source", "x/y");
      expect(leaksGitTerms(message), message).toEqual([]);
    }
  });
});

describe("the setup checklist", () => {
  it("starts by asking for a deliberate repository arrangement", () => {
    const steps = setupSteps(state());
    expect(steps[0].id).toBe("topology");
    expect(steps[0].done).toBe(false);
    expect(steps.slice(1).every((s) => s.blocked)).toBe(true);
    expect(currentStep(steps)?.id).toBe("topology");
  });

  it("unblocks choosing a repository once an account is connected", () => {
    const steps = setupSteps(
      state({ topologyConfirmed: true, githubAccountId: "9", githubLogin: "ggfizz" }),
    );
    const account = steps.find((s) => s.id === "account");
    expect(account?.done).toBe(true);
    expect(account?.detail).toContain("ggfizz");
    expect(steps.find((s) => s.id === "source")?.blocked).toBe(false);
    expect(currentStep(steps)?.id).toBe("source");
  });

  it("asks for a public site repository on the free topology", () => {
    const steps = setupSteps(
      state({ githubAccountId: "9", source: binding() }),
    );
    const delivery = steps.find((s) => s.id === "delivery");
    expect(delivery?.title).toContain("public site repository");
    expect(delivery?.done).toBe(false);
  });

  /** The paid topology has no second repository, so that step is not a gap. */
  it("counts the delivery step as done on the paid topology", () => {
    const steps = setupSteps(
      state({ githubAccountId: "9", source: binding(), topology: "single-private" }),
    );
    const delivery = steps.find((s) => s.id === "delivery");
    expect(delivery?.done).toBe(true);
    expect(delivery?.title).toContain("project repository");
  });

  it("is finished once source, publish, and Pages are confirmed", () => {
    const steps = setupSteps(
      state({
        githubAccountId: "9",
        source: binding(),
        delivery: binding({ githubId: "987", isPrivate: false, hasPages: true }),
        lastSyncedCommit: "c1",
        lastPublishedCommit: "p1",
      }),
    );
    expect(steps.every((s) => s.done)).toBe(true);
    expect(currentStep(steps)).toBeNull();
  });

  it("copes with no project at all", () => {
    const steps = setupSteps(null);
    expect(steps).toHaveLength(7);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it("uses the public source as the site on public-only", () => {
    const steps = setupSteps(
      state({
        topology: "single-public",
        githubAccountId: "9",
        source: binding({ isPrivate: false, hasPages: true }),
        lastSyncedCommit: "c1",
        lastPublishedCommit: "p1",
      }),
    );
    expect(steps.find((s) => s.id === "source")?.title).toContain("public");
    expect(steps.find((s) => s.id === "delivery")?.done).toBe(true);
    expect(steps.find((s) => s.id === "pages")?.done).toBe(true);
  });
});

describe("public-only privacy", () => {
  const safe = {
    topology: "single-public" as const,
    playerDataEnabled: false,
    playerCount: 0,
    cleanSlateCount: 0,
    hasPlayerActivity: false,
    hasPlayerHistory: false,
    hasPendingPlayerChanges: false,
  };

  it("allows a project with no Player Data evidence", () => {
    expect(publicSourcePrivacyProblem(safe)).toBe("");
  });

  it("blocks every retained form of Player Data evidence", () => {
    for (const changed of [
      { playerDataEnabled: true },
      { playerCount: 1 },
      { cleanSlateCount: 1 },
      { hasPlayerActivity: true },
      { hasPlayerHistory: true },
      { hasPendingPlayerChanges: true },
    ]) {
      expect(publicSourcePrivacyProblem({ ...safe, ...changed })).toContain(
        "Public-only cannot be used",
      );
    }
  });
});

describe("browser-guided setup", () => {
  /** Repository creation remains visible and deliberate on GitHub. */
  it("pre-fills the new-repository page as private for the project", () => {
    const url = new URL(newRepoUrl("cluster-source", "source"));
    expect(url.origin + url.pathname).toBe("https://github.com/new");
    expect(url.searchParams.get("name")).toBe("cluster-source");
    expect(url.searchParams.get("visibility")).toBe("private");
  });

  it("pre-fills it as public for the site", () => {
    const url = new URL(newRepoUrl("cluster-site", "delivery"));
    expect(url.searchParams.get("visibility")).toBe("public");
  });

  it("pre-fills a public source for public-only", () => {
    const url = new URL(newRepoUrl("cluster", "source", "single-public"));
    expect(url.searchParams.get("visibility")).toBe("public");
  });

  it("builds both project-site and user-site Pages addresses", () => {
    expect(pagesSiteUrl(binding({ owner: "GGFizz", name: "cluster" }))).toBe(
      "https://GGFizz.github.io/cluster/",
    );
    expect(pagesSiteUrl(binding({ owner: "GGFizz", name: "ggfizz.github.io" }))).toBe(
      "https://GGFizz.github.io/",
    );
  });

  it("escapes a name that would otherwise break the query", () => {
    const url = new URL(newRepoUrl("my repo&x=1", "source"));
    expect(url.searchParams.get("name")).toBe("my repo&x=1");
  });

  it("points at fine-grained tokens, which can be limited to one repository", () => {
    expect(newTokenUrl()).toContain("personal-access-tokens");
  });

  it("separates core access from optional collaborator management", () => {
    const required = REQUIRED_TOKEN_ACCESS.join(" ");
    expect(required).toContain("Only select repositories");
    expect(required).toContain("Contents: Read and write");
    expect(required).toContain("Metadata");
    expect(required).not.toContain("Administration");
    expect(required).not.toContain("Workflows");

    expect(OPTIONAL_TOKEN_ACCESS.join(" ")).toContain("Administration: Read and write");

    const unnecessary = UNNECESSARY_TOKEN_ACCESS.join(" ");
    expect(unnecessary).toContain("Workflows");
  });

  /** GitHub remains the fallback and source of truth for access. */
  it("links to the repository's own access settings", () => {
    expect(collaboratorsUrl(binding())).toBe(
      "https://github.com/ggfizz/cluster-source/settings/access",
    );
  });
});
