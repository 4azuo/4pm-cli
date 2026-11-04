/**
 * Vendored from @4pm/dto (audit.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const AUDITS_DIR = ".4pm/audits";
export const AUDIT_DEFAULT_REPORT_PATH = `${AUDITS_DIR}/{date}-{rule}.md`;
export const AUDIT_SCOPE_WARN = { files: 2000, bytes: 20 * 1024 * 1024 } as const;
export const AUDIT_VERDICT_FENCE = "json audit-verdict";
const folder = z
    .string()
    .trim()
    .min(1)
    .max(300)
    .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/, "repo-relative folder");
export const auditActionParamsSchema = z.object({
    description: z.string().trim().min(1).max(8000),
    folders: z.array(folder).min(1).max(50),
    exclude: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    templateFileId: z.string().guid(),
    checklistId: z.string().guid().optional().or(z.literal("")),
    reportPath: z
        .string()
        .trim()
        .max(300)
        .refine((p) => p.startsWith(`${AUDITS_DIR}/`) && p.endsWith(".md") && !p.split("/").includes(".."), `a .md path under ${AUDITS_DIR}/`)
        .default(AUDIT_DEFAULT_REPORT_PATH),
    notifyOwner: z.boolean().default(true),
    notifyPms: z.boolean().default(false),
    alertBelowPass: z.boolean().default(false),
});
export type AuditActionParams = z.infer<typeof auditActionParamsSchema>;
export function auditRuleSlug(name: string): string {
    return (name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "audit");
}
export function auditReportPath(pattern: string, date: string, ruleName: string): string {
    return pattern.replaceAll("{date}", date).replaceAll("{rule}", auditRuleSlug(ruleName));
}
export function auditTemplateSections(template: string, vars: {
    rule: string;
    date: string;
}): string[] {
    return template
        .split(/\r?\n/)
        .filter((l) => /^#{1,3}\s+\S/.test(l))
        .map((l) => l.replaceAll("{rule}", vars.rule).replaceAll("{date}", vars.date).replaceAll("{{rule}}", vars.rule).replaceAll("{{date}}", vars.date))
        .slice(0, 40);
}
export const auditVerdictSchema = z.object({
    summary: z.string().max(4000).default(""),
    checklist: z
        .array(z.object({ itemId: z.string().max(100), pass: z.boolean(), note: z.string().max(1000).default("") }))
        .max(200)
        .default([]),
    findings: z
        .array(z.object({ severity: z.enum(["high", "medium", "low"]), title: z.string().max(500), files: z.array(z.string().max(400)).max(20).default([]) }))
        .max(200)
        .default([]),
});
export type AuditVerdict = z.infer<typeof auditVerdictSchema>;
export function parseAuditOutput(output: string): {
    report: string;
    verdict: AuditVerdict;
} | null {
    const re = /```json audit-verdict\n([\s\S]*?)```/g;
    let last: RegExpExecArray | null = null;
    for (let m = re.exec(output); m; m = re.exec(output))
        last = m;
    if (!last)
        return null;
    let raw: unknown;
    try {
        raw = JSON.parse(last[1] ?? "");
    }
    catch {
        return null;
    }
    const parsed = auditVerdictSchema.safeParse(raw);
    if (!parsed.success)
        return null;
    return { report: output.slice(0, last.index).trim(), verdict: parsed.data };
}
export function auditScore(verdict: AuditVerdict): number | null {
    if (verdict.checklist.length === 0)
        return null;
    return Math.round((verdict.checklist.filter((c) => c.pass).length / verdict.checklist.length) * 100);
}
export const auditScopeQuerySchema = z.object({
    projectId: z.string().guid(),
    folders: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean).slice(0, 50))),
    exclude: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean).slice(0, 50))),
});
export type AuditScopeQuery = z.infer<typeof auditScopeQuerySchema>;
export interface AuditScopeFolder {
    path: string;
    files: number;
    bytes: number;
    children: AuditScopeFolder[];
}
export interface AuditScopeResponse {
    tree: AuditScopeFolder;
    selected: {
        files: number;
        bytes: number;
    };
    warn: boolean;
    limits: {
        files: number;
        bytes: number;
    };
}
export const auditsListQuerySchema = z.object({
    ruleId: z.string().guid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    size: z.coerce.number().int().min(1).max(100).default(20),
});
export type AuditsListQuery = z.infer<typeof auditsListQuerySchema>;
export interface AuditRuleSummary {
    id: string;
    name: string;
    scope: "org" | "project";
    cron: string | null;
    lastRun: {
        at: string;
        score: number | null;
        passed: boolean | null;
    } | null;
}
export interface AuditRunRow {
    id: string;
    ruleId: string;
    automationRunId: string;
    at: string;
    score: number | null;
    passed: boolean | null;
    passPercent: number | null;
    findings: {
        high: number;
        medium: number;
        low: number;
    };
    summary: string | null;
    reportPath: string;
    commitSha: string | null;
    scope: {
        folders: string[];
        exclude: string[];
        files: number;
        bytes: number;
        warned: boolean;
    };
    status: "succeeded" | "partial" | "failed";
}
export interface AuditsListResponse {
    rules: AuditRuleSummary[];
    runs: AuditRunRow[];
    total: number;
}
export const auditReportQuerySchema = z.object({ compare: z.string().guid().optional() });
export type AuditReportQuery = z.infer<typeof auditReportQuerySchema>;
export interface AuditReportFile {
    path: string;
    content: string;
    ref: string;
}
export interface AuditReportResponse extends AuditReportFile {
    compare: AuditReportFile | null;
}
