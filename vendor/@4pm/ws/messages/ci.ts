/**
 * Vendored from @4pm/ws (messages/ci.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export interface CiProposeFile {
    path: string;
    content: string | null;
}
export interface CiProposeRequest {
    files: CiProposeFile[];
    title: string;
    body: string;
    slug: string;
    scope: string;
    by: string;
    byLabel: string;
}
export interface CiProposeReply {
    ok: boolean;
    branch?: string;
    prUrl?: string | null;
    number?: number | null;
    code?: string;
    step?: "base" | "push" | "pr";
    error?: string;
}
export { CI_PROPOSE_MAX_FILE_BYTES, CI_PROPOSE_MAX_FILES, CI_PROPOSE_PATH } from "@4pm/shared-constants";
