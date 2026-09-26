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

/** One template file's metadata (blob served separately via download). Versioned by ADR-0332. */
export interface TemplateFileResponse {
  id: string;
  name: string;
  /** Optional free-text description (ADR-0332). */
  description: string | null;
  mime: string;
  size: number;
  /** Current version number (1-based, ADR-0332). */
  version: number;
  uploadedBy: string | null;
  createdAt: string;
  /** Last update (metadata edit or a new version upload). */
  updatedAt: string;
}

/** One immutable version in a template file's history (ADR-0332). */
export interface TemplateFileVersionResponse {
  id: string;
  version: number;
  mime: string;
  size: number;
  uploadedBy: string | null;
  createdAt: string;
}

/** Body PATCH /templates/:id — edit a file's metadata (name/description) (ADR-0332). */
export interface UpdateTemplateFileRequest {
  name?: string;
  description?: string | null;
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
