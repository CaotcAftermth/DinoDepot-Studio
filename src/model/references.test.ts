import { describe, expect, it } from "vitest";
import {
  flattenReferences,
  hasReferences,
  insertReference,
  parseReferences,
  referencesIn,
  referenceToken,
  triggerAt,
  TRIGGERS,
} from "./references";

const CAKE = "/Game/x/Cake.Cake";
const REX = "/Game/x/Rex.Rex";

const name = (kind: string, bpPath: string) =>
  `${kind === "creature" ? "Rex" : "Cake"}(${bpPath.length})`;

describe("parseReferences", () => {
  it("returns one plain run for text with no references", () => {
    expect(parseReferences("just words")).toEqual([
      { type: "text", text: "just words" },
    ]);
  });

  it("splits text around a reference, keeping order", () => {
    const text = `Feed it ${referenceToken("item", CAKE)} until tame`;
    expect(parseReferences(text)).toEqual([
      { type: "text", text: "Feed it " },
      { type: "ref", kind: "item", bpPath: CAKE },
      { type: "text", text: " until tame" },
    ]);
  });

  it("handles a reference at each end with nothing between", () => {
    const text = referenceToken("item", CAKE) + referenceToken("creature", REX);
    expect(parseReferences(text)).toEqual([
      { type: "ref", kind: "item", bpPath: CAKE },
      { type: "ref", kind: "creature", bpPath: REX },
    ]);
  });

  it("leaves a malformed token as plain text rather than dropping it", () => {
    // No closing bracket - it is not a reference, and must survive as typed.
    expect(parseReferences("[[item:/Game/x")).toEqual([
      { type: "text", text: "[[item:/Game/x" },
    ]);
    expect(parseReferences("[[widget:/Game/x]]")).toEqual([
      { type: "text", text: "[[widget:/Game/x]]" },
    ]);
  });

  it("does not carry regex state between calls", () => {
    const text = `${referenceToken("item", CAKE)} and more`;
    // A shared lastIndex would make the second call miss the match.
    expect(parseReferences(text)).toEqual(parseReferences(text));
    expect(hasReferences(text)).toBe(true);
    expect(hasReferences(text)).toBe(true);
  });
});

describe("referencesIn", () => {
  it("lists every reference in order, keeping duplicates", () => {
    const text = `${referenceToken("item", CAKE)} x ${referenceToken("item", CAKE)}`;
    expect(referencesIn(text)).toEqual([
      { kind: "item", bpPath: CAKE },
      { kind: "item", bpPath: CAKE },
    ]);
  });

  it("is empty for plain text", () => {
    expect(referencesIn("nothing here")).toEqual([]);
    expect(hasReferences("nothing here")).toBe(false);
  });
});

describe("flattenReferences", () => {
  it("swaps each reference for its resolved name", () => {
    const text = `Feed ${referenceToken("item", CAKE)} to a ${referenceToken("creature", REX)}`;
    expect(flattenReferences(text, name)).toBe(
      `Feed ${name("item", CAKE)} to a ${name("creature", REX)}`,
    );
  });

  it("leaves plain text untouched", () => {
    expect(flattenReferences("plain", name)).toBe("plain");
  });
});

describe("triggerAt", () => {
  it("fires when the caret sits straight after a trigger", () => {
    const text = `Feed it ${TRIGGERS.item}`;
    expect(triggerAt(text, text.length)).toEqual({
      kind: "item",
      start: text.length - TRIGGERS.item.length,
      end: text.length,
    });
  });

  it("recognises the creature trigger too", () => {
    const text = TRIGGERS.creature;
    expect(triggerAt(text, text.length)?.kind).toBe("creature");
  });

  it("is case-insensitive", () => {
    const text = "Feed it {ITEM}";
    expect(triggerAt(text, text.length)?.kind).toBe("item");
  });

  it("stays quiet when the caret is elsewhere in the line", () => {
    // Editing earlier in a paragraph that already mentions the trigger must
    // not keep reopening the picker.
    const text = `${TRIGGERS.item} and more text`;
    expect(triggerAt(text, text.length)).toBeNull();
    expect(triggerAt(text, 3)).toBeNull();
  });

  it("stays quiet for a partial trigger", () => {
    expect(triggerAt("{ite", 4)).toBeNull();
  });
});

describe("insertReference", () => {
  it("replaces the trigger and reports where the caret lands", () => {
    const text = `Feed it ${TRIGGERS.item}`;
    const hit = triggerAt(text, text.length)!;
    const out = insertReference(text, hit.start, hit.end, "item", CAKE);
    expect(out.text).toBe(`Feed it ${referenceToken("item", CAKE)}`);
    expect(out.caret).toBe(out.text.length);
    expect(referencesIn(out.text)).toEqual([{ kind: "item", bpPath: CAKE }]);
  });

  it("keeps text that follows the trigger", () => {
    const text = `${TRIGGERS.item} then run`;
    const out = insertReference(text, 0, TRIGGERS.item.length, "item", CAKE);
    expect(out.text).toBe(`${referenceToken("item", CAKE)} then run`);
    // The caret sits at the end of what was inserted, not the end of the line.
    expect(out.text.slice(out.caret)).toBe(" then run");
  });
});
