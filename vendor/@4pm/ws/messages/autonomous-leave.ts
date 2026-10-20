/**
 * `autonomous.leave` messages — server → cli (with reply), sent before a link leaves its served project while it
 * holds a claim: the cli releases the claim on the old project's books (WIP pushed, row returned without an attempt)
 * while its git access still works, then clears its project-scoped autonomous state. The request carries no fields.
 * @adr 0570
 */

/** The cli's answer to `autonomous.leave`. */
export interface AutonomousLeaveReply {
  /** The id of the row returned to the books, or null when nothing was released (no live claim / failure). */
  released: string | null;
  /** Why the release did not happen (timeout, push failure…); the cli still cleared its local state. */
  error?: string;
}
