/**
 * Worker-tools channel handlers (machine-0050-0058, ADR-0206/0252/0254/0258): probe the worker's
 * tool catalog, toggle per-tool auto-update, run streamed install/uninstall/update ops, and
 * reconcile the worker to a pushed manifest (copy-apply / restore). Streamed ops ack acceptance
 * then push `tools.progress` + a terminal `tools.done` keyed by opId; each op reports the fresh
 * snapshot back so the DB-backed Tools panel + restore target stay current.
 */
import {
  WsChannels,
  type ToolsAutoUpdateReply,
  type ToolsAutoUpdateRequest,
  type ToolsDonePayload,
  type ToolsListReply,
  type ToolsMutateReply,
  type ToolsMutateRequest,
  type ToolsProgressPayload,
  type ToolsRestoreReply,
  type ToolsRestoreRequest,
  type WsEnvelope,
} from "@4pm/ws";
import {
  detectWorkerTools,
  reconcileTools,
  resolveInstallTimeoutMs,
  runWorkerToolOp,
  setToolAutoUpdate,
} from "../../worker-tools";
import { readProfileConfig } from "../../../config/profile";
import type { WsHandlerCtx } from "../context";

/** Route the tools.* channels; returns true when the message was handled. */
export function handleToolsChannels(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  payload: Record<string, unknown>,
): boolean {
  switch (message.channel) {
    case WsChannels.TOOLS_LIST:
      // Request/reply (machine-0050, ADR-0206): probe the default catalog + extra globals. Pass the
      // per-tool auto-update flags (config.json, ADR-0253) so each row's `autoUpdate` reflects state.
      void detectWorkerTools(readProfileConfig(ctx.profileDir).autoUpdateTools ?? []).then((reply) =>
        ctx.send(WsChannels.TOOLS_LIST, reply satisfies ToolsListReply, message.id),
      );
      return true;
    case WsChannels.TOOLS_AUTOUPDATE: {
      // Request/reply (machine-0056): the server now persists the flag in the DB (ADR-0254) and
      // forwards this ONLY to an online worker for immediacy, so the local `config.json` mirror —
      // read by the ADR-0074 daily tick — updates now instead of at the next ws_token. A
      // prerequisite / invalid name is rejected without persisting (mirrors runWorkerToolOp).
      const req = payload as unknown as ToolsAutoUpdateRequest;
      const res = setToolAutoUpdate(ctx.profileDir, req.name, req.enabled);
      ctx.send(WsChannels.TOOLS_AUTOUPDATE, res satisfies ToolsAutoUpdateReply, message.id);
      return true;
    }
    case WsChannels.TOOLS_INSTALL:
    case WsChannels.TOOLS_UNINSTALL:
    case WsChannels.TOOLS_UPDATE: {
      // Streamed op (machine-0051/0052/0055, ADR-0206/0252): ack acceptance, then push progress
      // lines and one terminal `tools.done` frame keyed by opId (server relays them over SSE).
      const req = payload as unknown as ToolsMutateRequest;
      const op =
        message.channel === WsChannels.TOOLS_INSTALL
          ? "install"
          : message.channel === WsChannels.TOOLS_UPDATE
            ? "update"
            : "uninstall";
      ctx.send(message.channel, { started: true } satisfies ToolsMutateReply, message.id);
      const opTimeoutMs = resolveInstallTimeoutMs(
        readProfileConfig(ctx.profileDir).toolInstallTimeoutSec,
      );
      void runWorkerToolOp(
        op,
        req.name,
        req.manager,
        (line) =>
          ctx.send(WsChannels.TOOLS_PROGRESS, { opId: req.opId, line } satisfies ToolsProgressPayload),
        opTimeoutMs,
      ).then((res) => {
        ctx.send(WsChannels.TOOLS_DONE, {
          opId: req.opId,
          ok: res.ok,
          exitCode: res.exitCode,
          error: res.error,
        } satisfies ToolsDonePayload);
        // Report the new snapshot to the DB (ADR-0254) so the panel + restore target stay current.
        void ctx.reportWorkerTools();
      });
      return true;
    }
    case WsChannels.TOOLS_RESTORE: {
      // Reconcile the worker to a pushed manifest NOW (ADR-0254): the copy-apply / restore path. The
      // cli installs each missing/mismatched `name@version` (retry+backoff — ADR-0258), then reports
      // its new snapshot with the classified `restoreFailed`. Best-effort; per-tool failures never
      // fail the run. Two shapes (ADR-0258): a **manual** restore carries an `opId` — the cli acks
      // immediately and streams `tools.progress`/`tools.done` keyed by `opId` (machine-0058 → SSE);
      // the connect-hook/copy/re-drive path has no `opId` and the reply IS the terminal result (so the
      // server can clear the pending copy pointer). The report `trigger` echoes the request so a
      // restore-completion report is never mistaken for the `daily` tick that drives the re-drive.
      const req = payload as unknown as ToolsRestoreRequest;
      const restoreTrigger = req.trigger === "manual" ? "manual" : "boot";
      const installTimeoutMs = resolveInstallTimeoutMs(
        readProfileConfig(ctx.profileDir).toolInstallTimeoutSec,
      );
      const manifest = req.manifest.map((m) => ({ name: m.name, version: m.version, manager: m.manager }));
      const opId = req.opId;
      if (opId) {
        // Streamed manual restore (machine-0058): ack "started" now, stream progress + a terminal done.
        ctx.send(WsChannels.TOOLS_RESTORE, { ok: true } satisfies ToolsRestoreReply, message.id);
        void reconcileTools(
          manifest,
          (line) => {
            ctx.bus.log(line);
            ctx.send(WsChannels.TOOLS_PROGRESS, { opId, line } satisfies ToolsProgressPayload);
          },
          installTimeoutMs,
        )
          .then(async (restoreFailed) => {
            ctx.send(WsChannels.TOOLS_DONE, {
              opId,
              ok: restoreFailed.length === 0,
              exitCode: restoreFailed.length === 0 ? 0 : 1,
              // Name the tools that failed + their classified reason so the web card shows more than a
              // bare "failed" (the real per-tool npm/pnpm error already streamed in the log above).
              error:
                restoreFailed.length === 0
                  ? undefined
                  : restoreFailed.map((f) => `${f.name} (${f.reason})`).join(", "),
            } satisfies ToolsDonePayload);
            await ctx.reportWorkerTools(restoreTrigger, restoreFailed);
          })
          .catch((err: unknown) =>
            ctx.send(WsChannels.TOOLS_DONE, {
              opId,
              ok: false,
              exitCode: 1,
              error: String(err),
            } satisfies ToolsDonePayload),
          );
      } else {
        void reconcileTools(manifest, (line) => ctx.bus.log(line), installTimeoutMs)
          .then((restoreFailed) => ctx.reportWorkerTools(restoreTrigger, restoreFailed))
          .then(() => ctx.send(WsChannels.TOOLS_RESTORE, { ok: true } satisfies ToolsRestoreReply, message.id))
          .catch((err: unknown) =>
            ctx.send(
              WsChannels.TOOLS_RESTORE,
              { ok: false, error: String(err) } satisfies ToolsRestoreReply,
              message.id,
            ),
          );
      }
      return true;
    }
    default:
      return false;
  }
}
