import { describe, expect, it } from "vitest";
import {
  applyImport,
  defaultDecision,
  diffImport,
  importCounts,
  isNoOp,
  mergeReimport,
  type ImportRecord,
} from "./creatureImport";
import {
  CreatureInfoSchema,
  emptyCreatureInfo,
  emptyMethod,
  emptyPhase,
  type CreatureInfo,
} from "./creatureInfo";

function info(over: Partial<CreatureInfo> = {}): CreatureInfo {
  return { ...emptyCreatureInfo(), ...over };
}

function knockout(name = "Knockout tame", strategy = ""): CreatureInfo["methods"][number] {
  return {
    ...emptyMethod("m1", name),
    outcome: "direct-tame",
    tags: ["knockout"],
    phases: [{ ...emptyPhase("p1", "Knock out"), steps: [{ id: "s1", text: "Tranq it" }] }],
    strategy,
  };
}

function record(over: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: "imp-1",
    bpPath: "/Game/X/Rex.Rex",
    creatureName: "Rex",
    status: "pending",
    source: {
      page: "Rex",
      section: "Taming",
      url: "",
      revisionId: 100,
      revisionTimestamp: "",
      importedAt: "2026-08-04T00:00:00.000Z",
      game: "ASA",
      mod: "",
    },
    rawText: {},
    proposed: info({ availability: "acquirable", methods: [knockout()] }),
    unresolved: [],
    ambiguities: [],
    confidence: "high",
    duplicatesParent: false,
    reviewNote: "",
    reviewedAt: null,
    ...over,
  };
}

describe("defaultDecision", () => {
  it("accepts nothing - the reviewer opts in", () => {
    const d = defaultDecision();
    expect(Object.values(d.sections).every((s) => s === "reject")).toBe(true);
    expect(d.keepLocalStrategy).toBe(true);
  });
});

describe("applyImport", () => {
  const proposed = info({
    availability: "acquirable",
    methods: [knockout("Knockout tame", "source strategy")],
    notes: "source notes",
    technical: { dragWeight: 400 },
  });

  it("changes nothing when every section is rejected", () => {
    const current = info({ notes: "mine", technical: { dragWeight: 150 } });
    expect(applyImport(current, proposed, defaultDecision())).toEqual(current);
  });

  it("applies only the accepted sections", () => {
    const current = info({ notes: "mine", technical: { dragWeight: 150 } });
    const decision = defaultDecision();
    decision.sections.notes = "accept";

    const next = applyImport(current, proposed, decision);
    expect(next.notes).toBe("source notes");
    expect(next.technical.dragWeight).toBe(150); // rejected, untouched
    expect(next.methods).toEqual([]);
  });

  it("preserves a hand-written strategy for a method it recognises", () => {
    const current = info({ methods: [knockout("Knockout tame", "trap it at the river")] });
    const decision = defaultDecision();
    decision.sections.acquisition = "accept";

    const next = applyImport(current, proposed, decision);
    expect(next.methods[0].strategy).toBe("trap it at the river");
    // The rest of the method still comes from the proposal.
    expect(next.methods[0].outcome).toBe("direct-tame");
  });

  it("replaces the strategy when the reviewer explicitly says so", () => {
    const current = info({ methods: [knockout("Knockout tame", "trap it at the river")] });
    const next = applyImport(current, proposed, {
      sections: { ...defaultDecision().sections, acquisition: "accept" },
      keepLocalStrategy: false,
    });
    expect(next.methods[0].strategy).toBe("source strategy");
  });

  it("does not carry a strategy across differently-named methods", () => {
    const current = info({ methods: [knockout("Trap and tranq", "trap it at the river")] });
    const decision = defaultDecision();
    decision.sections.acquisition = "accept";
    expect(applyImport(current, proposed, decision).methods[0].strategy).toBe(
      "source strategy",
    );
  });

  it("makes a variant own any section it accepts", () => {
    const current = info({ overrides: ["notes"] });
    const decision = defaultDecision();
    decision.sections.acquisition = "accept";

    const next = applyImport(current, proposed, decision);
    expect(next.overrides.sort()).toEqual(["acquisition", "notes"]);
  });

  it("works from nothing at all", () => {
    const next = applyImport(undefined, proposed, {
      sections: {
        acquisition: "accept",
        spawns: "accept",
        abilities: "accept",
        drops: "accept",
        technical: "accept",
        notes: "accept",
      },
      keepLocalStrategy: true,
    });
    expect(next.availability).toBe("acquirable");
    expect(next.technical.dragWeight).toBe(400);
  });
});

describe("diffImport", () => {
  it("reports a first-time record as an addition", () => {
    const diffs = diffImport(undefined, info({ availability: "acquirable", methods: [knockout()] }));
    const acquisition = diffs.find((d) => d.section === "acquisition")!;
    expect(acquisition.kind).toBe("add");
    expect(acquisition.lines.some((l) => l.field === "Availability")).toBe(true);
  });

  it("reports an identical proposal as no change", () => {
    const same = info({ availability: "acquirable", methods: [knockout()] });
    expect(isNoOp(diffImport(same, same))).toBe(true);
  });

  it("reports a modified section as a change, not an addition", () => {
    const current = info({ notes: "old" });
    const diffs = diffImport(current, info({ notes: "new" }));
    const notes = diffs.find((d) => d.section === "notes")!;
    expect(notes.kind).toBe("change");
    expect(notes.lines[0]).toMatchObject({ before: "old", after: "new" });
  });

  it("leaves untouched sections marked same", () => {
    const current = info({ notes: "keep", technical: { dragWeight: 150 } });
    const diffs = diffImport(current, info({ notes: "keep", technical: { dragWeight: 150 } }));
    expect(diffs.every((d) => d.kind === "same")).toBe(true);
  });
});

describe("mergeReimport", () => {
  it("leaves an existing record alone when the revision hasn't moved", () => {
    const existing = [record({ status: "accepted" })];
    const result = mergeReimport(existing, [record({ id: "imp-2" })]);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].status).toBe("accepted"); // review not reset
    expect(result.unchanged).toEqual(["Rex"]);
    expect(result.superseded).toEqual([]);
  });

  it("supersedes rather than overwrites when the source moved on", () => {
    const existing = [record({ status: "accepted" })];
    const fresh = record({ id: "imp-2", source: { ...record().source, revisionId: 200 } });
    const result = mergeReimport(existing, [fresh]);

    expect(result.records).toHaveLength(2);
    expect(result.records[0].status).toBe("superseded");
    expect(result.records[1].id).toBe("imp-2");
    expect(result.superseded).toEqual(["imp-1"]);
  });

  it("does not re-supersede an already superseded record", () => {
    const existing = [record({ status: "superseded" })];
    const fresh = record({ id: "imp-2", source: { ...record().source, revisionId: 200 } });
    expect(mergeReimport(existing, [fresh]).superseded).toEqual([]);
  });

  it("keeps records for other creatures untouched", () => {
    const existing = [record({ id: "imp-dodo", creatureName: "Dodo" })];
    const result = mergeReimport(existing, [record()]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].status).toBe("pending");
  });
});

describe("importCounts", () => {
  it("counts each status", () => {
    const counts = importCounts([
      record(),
      record({ id: "b", status: "accepted" }),
      record({ id: "c", status: "accepted" }),
      record({ id: "d", status: "rejected" }),
    ]);
    expect(counts).toEqual({ pending: 1, accepted: 2, rejected: 1, superseded: 0 });
  });
});

describe("round trip", () => {
  it("a staged proposal survives the schema unchanged", () => {
    const r = record();
    expect(CreatureInfoSchema.parse(r.proposed)).toEqual(r.proposed);
  });
});
