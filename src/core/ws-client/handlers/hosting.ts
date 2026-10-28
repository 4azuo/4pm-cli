/**
 * Worker hosting channel handlers: `host.deploy` (reply `{accepted}`), `host.stop`, `host.tunnel.start` /
 * `.stop` and `host.logs` (reply) — all served by the process's `HostingRunner`.
 * @adr 0664
 */
import { WsChannels, type HostDeployRequest, type HostLogsRequest, type HostStopRequest, type HostTunnelRequest, type WsEnvelope } from "@4pm/ws";
import { logger } from "../../../common/logger/logger";
import type { HostingRunner } from "../../hosting/hosting-runner";
import type { WsHandlerCtx } from "../context";

/** Route the host.* channels; returns true when the message was handled. */
export function handleHostingChannels(ctx: WsHandlerCtx, runner: HostingRunner, message: WsEnvelope, payload: Record<string, unknown>): boolean {
  switch (message.channel) {
    case WsChannels.HOST_DEPLOY:
      ctx.send(WsChannels.HOST_DEPLOY, runner.deploy(payload as unknown as HostDeployRequest), message.id);
      return true;
    case WsChannels.HOST_STOP: {
      const req = payload as unknown as HostStopRequest;
      void runner.stopEnv(req.environmentId, req.releaseId).catch((err: unknown) => logger.warn("hosting.stop.failed", { error: String(err) }));
      return true;
    }
    case WsChannels.HOST_TUNNEL_START:
    case WsChannels.HOST_TUNNEL_STOP: {
      const on = message.channel === WsChannels.HOST_TUNNEL_START;
      void runner.tunnel(payload as unknown as HostTunnelRequest, on).catch((err: unknown) => logger.warn("hosting.tunnel.failed", { error: String(err) }));
      return true;
    }
    case WsChannels.HOST_LOGS: {
      const req = payload as unknown as HostLogsRequest;
      ctx.send(WsChannels.HOST_LOGS, runner.logs(req.environmentId, Math.min(2000, Math.max(1, Number(req.lines) || 300))), message.id);
      return true;
    }
    default:
      return false;
  }
}
