/**
 * `autonomous.bookGroups` messages — the cli asks the server for fresh book group numbers before an intake
 * run (the AI may use only those for its new `TSK-` / `QA-` groups), so no two writers ever pick the same
 * group. cli → server (with reply), relayed by the cli-server to the server's internal gRPC
 * `AllocateBookGroups`; the server counts per project in Postgres. A DOC round asks the same channel for the
 * numbers of its new numbered doc files (`docNumbers`, one counter per doc type — `count: 0` when it needs no group).
 * @adr 0455 @adr 0536
 */

/** A `autonomous.bookGroups` request. */
export interface AutonomousBookGroupsRequest {
  /** How many groups (1–50; 0 with `docNumbers` = doc numbers only). */
  count: number;
  /** Doc numbers per doc type: `count` numbers above `floor` (the highest seen in the repo). @adr 0536 */
  docNumbers?: { type: string; count: number; floor: number }[];
}

/** The allocated group numbers (format with `bookGroupCode` → `GGGGGG`). */
export interface AutonomousBookGroupsReply {
  groups: number[];
  /** The allocated doc numbers per type (absent from an older server). @adr 0536 */
  docNumbers?: { type: string; values: number[] }[];
}
