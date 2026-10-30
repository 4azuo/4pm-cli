/**
 * `audit.saveReport` / `audit.readReport` — AI audit reports under `.4pm/audits/` (part of the books set): the save
 * commits the report on the books branch through the books writer (the books sync brings it to `<base>`); the read
 * takes it from the books branch, else `origin/<base>`. Paths outside `.4pm/audits/` or not `.md` are refused. Never
 * throws.
 * @adr 0699 @arch 0077
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AUDITS_DIR } from "@4pm/dto";
import type { AuditReadReportReply, AuditReadReportRequest, AuditSaveReportReply, AuditSaveReportRequest } from "@4pm/ws";
import { booksReadRef, freshBooksRef, gitQuiet, mutateBooks, readBooksFile, resolveBases } from "../../autonomous/autonomous-git";

/** Largest report accepted. */
const MAX_REPORT_BYTES = 1024 * 1024;

/** True for a `.md` path under the audits folder. */
export function validReportPath(path: string): boolean {
  return typeof path === "string" && path.startsWith(`${AUDITS_DIR}/`) && path.endsWith(".md") && !path.split("/").some((s) => s === ".." || s === "");
}

/** `audit.saveReport` on the project at `root`. */
export async function saveAuditReport(root: string, req: AuditSaveReportRequest): Promise<AuditSaveReportReply> {
  try {
    if (!validReportPath(req.path)) return { ok: false, code: "AUDIT_PATH_INVALID", error: `The report must be a .md file under ${AUDITS_DIR}/.` };
    if (Buffer.byteLength(req.content ?? "") > MAX_REPORT_BYTES) return { ok: false, code: "AUDIT_REPORT_SAVE_FAILED", error: "The report is larger than 1 MB." };
    const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
    if (!base) return { ok: false, code: "AUDIT_REPORT_SAVE_FAILED", error: "The repository has no base branch." };
    const result = await mutateBooks(
      root,
      base,
      (req.commitMessage || "audit: report").slice(0, 200),
      async (dir) => {
        const abs = join(dir, req.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, req.content.endsWith("\n") ? req.content : `${req.content}\n`, "utf8");
        return true;
      },
      [AUDITS_DIR],
    );
    if (result === "failed") return { ok: false, code: "AUDIT_REPORT_SAVE_FAILED", error: "Could not push the report to the books branch (retry)." };
    const ref = await freshBooksRef(root, base);
    const commit = ref ? (await gitQuiet(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim() || null : null;
    const baseCommit = (await gitQuiet(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}^{commit}`])).trim() || null;
    return { ok: true, commit, baseCommit };
  } catch (err) {
    return { ok: false, code: "AUDIT_REPORT_SAVE_FAILED", error: err instanceof Error ? err.message : String(err) };
  }
}

/** `audit.readReport` on the project at `root`. */
export async function readAuditReport(root: string, req: AuditReadReportRequest): Promise<AuditReadReportReply> {
  try {
    if (!validReportPath(req.path)) return { ok: false, code: "AUDIT_PATH_INVALID", error: "Not an audit report path." };
    const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
    if (!base) return { ok: false, code: "AUDIT_REPORT_NOT_FOUND", error: "The repository has no base branch." };
    const content = await readBooksFile(root, base, req.path);
    if (content) return { ok: true, content: content.slice(0, MAX_REPORT_BYTES), ref: (await booksReadRef(root, base)) ?? base };
    const onBase = await gitQuiet(root, ["show", `refs/remotes/origin/${base}:${req.path}`]);
    if (onBase) return { ok: true, content: onBase.slice(0, MAX_REPORT_BYTES), ref: `origin/${base}` };
    return { ok: false, code: "AUDIT_REPORT_NOT_FOUND", error: "The report is not on the books branch nor on the base." };
  } catch (err) {
    return { ok: false, code: "AUDIT_REPORT_NOT_FOUND", error: err instanceof Error ? err.message : String(err) };
  }
}
