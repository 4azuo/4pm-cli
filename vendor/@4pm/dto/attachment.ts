/**
 * Vendored from @4pm/dto (attachment.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;
export const ATTACHMENT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type AttachmentImageMime = (typeof ATTACHMENT_IMAGE_MIME_TYPES)[number];
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
export const ATTACHMENT_FILE_EXTENSIONS = [".pdf", ".zip", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".csv", ".json"] as const;
export type AttachmentCategory = "image" | "file";
export function attachmentCategory(mime: string): AttachmentCategory | null {
    if ((ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mime))
        return "image";
    if ((ATTACHMENT_FILE_MIME_TYPES as readonly string[]).includes(mime))
        return "file";
    return null;
}
export const ATTACHMENT_ACCEPT = [...ATTACHMENT_IMAGE_MIME_TYPES, ...ATTACHMENT_FILE_MIME_TYPES, ...ATTACHMENT_FILE_EXTENSIONS].join(",");
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
export function attachmentMimeFromId(id: string): string {
    const ext = id.split(".").pop() ?? "";
    const mime = [...ATTACHMENT_IMAGE_MIME_TYPES, ...ATTACHMENT_FILE_MIME_TYPES].find((m) => attachmentExt(m) === ext);
    return mime ?? "application/octet-stream";
}
export const ATTACHMENT_ID_EXT_PATTERN = "png|jpg|webp|gif|pdf|zip|doc|docx|xls|xlsx|txt|csv|json";
export const ATTACHMENT_LABEL_RE = /\[(Image|File)#(\d+)\]/g;
export function attachmentLabel(category: AttachmentCategory, n: number): string {
    return category === "image" ? `[Image#${n}]` : `[File#${n}]`;
}
