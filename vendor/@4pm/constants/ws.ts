/**
 * WebSocket channel names server ↔ 4PM cli (details in @4pm/ws).
 */

/** Standard WS channels — identify the message type. */
export const WsChannel = {
  COMMAND_DISPATCH: "command.dispatch",
  COMMAND_OUTPUT: "command.output",
  MACHINE_STATUS: "machine.status",
} as const;

/** Union type of WS channels. */
export type WsChannel = (typeof WsChannel)[keyof typeof WsChannel];

/** 4PM-specific WS close codes. */
export const WsCloseCode = {
  /** Server draining (graceful shutdown) — cli reconnect backoff + jitter. */
  DRAINING: 4001,
} as const;

/** Union type of close codes. */
export type WsCloseCode = (typeof WsCloseCode)[keyof typeof WsCloseCode];
