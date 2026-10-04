/**
 * Unified composer attachments (ADR-0388) — the ONE limit + MIME set every attach surface shares
 * (memo, AI-Todo, Console, Help, Research, Support, 4rum post/comment, Messenger). Clients validate
 * against it before staging; every upload endpoint enforces the same values server-side. The older
 * per-surface constants (`COMMAND_IMAGE_*`, `PROJECT_IMAGE_*`, `RESEARCH_ATTACHMENTS_*`, …) are aliases
 * of these.
 */

/** Max bytes of one attachment (image or file). */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Max attachments carried by one submit (create / send / edit). */
export const ATTACHMENT_MAX_COUNT = 10;

/** Allowed image MIME types (shown as a thumbnail, referenced as `[Image#N]`). */
export const ATTACHMENT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type AttachmentImageMime = (typeof ATTACHMENT_IMAGE_MIME_TYPES)[number];

/** Allowed file (document/archive) MIME types (shown as a file chip, referenced as `[File#N]`). */
export const ATTACHMENT_FILE_MIME_TYPES = [
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
  "application/json",
] as const;

/** File extensions accepted alongside the MIME list (browsers report some text types inconsistently). */
export const ATTACHMENT_FILE_EXTENSIONS = [".pdf", ".zip", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".csv", ".json"] as const;

/** Whether an attachment is an image (`[Image#N]`) or a file (`[File#N]`). */
export type AttachmentCategory = "image" | "file";

/** The category of an allowed MIME; null when the MIME is not allowed at all. */
export function attachmentCategory(mime: string): AttachmentCategory | null {
  if ((ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) return "image";
  if ((ATTACHMENT_FILE_MIME_TYPES as readonly string[]).includes(mime)) return "file";
  return null;
}

/** The `accept` attribute for a file picker that takes every allowed attachment. */
export const ATTACHMENT_ACCEPT = [...ATTACHMENT_IMAGE_MIME_TYPES, ...ATTACHMENT_FILE_MIME_TYPES, ...ATTACHMENT_FILE_EXTENSIONS].join(",");

/** The storage/on-disk extension for an allowed attachment MIME; null when the MIME is not allowed. */
export function attachmentExt(mime: string): string | null {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "application/pdf":
      return "pdf";
    case "application/zip":
    case "application/x-zip-compressed":
      return "zip";
    case "application/msword":
      return "doc";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
    case "application/vnd.ms-excel":
      return "xls";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return "xlsx";
    case "text/plain":
      return "txt";
    case "text/csv":
      return "csv";
    case "application/json":
      return "json";
    default:
      return null;
  }
}

/** The extension group a stored `<uuidv4>.<ext>` attachment id may carry (path-traversal-safe ids). */
export const ATTACHMENT_ID_EXT_PATTERN = "png|jpg|webp|gif|pdf|zip|doc|docx|xls|xlsx|txt|csv|json";

/** Matches every `[Image#N]` / `[File#N]` label in a text (global — reset `lastIndex` or use `matchAll`). */
export const ATTACHMENT_LABEL_RE = /\[(Image|File)#(\d+)\]/g;

/** The label for the N-th attachment of a category. */
export function attachmentLabel(category: AttachmentCategory, n: number): string {
  return category === "image" ? `[Image#${n}]` : `[File#${n}]`;
}
