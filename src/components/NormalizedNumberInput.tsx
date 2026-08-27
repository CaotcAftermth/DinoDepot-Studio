import { useEffect, useState, type InputHTMLAttributes } from "react";
import { Input } from "./ui";

export function NormalizedNumberInput({
  value,
  onCommit,
  parse,
  ...props
}: Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange" | "onBlur" | "onFocus" | "onKeyDown"
> & {
  value: number;
  onCommit: (value: number) => void;
  parse: (raw: string) => number | null;
}) {
  const normalized = String(value);
  const [draft, setDraft] = useState(normalized);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(normalized);
  }, [focused, normalized]);

  function commit() {
    const parsed = parse(draft);
    if (parsed === null) {
      setDraft(normalized);
      return;
    }
    onCommit(parsed);
    setDraft(String(parsed));
  }

  return (
    <Input
      {...props}
      type="text"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        commit();
      }}
    />
  );
}
