/**
 * Vendored from @4pm/ws (messages/ai-run-state.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export type AiRunSource = "command" | "local" | "autonomous" | "task" | "support" | "research" | "faq" | "memory";
export interface AiRunInfo {
    runId: string;
    label: string;
    account: string;
    provider: string;
    source: AiRunSource;
    startedAt: string;
}
export interface AiRunStatePayload {
    runs: AiRunInfo[];
}
