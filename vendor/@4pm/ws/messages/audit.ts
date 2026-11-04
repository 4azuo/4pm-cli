/**
 * Vendored from @4pm/ws (messages/audit.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export interface AuditScopeFolderWire {
    path: string;
    files: number;
    bytes: number;
    children: AuditScopeFolderWire[];
}
export interface AuditScopeRequest {
    folders: string[];
    exclude: string[];
}
export interface AuditScopeReply {
    ok: boolean;
    tree?: AuditScopeFolderWire;
    selected?: {
        files: number;
        bytes: number;
    };
    code?: string;
    error?: string;
}
export interface AuditSaveReportRequest {
    path: string;
    content: string;
    commitMessage: string;
}
export interface AuditSaveReportReply {
    ok: boolean;
    commit?: string | null;
    baseCommit?: string | null;
    code?: string;
    error?: string;
}
export interface AuditReadReportRequest {
    path: string;
}
export interface AuditReadReportReply {
    ok: boolean;
    content?: string;
    ref?: string;
    code?: string;
    error?: string;
}
