/**
 * Vendored from @4pm/shared-constants (project-template.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import templateData from "./project-template.json";
export interface ProjectTemplateChangelogEntry {
    version: string;
    date: string;
    summary: string;
    notes?: string[];
    files?: string[];
    skippable?: boolean;
}
export interface ProjectTemplate {
    version: string;
    changelog: ProjectTemplateChangelogEntry[];
}
export const PROJECT_TEMPLATE: ProjectTemplate = templateData;
