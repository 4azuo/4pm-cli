/**
 * Vendored from @4pm/ws (messages/autonomous-book-usage.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export type AutonomousBookName = "USER_TODO" | "USER_QA" | "AI_TODO";
export interface AutonomousBookUsageRequest {
    added?: Partial<Record<AutonomousBookName, number>>;
}
export interface AutonomousBookUsageReply {
    books: Record<AutonomousBookName, {
        used: number;
        limit: number | null;
    }>;
    resetAt: string;
}
