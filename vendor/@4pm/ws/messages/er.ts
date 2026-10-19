/**
 * `er.read` / `er.write` messages — the project ER on the books branch (server → cli, with reply). Read the
 * approved module files (now or at a past version), the change requests with their states, the entity
 * versions and the history; save / withdraw a change request; approve-and-apply / reject one. Shapes mirror
 * `@4pm/dto` (`ErcState`, `ErHistoryEntry`, `ApprovalEntry`) structurally — this package has no dto import.
 * @adr 0453 @arch 0053
 */
import type { ApprovalEntry, ApprovalState } from "./envelope";

/** ERC lifecycle state — mirrors `@4pm/dto` `ErcState`. */
export type ErcStateWire = "pending" | "applied" | "rejected" | "conflict" | "withdrawn";

/** `er.read` request. */
export interface ErReadRequest {
  /** Read the module files as of this applied version (absent ⇒ current). */
  version?: number;
  /** Include the change-request files (default true). */
  changes?: boolean;
}

/** One module file. */
export interface ErModuleFile {
  name: string;
  path: string;
  content: string;
}

/** One change-request file with its sidecar record. */
export interface ErChangeFile {
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

/** One applied version. */
export interface ErHistoryWire {
  version: number;
  erc: string;
  appliedAt: string;
  approvedBy: string;
  approvedByLabel?: string;
  entities: string[];
  commit?: string;
}

/** `er.read` reply (`error` set on failure — e.g. an unknown version). */
export interface ErReadReply {
  erDir: string;
  /** The version `modules` belong to (0 = no ER yet). */
  version: number;
  /** The current (latest) version. */
  currentVersion: number;
  index: string;
  modules: ErModuleFile[];
  changes: ErChangeFile[];
  entities: Record<string, { v: number; module: string }>;
  /** Newest first. */
  history: ErHistoryWire[];
  /** `.autonomous.approvals.json` / `.autonomous.authors.json` texts. */
  approvals: string;
  authors: string;
  /** Signature state of each ERC approval entry. */
  approvalStates: Record<string, ApprovalState>;
  error?: string;
}

/** `er.write` request — `by` / `byLabel` / `byIsAdmin` are server-filled. */
export type ErWriteRequest =
  | {
      kind: "save";
      /** `ERC-<n>` to revise; absent = new. */
      id?: string;
      title: string;
      module: string;
      modules: { name: string; content: string }[];
      baseVersion: number;
      rationale?: string;
      req?: string[];
      group?: string;
      by: string;
      byLabel?: string;
    }
  | { kind: "withdraw"; id: string; by: string; byLabel?: string; byIsAdmin?: boolean }
  | {
      kind: "decide";
      id: string;
      decision: "approve" | "reject";
      reason?: string;
      /** The server-signed approval entry (approve; absent in unsigned mode — the cli writes an unsigned one). */
      entry?: ApprovalEntry;
      /** The ERC file hash the approver signed (`sha256:<hex>`) — the cli refuses a mismatch. */
      h?: string;
      by: string;
      byLabel?: string;
      byIsAdmin?: boolean;
    };

/** `er.write` reply. `code` = `ER_CHANGE_CONFLICT` | `ER_CHANGE_INVALID` | `ER_CHANGE_STALE` | `APPROVAL_SELF` | `APPROVAL_STALE` | `NOT_FOUND` | `FORBIDDEN`. */
export interface ErWriteReply {
  ok: boolean;
  id?: string;
  state?: ErcStateWire;
  /** Other open ERCs touching the same entities. */
  overlaps?: string[];
  /** The new ER version after an apply. */
  version?: number;
  code?: string;
  error?: string;
  /** Detail for the UI: `{module, line}` (invalid), `{conflictsWith, entities}` (conflict). */
  meta?: Record<string, unknown>;
}
