/**
 * `diagram.read` / `diagram.write` messages — the project system diagram (draw.io) on the books branch (server →
 * cli, with reply). Read the approved module files (now or at a past version), the change requests with their
 * states, the cell versions, the history and the auto-approve flag; save / withdraw a change request (applied at
 * once under `diagramAutoApprove`); approve-and-apply / reject one. Shapes mirror `@4pm/dto` structurally.
 * @adr 0530 @arch 0057
 */
import type { ApprovalEntry, ApprovalState } from "./envelope";
import type { ErcStateWire } from "./er";

/** `diagram.read` request. */
export interface DiagramReadRequest {
  version?: number;
  changes?: boolean;
}

/** One `.drawio` module file. */
export interface DiagramModuleFile {
  name: string;
  path: string;
  content: string;
}

/** One change-request file with its sidecar record. */
export interface DiagramChangeFile {
  id: string;
  path: string;
  content: string;
  state: ErcStateWire;
  reason?: string;
  conflictsWith?: string[];
  appliedVersion?: number;
  at?: string;
  by?: string;
  byLabel?: string;
}

/** One applied version (`approvedBy = "auto"` for an auto-approved apply). */
export interface DiagramHistoryWire {
  version: number;
  sdc: string;
  appliedAt: string;
  approvedBy: string;
  approvedByLabel?: string;
  cells: string[];
  commit?: string;
}

/** `diagram.read` reply (`error` set on failure). */
export interface DiagramReadReply {
  diagramDir: string;
  version: number;
  currentVersion: number;
  /** The project's `diagramAutoApprove` as the cli has it (policy). */
  autoApprove: boolean;
  index: string;
  modules: DiagramModuleFile[];
  changes: DiagramChangeFile[];
  cells: Record<string, { v: number; module: string; page: string }>;
  /** Newest first. */
  history: DiagramHistoryWire[];
  approvals: string;
  authors: string;
  approvalStates: Record<string, ApprovalState>;
  error?: string;
}

/** `diagram.write` request — `by` / `byLabel` / `byIsAdmin` are server-filled. */
export type DiagramWriteRequest =
  | {
      kind: "save";
      id?: string;
      title: string;
      module: string;
      page?: string;
      modules: { name: string; content: string }[];
      baseVersion: number;
      rationale?: string;
      req?: string[];
      group?: string;
      source?: "web" | "draft";
      by: string;
      byLabel?: string;
    }
  | { kind: "withdraw"; id: string; by: string; byLabel?: string; byIsAdmin?: boolean }
  | {
      kind: "decide";
      id: string;
      decision: "approve" | "reject";
      reason?: string;
      entry?: ApprovalEntry;
      h?: string;
      by: string;
      byLabel?: string;
      byIsAdmin?: boolean;
    };

/** `diagram.write` reply. `code` = `DIAGRAM_CHANGE_CONFLICT` | `DIAGRAM_INVALID` | `DIAGRAM_CHANGE_STALE` | `APPROVAL_SELF` | `APPROVAL_STALE` | `NOT_FOUND` | `FORBIDDEN`. */
export interface DiagramWriteReply {
  ok: boolean;
  id?: string;
  state?: ErcStateWire;
  overlaps?: string[];
  version?: number;
  code?: string;
  error?: string;
  meta?: Record<string, unknown>;
}
