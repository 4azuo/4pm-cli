/**
 * Project-mode messages. `repo.pushProbe` (server → cli, reply): may the project credential push the primary repo's
 * `<base>`? — run before Delivery · Auto is accepted. `autonomous.autoApprove` (cli → server, reply): under Rigor ·
 * Best performance the cli asks the server to sign approvals as the actor `auto` for rows it just published; the
 * server signs only while the project's rigor is `fast` and returns the signed entries for the cli to write.
 * @adr 0608
 */
import type { ApprovalEntry } from "./envelope";

/** Server → cli: probe push rights on the primary repo's base branch. */
export type RepoPushProbeRequest = Record<string, never>;

/** The probe outcome; `reason` names what failed (no credential, push refused, protected branch…). */
export interface RepoPushProbeReply {
  ok: boolean;
  reason?: string;
}

/** Cli → server: the rows to approve automatically, with the books they live in (USER_QA rows are refused). */
export interface AutonomousAutoApproveRequest {
  rowIds: string[];
  books: { userTodo?: string; aiTodo?: string };
}

/** The signed final entries (by `auto`) per row; `error` when the server refuses (rigor is not `fast`). */
export interface AutonomousAutoApproveReply {
  signed: Record<string, ApprovalEntry>;
  /** No signing key was ever published — the cli writes plain approvals for `rowIds`. */
  unsigned?: boolean;
  /** The rows the server accepted (USER_QA and unknown rows dropped). */
  rowIds: string[];
  error?: string;
}
