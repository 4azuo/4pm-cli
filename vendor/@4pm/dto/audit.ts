/**
 * AI audits — the automation action `run_audit`: its params, the scope warning, the report path, the template sections,
 * the agent's `audit-verdict` block and the shapes of the Audits routes. Reports live under `.4pm/audits/` (part of the
 * books set, so they reach `<base>` through the books sync).
 * @adr 0699 @arch 0077
 */
import { z } from "zod";

/** The folder every audit report is written under. */
export const AUDITS_DIR = ".4pm/audits";

/** The default report path pattern (`{date}` = run date in the org timezone, `{rule}` = rule slug). */
export const AUDIT_DEFAULT_REPORT_PATH = `${AUDITS_DIR}/{date}-{rule}.md`;

/** Above this scope the editor warns (never blocks). */
export const AUDIT_SCOPE_WARN = { files: 2000, bytes: 20 * 1024 * 1024 } as const;

/** The fence info string of the verdict block. */
export const AUDIT_VERDICT_FENCE = "json audit-verdict";

const folder = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/, "repo-relative folder");

/** The params of a `run_audit` action. */
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

/** A rule name as a file-name slug. */
export function auditRuleSlug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "audit"
  );
}

/** The report path of one run. */
export function auditReportPath(pattern: string, date: string, ruleName: string): string {
  return pattern.replaceAll("{date}", date).replaceAll("{rule}", auditRuleSlug(ruleName));
}

/** The `#` / `##` headings of a template file — the report's sections (`{rule}` / `{date}` filled). */
export function auditTemplateSections(template: string, vars: { rule: string; date: string }): string[] {
  return template
    .split(/\r?\n/)
    .filter((l) => /^#{1,3}\s+\S/.test(l))
    .map((l) => l.replaceAll("{rule}", vars.rule).replaceAll("{date}", vars.date).replaceAll("{{rule}}", vars.rule).replaceAll("{{date}}", vars.date))
    .slice(0, 40);
}

/** One checklist item verdict of an audit. */
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

/** The report (the answer before the verdict block) and the verdict, or null when the block is missing / invalid. */
export function parseAuditOutput(output: string): { report: string; verdict: AuditVerdict } | null {
  const re = /```json audit-verdict\n([\s\S]*?)```/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(output); m; m = re.exec(output)) last = m;
  if (!last) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(last[1] ?? "");
  } catch {
    return null;
  }
  const parsed = auditVerdictSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { report: output.slice(0, last.index).trim(), verdict: parsed.data };
}

/** The score (0–100) of the checklist verdicts, or null without items. */
export function auditScore(verdict: AuditVerdict): number | null {
  if (verdict.checklist.length === 0) return null;
  return Math.round((verdict.checklist.filter((c) => c.pass).length / verdict.checklist.length) * 100);
}

// ---- Routes ------------------------------------------------------------------------------------------------------

/** Query of rule-0012. */
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

/** One folder of the scope tree. */
export interface AuditScopeFolder {
  path: string;
  files: number;
  bytes: number;
  children: AuditScopeFolder[];
}

/** Response of rule-0012. */
export interface AuditScopeResponse {
  tree: AuditScopeFolder;
  selected: { files: number; bytes: number };
  warn: boolean;
  limits: { files: number; bytes: number };
}

/** Query of project-0167. */
export const auditsListQuerySchema = z.object({
  ruleId: z.string().guid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});
export type AuditsListQuery = z.infer<typeof auditsListQuerySchema>;

/** One audit rule of a project. */
export interface AuditRuleSummary {
  id: string;
  name: string;
  scope: "org" | "project";
  cron: string | null;
  lastRun: { at: string; score: number | null; passed: boolean | null } | null;
}

/** One audit run. */
export interface AuditRunRow {
  id: string;
  ruleId: string;
  automationRunId: string;
  at: string;
  score: number | null;
  passed: boolean | null;
  passPercent: number | null;
  findings: { high: number; medium: number; low: number };
  summary: string | null;
  reportPath: string;
  commitSha: string | null;
  scope: { folders: string[]; exclude: string[]; files: number; bytes: number; warned: boolean };
  status: "succeeded" | "partial" | "failed";
}

/** Response of project-0167 (the runs are the paged list). */
export interface AuditsListResponse {
  rules: AuditRuleSummary[];
  runs: AuditRunRow[];
  total: number;
}

/** Query of project-0168. */
export const auditReportQuerySchema = z.object({ compare: z.string().guid().optional() });
export type AuditReportQuery = z.infer<typeof auditReportQuerySchema>;

/** One report as read from the repo. */
export interface AuditReportFile {
  path: string;
  content: string;
  ref: string;
}

/** Response of project-0168. */
export interface AuditReportResponse extends AuditReportFile {
  compare: AuditReportFile | null;
}
