import { describe, expect, it } from "vitest";
import { buildOutputStates, summarizeOutputs } from "./outputs";
import type { OutputFamily } from "./history";
import {
  catalog,
  cosmetic,
  cosmetics,
  historyMatching,
  outputsFor,
  production,
  publishedHistory,
  remapEntry,
  remaps,
  rule,
  settings,
  source,
  players,
  REX,
} from "./overviewFixtures";
import { emptyProductionDraft } from "./production";
import { emptyRemapsDraft } from "./remaps";
import { emptyCosmeticsDraft } from "./cosmetics";
import { emptyCatalog } from "./catalog";
import { emptyPlayers } from "./players";
import { emptyHistory } from "./history";

const find = (states: ReturnType<typeof outputsFor>, family: OutputFamily) =>
  states.find((s) => s.family === family)!;

describe("buildOutputStates — semantic emptiness", () => {
  it("treats a brand-new project as having nothing to publish", () => {
    const states = outputsFor();
    for (const family of ["production", "remaps", "cosmetics"] as const) {
      const output = find(states, family);
      expect(output.hasContent, family).toBe(false);
      expect(output.dirty, family).toBe(false);
      expect(output.status, family).toBe("empty");
    }
  });

  // The precise bug this model exists to kill. An empty CCM list really is an
  // empty string, so the old `content.length > 0` check happened to work for
  // cosmetics — but production and remaps serialize to a JSON document that is
  // structurally empty and textually not, and both read as dirty on a project
  // where nobody had done anything yet.
  it("is not fooled by an empty document that still has characters in it", () => {
    const states = outputsFor();
    for (const family of ["production", "remaps"] as const) {
      const output = find(states, family);
      expect(output.content.length, family).toBeGreaterThan(0);
      expect(output.hasContent, family).toBe(false);
    }
  });

  it("does not count a disabled rule as production content", () => {
    const states = outputsFor({ production: production(rule({ enabled: false })) });
    expect(find(states, "production").hasContent).toBe(false);
  });

  it("does not count an inactive remap as remap content", () => {
    const states = outputsFor({ remaps: remaps(remapEntry({ active: false })) });
    expect(find(states, "remaps").hasContent).toBe(false);
  });

  it("does not count a deprecated cosmetic as publishable content", () => {
    // Included but delisted: held back from the file, so it is not content.
    const states = outputsFor({
      cosmetics: cosmetics(
        cosmetic({ included: true, deprecatedAt: "2026-08-01T00:00:00.000Z" }),
      ),
    });
    expect(find(states, "cosmetics").hasContent).toBe(false);
  });

  it("does not count an excluded cosmetic as publishable content", () => {
    const states = outputsFor({ cosmetics: cosmetics(cosmetic({ included: false })) });
    expect(find(states, "cosmetics").hasContent).toBe(false);
  });

  it("counts an active included cosmetic", () => {
    const states = outputsFor({ cosmetics: cosmetics(cosmetic()) });
    expect(find(states, "cosmetics").hasContent).toBe(true);
  });

  it("counts an enabled rule as content", () => {
    const states = outputsFor({ production: production(rule()) });
    const output = find(states, "production");
    expect(output.hasContent).toBe(true);
    expect(output.status).toBe("unpublished");
  });
});

describe("buildOutputStates — publish comparison", () => {
  it("is published when the draft matches what was published", () => {
    const fixture = { production: production(rule()) };
    const states = outputsFor({ ...fixture, history: historyMatching(fixture) });
    expect(find(states, "production").status).toBe("published");
    expect(find(states, "production").dirty).toBe(false);
  });

  it("reports changes pending once the draft moves on", () => {
    const fixture = { production: production(rule()) };
    const history = historyMatching(fixture);
    const states = outputsFor({
      production: production(rule({ chanceToProduce: 0.5 })),
      history,
    });
    expect(find(states, "production").status).toBe("changed");
    expect(find(states, "production").dirty).toBe(true);
  });

  it("still reports a change when a published output is emptied", () => {
    // The remote holds the old content — going empty is a real change.
    const fixture = { production: production(rule()) };
    const history = historyMatching(fixture);
    const states = outputsFor({ history });
    const output = find(states, "production");
    expect(output.hasContent).toBe(false);
    expect(output.status).toBe("changed");
    expect(output.dirty).toBe(true);
  });

  it("carries the publish record for the commit details", () => {
    const fixture = { production: production(rule()) };
    const states = outputsFor({ ...fixture, history: historyMatching(fixture) });
    expect(find(states, "production").lastRecord?.commitSha).toBe("abc1234");
    expect(find(states, "production").lastPublishedAt).toBe(
      "2026-08-01T10:00:00.000Z",
    );
  });
});

describe("buildOutputStates — applicability", () => {
  it("marks Player Data disabled when the module is off", () => {
    const output = find(outputsFor(), "players");
    expect(output.applicable).toBe(false);
    expect(output.status).toBe("disabled");
  });

  it("includes Player Data once the module is on", () => {
    const states = outputsFor({
      settings: settings({ modules: { "player-data": true } }),
      players: players(2),
    });
    const output = find(states, "players");
    expect(output.applicable).toBe(true);
    expect(output.hasContent).toBe(true);
  });

  it("keeps a disabled output out of the totals", () => {
    const totals = summarizeOutputs(outputsFor());
    expect(totals.dirty.some((o) => o.family === "players")).toBe(false);
    expect(totals.withContent.some((o) => o.family === "players")).toBe(false);
  });

  it("hashes the roster without its generation stamp", () => {
    // Two builds moments apart must agree, or Player Data reads as dirty
    // forever — the roster stamps `generatedAt` into its own output.
    const fixture = {
      settings: settings({ modules: { "player-data": true } }),
      players: players(1),
    };
    expect(find(outputsFor(fixture), "players").hash).toBe(
      find(outputsFor(fixture), "players").hash,
    );
    const published = historyMatching(fixture);
    expect(find(outputsFor({ ...fixture, history: published }), "players").status).toBe(
      "published",
    );
  });
});

describe("buildOutputStates — viewer outputs", () => {
  it("has no viewer data until production does", () => {
    expect(find(outputsFor(), "viewerData").hasContent).toBe(false);
  });

  it("has viewer data once a rule exists", () => {
    const states = outputsFor({ production: production(rule()) });
    expect(find(states, "viewerData").hasContent).toBe(true);
  });

  it("blocks viewer data on production errors", () => {
    // An empty blueprint path is a production error; the viewer must not
    // publish data built from it.
    const states = outputsFor({ production: production(rule({ dinoType: "" })) });
    expect(find(states, "production").errors).toBeGreaterThan(0);
    expect(find(states, "viewerData").status).toBe("blocked");
  });

  it("has no viewer page to publish until there is data for it to show", () => {
    // The page is a shell that fetches the data file. Counting it as content
    // on a new project made every fresh project open with pending work.
    const output = find(outputsFor(), "viewerPage");
    expect(output.hasContent).toBe(false);
    expect(output.status).toBe("empty");
  });

  it("has a viewer page once production gives it something to show", () => {
    const output = find(outputsFor({ production: production(rule()) }), "viewerPage");
    expect(output.hasContent).toBe(true);
    expect(output.status).toBe("unpublished");
  });

  it("has no viewer page without settings", () => {
    const output = find(
      outputsFor({ settings: null, production: production(rule()) }),
      "viewerPage",
    );
    expect(output.hasContent).toBe(false);
  });
});

describe("summarizeOutputs", () => {
  it("counts errors, dirt and synchronization across applicable outputs", () => {
    const fixture = {
      production: production(rule()),
      cosmetics: cosmetics(cosmetic()),
    };
    const history = historyMatching(fixture);
    // Cosmetics move on, everything else stays put.
    const totals = summarizeOutputs(
      outputsFor({
        ...fixture,
        cosmetics: cosmetics(cosmetic(), cosmetic({ id: "cm2", modId: "333" })),
        history,
      }),
    );
    expect(totals.errors).toBe(0);
    expect(totals.dirty.map((o) => o.family)).toEqual(["cosmetics"]);
    expect(totals.synchronized.length).toBe(4);
  });

  it("reports the outputs that are blocked", () => {
    const totals = summarizeOutputs(
      outputsFor({ production: production(rule({ dinoType: "" })) }),
    );
    expect(totals.blocked.map((o) => o.family).sort()).toEqual([
      "production",
      "viewerData",
    ]);
  });
});

describe("buildOutputStates — inputs", () => {
  it("builds from wholly empty inputs without a settings object", () => {
    // Overview renders before a project finishes loading.
    const states = buildOutputStates({
      production: emptyProductionDraft(),
      remaps: emptyRemapsDraft(),
      cosmetics: emptyCosmeticsDraft(),
      catalog: emptyCatalog(),
      players: emptyPlayers(),
      history: emptyHistory(),
      imageFiles: [],
      settings: null,
      index: null,
    });
    expect(states).toHaveLength(6);
    expect(states.every((s) => s.path === "")).toBe(true);
  });

  it("exposes each output's repository path", () => {
    const states = outputsFor({ catalog: catalog(source()) });
    expect(find(states, "production").path).toBe(
      settings().github.paths.production,
    );
  });

  it("keeps the presentation order stable", () => {
    expect(outputsFor().map((s) => s.family)).toEqual([
      "production",
      "remaps",
      "cosmetics",
      "viewerData",
      "viewerPage",
      "players",
    ]);
  });

  it("labels a published-then-unchanged remap correctly", () => {
    const fixture = { remaps: remaps(remapEntry()) };
    const states = outputsFor({ ...fixture, history: historyMatching(fixture) });
    expect(find(states, "remaps").status).toBe("published");
  });

  it("ignores a publish record belonging to another family", () => {
    const states = outputsFor({
      production: production(rule()),
      history: publishedHistory([{ family: "remaps", hash: "deadbeef" }]),
    });
    expect(find(states, "production").lastRecord).toBeNull();
    expect(find(states, "production").status).toBe("unpublished");
  });

  it("does not treat a rule for an unknown creature as an error without a catalog", () => {
    // No index means no catalog cross-checks; the rule is structurally fine.
    const states = outputsFor({ production: production(rule({ dinoType: REX })) });
    expect(find(states, "production").errors).toBe(0);
  });
});
