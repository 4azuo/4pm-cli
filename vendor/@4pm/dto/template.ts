/**
 * Vendored from @4pm/dto (template.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const TEMPLATE_KINDS = ["report", "est", "wbs", "proposal", "feasibility"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
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
export interface TemplateFileResponse {
    id: string;
    name: string;
    description: string | null;
    mime: string;
    size: number;
    version: number;
    uploadedBy: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface TemplateFileVersionResponse {
    id: string;
    version: number;
    mime: string;
    size: number;
    uploadedBy: string | null;
    createdAt: string;
}
export interface UpdateTemplateFileRequest {
    name?: string;
    description?: string | null;
}
export interface TemplateListResponse {
    items: TemplateFileResponse[];
    usedBytes: number;
    quotaBytes: number | null;
    fileMaxBytes: number | null;
}
export type ProjectTemplateSelection = Partial<Record<TemplateKind, string>>;
export type ProjectTemplateFileSource = "org" | "project" | "fork";
export interface ProjectTemplateFileResponse extends TemplateFileResponse {
    source: ProjectTemplateFileSource;
    enabled: boolean;
    sourceVersion: number | null;
    forkedFromVersion: number | null;
}
export interface AttachProjectTemplateFileRequest {
    mode: "attach" | "fork";
    templateFileId: string;
    enabled?: boolean;
}
export interface UpdateProjectTemplateFileRequest {
    enabled?: boolean;
    name?: string;
    description?: string | null;
    updateFromSource?: boolean;
}
export const attachProjectTemplateFileSchema = z.object({
    mode: z.enum(["attach", "fork"]),
    templateFileId: z.string().guid(),
    enabled: z.boolean().optional(),
});
export const updateProjectTemplateFileSchema = z.object({
    enabled: z.boolean().optional(),
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(4000).nullable().optional(),
    updateFromSource: z.boolean().optional(),
});
