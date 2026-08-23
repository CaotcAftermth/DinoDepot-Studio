import { Button, Modal } from "./ui";
import { toast } from "./toast";

/**
 * The exact text an output would publish, shown read-only.
 *
 * Publish and CurseForge both open this. They used to be able to disagree
 * about what "the output" looks like; keeping one component means a change to
 * the preview — the copy control, the empty-output wording, the styling of the
 * text block — happens once and reaches both.
 */
export function OutputPreviewModal({
  label,
  content,
  onClose,
}: {
  /** The output family's name, e.g. "Custom Cosmetics". */
  label: string;
  /** The exact text that would be published. */
  content: string;
  onClose: () => void;
}) {
  /**
   * The webview's clipboard API is the only route — there is no Tauri
   * clipboard plugin in this build — and it can be refused, so the failure
   * says what happened rather than nothing at all.
   */
  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      toast.success(`${label} output copied`);
    } catch {
      toast.error(
        "Could not reach the clipboard. Select the text in the preview and copy it instead.",
      );
    }
  }

  return (
    <Modal
      title={`${label} — output preview`}
      onClose={onClose}
      wide
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="primary" disabled={content === ""} onClick={copy}>
            Copy to Clipboard
          </Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      }
    >
      <pre className="mono bg-ink-950 border border-ink-700 rounded-lg p-3 overflow-auto max-h-[60vh] text-ink-200 whitespace-pre-wrap break-all">
        {content || "(empty output)"}
      </pre>
    </Modal>
  );
}
