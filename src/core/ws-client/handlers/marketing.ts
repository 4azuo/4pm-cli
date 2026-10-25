/**
 * Marketing channel handlers (`marketing.read` / `.write` / `.approve`, request / reply): the scenes of Content ▸
 * Marketing on `4pm/marketing/<base>` of the served project. A worker serving no project answers with a refusal.
 * @adr 0640 @arch 0067
 */
import { WsChannels, type MarketingApproveRequest, type MarketingReadRequest, type MarketingWriteRequest, type WsEnvelope } from "@4pm/ws";
import { approveMarketing, readMarketing, writeMarketing } from "../../marketing/marketing-scenes";
import { work } from "../../session/work-tracker";
import type { WsHandlerCtx } from "../context";

/** The reply when the worker serves no project. */
const NO_PROJECT = { ok: false, code: "MARKETING_WRITE_FAILED", error: "This worker serves no project." };

/** Route the marketing.* channels; returns true when the message was handled. */
export function handleMarketingChannels(ctx: WsHandlerCtx, message: WsEnvelope, payload: Record<string, unknown>): boolean {
  const root = ctx.physicRoot;
  switch (message.channel) {
    case WsChannels.MARKETING_READ: {
      const req = payload as unknown as MarketingReadRequest;
      void (root ? readMarketing(root, req) : Promise.resolve(NO_PROJECT)).then((reply) => ctx.send(WsChannels.MARKETING_READ, reply, message.id));
      return true;
    }
    case WsChannels.MARKETING_WRITE: {
      const req = payload as unknown as MarketingWriteRequest;
      void (root ? work.track("bookWrite", "marketing.write", () => writeMarketing(root, req)) : Promise.resolve(NO_PROJECT)).then((reply) =>
        ctx.send(WsChannels.MARKETING_WRITE, reply, message.id),
      );
      return true;
    }
    case WsChannels.MARKETING_APPROVE: {
      const req = payload as unknown as MarketingApproveRequest;
      void (root ? work.track("bookWrite", "marketing.approve", () => approveMarketing(root, req)) : Promise.resolve(NO_PROJECT)).then((reply) =>
        ctx.send(WsChannels.MARKETING_APPROVE, reply, message.id),
      );
      return true;
    }
    default:
      return false;
  }
}
