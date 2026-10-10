/**
 * Assorted single-channel handlers that don't warrant their own module: tail this cli's logs
 * (LOG_READ), read a finished command's captured output (COMMAND_OUTPUT_READ),
 * flush the log tail on rental release (RENTAL_FLUSH), act as an outbound reviewer
 * (REVIEW_EVALUATE), and start/stop the console-sync / worker-metrics
 * watch leases.
 * @adr 0150 @adr 0214 @adr 0072 @adr 0115 @adr 0210 @adr 0082
 */
import { join } from "node:path";
import {
  WsChannels,
  type CommandOutputReply,
  type CommandOutputRequest,
  type ConsoleWatchPayload,
  type LogReadReply,
  type LogReadRequest,
  type MetricsWatchPayload,
  type RentalFlushReply,
  type ReviewEvaluatePayload,
  type WsEnvelope,
} from "@4pm/ws";
import { readCommandOutput } from "../../exec/command-output-store";
import { evaluateReview } from "../../agent/outbound-review";
import { readRecentLogLines } from "../../../common/logger/logger";
import type { WsHandlerCtx } from "../context";

/** Route the assorted single channels; returns true when the message was handled. */
export function handleMiscChannels(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  payload: Record<string, unknown>,
): boolean {
  switch (message.channel) {
    case WsChannels.CLI_UPDATE: {
      // server → cli (ADR-0289): update to latest now (idle-aware self-update + re-exec). No reply.
      ctx.updateCliNow();
      return true;
    }
    case WsChannels.LOG_READ: {
      // Request/reply (machine-0019): tail this cli's own JSONL logs.
      const limit = Math.min(Math.max((payload as LogReadRequest).limit ?? 200, 1), 2000);
      const lines = readRecentLogLines(join(ctx.profileDir, "logs"), limit);
      ctx.send(WsChannels.LOG_READ, { lines } satisfies LogReadReply, message.id);
      return true;
    }
    case WsChannels.COMMAND_OUTPUT_READ: {
      // Request/reply: read a finished command's captured output from the local
      // command-output store; null when pruned (>200 files) or never captured.
      const output = readCommandOutput((payload as unknown as CommandOutputRequest).commandId);
      ctx.send(WsChannels.COMMAND_OUTPUT_READ, { output } satisfies CommandOutputReply, message.id);
      return true;
    }
    case WsChannels.RENTAL_FLUSH: {
      // Request/reply: the machine is being released — flush the pending log tail so
      // it is persisted server-side before the scrub, then ack. Per-command history was already
      // pushed on finish, so the log upload is the only queued data. Best-effort; always acks.
      ctx.uploadLog();
      ctx.send(WsChannels.RENTAL_FLUSH, { ok: true } satisfies RentalFlushReply, message.id);
      return true;
    }
    case WsChannels.REVIEW_EVALUATE:
      // This cli is an outbound reviewer: vet another cli's input, reply verdict.
      void evaluateReview(payload as unknown as ReviewEvaluatePayload).then((reply) =>
        ctx.send(WsChannels.REVIEW_EVALUATE, reply, message.id),
      );
      return true;
    case WsChannels.CONSOLE_WATCH:
      // A web Console viewer attached/detached — start/stop mirroring the transcript.
      ctx.setConsoleWatching((payload as unknown as ConsoleWatchPayload).on);
      return true;
    case WsChannels.METRICS_WATCH:
      // A viewer has the Workers tab open — start/stop sampling worker resources.
      ctx.setMetricsWatching((payload as unknown as MetricsWatchPayload).on);
      return true;
    default:
      return false;
  }
}
