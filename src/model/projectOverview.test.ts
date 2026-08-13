import { describe, expect, it } from "vitest";
import {
  activeWatched,
  ATTENTION_RANK,
  watchedNeedingReview,
} from "./projectOverview";
import { githubReadiness } from "./githubReadiness";
import {
  catalog,
  cosmetic,
  cosmetics,
  historyMatching,
  outputsFor,
  overviewFor,
  production,
  remapEntry,
  remaps,
  rule,
  settings,
  source,
  watched,
  watchlist,
  players,
  githubConfig,
} from "./overviewFixtures";

/** A project with a rule and a remap, everything published and in sync. */
function healthyFixture() {
  const base = {
    production: production(rule()),
    remaps: remaps(remapEntry()),
    cosmetics: cosmetics(cosmetic()),
  };
  return { ...base, history: historyMatching(base) };
}

const card = (model: ReturnType<typeof overviewFor>, id: string) =>
  model.inventory.find((c) => c.id === id)!;
const item = (model: ReturnType<typeof overviewFor>, id: string) =>
  model.attention.find((a) => a.id === id);

describe("project health", () => {
  it("calls a fully published project healthy", () => {
    const model = overviewFor(healthyFixture());
    expect(model.health).toBe("healthy");
    expect(model.attention).toHaveLength(0);
    expect(model.synchronized).toEqual({ count: 5, total: 5 });
  });

  it("calls a brand-new empty project healthy, not dirty", () => {
    // Nothing configured is a legitimate starting state, not a problem.
    const model = overviewFor();
    expect(model.health).toBe("healthy");
    expect(model.attention).toHaveLength(0);
    expect(model.headline).toMatch(/Nothing configured yet/);
  });

  it("reports changes pending when an output has moved on", () => {
    const base = healthyFixture();
    const model = overviewFor({
      ...base,
      production: production(rule({ chanceToProduce: 0.25 })),
    });
    expect(model.health).toBe("changes");
    expect(item(model, "unpublished")?.detail).toContain("Passive Production");
  });

  it("is blocked by validation errors", () => {
    const model = overviewFor({ production: production(rule({ dinoType: "" })) });
    expect(model.health).toBe("blocked");
    expect(item(model, "validation-errors")?.tone).toBe("error");
  });

  it("ranks warnings above pending changes", () => {
    // A remap whose source mod is still enabled warns; the project also has
    // unpublished work. Attention outranks changes.
    const model = overviewFor({
      remaps: remaps(remapEntry({ intentional: false, toClass: "" })),
    });
    expect(model.health).toBe("blocked");
  });

  it("is attention-level for a watched mod needing review", () => {
    const model = overviewFor({
      ...healthyFixture(),
      watchlist: watchlist(watched({ needsReview: true })),
    });
    expect(model.health).toBe("attention");
  });

  it("is attention-level for a disabled content source", () => {
    const model = overviewFor({
      ...healthyFixture(),
      catalog: catalog(source({ enabled: false })),
    });
    expect(model.health).toBe("attention");
  });
});

describe("publishing readiness gates health", () => {
  it("does not block an empty project for having no GitHub destination", () => {
    // Nothing to publish means nowhere to publish it to — not a red banner.
    const model = overviewFor({ github: githubConfig({ owner: "", repo: "", branch: "" }) });
    expect(model.health).toBe("healthy");
    expect(item(model, "github-not-ready")).toBeUndefined();
  });

  it("blocks a project that has content but no destination", () => {
    const model = overviewFor({
      production: production(rule()),
      github: githubConfig({ owner: "", repo: "", branch: "" }),
    });
    expect(model.health).toBe("blocked");
    expect(item(model, "github-not-ready")?.label).toBe(
      "GitHub publishing is not configured",
    );
  });

  it("blocks a project with content when the token is missing", () => {
    // The destination is complete, so this is a different message.
    const model = overviewFor({
      production: production(rule()),
      tokenPresent: false,
    });
    expect(model.health).toBe("blocked");
    expect(item(model, "github-not-ready")?.label).toBe("Publishing is not ready");
    expect(item(model, "github-not-ready")?.detail).toContain("No GitHub token");
  });

  it("blocks a project with content outside the desktop app", () => {
    const model = overviewFor({ production: production(rule()), desktop: false });
    expect(model.github.ready).toBe(false);
    expect(model.github.blockers).toContain(
      "Publishing only runs in the desktop app",
    );
  });

  it("does not claim a blocker while the token check is still running", () => {
    const readiness = githubReadiness({
      github: githubConfig(),
      outputs: outputsFor(),
      tokenPresent: null,
      desktop: true,
      connection: "unknown",
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toHaveLength(0);
  });

  it("separates configured, ready and verified", () => {
    const outputs = outputsFor();
    const base = { github: githubConfig(), outputs, desktop: true };
    const configuredOnly = githubReadiness({
      ...base,
      tokenPresent: false,
      connection: "unknown",
    });
    expect(configuredOnly.destinationConfigured).toBe(true);
    expect(configuredOnly.ready).toBe(false);
    expect(configuredOnly.verified).toBe(false);

    const ready = githubReadiness({ ...base, tokenPresent: true, connection: "unknown" });
    expect(ready.ready).toBe(true);
    expect(ready.verified).toBe(false);

    const verified = githubReadiness({ ...base, tokenPresent: true, connection: "ok" });
    expect(verified.verified).toBe(true);
    expect(verified.target).toBe("ggfizz/cluster@main");
  });

  it("stays healthy when ready but not verified this session", () => {
    // Not having clicked Test Connection is not a defect. The distinction is
    // carried on the publishing target chip, not by downgrading health.
    const model = overviewFor({ ...healthyFixture(), connection: "unknown" });
    expect(model.health).toBe("healthy");
    expect(model.attention).toHaveLength(0);
    expect(model.github.ready).toBe(true);
    expect(model.github.verified).toBe(false);
  });

  it("never reports attention items on a healthy project", () => {
    // The banner and the attention card must never contradict each other.
    for (const fixture of [{}, healthyFixture(), { ...healthyFixture(), connection: "unknown" as const }]) {
      const model = overviewFor(fixture);
      if (model.health === "healthy") expect(model.attention).toHaveLength(0);
    }
  });
});

describe("watchlist counting", () => {
  it("counts only actively watched mods", () => {
    const model = overviewFor({
      ...healthyFixture(),
      watchlist: watchlist(
        watched({ id: "a", watching: true }),
        watched({ id: "b", watching: false }),
        watched({ id: "c", watching: false }),
      ),
    });
    expect(card(model, "watched").value).toBe("1");
  });

  it("ignores a parked entry that still needs review", () => {
    // History, not a current problem: the cluster no longer runs that mod.
    const list = watchlist(watched({ watching: false, needsReview: true }));
    expect(activeWatched(list)).toHaveLength(0);
    expect(watchedNeedingReview(list)).toHaveLength(0);

    const model = overviewFor({ ...healthyFixture(), watchlist: list });
    expect(model.health).toBe("healthy");
    expect(item(model, "mods-need-review")).toBeUndefined();
  });

  it("raises one aggregated row for several mods needing review", () => {
    const model = overviewFor({
      ...healthyFixture(),
      watchlist: watchlist(
        watched({ id: "a", name: "Alpha", needsReview: true }),
        watched({ id: "b", name: "Beta", needsReview: true }),
        watched({ id: "c", name: "Gamma", needsReview: true }),
        watched({ id: "d", name: "Delta", needsReview: true }),
      ),
    });
    const row = item(model, "mods-need-review")!;
    expect(row.label).toBe("4 watched mods need review");
    expect(row.detail).toBe("Alpha, Beta, Gamma, +1 more");
    expect(model.attention.filter((a) => a.id === "mods-need-review")).toHaveLength(1);
  });

  it("says 'needs' for a single mod", () => {
    const model = overviewFor({
      ...healthyFixture(),
      watchlist: watchlist(watched({ needsReview: true })),
    });
    expect(item(model, "mods-need-review")?.label).toBe("1 watched mod needs review");
  });
});

describe("inventory cards", () => {
  it("leads with the publishable cosmetic count, not the catalogue", () => {
    const model = overviewFor({
      cosmetics: cosmetics(
        cosmetic({ id: "a", modId: "1" }),
        cosmetic({ id: "b", modId: "2" }),
        cosmetic({ id: "c", modId: "3", deprecatedAt: "2026-08-01T00:00:00.000Z" }),
        cosmetic({ id: "d", modId: "4", included: false }),
      ),
    });
    const cosmeticsCard = card(model, "cosmetics");
    expect(cosmeticsCard.value).toBe("2");
    expect(cosmeticsCard.sub).toContain("4 cataloged");
    expect(cosmeticsCard.sub).toContain("1 deprecated");
  });

  it("splits enabled and disabled production rules", () => {
    const model = overviewFor({
      production: production(rule({ id: "a" }), rule({ id: "b", enabled: false })),
    });
    expect(card(model, "production").value).toBe("1");
    expect(card(model, "production").sub).toContain("1 disabled");
    expect(card(model, "production").sub).toContain("All valid");
  });

  it("flags a production card carrying errors", () => {
    const model = overviewFor({ production: production(rule({ dinoType: "" })) });
    expect(card(model, "production").alert).toBe(true);
    expect(card(model, "production").sub).toContain("error");
  });

  it("splits active and inactive remaps", () => {
    const model = overviewFor({
      remaps: remaps(remapEntry({ id: "a" }), remapEntry({ id: "b", active: false })),
    });
    expect(card(model, "remaps").value).toBe("1");
    expect(card(model, "remaps").sub).toContain("1 inactive");
  });

  it("reports content sources and their trouble", () => {
    const model = overviewFor({
      catalog: catalog(source({ id: "a" }), source({ id: "b", removed: true })),
    });
    expect(card(model, "sources").value).toBe("2");
    expect(card(model, "sources").sub).toBe("1 disabled or removing");
    expect(card(model, "sources").alert).toBe(true);
  });

  it("says Official ASA only when no mods are catalogued", () => {
    expect(card(overviewFor(), "sources").sub).toBe("Official ASA only");
  });

  it("navigates each card to its page", () => {
    const model = overviewFor();
    expect(model.inventory.map((c) => c.to)).toEqual([
      "/production",
      "/remaps",
      "/curseforge",
      "/curseforge",
      "/content",
    ]);
  });
});

describe("attention ordering and aggregation", () => {
  it("puts blocking problems before readiness, warnings and pending work", () => {
    const model = overviewFor({
      production: production(rule({ dinoType: "" })),
      remaps: remaps(remapEntry({ intentional: false })),
      catalog: catalog(source({ removed: true }), source({ id: "s2", enabled: false })),
      watchlist: watchlist(watched({ needsReview: true })),
      tokenPresent: false,
    });
    const ranks = model.attention.map((a) => a.rank);
    expect([...ranks]).toEqual([...ranks].sort((a, b) => a - b));
    expect(model.attention[0].id).toBe("validation-errors");
    expect(model.attention[0].rank).toBe(ATTENTION_RANK.blocking);
    expect(model.attention[1].id).toBe("github-not-ready");
  });

  it("aggregates sources rather than listing one row each", () => {
    const model = overviewFor({
      ...healthyFixture(),
      catalog: catalog(
        source({ id: "a", removed: true }),
        source({ id: "b", removed: true }),
        source({ id: "c", enabled: false }),
      ),
    });
    expect(item(model, "sources-removing")?.label).toBe("2 content sources being removed");
    expect(item(model, "sources-disabled")?.label).toBe("1 content source disabled");
  });

  it("does not repeat a blocked output as unpublished changes", () => {
    // It is already named in the errors row, and it cannot be published
    // anyway — two rows for one problem is the noise this aggregation exists
    // to prevent.
    const model = overviewFor({ production: production(rule({ dinoType: "" })) });
    expect(item(model, "validation-errors")?.detail).toContain("Passive Production");
    expect(item(model, "unpublished")).toBeUndefined();
  });

  it("names the outputs with unpublished changes", () => {
    const base = healthyFixture();
    const model = overviewFor({
      ...base,
      cosmetics: cosmetics(cosmetic(), cosmetic({ id: "x", modId: "777" })),
    });
    expect(item(model, "unpublished")?.label).toBe("1 output has unpublished changes");
    expect(item(model, "unpublished")?.detail).toBe("Custom Cosmetics");
  });

  it("routes every attention item somewhere real", () => {
    const model = overviewFor({
      production: production(rule({ dinoType: "" })),
      watchlist: watchlist(watched({ needsReview: true })),
      catalog: catalog(source({ enabled: false })),
      tokenPresent: false,
    });
    const routes = new Set(["/publish", "/settings", "/curseforge", "/content"]);
    for (const a of model.attention) expect(routes.has(a.to), a.id).toBe(true);
  });
});

describe("next actions", () => {
  it("does not nag about GitHub on a project with nothing to publish", () => {
    // Offering a chore beside a "Project healthy" banner reads as a
    // contradiction, and there is nothing to send to a repository yet.
    const model = overviewFor({
      github: githubConfig({ owner: "", repo: "", branch: "" }),
    });
    expect(model.health).toBe("healthy");
    expect(model.actions.map((a) => a.id)).not.toContain("configure-github");
    expect(model.actions.every((a) => !a.primary)).toBe(true);
  });

  it("offers GitHub configuration once there is something to publish", () => {
    const model = overviewFor({
      production: production(rule()),
      github: githubConfig({ owner: "", repo: "", branch: "" }),
    });
    expect(model.actions.map((a) => a.id)).toContain("configure-github");
  });

  it("offers contextual actions when there is outstanding work", () => {
    const base = healthyFixture();
    const model = overviewFor({
      ...base,
      production: production(rule({ chanceToProduce: 0.5 })),
      watchlist: watchlist(watched({ needsReview: true })),
    });
    const ids = model.actions.map((a) => a.id);
    expect(ids).toContain("review-mods");
    expect(ids).toContain("publish");
    expect(model.actions.every((a) => a.primary)).toBe(true);
  });

  it("does not offer publishing while errors block it", () => {
    const model = overviewFor({ production: production(rule({ dinoType: "" })) });
    const ids = model.actions.map((a) => a.id);
    expect(ids).toContain("fix-errors");
    expect(ids).not.toContain("publish");
  });

  it("falls back to common tasks when nothing is outstanding", () => {
    const model = overviewFor(healthyFixture());
    expect(model.actions.every((a) => !a.primary)).toBe(true);
    expect(model.actions.map((a) => a.id)).toContain("simulate");
  });
});

describe("optional outputs in the publishing list", () => {
  it("shows Player Data as disabled rather than unhealthy", () => {
    const model = overviewFor(healthyFixture());
    const playersOutput = model.outputs.find((o) => o.family === "players")!;
    expect(playersOutput.status).toBe("disabled");
    expect(model.health).toBe("healthy");
    // Disabled outputs are excluded from the synchronized tally.
    expect(model.synchronized.total).toBe(5);
  });

  it("counts Player Data once the module is on", () => {
    const base = {
      ...healthyFixture(),
      settings: settings({ modules: { "player-data": true } }),
      players: players(3),
    };
    const model = overviewFor({ ...base, history: historyMatching(base) });
    expect(model.synchronized).toEqual({ count: 6, total: 6 });
    expect(model.health).toBe("healthy");
  });

  it("includes viewer outputs in the publishing health", () => {
    // Production published but the viewer left behind — still pending work.
    const fixture = { production: production(rule()) };
    const history = historyMatching(fixture);
    const model = overviewFor({
      ...fixture,
      history: {
        ...history,
        records: history.records.filter(
          (r) => r.family !== "viewerData" && r.family !== "viewerPage",
        ),
      },
    });
    expect(model.health).toBe("changes");
    expect(item(model, "unpublished")?.detail).toContain("Cluster Viewer Data");
    expect(item(model, "unpublished")?.detail).toContain("Cluster Viewer Page");
  });
});
