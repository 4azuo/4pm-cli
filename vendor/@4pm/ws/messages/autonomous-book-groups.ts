/**
 * Vendored from @4pm/ws (messages/autonomous-book-groups.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export interface AutonomousBookGroupsRequest {
    count: number;
    docNumbers?: {
        type: string;
        count: number;
        floor: number;
    }[];
}
export interface AutonomousBookGroupsReply {
    groups: number[];
    docNumbers?: {
        type: string;
        values: number[];
    }[];
}
