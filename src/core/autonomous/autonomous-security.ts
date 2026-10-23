/**
 * The security review of a finished task (Rigor · Full power): its prompt over the task diff (≤ 200 KB) and
 * `AI_SECURITY.md`, the reply parser (any `high` / `critical` finding fails it whatever the stated verdict), and the
 * `ai-security-<ID>.md` evidence written on a pass.
 * @adr 0608 @arch 0065
 */
import { resolveCliPrompt } from "../ai/prompt-overrides";

/** Cap of the diff given to the review. */
export const SECURITY_DIFF_MAX = 200 * 1024;

/** One finding of the review. */
export interface SecurityFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  issue: string;
  fix: string;
}

/** The parsed review. */
export interface SecurityVerdict {
  verdict: "pass" | "fail";
  findings: SecurityFinding[];
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

/** Build the review prompt (task text, diff and security rules are wrapped as untrusted by the registry). */
export function buildSecurityPrompt(taskId: string, desc: string, diff: string, security: string): string {
  return resolveCliPrompt("cli.autonomous.securityReview", {
    taskId,
    desc,
    diff: diff.slice(0, SECURITY_DIFF_MAX) || "(no changes)",
    security: security.trim() || "(none)",
  });
}

/** Parse the last JSON block of a reply into a verdict; null when it does not parse. */
export function parseSecurityReply(text: string): SecurityVerdict | null {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)].map((m) => m[1]!.trim()).reverse();
  const candidates = fenced.length ? fenced : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    try {
      const o = JSON.parse(c) as { verdict?: unknown; findings?: unknown };
      if (o.verdict !== "pass" && o.verdict !== "fail") continue;
      const findings = (Array.isArray(o.findings) ? o.findings : []).flatMap((f): SecurityFinding[] => {
        const r = (f ?? {}) as Record<string, unknown>;
        const severity = SEVERITIES.includes(r.severity as SecurityFinding["severity"]) ? (r.severity as SecurityFinding["severity"]) : "medium";
        const str = (v: unknown): string => (typeof v === "string" ? v.slice(0, 2000) : "");
        return [{ severity, file: str(r.file), line: typeof r.line === "number" ? r.line : 0, issue: str(r.issue), fix: str(r.fix) }];
      });
      // A blocking finding fails the review whatever verdict the reply states.
      const blocking = findings.some((f) => f.severity === "critical" || f.severity === "high");
      return { verdict: blocking || o.verdict === "fail" ? "fail" : "pass", findings };
    } catch {
      // try the next block
    }
  }
  return null;
}

/** One line per finding (for the attempt reason / the next implement prompt). */
export function findingsText(findings: readonly SecurityFinding[]): string {
  return findings.map((f) => `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.issue}${f.fix ? ` (fix: ${f.fix})` : ""}`).join("\n");
}

/** The `ai-security-<ID>.md` evidence of a passed review. */
export function securityMarkdown(taskId: string, v: SecurityVerdict, at: string = new Date().toISOString()): string {
  const rows = v.findings.length
    ? v.findings.map((f) => `| ${f.severity} | \`${f.file}${f.line ? `:${f.line}` : ""}\` | ${f.issue.replace(/\|/g, "\\|")} | ${f.fix.replace(/\|/g, "\\|")} |`).join("\n")
    : "| — | — | No finding | — |";
  return `# Security review — ${taskId}\n\nVerdict: **${v.verdict}** · ${at}\n\n| Severity | Where | Issue | Fix |\n| --- | --- | --- | --- |\n${rows}\n`;
}
