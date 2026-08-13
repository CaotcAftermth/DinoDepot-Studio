import { useState } from "react";
import { Button, Input } from "./ui";

/**
 * A field for a value that goes into Windows Credential Manager.
 *
 * A stored secret is never rendered — not even masked-but-present, because
 * there is nothing to render: the app cannot read one back. The row of
 * asterisks is a statement that something is stored, not the thing itself.
 *
 * Shared between the GitHub sign-in and the Discord webhook, which is why it
 * lives here rather than inside the Settings page it started in.
 */
export function SecretInput({
  stored,
  value,
  onChange,
  placeholder,
}: {
  stored: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [replacing, setReplacing] = useState(false);

  if (stored && !replacing) {
    return (
      <div className="flex gap-2 flex-1">
        <Input
          readOnly
          value={"*".repeat(28)}
          className="mono tracking-widest text-ink-400"
          title="A value is stored in Windows Credential Manager"
        />
        <Button
          className="shrink-0"
          onClick={() => {
            onChange("");
            setReplacing(true);
          }}
        >
          Replace
        </Button>
      </div>
    );
  }

  return (
    <div className="flex gap-2 flex-1">
      <Input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={replacing}
      />
      {stored && (
        <Button
          className="shrink-0"
          onClick={() => {
            onChange("");
            setReplacing(false);
          }}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}
