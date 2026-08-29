/**
 * Inline catalog references inside prose.
 *
 * An admin writing a step wants to say "feed it Sweet Vegetable Cake" and have
 * that be the *real* item - resolving to its current name and icon, and
 * surviving a rename in the catalog. Typing the name as plain text gives none
 * of that.
 *
 * So a reference is stored as a token in the text and resolved on the way out:
 *
 *   Feed it [[item:/Game/.../PrimalItemConsumable_SweetVeggieCake]] until tame
 *
 * Storing the path rather than the name is the whole point - the name is a
 * display concern and is looked up fresh every time it is rendered.
 */

export const REFERENCE_KINDS = ["item", "creature"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** What the admin types to summon the picker. Matched case-insensitively. */
export const TRIGGERS: Record<ReferenceKind, string> = {
  item: "{item}",
  creature: "{creature}",
};

/**
 * A stored reference. The closing `]]` is what bounds it, so a path containing
 * a `]` would break - blueprint paths never do.
 */
const TOKEN = /\[\[(item|creature):([^\]]+)\]\]/g;

export function referenceToken(kind: ReferenceKind, bpPath: string): string {
  return `[[${kind}:${bpPath}]]`;
}

export type TextSegment =
  | { type: "text"; text: string }
  | { type: "ref"; kind: ReferenceKind; bpPath: string };

/**
 * Splits prose into plain runs and references, in order.
 *
 * Every renderer goes through this - the preview card, the published viewer -
 * so a token can never leak to a reader as raw `[[item:...]]`.
 */
export function parseReferences(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  // `matchAll` needs the regex to stay stateless between calls.
  for (const match of text.matchAll(new RegExp(TOKEN))) {
    const at = match.index ?? 0;
    if (at > last) out.push({ type: "text", text: text.slice(last, at) });
    out.push({
      type: "ref",
      kind: match[1] as ReferenceKind,
      bpPath: match[2],
    });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/** Every reference in a piece of text, in order, with duplicates kept. */
export function referencesIn(
  text: string,
): { kind: ReferenceKind; bpPath: string }[] {
  return parseReferences(text).flatMap((seg) =>
    seg.type === "ref" ? [{ kind: seg.kind, bpPath: seg.bpPath }] : [],
  );
}

export function hasReferences(text: string): boolean {
  return new RegExp(TOKEN).test(text);
}

/**
 * Flattens to plain text, using `resolve` for each reference.
 *
 * Used where markup is impossible - a tooltip, a one-line summary, a search
 * haystack - so those never show a raw token either.
 */
export function flattenReferences(
  text: string,
  resolve: (kind: ReferenceKind, bpPath: string) => string,
): string {
  return parseReferences(text)
    .map((seg) => (seg.type === "text" ? seg.text : resolve(seg.kind, seg.bpPath)))
    .join("");
}

/**
 * Finds a trigger the admin has just finished typing.
 *
 * Only the trigger nearest the caret counts, and only when the caret sits
 * right after it - otherwise editing earlier in a paragraph that already
 * mentions `{item}` would keep reopening the picker.
 */
export function triggerAt(
  text: string,
  caret: number,
): { kind: ReferenceKind; start: number; end: number } | null {
  const before = text.slice(0, caret).toLowerCase();
  for (const kind of REFERENCE_KINDS) {
    const trigger = TRIGGERS[kind];
    if (before.endsWith(trigger)) {
      return { kind, start: caret - trigger.length, end: caret };
    }
  }
  return null;
}

/** Replaces a trigger with a reference, returning the text and new caret. */
export function insertReference(
  text: string,
  start: number,
  end: number,
  kind: ReferenceKind,
  bpPath: string,
): { text: string; caret: number } {
  const token = referenceToken(kind, bpPath);
  return {
    text: text.slice(0, start) + token + text.slice(end),
    caret: start + token.length,
  };
}
