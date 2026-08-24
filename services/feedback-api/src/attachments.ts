import type { BlobStore, Settings } from "./env";
import type { FeedbackReport } from "./shared";

/**
 * Where an attached screenshot goes.
 *
 * GitHub has no supported API for uploading an attachment to an issue — the
 * drag-and-drop upload in the web interface is not a public endpoint — so an
 * image has to be stored somewhere the issue can link to. The two bad answers
 * are embedding it in the Markdown, which produces an unreadable issue and a
 * repository full of base64, and committing it into the repository, which
 * makes every clone carry every screenshot forever.
 *
 * So: an interface, and one implementation that writes to an object store.
 * When no store is bound the service says so plainly and files the report
 * without the image, rather than failing a report over a screenshot.
 */

export interface StoredAttachment {
  id: string;
  fileName: string;
  url: string;
}

export interface AttachmentService {
  readonly available: boolean;
  /** Stores one attachment, returning where it landed. */
  upload(
    reportId: string,
    attachment: { id: string; fileName: string; contentType: string; dataB64: string },
  ): Promise<StoredAttachment>;
}

export const ATTACHMENT_ROUTE_PREFIX = "/api/attachments";

/** What one attachment may weigh. The client and Rust enforce the same number. */
export const MAX_ATTACHMENT_BYTES = 1 * 1024 * 1024;

/** Images only. An attachment is evidence of what a screen looked like. */
const ALLOWED_TYPES = new Set(["image/webp", "image/png", "image/jpeg"]);

/**
 * The first bytes each accepted format must begin with.
 *
 * Checked because a declared content type is something the client chose, and
 * the store this writes to will serve back whatever it is given. Verifying the
 * signature is what stops an executable being stored under an image name and
 * handed out from the project's own domain.
 */
const SIGNATURES: { type: string; test(bytes: Uint8Array): boolean }[] = [
  {
    type: "image/png",
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { type: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: "image/webp",
    // "RIFF" .... "WEBP"
    test: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

export class AttachmentRejected extends Error {}

/** Decodes and checks one attachment, or explains why it will not be stored. */
export function decodeAttachment(attachment: {
  contentType: string;
  dataB64: string;
}): { bytes: Uint8Array; type: string } {
  if (!ALLOWED_TYPES.has(attachment.contentType)) {
    throw new AttachmentRejected("only PNG, JPEG and WebP images can be attached");
  }
  let binary: string;
  try {
    binary = atob(attachment.dataB64);
  } catch {
    throw new AttachmentRejected("the attachment was not valid base64");
  }
  if (binary.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentRejected("the attachment is larger than 1 MB");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  const matched = SIGNATURES.find((signature) => signature.test(bytes));
  if (!matched) throw new AttachmentRejected("the attachment is not an image");
  if (matched.type !== attachment.contentType) {
    throw new AttachmentRejected("the attachment is not the kind of image it claims");
  }
  return { bytes, type: matched.type };
}

const EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};

/**
 * An object store, addressed by report id.
 *
 * Keys are `<reportId>/<attachmentId>.<ext>`. Both halves are values this
 * service generated or validated, and neither is derived from a file name the
 * reporter chose — a file name is the one part of an attachment an attacker
 * controls completely.
 */
export class BlobAttachmentService implements AttachmentService {
  readonly available: boolean;

  constructor(
    private readonly bucket: BlobStore | undefined,
    private readonly baseUrl: string,
  ) {
    this.available = Boolean(bucket && baseUrl);
  }

  async upload(
    reportId: string,
    attachment: { id: string; fileName: string; contentType: string; dataB64: string },
  ): Promise<StoredAttachment> {
    if (!this.bucket || !this.baseUrl) {
      throw new AttachmentRejected("this deployment cannot store attachments");
    }
    const { bytes, type } = decodeAttachment(attachment);
    const key = `${safeSegment(reportId)}/${safeSegment(attachment.id)}.${EXTENSIONS[type]}`;
    await this.bucket.put(key, bytes.slice().buffer, {
      httpMetadata: { contentType: type },
    });
    return {
      id: attachment.id,
      fileName: attachment.fileName,
      url: `${this.baseUrl}/${key}`,
    };
  }
}

/** One path segment, with nothing in it that could climb out of the prefix. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  return cleaned || "unknown";
}

export function attachmentServiceFor(
  settings: Settings,
  bucket: BlobStore | undefined,
  publicOrigin = "",
): AttachmentService {
  const workerUrl = publicOrigin
    ? `${publicOrigin.replace(/\/+$/, "")}${ATTACHMENT_ROUTE_PREFIX}`
    : "";
  return new BlobAttachmentService(
    bucket,
    settings.attachmentsBaseUrl || workerUrl,
  );
}

/**
 * Recognises only keys this service can create. Rejecting every other path
 * keeps the bucket private without turning the Worker into a general R2 proxy.
 */
export function attachmentKeyFromPath(path: string): string | null {
  const match = new RegExp(
    `^${ATTACHMENT_ROUTE_PREFIX}/([A-Za-z0-9_-]{1,80})/([A-Za-z0-9_-]{1,80}\\.(?:png|jpg|webp))$`,
  ).exec(path);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Streams one public issue attachment while the underlying bucket stays private. */
export async function serveAttachment(
  bucket: BlobStore | undefined,
  key: string,
): Promise<Response> {
  const object = await bucket?.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

export interface AttachmentOutcome {
  /** Attachments that were stored, ready to be linked from the issue. */
  stored: StoredAttachment[];
  /** File names that could not be, with the reason, for the reply. */
  rejected: { fileName: string; reason: string }[];
}

/**
 * Stores what can be stored and reports what cannot.
 *
 * A failed attachment never fails the report. Somebody who wrote three
 * paragraphs about a bug and attached a screenshot should not lose the
 * paragraphs because the screenshot could not be saved — they are told, and
 * the issue is filed.
 */
export async function storeAttachments(
  service: AttachmentService,
  report: FeedbackReport,
): Promise<AttachmentOutcome> {
  const stored: StoredAttachment[] = [];
  const rejected: { fileName: string; reason: string }[] = [];

  for (const attachment of report.attachments) {
    if (!attachment.dataB64) continue;
    if (!service.available) {
      rejected.push({
        fileName: attachment.fileName,
        reason: "this feedback service is not set up to store attachments",
      });
      continue;
    }
    try {
      stored.push(await service.upload(report.id, attachment));
    } catch (error) {
      rejected.push({
        fileName: attachment.fileName,
        reason:
          error instanceof AttachmentRejected
            ? error.message
            : "it could not be stored",
      });
    }
  }
  return { stored, rejected };
}
