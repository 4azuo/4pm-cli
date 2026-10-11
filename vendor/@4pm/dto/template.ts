/**
 * DTOs for the org template-file library: permanent cloud storage for report /
 * estimation / … templates, quota-limited per plan, referenced per-project by kind.
 * @adr 0113
 */
import { z } from "zod";

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
  /** Optional free-text description. @adr 0332 */
  description: string | null;
  mime: string;
  size: number;
  /** Current version number (1-based). @adr 0332 */
  version: number;
  uploadedBy: string | null;
  createdAt: string;
  /** Last update (metadata edit or a new version upload). */
  updatedAt: string;
}

/** One immutable version in a template file's history. @adr 0332 */
export interface TemplateFileVersionResponse {
  id: string;
  version: number;
  mime: string;
  size: number;
  uploadedBy: string | null;
  createdAt: string;
}

/** Body PATCH /templates/:id — edit a file's metadata (name/description). @adr 0332 */
export interface UpdateTemplateFileRequest {
  name?: string;
  description?: string | null;
}

/** Data GET /templates — the org's files + storage-quota usage. */
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

/** Where a project's template file comes from. @adr 0456 */
export type ProjectTemplateFileSource = "org" | "project" | "fork";

/** One template file as used by a project. @api template-0014 @adr 0456 */
export interface ProjectTemplateFileResponse extends TemplateFileResponse {
  source: ProjectTemplateFileSource;
  enabled: boolean;
  /** For a fork: the org source's current version (null when the source is gone). */
  sourceVersion: number | null;
  /** For a fork: the version it was copied from. */
  forkedFromVersion: number | null;
}

/** Body POST /projects/:id/template-files (JSON modes; `upload` is multipart). @api template-0015 */
export interface AttachProjectTemplateFileRequest {
  mode: "attach" | "fork";
  templateFileId: string;
  enabled?: boolean;
}

/** Body PATCH /projects/:id/template-files/:fileId. @api template-0016 */
export interface UpdateProjectTemplateFileRequest {
  enabled?: boolean;
  /** Owned / fork only. */
  name?: string;
  description?: string | null;
  /** Fork only: copy the org file's current blob as a new version. */
  updateFromSource?: boolean;
}

/** Body schema — POST /projects/:id/template-files (JSON attach / fork). @api template-0015 */
export const attachProjectTemplateFileSchema = z.object({
  mode: z.enum(["attach", "fork"]),
  templateFileId: z.string().guid(),
  enabled: z.boolean().optional(),
});

/** Body schema — PATCH /projects/:id/template-files/:fileId. @api template-0016 */
export const updateProjectTemplateFileSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(4000).nullable().optional(),
  updateFromSource: z.boolean().optional(),
});
