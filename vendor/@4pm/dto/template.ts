/**
 * DTOs for the org template-file library (ADR-0113): permanent cloud storage for report /
 * estimation / … templates, quota-limited per plan, referenced per-project by kind.
 */

/** Template kinds a project can assign a file to (aligns with the Theme C generators). */
export const TEMPLATE_KINDS = ["report", "est", "wbs", "proposal", "feasibility"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** Allowed template upload MIME types (docs/sheets/text) — anything else is rejected. */
export const TEMPLATE_ALLOWED_MIME = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const;

/** One template file's metadata (blob served separately via download). */
export interface TemplateFileResponse {
  id: string;
  name: string;
  mime: string;
  size: number;
  uploadedBy: string | null;
  createdAt: string;
}

/** Data GET /templates — the org's files + storage-quota usage (ADR-0113). */
export interface TemplateListResponse {
  items: TemplateFileResponse[];
  /** Sum of the org's non-deleted template file sizes (bytes). */
  usedBytes: number;
  /** Plan total cap (bytes); null = unlimited. */
  quotaBytes: number | null;
  /** Plan per-file cap (bytes); null = unlimited. */
  fileMaxBytes: number | null;
}

/** Per-project template selection (`project.settings.templates`) — kind → template file id. */
export type ProjectTemplateSelection = Partial<Record<TemplateKind, string>>;
