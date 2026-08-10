/**
 * Renders `<placeholder>` segments in a distinct color so categories stand
 * out from literal config text. Used for both keys and values.
 */
export function PlaceholderText({ text }: { text: string }) {
  const parts = text.split(/(<[^>]*>)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^<[^>]*>$/.test(part) ? (
          <span key={i} className="text-sky-400" title="Category placeholder">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
