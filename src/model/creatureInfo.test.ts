import { describe, expect, it } from "vitest";
import {
  ABILITY_KINDS,
  ABILITY_PRESETS,
  abilityPresetFor,
  applyTemplate,
  creatureInfoSummary,
  CreatureInfo,
  CreatureInfoSchema,
  describeTemplate,
  DROP_LISTS,
  DropEntry,
  dropCount,
  emptyCreatureInfo,
  emptyAbilityEffectRow,
  emptyDropEntry,
  effectShape,
  emptyDrops,
  formatRate,
  hasDrops,
  emptyMethod,
  emptyPhase,
  hasCreatureInfo,
  inheritSection,
  METHOD_TEMPLATES,
  TAG_LABELS,
  methodLabel,
  methodStepCount,
  overrideSection,
  phaseHasOutcomes,
  pruneCreatureInfo,
  resolveCreatureInfo,
} from "./creatureInfo";

const info = (patch: Partial<CreatureInfo> = {}): CreatureInfo => ({
  ...emptyCreatureInfo(),
  ...patch,
});

let n = 0;
const ids = () => `id-${++n}`;

// ---------------------------------------------------------------------------

describe("CreatureInfo schema", () => {
  it("defaults an untouched creature to nothing recorded", () => {
    const parsed = CreatureInfoSchema.parse({});
    expect(parsed.availability).toBe("");
    expect(parsed.methods).toEqual([]);
    expect(parsed.technical.dragWeight).toBeNull();
    expect(parsed.overrides).toEqual([]);
  });

  it("accepts a multi-method creature", () => {
    const parsed = CreatureInfoSchema.parse({
      availability: "acquirable",
      methods: [
        { id: "a", name: "Knockout", tags: ["knockout"] },
        { id: "b", name: "Mounted hunt", tags: ["trust", "mounted"] },
      ],
    });
    expect(parsed.methods).toHaveLength(2);
    expect(parsed.methods[1].tags).toEqual(["trust", "mounted"]);
  });

  it("rejects an availability it doesn't know", () => {
    expect(
      CreatureInfoSchema.safeParse({ availability: "maybe" }).success,
    ).toBe(false);
  });

  it("rejects a method outcome it doesn't know", () => {
    expect(
      CreatureInfoSchema.safeParse({
        methods: [{ id: "m", outcome: "borrowed" }],
      }).success,
    ).toBe(false);
  });

  it("degrades an unrecognised legacy status rather than losing the record", () => {
    const out = CreatureInfoSchema.parse({
      status: "bribed",
      notes: "keep me",
    }) as CreatureInfo;
    expect(out.availability).toBe("");
    expect(out.notes).toBe("keep me");
  });

  it("keeps a drag weight of zero rather than treating it as unset", () => {
    expect(
      CreatureInfoSchema.parse({ technical: { dragWeight: 0 } }).technical
        .dragWeight,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("legacy migration", () => {
  const legacy = {
    tameMethod: "knockout",
    dragWeight: 150,
    foods: [
      { id: "f1", bpPath: "/Game/x/Cake.Cake", note: "best" },
      { id: "f2", bpPath: "/Game/x/Berry.Berry", note: "" },
    ],
    steps: [
      { id: "s1", text: "Trap it" },
      { id: "s2", text: "Tranq it" },
    ],
    abilities: [{ id: "a1", label: "Causes bleed", detail: "" }],
    notes: "Night spawns only",
  };

  it("turns the old single tame into one method", () => {
    const out = CreatureInfoSchema.parse(legacy) as CreatureInfo;
    expect(out.methods).toHaveLength(1);
    expect(out.methods[0].name).toBe("Knockout tame");
    expect(out.methods[0].tags).toEqual(["knockout"]);
  });

  it("maps the old status onto availability plus a method outcome", () => {
    const out = CreatureInfoSchema.parse(legacy) as CreatureInfo;
    expect(out.availability).toBe("acquirable");
    expect(out.methods[0].outcome).toBe("direct-tame");
    expect(
      (CreatureInfoSchema.parse({ tameMethod: "none" }) as CreatureInfo)
        .availability,
    ).toBe("unavailable");
  });

  it("carries foods over as taming-food inputs, in order", () => {
    const method = (CreatureInfoSchema.parse(legacy) as CreatureInfo).methods[0];
    expect(method.inputs.map((i) => i.bpPath)).toEqual([
      "/Game/x/Cake.Cake",
      "/Game/x/Berry.Berry",
    ]);
    expect(method.inputs.every((i) => i.role === "taming-food")).toBe(true);
    expect(method.inputs[0].note).toBe("best");
  });

  it("wraps the flat step list in a single phase", () => {
    const method = (CreatureInfoSchema.parse(legacy) as CreatureInfo).methods[0];
    expect(method.phases).toHaveLength(1);
    expect(method.phases[0].steps.map((s) => s.text)).toEqual([
      "Trap it",
      "Tranq it",
    ]);
  });

  it("moves drag weight under technical and keeps abilities and notes", () => {
    const out = CreatureInfoSchema.parse(legacy) as CreatureInfo;
    expect(out.technical.dragWeight).toBe(150);
    expect(out.abilities[0].label).toBe("Causes bleed");
    expect(out.notes).toBe("Night spawns only");
  });

  it("creates no method when the old record had only a drag weight", () => {
    const out = CreatureInfoSchema.parse({ dragWeight: 42 }) as CreatureInfo;
    expect(out.methods).toEqual([]);
    expect(out.technical.dragWeight).toBe(42);
  });

  it("infers a reference type for v1 inputs that had none", () => {
    const out = CreatureInfoSchema.parse({
      status: "tameable",
      methods: [
        {
          id: "m",
          inputs: [
            { id: "a", bpPath: "/Game/x/Cake.Cake", role: "taming-food" },
            { id: "b", label: "any berry", role: "aid" },
          ],
        },
      ],
    }) as CreatureInfo;
    expect(out.methods[0].inputs[0].referenceType).toBe("item");
    expect(out.methods[0].inputs[1].referenceType).toBe("text");
  });

  it("renames the v1 input roles", () => {
    const out = CreatureInfoSchema.parse({
      methods: [
        {
          id: "m",
          inputs: [
            { id: "a", role: "buff" },
            { id: "b", role: "aid" },
          ],
        },
      ],
    }) as CreatureInfo;
    expect(out.methods[0].inputs.map((i) => i.role)).toEqual([
      "required-buff",
      "optional-aid",
    ]);
  });

  it("turns a v1 host item into a host creature reference", () => {
    const out = CreatureInfoSchema.parse({
      methods: [
        {
          id: "m",
          inputs: [{ id: "a", bpPath: "/Game/x/Thing.Thing", role: "host-item" }],
        },
      ],
    }) as CreatureInfo;
    const input = out.methods[0].inputs[0];
    expect(input.role).toBe("host-creature");
    // It pointed at an item, so it now needs re-picking — but the path is
    // kept rather than dropped so the reviewer can see what it was.
    expect(input.referenceType).toBe("creature");
    expect(input.bpPath).toBe("/Game/x/Thing.Thing");
  });

  it("gives v1 phases the new optional outcome fields, empty", () => {
    const out = CreatureInfoSchema.parse({
      methods: [
        { id: "m", phases: [{ id: "p", name: "Go", steps: [] }] },
      ],
    }) as CreatureInfo;
    const phase = out.methods[0].phases[0];
    expect(phase.repeatUntil).toBe("");
    expect(phase.failureOrReset).toBe("");
    expect(phaseHasOutcomes(phase)).toBe(false);
  });

  it("leaves an already-migrated record alone", () => {
    const modern = info({ availability: "acquirable", notes: "hi" });
    expect(CreatureInfoSchema.parse(modern)).toEqual(modern);
  });
});

// ---------------------------------------------------------------------------

describe("variant inheritance", () => {
  const parent = info({
    availability: "acquirable",
    methods: [emptyMethod("m1", "Knockout")],
    abilities: [{ id: "a1", label: "Pack bonus", detail: "", kind: "passive" as const, effect: "none" as const, rows: []  }],
    technical: { dragWeight: 150 },
    notes: "parent notes",
  });

  it("inherits every section when the variant overrides nothing", () => {
    const r = resolveCreatureInfo(info(), parent, "/Game/Rex");
    expect(r.info.availability).toBe("acquirable");
    expect(r.info.notes).toBe("parent notes");
    expect(r.inheritedFrom).toBe("/Game/Rex");
    expect(r.inheritedSections).toEqual([
      "acquisition",
      "spawns",
      "abilities",
      "drops",
      "technical",
      "notes",
    ]);
  });

  it("uses the variant's own data for an overridden section only", () => {
    const own = info({
      overrides: ["technical"],
      technical: { dragWeight: 999 },
    });
    const r = resolveCreatureInfo(own, parent, "/Game/Rex");
    expect(r.info.technical.dragWeight).toBe(999);
    expect(r.info.notes).toBe("parent notes");
    expect(r.inheritedSections).not.toContain("technical");
  });

  it("owns everything when there is no parent", () => {
    const r = resolveCreatureInfo(info({ notes: "mine" }), undefined, null);
    expect(r.inheritedFrom).toBeNull();
    expect(r.inheritedSections).toEqual([]);
    expect(r.info.notes).toBe("mine");
  });

  it("seeds an override with what was being inherited", () => {
    const own = overrideSection(info(), parent, "acquisition");
    expect(own.overrides).toContain("acquisition");
    expect(own.availability).toBe("acquirable");
    expect(own.methods).toHaveLength(1);
  });

  it("copies rather than aliases the parent's methods", () => {
    const own = overrideSection(info(), parent, "acquisition");
    own.methods[0].name = "Changed";
    expect(parent.methods[0].name).toBe("Knockout");
  });

  it("drops the variant's copy when a section goes back to inheriting", () => {
    const own = overrideSection(info(), parent, "notes");
    const back = inheritSection({ ...own, notes: "edited" }, "notes");
    expect(back.overrides).not.toContain("notes");
    expect(back.notes).toBe("");
    expect(resolveCreatureInfo(back, parent, "/Game/Rex").info.notes).toBe(
      "parent notes",
    );
  });
});

// ---------------------------------------------------------------------------

describe("templates", () => {
  const template = METHOD_TEMPLATES.knockout;

  it("never reports changes that would silently destroy work", () => {
    const filled = {
      ...emptyMethod("m", "Mine"),
      phases: [{ ...emptyPhase("p", "Prepare") }],
    };
    const lines = describeTemplate(filled, template, "fill-empty");
    expect(lines.some((l) => l.startsWith("Add phase"))).toBe(false);
  });

  it("previews the phases a merge would add", () => {
    const lines = describeTemplate(emptyMethod("m"), template, "merge-missing");
    expect(lines).toContain('Add phase "Prepare" with 1 step(s)');
    expect(lines).toContain('Add phase "Knock out" with 2 step(s)');
  });

  it("previews the destruction a replace would cause", () => {
    const filled = {
      ...emptyMethod("m"),
      phases: [
        { ...emptyPhase("p", "Custom"), steps: [{ id: "s", text: "x" }] },
      ],
    };
    const lines = describeTemplate(filled, template, "replace");
    expect(lines).toContain("Remove all 1 existing phase(s) and their steps");
  });

  it("adds only the phases that are missing on merge", () => {
    const partial = {
      ...emptyMethod("m"),
      phases: [{ ...emptyPhase("p", "Prepare") }],
    };
    const out = applyTemplate(partial, template, "merge-missing", ids);
    expect(out.phases.map((p) => p.name)).toEqual([
      "Prepare",
      "Knock out",
      "Feed",
    ]);
  });

  it("keeps existing text when filling empty fields", () => {
    const partial = { ...emptyMethod("m"), requirements: "My own gear" };
    const out = applyTemplate(partial, template, "merge-missing", ids);
    expect(out.requirements).toBe("My own gear");
    expect(out.failure).toBe(template.failure);
  });

  it("rebuilds from scratch on replace", () => {
    const filled = {
      ...emptyMethod("m"),
      phases: [
        { ...emptyPhase("p", "Custom"), steps: [{ id: "s", text: "x" }] },
      ],
    };
    const out = applyTemplate(filled, template, "replace", ids);
    expect(out.phases.map((p) => p.name)).toEqual([
      "Prepare",
      "Knock out",
      "Feed",
    ]);
  });

  it("merges the template's tags without dropping the method's own", () => {
    const tagged = { ...emptyMethod("m"), tags: ["mounted"] };
    const out = applyTemplate(tagged, template, "merge-missing", ids);
    expect(out.tags).toEqual(["mounted", "knockout"]);
  });

  it("offers a template for every tag", () => {
    for (const [tag, t] of Object.entries(METHOD_TEMPLATES)) {
      expect(t.name, tag).toBeTruthy();
      expect(t.phases.length, tag).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------

describe("read helpers", () => {
  it("hasCreatureInfo is false for an empty record", () => {
    expect(hasCreatureInfo(undefined)).toBe(false);
    expect(hasCreatureInfo(emptyCreatureInfo())).toBe(false);
  });

  it("hasCreatureInfo is true once anything is set", () => {
    expect(hasCreatureInfo(info({ availability: "acquirable" }))).toBe(true);
    expect(hasCreatureInfo(info({ technical: { dragWeight: 5 } }))).toBe(true);
    expect(hasCreatureInfo(info({ methods: [emptyMethod("m")] }))).toBe(true);
  });

  it("summarises the record for the entry list", () => {
    expect(
      creatureInfoSummary(
        info({
          availability: "acquirable",
          methods: [emptyMethod("a"), emptyMethod("b")],
          abilities: [{ id: "x", label: "Causes bleed", detail: "", kind: "active" as const, effect: "none" as const, rows: []  }],
          technical: { dragWeight: 150 },
        }),
      ),
    ).toBe("Acquirable · 2 methods · 1 ability · DW 150");
  });

  it("falls back from method name to tag to a placeholder", () => {
    expect(methodLabel(emptyMethod("m", "Mounted hunt"))).toBe("Mounted hunt");
    expect(methodLabel({ ...emptyMethod("m", ""), tags: ["trust"] })).toBe(
      "Trust building",
    );
    expect(methodLabel(emptyMethod("m", ""))).toBe("Untitled method");
  });

  it("counts steps across every phase", () => {
    const method = {
      ...emptyMethod("m"),
      phases: [
        { ...emptyPhase("p1", "a"), steps: [{ id: "s1", text: "" }] },
        {
          ...emptyPhase("p2", "b"),
          steps: [
            { id: "s2", text: "" },
            { id: "s3", text: "" },
          ],
        },
      ],
    };
    expect(methodStepCount(method)).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe("ability kinds", () => {
  it("reads a record written before the split as passive", () => {
    const parsed = CreatureInfoSchema.parse({
      abilities: [{ id: "a", label: "Pack bonus", detail: "" }],
    }) as CreatureInfo;
    expect(parsed.abilities[0].kind).toBe("passive");
  });

  it("gives every preset a kind, and matches one case-insensitively", () => {
    expect(ABILITY_PRESETS.every((p) => ABILITY_KINDS.includes(p.kind))).toBe(true);
    expect(abilityPresetFor("causes BLEED")?.kind).toBe("active");
    expect(abilityPresetFor("Pack bonus")?.kind).toBe("passive");
    expect(abilityPresetFor("not a preset")).toBeUndefined();
  });

  it("offers both an active and a passive preset to pick from", () => {
    for (const kind of ABILITY_KINDS) {
      expect(ABILITY_PRESETS.some((p) => p.kind === kind)).toBe(true);
    }
  });
});

describe("drops", () => {
  const drop = (id: string, patch: Partial<DropEntry> = {}): DropEntry => ({
    ...emptyDropEntry(id),
    ...patch,
  });

  it("defaults to three empty lists on a record that has none", () => {
    const parsed = CreatureInfoSchema.parse({}) as CreatureInfo;
    expect(parsed.drops).toEqual(emptyDrops());
    expect(hasDrops(parsed.drops)).toBe(false);
    expect(dropCount(parsed.drops)).toBe(0);
  });

  it("counts entries across every list", () => {
    const drops = {
      harvest: [drop("h1"), drop("h2")],
      guaranteed: [drop("g1")],
      random: [],
      production: [],
    };
    expect(dropCount(drops)).toBe(3);
    expect(hasDrops(drops)).toBe(true);
  });

  it("only asks for odds on random loot", () => {
    expect(DROP_LISTS.find((l) => l.key === "random")?.hasChance).toBe(true);
    expect(DROP_LISTS.find((l) => l.key === "harvest")?.hasChance).toBe(false);
    expect(DROP_LISTS.find((l) => l.key === "guaranteed")?.hasChance).toBe(false);
  });

  it("counts toward hasCreatureInfo and the entry-list summary", () => {
    const withDrop = info({
      drops: { harvest: [drop("h1")], guaranteed: [], random: [], production: [] },
    });
    expect(hasCreatureInfo(withDrop)).toBe(true);
    expect(creatureInfoSummary(withDrop)).toBe("1 drop");
  });
});

describe("spawn maps", () => {
  it("defaults to empty and counts toward the summary once set", () => {
    expect(emptyCreatureInfo().spawnMaps).toEqual([]);
    const spawning = info({ spawnMaps: ["Ragnarok", "Scorched Earth"] });
    expect(hasCreatureInfo(spawning)).toBe(true);
    expect(creatureInfoSummary(spawning)).toBe("2 maps");
  });

  it("is inherited and overridden independently of acquisition", () => {
    const parent = info({
      spawnMaps: ["The Island"],
      methods: [emptyMethod("m1", "Knockout")],
    });
    const variant = overrideSection(info(), parent, "spawns");
    const resolved = resolveCreatureInfo(variant, parent, "/Game/Rex");
    // Owning spawns must not drag acquisition along with it.
    expect(resolved.inheritedSections).toContain("acquisition");
    expect(resolved.inheritedSections).not.toContain("spawns");
    expect(resolved.info.spawnMaps).toEqual(["The Island"]);
    expect(resolved.info.methods).toHaveLength(1);
  });

  it("copies rather than aliases the parent's spawn maps", () => {
    const parent = info({ spawnMaps: ["The Island"] });
    const variant = overrideSection(info(), parent, "spawns");
    variant.spawnMaps.push("Aberration");
    expect(parent.spawnMaps).toEqual(["The Island"]);
  });

  it("drops the variant's copy when it goes back to inheriting", () => {
    const owned = info({ spawnMaps: ["Aberration"], overrides: ["spawns"] });
    expect(inheritSection(owned, "spawns").spawnMaps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("production drops", () => {
  it("asks for a rate rather than odds or a plain quantity", () => {
    const list = DROP_LISTS.find((l) => l.key === "production")!;
    expect(list.hasRate).toBe(true);
    expect(list.hasChance).toBe(false);
    // The other lists describe one event, so none of them recur.
    expect(DROP_LISTS.filter((l) => l.hasRate)).toHaveLength(1);
  });

  it("formats a rate from whichever halves were filled in", () => {
    const e = (patch: Partial<DropEntry>) => ({ ...emptyDropEntry("d"), ...patch });
    expect(formatRate(e({ rate: "1", per: "5 min" }))).toBe("1 / 5 min");
    expect(formatRate(e({ rate: "3" }))).toBe("3");
    expect(formatRate(e({ per: "hour" }))).toBe("per hour");
    expect(formatRate(e({}))).toBe("");
  });

  it("counts toward the drop total like any other list", () => {
    const drops = {
      ...emptyDrops(),
      production: [emptyDropEntry("p1"), emptyDropEntry("p2")],
    };
    expect(dropCount(drops)).toBe(2);
    expect(hasDrops(drops)).toBe(true);
  });
});

describe("ability effects", () => {
  it("reads an ability written before effects existed as plain", () => {
    const parsed = CreatureInfoSchema.parse({
      abilities: [{ id: "a", label: "Pack bonus" }],
    }) as CreatureInfo;
    expect(parsed.abilities[0].effect).toBe("none");
    expect(parsed.abilities[0].rows).toEqual([]);
  });

  it("asks for a percentage on weight reduction and preserving", () => {
    expect(effectShape("weight-reduction")).toMatchObject({
      hasPercent: true,
      hasConversion: false,
    });
    expect(effectShape("preserver")).toMatchObject({
      hasPercent: true,
      hasConversion: false,
    });
    // The two percentages mean different things, so they are labelled apart.
    expect(effectShape("weight-reduction").percentLabel).not.toBe(
      effectShape("preserver").percentLabel,
    );
  });

  it("asks for two items and two rates on a conversion, and no percentage", () => {
    expect(effectShape("conversion")).toMatchObject({
      hasPercent: false,
      hasConversion: true,
    });
  });

  it("treats a plain ability as having no structured fields at all", () => {
    expect(effectShape("none")).toMatchObject({
      hasPercent: false,
      hasConversion: false,
    });
  });

  it("wires each structured preset to its effect, as a passive", () => {
    for (const label of ["Weight reduction", "Preserver", "Conversion"]) {
      const preset = abilityPresetFor(label);
      expect(preset?.kind, label).toBe("passive");
      expect(preset?.effect, label).not.toBe(undefined);
      expect(preset?.effect, label).not.toBe("none");
    }
    // An ordinary preset stays plain.
    expect(abilityPresetFor("Pack bonus")?.effect).toBeUndefined();
  });

  it("round-trips a conversion row through the schema", () => {
    const parsed = CreatureInfoSchema.parse({
      abilities: [
        {
          id: "a",
          label: "Conversion",
          kind: "passive",
          effect: "conversion",
          rows: [
            {
              id: "r",
              bpPath: "/Game/x/Feces.Feces",
              rate: "3",
              toBpPath: "/Game/x/Oil.Oil",
              toRate: "1",
            },
          ],
        },
      ],
    }) as CreatureInfo;
    const row = parsed.abilities[0].rows[0];
    expect(row).toMatchObject({ rate: "3", toRate: "1" });
    expect(row.percent).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("pruneCreatureInfo", () => {
  it("drops ability effect rows that were never filled in", () => {
    const out = pruneCreatureInfo(
      info({
        abilities: [
          {
            id: "a",
            label: "Weight reduction",
            detail: "",
            kind: "passive",
            effect: "weight-reduction",
            rows: [
              emptyAbilityEffectRow("r1"),
              { ...emptyAbilityEffectRow("r2", "/Game/x.x"), percent: "50%" },
            ],
          },
        ],
      }),
    );
    expect(out.abilities[0].rows.map((r) => r.id)).toEqual(["r2"]);
  });

  it("keeps a row that has only a percentage — the item may come later", () => {
    const out = pruneCreatureInfo(
      info({
        abilities: [
          {
            id: "a",
            label: "Preserver",
            detail: "",
            kind: "passive",
            effect: "preserver",
            rows: [{ ...emptyAbilityEffectRow("r1"), percent: "200%" }],
          },
        ],
      }),
    );
    expect(out.abilities[0].rows).toHaveLength(1);
  });

  it("clears rows entirely from an ability that is not a table", () => {
    const out = pruneCreatureInfo(
      info({
        abilities: [
          {
            id: "a",
            label: "Pack bonus",
            detail: "",
            kind: "passive",
            effect: "none",
            rows: [{ ...emptyAbilityEffectRow("r1", "/Game/x.x"), percent: "5" }],
          },
        ],
      }),
    );
    expect(out.abilities[0].rows).toEqual([]);
  });

  it("drops abilities with no label at all", () => {
    const out = pruneCreatureInfo(
      info({
        abilities: [
          { id: "a", label: "  ", detail: "x", kind: "passive", effect: "none", rows: [] },
          { id: "b", label: "Pack bonus", detail: "", kind: "passive", effect: "none", rows: [] },
        ],
      }),
    );
    expect(out.abilities.map((a) => a.id)).toEqual(["b"]);
  });

  it("drops empty drop entries but keeps one carrying only a note", () => {
    const out = pruneCreatureInfo(
      info({
        drops: {
          ...emptyDrops(),
          harvest: [
            emptyDropEntry("d1"),
            { ...emptyDropEntry("d2"), note: "only on a corpse" },
            emptyDropEntry("d3", "/Game/x.x"),
          ],
        },
      }),
    );
    expect(out.drops.harvest.map((d) => d.id)).toEqual(["d2", "d3"]);
  });

  it("drops blank steps and the phases left with nothing", () => {
    const method = {
      ...emptyMethod("m"),
      phases: [
        { ...emptyPhase("p1", ""), steps: [{ id: "s1", text: "  " }] },
        { ...emptyPhase("p2", "Knock out"), steps: [{ id: "s2", text: "" }] },
        {
          ...emptyPhase("p3", ""),
          steps: [
            { id: "s3", text: "Feed it" },
            { id: "s4", text: "" },
          ],
        },
      ],
    };
    const out = pruneCreatureInfo(info({ methods: [method] }));
    const phases = out.methods[0].phases;
    // p1 had nothing; p2 keeps its name; p3 keeps its one real step.
    expect(phases.map((p) => p.id)).toEqual(["p2", "p3"]);
    expect(phases[1].steps.map((s) => s.id)).toEqual(["s3"]);
  });

  it("keeps an unnamed phase that still carries an outcome", () => {
    const method = {
      ...emptyMethod("m"),
      phases: [{ ...emptyPhase("p1", ""), failureOrReset: "aggro resets it" }],
    };
    expect(pruneCreatureInfo(info({ methods: [method] })).methods[0].phases)
      .toHaveLength(1);
  });

  it("drops inputs with neither a reference nor a label", () => {
    const method = {
      ...emptyMethod("m"),
      inputs: [
        { id: "i1", referenceType: "text" as const, bpPath: "", label: "", role: "taming-food", qty: "", note: "" },
        { id: "i2", referenceType: "text" as const, bpPath: "", label: "Ghillie", role: "optional-aid", qty: "", note: "" },
        { id: "i3", referenceType: "item" as const, bpPath: "/Game/x.x", label: "", role: "taming-food", qty: "", note: "" },
      ],
    };
    const out = pruneCreatureInfo(info({ methods: [method] }));
    expect(out.methods[0].inputs.map((i) => i.id)).toEqual(["i2", "i3"]);
  });

  it("drops blank spawn maps", () => {
    expect(
      pruneCreatureInfo(info({ spawnMaps: ["Ragnarok", "  ", ""] })).spawnMaps,
    ).toEqual(["Ragnarok"]);
  });

  it("leaves a fully populated record untouched", () => {
    const full = info({
      availability: "acquirable",
      spawnMaps: ["Ragnarok"],
      notes: "hi",
      technical: { dragWeight: 150 },
    });
    expect(pruneCreatureInfo(full)).toEqual(full);
  });
});

// ---------------------------------------------------------------------------

describe("override migration for pre-inheritance records", () => {
  it("gives a record with no overrides key ownership of what it holds", () => {
    const out = CreatureInfoSchema.parse({
      availability: "acquirable",
      notes: "night spawns",
    }) as CreatureInfo;
    expect(out.overrides.sort()).toEqual(["acquisition", "notes"]);
  });

  it("does not claim sections the record never filled in", () => {
    const out = CreatureInfoSchema.parse({ notes: "just a note" }) as CreatureInfo;
    expect(out.overrides).toEqual(["notes"]);
  });

  it("respects an explicitly stored empty array as deliberate inheritance", () => {
    const out = CreatureInfoSchema.parse({
      overrides: [],
      availability: "acquirable",
      notes: "hi",
    }) as CreatureInfo;
    expect(out.overrides).toEqual([]);
  });

  it("leaves an explicit partial override list alone", () => {
    const out = CreatureInfoSchema.parse({
      overrides: ["notes"],
      availability: "acquirable",
      notes: "hi",
    }) as CreatureInfo;
    expect(out.overrides).toEqual(["notes"]);
  });

  it("owns nothing when the record is genuinely blank", () => {
    expect((CreatureInfoSchema.parse({}) as CreatureInfo).overrides).toEqual([]);
  });

  it("gives a v0 record ownership of its migrated sections", () => {
    const out = CreatureInfoSchema.parse({
      tameMethod: "knockout",
      dragWeight: 150,
      notes: "old",
    }) as CreatureInfo;
    expect(out.overrides.sort()).toEqual(["acquisition", "notes", "technical"]);
  });

  it("keeps a legacy variant's own data visible instead of its parent's", () => {
    // The bug: a pre-inheritance record detected as a variant inherited every
    // section, hiding its own work — and claiming a section then overwrote it.
    const legacy = CreatureInfoSchema.parse({
      methods: [{ id: "mine", name: "My own route" }],
      notes: "my own notes",
    }) as CreatureInfo;
    const parent = info({
      methods: [emptyMethod("theirs", "Parent route")],
      notes: "parent notes",
    });
    const resolved = resolveCreatureInfo(legacy, parent, "/Game/Rex");
    expect(resolved.info.methods[0].name).toBe("My own route");
    expect(resolved.info.notes).toBe("my own notes");
    expect(resolved.inheritedSections).not.toContain("acquisition");
    expect(resolved.inheritedSections).not.toContain("notes");
    // Sections it never wrote still follow the parent.
    expect(resolved.inheritedSections).toContain("abilities");
  });

  it("owns drops and spawns written before the overrides key existed", () => {
    const out = CreatureInfoSchema.parse({
      spawnMaps: ["Ragnarok"],
      drops: { harvest: [{ id: "d", bpPath: "/Game/x.x" }] },
    }) as CreatureInfo;
    expect(out.overrides.sort()).toEqual(["drops", "spawns"]);
  });
});

describe("template preview completeness", () => {
  const template = METHOD_TEMPLATES.knockout;

  it("lists the name, outcome and tags a template would set", () => {
    const lines = describeTemplate(emptyMethod("m", ""), template, "merge-missing");
    expect(lines).toContain(`Set method name to "${template.name}"`);
    expect(lines.some((l) => l.startsWith("Set outcome to"))).toBe(true);
    expect(lines.some((l) => l.startsWith('Add tag "'))).toBe(true);
  });

  it("stays quiet about identity fields the method already sets", () => {
    const method = {
      ...emptyMethod("m", "My own name"),
      outcome: "claim" as const,
      tags: [...template.tags],
    };
    const lines = describeTemplate(method, template, "merge-missing");
    expect(lines.some((l) => l.startsWith("Set method name"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Set outcome"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Add tag"))).toBe(false);
  });

  it("lists them in replace mode too", () => {
    const lines = describeTemplate(emptyMethod("m", ""), template, "replace");
    expect(lines.some((l) => l.startsWith("Set outcome to"))).toBe(true);
  });

  it("matches what applyTemplate actually does", () => {
    // The preview's promise is the exact change set, so anything applied and
    // not previewed is a bug.
    const before = emptyMethod("m", "");
    const after = applyTemplate(before, template, "merge-missing", ids);
    const lines = describeTemplate(before, template, "merge-missing");
    if (after.name !== before.name) {
      expect(lines.some((l) => l.startsWith("Set method name"))).toBe(true);
    }
    if (after.outcome !== before.outcome) {
      expect(lines.some((l) => l.startsWith("Set outcome"))).toBe(true);
    }
    for (const tag of after.tags) {
      if (!before.tags.includes(tag)) {
        expect(lines.some((l) => l.includes(TAG_LABELS[tag as never] ?? tag))).toBe(
          true,
        );
      }
    }
  });
});
