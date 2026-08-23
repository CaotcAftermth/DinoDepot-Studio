import { ipc, isTauri } from "../ipc";
import { pickFile } from "../dialogs";
import { newId } from "../../model/ids";
import { asStudioError } from "../../model/errors";
import { FEEDBACK_CONFIG } from "../../model/feedback/config";
import {
  FeedbackAttachmentSchema,
  type FeedbackAttachment,
} from "../../model/feedback/types";

/**
 * Attachments, behind an interface that can outlive how they are stored.
 *
 * Right now an attachment travels inside the report and the service uploads it
 * where it needs to. That is the arrangement with the fewest moving parts, and
 * it is not the only one that could be right — object storage with a signed
 * URL would be better for large files, and the client would not have to change
 * if it arrived, because the client only ever asks this interface for an
 * attachment and hands what it gets to the report.
 *
 * ## Why there is no automatic screen capture
 *
 * Tauri 2 has no window-capture command, and nothing in the webview can
 * photograph the native window it is inside. The honest options were a plugin
 * that adds a screen-recording permission to the application's manifest, or
 * asking the reporter to take the screenshot themselves. The second is what is
 * implemented, because a bug reporting feature that makes the whole app
 * request screen capture at install time is a poor trade — and because a
 * screenshot the reporter took is a screenshot the reporter has seen.
 *
 * The seam is here regardless: an implementation of {@link AttachmentSource}
 * that captures a window drops in without touching anything above it.
 */

/** Where the bytes for an attachment come from. */
export interface AttachmentSource {
  /** What the button says. */
  readonly label: string;
  /** Whether this source can work in the current build. */
  readonly available: boolean;
  /** Produces one attachment, or null when the reporter cancelled. */
  pick(): Promise<FeedbackAttachment | null>;
}

interface RawImage {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
  dataB64: string;
}

/**
 * An image the reporter chose from disk.
 *
 * The decode, the re-encode and the metadata strip all happen in Rust — see
 * `commands/feedback.rs`. The webview never sees the original bytes, which
 * means it also never sees the EXIF block that may have been on them.
 */
export const filePickerSource: AttachmentSource = {
  label: "Attach an image",
  available: isTauri,
  async pick(): Promise<FeedbackAttachment | null> {
    const path = await pickFile("Choose a screenshot", [
      { name: "Images", extensions: ["png", "webp", "jpg", "jpeg"] },
    ]);
    if (!path) return null;

    const raw = await ipc<RawImage>("feedback_read_image", { path });
    if (raw.sizeBytes > FEEDBACK_CONFIG.maxAttachmentBytes) {
      throw asStudioError(
        new Error("attachment over the configured limit"),
        "validation.failed",
        "That image is too large to attach.",
      );
    }
    return FeedbackAttachmentSchema.parse({
      id: newId(),
      fileName: raw.fileName,
      contentType: raw.contentType,
      sizeBytes: raw.sizeBytes,
      dataB64: raw.dataB64,
    });
  },
};

/** The sources this build offers, in the order the form shows them. */
export const attachmentSources: readonly AttachmentSource[] = [filePickerSource];

/** Whether another attachment may be added. */
export function canAddAttachment(current: FeedbackAttachment[]): boolean {
  return current.length < FEEDBACK_CONFIG.maxAttachments;
}

/** Total attachment weight, for the size warning on the form. */
export function attachmentBytes(attachments: FeedbackAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0);
}

/** `1.4 MB`, for a size somebody has to judge at a glance. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
