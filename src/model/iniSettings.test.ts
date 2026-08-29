import { describe, expect, it } from "vitest";
import {
  expandPlaceholders,
  expandRange,
  findPlaceholders,
  inferIniFile,
  inferValueType,
  iniSettingsToText,
  invalidOptions,
  isAddedToBuild,
  parseIniText,
  placeholdersNeedingOptions,
  pruneEmptyPlaceholderSections,
  properCaseBool,
  parseNoteOptions,
  scaffoldPlaceholderSections,
  syncPlaceholderSections,
  validateValue,
} from "./iniSettings";
import { IniBuildStateSchema, type IniSetting } from "./catalog";

describe("parseIniText", () => {
  it("parses sections and key=value pairs", () => {
    const { settings } = parseIniText(`
[ServerSettings]
XPMultiplier=2.0
TamingSpeedMultiplier=5.0
`);
    expect(settings).toHaveLength(2);
    expect(settings[0]).toMatchObject({
      section: "ServerSettings",
      key: "XPMultiplier",
      value: "2.0",
      type: "float",
      file: "GameUserSettings.ini",
    });
  });

  it("uses a preceding comment as the description", () => {
    const { settings } = parseIniText(`
[MyMod]
; Doubles the harvest rate for modded creatures
HarvestMultiplier=2.0
`);
    expect(settings[0].description).toBe(
      "Doubles the harvest rate for modded creatures",
    );
  });

  it("uses a trailing comment as the description", () => {
    const { settings } = parseIniText(`XPMultiplier=2.0 ; double XP`);
    expect(settings[0].value).toBe("2.0");
    expect(settings[0].description).toBe("double XP");
  });

  it("does not split on semicolons inside values", () => {
    const line =
      'ConfigOverrideItemMaxQuantity=(ItemClassString="PrimalItem_X",Quantity=(MaxItemQuantity=100))';
    const { settings } = parseIniText(line);
    expect(settings[0].value).toBe(
      '(ItemClassString="PrimalItem_X",Quantity=(MaxItemQuantity=100))',
    );
    expect(settings[0].description).toBe("");
  });

  it("keeps values that contain '=' intact", () => {
    const { settings } = parseIniText(
      `OverrideNamedEngramEntries=(EngramClassName="EngramEntry_X",EngramHidden=false)`,
    );
    expect(settings[0].key).toBe("OverrideNamedEngramEntries");
    expect(settings[0].value).toContain("EngramHidden=false");
  });

  it("reports lines it could not parse", () => {
    const { settings, skipped } = parseIniText(`
[ServerSettings]
this is just prose
XPMultiplier=2.0
`);
    expect(settings).toHaveLength(1);
    expect(skipped).toEqual(["this is just prose"]);
  });

  it("resets a pending comment across blank lines", () => {
    const { settings } = parseIniText(`
; orphaned note

XPMultiplier=2.0
`);
    expect(settings[0].description).toBe("");
  });
});

describe("inferValueType", () => {
  it.each([
    ["True", "bool"],
    ["false", "bool"],
    ["42", "int"],
    ["2.0", "float"],
    ["https://example.com", "url"],
    ['(ItemClassString="X")', "struct"],
    ["SomeText", "string"],
    ["", ""],
  ])("%s -> %s", (value, expected) => {
    expect(inferValueType(value)).toBe(expected);
  });
});

describe("validateValue", () => {
  it("flags a mismatched value", () => {
    expect(validateValue("maybe", "bool")).toMatch(/True or False/);
    expect(validateValue("2.5", "int")).toMatch(/whole number/);
  });

  it("accepts matching values and unspecified types", () => {
    expect(validateValue("True", "bool")).toBeNull();
    expect(validateValue("anything", "")).toBeNull();
    expect(validateValue("", "int")).toBeNull();
  });
});

describe("inferIniFile", () => {
  it("maps well-known sections to their file", () => {
    expect(inferIniFile("ServerSettings")).toBe("GameUserSettings.ini");
    expect(inferIniFile("/script/shootergame.shootergamemode")).toBe("Game.ini");
  });

  it("leaves mod-specific sections unassigned", () => {
    expect(inferIniFile("ArkologyNewEncounters")).toBe("");
  });
});

describe("iniSettingsToText", () => {
  const setting = (over: Partial<IniSetting>): IniSetting => ({
    id: Math.random().toString(),
    section: "ServerSettings",
    key: "K",
    value: "V",
    type: "",
    file: "GameUserSettings.ini",
    description: "",
    details: "",
    required: false,
    added: false,
    ...over,
  });

  it("omits descriptions by default so a copy is config only", () => {
    const text = iniSettingsToText([
      setting({ key: "XPMultiplier", value: "2.0", description: "double XP" }),
      setting({ key: "TamingSpeedMultiplier", value: "5.0" }),
      setting({
        key: "bUseCorpseLocator",
        value: "true",
        section: "/script/shootergame.shootergamemode",
        file: "Game.ini",
      }),
    ]);
    expect(text).not.toContain("; double XP");
    expect(text).toContain("[ServerSettings]");
    expect(text).toContain("XPMultiplier=2.0");
    expect(text).toContain("bUseCorpseLocator=true");
    // File banners survive only because these span two files.
    expect(text).toContain("; ===== GameUserSettings.ini =====");
    expect(text).toContain("; ===== Game.ini =====");
  });

  it("emits no comments at all for a single-file block", () => {
    const text = iniSettingsToText([
      setting({ key: "XPMultiplier", value: "2.0", description: "double XP" }),
    ]);
    expect(text).not.toContain(";");
    expect(text).toBe("[ServerSettings]\nXPMultiplier=2.0");
  });

  it("includes descriptions when explicitly asked", () => {
    const text = iniSettingsToText(
      [setting({ key: "XPMultiplier", value: "2.0", description: "double XP" })],
      true,
    );
    expect(text).toContain("; double XP");
  });

  it("round-trips through the parser", () => {
    const original = [
      setting({ key: "XPMultiplier", value: "2.0", description: "double XP" }),
      setting({ key: "TamingSpeedMultiplier", value: "5.0" }),
    ];
    const { settings } = parseIniText(iniSettingsToText(original, true));
    expect(settings).toHaveLength(2);
    expect(settings[0]).toMatchObject({
      section: "ServerSettings",
      key: "XPMultiplier",
      value: "2.0",
      description: "double XP",
    });
  });

  it("returns an empty string for no settings", () => {
    expect(iniSettingsToText([])).toBe("");
  });
});

describe("placeholder values", () => {
  it("types on the inner content of a <placeholder>", () => {
    expect(inferValueType("<1>")).toBe("int");
    expect(inferValueType("<0.1>")).toBe("float");
    expect(inferValueType("<creature>")).toBe("string");
  });

  it("type-checks the inner content of a placeholder", () => {
    // <1> stands for a list of ints, so it passes an int type…
    expect(validateValue("<1>", "int")).toBeNull();
    expect(validateValue("<0.1>", "float")).toBeNull();
    // …but a non-boolean placeholder must not pass as a bool.
    expect(validateValue("<HelloWorld>", "bool")).toMatch(/True or False/);
    expect(validateValue("<creature>", "int")).toMatch(/whole number/);
  });

  it("finds placeholders in keys and values", () => {
    expect(findPlaceholders("PreventRemapping<creature>")).toEqual(["creature"]);
    expect(findPlaceholders("A<x>B<y> <X>")).toEqual(["x", "y"]);
  });
});

describe("parseNoteOptions", () => {
  const NOTES = `
Some prose about the setting.

<Creature>
- Ammonite
- Cnidaria
- Eurypterid

<Level>
- 1-5
`;

  it("reads a markdown list under a <Name> header", () => {
    const options = parseNoteOptions(NOTES);
    expect(options.get("creature")).toEqual([
      "Ammonite",
      "Cnidaria",
      "Eurypterid",
    ]);
  });

  it("expands a dash range into whole numbers", () => {
    expect(parseNoteOptions(NOTES).get("level")).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  it("is case-insensitive on the header and tolerates code fences", () => {
    const options = parseNoteOptions("```\n<CREATURE>\n```\n- Dodo");
    expect(options.get("creature")).toEqual(["Dodo"]);
  });

  it("leaves a non-numeric dash alone", () => {
    expect(expandRange("Raw-Meat")).toEqual(["Raw-Meat"]);
  });

  it("flags options that clash with the declared type", () => {
    expect(invalidOptions(["1", "2", "oops"], "int")).toEqual(["oops"]);
    expect(invalidOptions(["0.1", "0.2"], "float")).toEqual([]);
  });
});

describe("expandPlaceholders", () => {
  it("produces one line per chosen option", () => {
    const lines = expandPlaceholders("PreventRemapping<creature>", "False", {
      creature: ["Ammonite", "Cnidaria"],
    });
    expect(lines).toEqual([
      "PreventRemappingAmmonite=False",
      "PreventRemappingCnidaria=False",
    ]);
  });

  it("substitutes placeholders on the value side too", () => {
    const lines = expandPlaceholders("HarvestRate", "<rate>", {
      rate: ["0.2"],
    });
    expect(lines).toEqual(["HarvestRate=0.2"]);
  });

  it("leaves unresolved placeholders visible", () => {
    expect(expandPlaceholders("Prevent<creature>", "False", {})).toEqual([
      "Prevent<creature>=False",
    ]);
  });

  it("caps combinations so multi-selects cannot explode", () => {
    const many = Array.from({ length: 40 }, (_, i) => String(i));
    const lines = expandPlaceholders("K<a><b>", "V", { a: many, b: many }, {
      max: 50,
    });
    expect(lines.length).toBeLessThanOrEqual(50);
  });
});

describe("isAddedToBuild", () => {
  const s = (over: Partial<IniSetting>): IniSetting => ({
    id: "x", section: "", key: "K", value: "V", type: "", file: "",
    description: "", details: "", required: false, added: false, ...over,
  });

  it("treats required settings as always included", () => {
    expect(isAddedToBuild(s({ required: true, added: false }))).toBe(true);
  });

  it("otherwise follows the added flag", () => {
    expect(isAddedToBuild(s({ added: true }))).toBe(true);
    expect(isAddedToBuild(s({}))).toBe(false);
  });
});

describe("scaffoldPlaceholderSections", () => {
  it("adds a section for each placeholder that has none", () => {
    const out = scaffoldPlaceholderSections("Prevent<creature>", "<tier>", "");
    expect(out).toContain("<creature>");
    expect(out).toContain("<tier>");
  });

  it("leaves existing sections alone", () => {
    const existing = "<creature>\n- Ammonite";
    expect(
      scaffoldPlaceholderSections("Prevent<creature>", "False", existing),
    ).toBe(existing);
  });

  it("appends without clobbering prior notes", () => {
    const out = scaffoldPlaceholderSections("K<x>", "V", "Some prose.");
    expect(out.startsWith("Some prose.")).toBe(true);
    expect(out).toContain("<x>");
  });

  it("writes guidance that is not itself parsed as an option", () => {
    const out = scaffoldPlaceholderSections("K<x>", "V", "");
    expect(parseNoteOptions(out).get("x")).toEqual([]);
  });

  it("writes only the heading, leaving nothing to delete first", () => {
    expect(scaffoldPlaceholderSections("K<x>", "V", "")).toBe("<x>");
  });

  it("does nothing when there are no placeholders", () => {
    expect(scaffoldPlaceholderSections("Key", "Value", "notes")).toBe("notes");
  });
});

describe("placeholdersNeedingOptions", () => {
  it("lists placeholders with no options yet", () => {
    expect(placeholdersNeedingOptions("K<x>", "<y>", "<x>\n- One")).toEqual([
      "y",
    ]);
  });

  it("counts a bare heading as still needing options", () => {
    expect(placeholdersNeedingOptions("K<x>", "V", "<x>")).toEqual(["x"]);
  });

  it("is empty once every placeholder has options", () => {
    expect(
      placeholdersNeedingOptions("K<x>", "<y>", "<x>\n- One\n\n<y>\n- Two"),
    ).toEqual([]);
  });

  it("is empty when the setting has no placeholders", () => {
    expect(placeholdersNeedingOptions("Key", "Value", "")).toEqual([]);
  });
});

describe("pruneEmptyPlaceholderSections", () => {
  it("clears the trail left by typing a name one character at a time", () => {
    const typed = "<t>\n\n<te>\n\n<tes>\n\n<test>";
    expect(pruneEmptyPlaceholderSections("K<test>", "V", typed)).toBe("<test>");
  });

  it("keeps a stale section that has options - that's admin work", () => {
    const notes = "<old>\n- Ammonite\n- Cnidaria";
    expect(pruneEmptyPlaceholderSections("K<new>", "V", notes)).toBe(notes);
  });

  it("leaves prose above the sections alone", () => {
    const out = pruneEmptyPlaceholderSections(
      "K<b>",
      "V",
      "Some prose.\n\n<a>\n\n<b>",
    );
    expect(out).toBe("Some prose.\n\n<b>");
  });

  it("does nothing when every section is still in use", () => {
    const notes = "<a>\n\n<b>";
    expect(pruneEmptyPlaceholderSections("K<a>", "<b>", notes)).toBe(notes);
  });
});

describe("syncPlaceholderSections", () => {
  it("replaces a renamed placeholder's empty section in one pass", () => {
    expect(syncPlaceholderSections("K<new>", "V", "<old>")).toBe("<new>");
  });

  it("prunes the typing trail and adds the finished name", () => {
    const typed = "<t>\n\n<te>";
    expect(syncPlaceholderSections("K<test>", "V", typed)).toBe("<test>");
  });

  it("keeps options written against the surviving placeholder", () => {
    const notes = "<creature>\n- Ammonite";
    expect(syncPlaceholderSections("K<creature>", "<n>", notes)).toBe(
      "<creature>\n- Ammonite\n\n<n>",
    );
  });

  it("is a no-op for a setting with no placeholders", () => {
    expect(syncPlaceholderSections("Key", "Value", "prose")).toBe("prose");
  });
});

describe("IniBuildState schema", () => {
  it("defaults an untouched setting to no composed state", () => {
    expect(IniBuildStateSchema.parse({})).toEqual({
      value: "",
      choices: {},
      optionValues: {},
    });
  });

  it("round-trips choices and per-option values", () => {
    const parsed = IniBuildStateSchema.parse({
      value: "True",
      choices: { creature: ["Ammonite", "Cnidaria"] },
      optionValues: { creature: { Ammonite: "False" } },
    });
    expect(parsed.choices.creature).toEqual(["Ammonite", "Cnidaria"]);
    expect(parsed.optionValues.creature.Ammonite).toBe("False");
  });

  it("survives a round trip through JSON, as the project file does", () => {
    const state = {
      value: "2.5",
      choices: { tier: ["1", "2"] },
      optionValues: { tier: { "1": "0.5" } },
    };
    expect(IniBuildStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(
      state,
    );
  });
});

describe("properCaseBool", () => {
  it("normalises typed booleans", () => {
    expect(properCaseBool("true")).toBe("True");
    expect(properCaseBool("FALSE")).toBe("False");
    expect(properCaseBool(" True ")).toBe("True");
  });

  it("leaves anything else untouched", () => {
    expect(properCaseBool("2.0")).toBe("2.0");
    expect(properCaseBool("trueish")).toBe("trueish");
    expect(properCaseBool("")).toBe("");
  });
});

describe("per-option values", () => {
  it("gives each chosen option its own value", () => {
    const lines = expandPlaceholders(
      "PreventRemapping<creature>",
      "False",
      { creature: ["Ammonite", "Cnidaria", "Eurypterid"] },
      { optionValues: { creature: { Ammonite: "True", Cnidaria: "False" } } },
    );
    expect(lines).toEqual([
      "PreventRemappingAmmonite=True",
      "PreventRemappingCnidaria=False",
      // no override -> falls back to the row's working value
      "PreventRemappingEurypterid=False",
    ]);
  });

  it("ignores blank overrides", () => {
    const lines = expandPlaceholders(
      "K<a>",
      "Default",
      { a: ["one"] },
      { optionValues: { a: { one: "" } } },
    );
    expect(lines).toEqual(["Kone=Default"]);
  });
});
