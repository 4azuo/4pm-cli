/**
 * `audit.*` messages (server → cli, with reply) — AI audits on the serving worker: the repo's folder tree with file
 * counts / bytes for the action editor (`audit.scope`), committing a report under `.4pm/audits/` on the books branch
 * (`audit.saveReport`), and reading one back — books branch, else `origin/<base>` (`audit.readReport`).
 * @adr 0699 @arch 0077
 */

/** One folder of the scope tree. */
export interface AuditScopeFolderWire {
  path: string;
  files: number;
  bytes: number;
  children: AuditScopeFolderWire[];
}

/** `audit.scope` request. */
export interface AuditScopeRequest {
  folders: string[];
  exclude: string[];
}

/** `audit.scope` reply. */
export interface AuditScopeReply {
  ok: boolean;
  tree?: AuditScopeFolderWire;
  selected?: { files: number; bytes: number };
  code?: string;
  error?: string;
}

/** `audit.saveReport` request. */
export interface AuditSaveReportRequest {
  path: string;
  content: string;
  commitMessage: string;
}

/** `audit.saveReport` reply. */
export interface AuditSaveReportReply {
  ok: boolean;
  commit?: string | null;
  baseCommit?: string | null;
  code?: string;
  error?: string;
}

/** `audit.readReport` request. */
export interface AuditReadReportRequest {
  path: string;
}

/** `audit.readReport` reply. */
export interface AuditReadReportReply {
  ok: boolean;
  content?: string;
  ref?: string;
  /** `AUDIT_REPORT_NOT_FOUND` */
  code?: string;
  error?: string;
}
