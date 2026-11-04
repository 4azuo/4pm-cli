/**
 * Vendored from @4pm/shared-constants (ws.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export const WsChannel = {
    COMMAND_DISPATCH: "command.dispatch",
    COMMAND_OUTPUT: "command.output",
    MACHINE_STATUS: "machine.status",
} as const;
export type WsChannel = (typeof WsChannel)[keyof typeof WsChannel];
export const WsCloseCode = {
    DRAINING: 4001,
} as const;
export type WsCloseCode = (typeof WsCloseCode)[keyof typeof WsCloseCode];
