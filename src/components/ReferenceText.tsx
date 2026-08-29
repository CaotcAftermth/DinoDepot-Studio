import {
  ChangeEvent,
  KeyboardEvent,
  ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  insertReference,
  parseReferences,
  referencesIn,
  triggerAt,
  TRIGGERS,
  type ReferenceKind,
} from "../model/references";
import { normalizeBpPath } from "../model/catalog";
import { displayNameFor, useCatalogIndex } from "../stores/useCatalogIndex";
import { BlueprintPicker } from "./BlueprintPicker";
import { EntityIcon } from "./EntityIcon";
import { Input, cx } from "./ui";

const KIND_TO_CATALOG: Record<ReferenceKind, "items" | "creatures"> = {
  item: "items",
  creature: "creatures",
};

/** Resolve a reference to the name the catalog currently gives it. */
export function useReferenceName() {
  const index = useCatalogIndex();
  return (kind: ReferenceKind, bpPath: string) =>
    displayNameFor(index, KIND_TO_CATALOG[kind], bpPath);
}

/**
 * Renders prose with its catalog references resolved to icon + name.
 *
 * This is the read side - the preview card and anything else showing stored
 * text. A reference whose target has left the catalog still renders, marked,
 * rather than vanishing or showing a raw token.
 */
export function ReferenceText({
  text,
  className,
  iconSize = 16,
}: {
  text: string;
  className?: string;
  iconSize?: number;
}) {
  const index = useCatalogIndex();
  const segments = parseReferences(text);

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (seg.type === "text") return <span key={i}>{seg.text}</span>;
        const kind = KIND_TO_CATALOG[seg.kind];
        const known = index[kind].has(normalizeBpPath(seg.bpPath));
        const name = displayNameFor(index, kind, seg.bpPath);
        return (
          <span
            key={i}
            className={cx(
              "inline-flex items-center gap-1 align-middle rounded px-1 py-0.5 mx-0.5",
              known
                ? "bg-ink-700/40 text-ink-100"
                : "bg-amber-flag/10 text-amber-400",
            )}
            title={known ? seg.bpPath : `Not in the ${kind} catalog`}
          >
            <EntityIcon
              bpPath={seg.bpPath}
              kind={kind}
              name={name}
              size={iconSize}
            />
            {name}
            {!known && " ⚠"}
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------

/**
 * Bold and italic runs inside one line, with references resolved.
 *
 * Mirrors the `inline()` step of the published viewer's markdown so the
 * preview and the page agree on what the same text means.
 */
function InlineMarkdown({ text }: { text: string }) {
  // Split on the markers themselves so the delimiters survive for matching.
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            <b key={i} className="text-ink-100">
              <ReferenceText text={part.slice(2, -2)} />
            </b>
          );
        }
        if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
          return (
            <i key={i}>
              <ReferenceText text={part.slice(1, -1)} />
            </i>
          );
        }
        return <ReferenceText key={i} text={part} />;
      })}
    </>
  );
}

/**
 * The markdown subset the notes editor advertises: `#` headers, `**bold**`,
 * `- lists`, blank-line-separated paragraphs.
 *
 * Deliberately the same subset the published page understands - a preview
 * that showed the raw `**` while the Atlas showed bold would be misleading
 * about the one thing a preview exists to answer.
 */
export function MarkdownText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const blocks: ReactElement[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={`p${blocks.length}`}>
        <InlineMarkdown text={paragraph.join(" ")} />
      </p>,
    );
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`u${blocks.length}`} className="list-disc ml-5">
        {list.map((item, i) => (
          <li key={i}>
            <InlineMarkdown text={item} />
          </li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^(#{1,3})\s+(.*)/);
    if (header) {
      flushParagraph();
      flushList();
      blocks.push(
        <h5
          key={`h${blocks.length}`}
          className="text-sm font-semibold text-white mt-1"
        >
          <InlineMarkdown text={header[2]} />
        </h5>,
      );
      continue;
    }
    if (line.startsWith("- ")) {
      flushParagraph();
      list.push(line.slice(2));
      continue;
    }
    if (line === "") {
      flushParagraph();
      flushList();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();

  return <div className={cx("flex flex-col gap-1.5", className)}>{blocks}</div>;
}

// ---------------------------------------------------------------------------

/**
 * A text field that understands `{item}` and `{creature}`.
 *
 * Typing either opens the catalog picker and swaps the trigger for a stored
 * reference. The icon cannot live *inside* a native input - an `<input>` and
 * `<textarea>` render text only - so the resolved references show as chips
 * directly beneath the field, and render inline everywhere the text is
 * displayed for reading. That keeps typing, undo, paste and IME behaving
 * exactly like the plain fields they replace, which a contenteditable would
 * not.
 */
export function ReferenceInput({
  value,
  onChange,
  placeholder,
  className,
  multiline,
  rows = 3,
  autoFocus,
  onKeyDown,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  rows?: number;
  autoFocus?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}) {
  const field = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  /** The trigger waiting on a pick, and where in the text it sits. */
  const [picking, setPicking] = useState<{
    kind: ReferenceKind;
    start: number;
    end: number;
  } | null>(null);
  /** Caret to restore after a reference is inserted. */
  const caretAfter = useRef<number | null>(null);

  useEffect(() => {
    if (caretAfter.current === null || !field.current) return;
    field.current.focus();
    field.current.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [value]);

  function handleChange(
    e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    const next = e.target.value;
    onChange(next);
    const hit = triggerAt(next, e.target.selectionStart ?? next.length);
    if (hit) setPicking(hit);
  }

  const refs = referencesIn(value);
  const shared = {
    ref: field as never,
    value,
    placeholder,
    autoFocus,
    onChange: handleChange,
    onKeyDown,
  };

  return (
    <>
      {multiline ? (
        <textarea
          {...shared}
          rows={rows}
          className={cx(
            "w-full bg-ink-950 border border-ink-600 rounded-md p-2.5 text-sm text-ink-100",
            "focus:outline-none focus:border-accent-500/60 placeholder:text-ink-400",
            className,
          )}
        />
      ) : (
        <Input {...shared} className={className} />
      )}

      <div className="flex items-center gap-1.5 flex-wrap mt-1">
        {refs.length > 0 ? (
          refs.map((r, i) => <RefChip key={i} kind={r.kind} bpPath={r.bpPath} />)
        ) : (
          <span className="text-[11px] text-ink-500">
            Type <span className="mono">{TRIGGERS.item}</span> or{" "}
            <span className="mono">{TRIGGERS.creature}</span> to insert one from
            the catalog.
          </span>
        )}
      </div>

      {picking && (
        <BlueprintPicker
          kind={KIND_TO_CATALOG[picking.kind]}
          title={
            picking.kind === "creature" ? "Insert a creature" : "Insert an item"
          }
          onClose={() => {
            // Leave the trigger text alone - cancelling should not silently
            // eat what the admin typed.
            setPicking(null);
            field.current?.focus();
          }}
          onPick={(bpPath) => {
            const { kind, start, end } = picking;
            const next = insertReference(value, start, end, kind, bpPath);
            setPicking(null);
            caretAfter.current = next.caret;
            onChange(next.text);
          }}
        />
      )}
    </>
  );
}

function RefChip({ kind, bpPath }: { kind: ReferenceKind; bpPath: string }) {
  const index = useCatalogIndex();
  const catalogKind = KIND_TO_CATALOG[kind];
  const known = index[catalogKind].has(normalizeBpPath(bpPath));
  const name = displayNameFor(index, catalogKind, bpPath);
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 text-[11px] rounded-full border pl-0.5 pr-2 py-0.5",
        known
          ? "border-ink-700 text-ink-300"
          : "border-amber-flag/40 text-amber-400",
      )}
      title={known ? bpPath : `Not in the ${catalogKind} catalog`}
    >
      <EntityIcon bpPath={bpPath} kind={catalogKind} name={name} size={16} />
      {name}
      {!known && " ⚠"}
    </span>
  );
}
