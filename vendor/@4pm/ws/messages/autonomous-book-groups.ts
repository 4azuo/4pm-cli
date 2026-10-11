/**
 * `autonomous.bookGroups` messages — the cli asks the server for fresh book group numbers before an intake
 * run (the AI may use only those for its new `TSK-` / `QA-` groups), so no two writers ever pick the same
 * group. cli → server (with reply), relayed by the cli-server to the server's internal gRPC
 * `AllocateBookGroups`; the server counts per project in Postgres.
 * @adr 0455
 */

/** A `autonomous.bookGroups` request. */
export interface AutonomousBookGroupsRequest {
  /** How many groups (1–50). */
  count: number;
}

/** The allocated group numbers (format with `bookGroupCode` → `GGGGGG`). */
export interface AutonomousBookGroupsReply {
  groups: number[];
}
