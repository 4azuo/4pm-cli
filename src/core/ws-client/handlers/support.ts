/**
 * AI-compose channel handlers run through the shared AI path (every configured account, working-first,
 * failover, account lease — ADR-0520): SUPPORT_ANSWER — a support agent answers a "how to use 4PM"
 * question from the shared docs/FAQ repo, isolated from any customer project; FAQ_COMPOSE — the platform
 * pool distils support tickets into FAQ markdown and opens a PR; CHECKLIST_AUTHOR — the org AI pool drafts
 * checklist items. Each echoes the Q/A into the transcript like a normal AI dispatch so the operator sees it.
 * @adr 0170 @adr 0057 @adr 0520
 */
import {
  WsChannels,
  type ChecklistAuthorReply,
  type ChecklistAuthorRequest,
  type FaqComposeRequest,
  type SupportAnswerRequest,
  type UsageReportPayload,
  type WsEnvelope,
} from "@4pm/ws";
import { UsageMetric } from "@4pm/constants";
import { runChecklistAuthor, runSupportAnswer } from "../../knowledge/support-answer";
import { runFaqCompose } from "../../knowledge/faq-compose";
import { aiProviderOf } from "../../ai/ai-stream";
import { createAiTextRunner } from "../../ai/ai-text-run";
import { resolveClaudeAuthMode } from "../../../utils/ai-cli";
import { readProfileConfig } from "../../../config/profile";
import { acquireRunSlot } from "../run-slot";
import type { WsHandlerCtx } from "../context";

/** Route the AI-compose channels; returns true when the message was handled. */
export function handleSupportChannels(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  payload: Record<string, unknown>,
): boolean {
  switch (message.channel) {
    case WsChannels.SUPPORT_ANSWER: {
      // Request/reply: a support agent answers a "how to use 4PM" question by
      // reading the shared docs/FAQ repo. Isolated from any customer project (own cache dir).
      const req = payload as unknown as SupportAnswerRequest;
      const supportCmd = readProfileConfig(ctx.profileDir).aiCli || "claude";
      // Echo the Q&A into the transcript like a normal AI dispatch (ADR-0057/0108) so the
      // operator at the support machine sees the question and the composed answer, not just
      // the "processing" spinner. Server-dispatched ⇒ source "server".
      ctx.bus.push({ source: "server", kind: "aireq", text: `${supportCmd} ‹ ${req.question}` });
      ctx.bus.startBusy("support-answer");
      void runSupportAnswer(req, createAiTextRunner(ctx), ctx.profileDir)
        .then((reply) => {
          if (reply.error) {
            ctx.bus.push({
              source: "server",
              kind: "log",
              text: `support-answer failed: ${reply.error}`,
              level: "warn",
            });
          } else {
            ctx.bus.push({ source: "server", kind: "aires", text: `${supportCmd} ›` });
            ctx.bus.push({ source: "server", kind: "out", text: reply.body });
          }
          ctx.send(WsChannels.SUPPORT_ANSWER, reply, message.id);
        })
        .finally(() => ctx.bus.endBusy("support-answer"));
      return true;
    }
    case WsChannels.FAQ_COMPOSE: {
      // Request/reply (ADR-0333): the platform AI pool distils the selected support tickets into FAQ
      // markdown in the 4pm-faq repo and opens a PR, using the short-lived WRITE token in the request
      // (never persisted). Write-capable agent — same profile handling as the normal AI dispatch.
      const freq = payload as unknown as FaqComposeRequest;
      const fcmd = readProfileConfig(ctx.profileDir).aiCli || "claude";
      ctx.bus.push({ source: "server", kind: "aireq", text: `${fcmd} ‹ synthesize FAQ (${freq.tickets.length} tickets)` });
      ctx.bus.startBusy("faq-compose");
      void runFaqCompose(freq, createAiTextRunner(ctx))
        .then((reply) => {
          if (reply.error) {
            ctx.bus.push({ source: "server", kind: "log", text: `faq-compose failed: ${reply.error}`, level: "warn" });
          } else {
            ctx.bus.push({ source: "server", kind: "aires", text: `${fcmd} › ${reply.prUrl || "no changes"}` });
          }
          ctx.send(WsChannels.FAQ_COMPOSE, reply, message.id);
        })
        .finally(() => ctx.bus.endBusy("faq-compose"));
      return true;
    }
    case WsChannels.CHECKLIST_AUTHOR: {
      // Request/reply (ADR-0376): the org AI pool runs a one-shot "author checklist items" prompt
      // (built by the web) — text-in → text-out, no tools, no project. Same profile handling as the
      // normal AI dispatch. The web parses the proposed items from the returned output.
      const creq = payload as unknown as ChecklistAuthorRequest;
      const ccfg = readProfileConfig(ctx.profileDir);
      const ccmd = ccfg.aiCli || "claude";
      ctx.bus.push({ source: "server", kind: "aireq", text: `${ccmd} ‹ author checklist items` });
      ctx.bus.startBusy("checklist-author");
      void (async () => {
        // Org AI checklist authoring takes an org run slot (ADR-0359) and is metered to the org
        // (ADR-0380 — COMMANDS + AI_TOKENS, projectId=null on an org-AI-pool cli), like every AI run.
        const slot = await acquireRunSlot(ctx, () => undefined);
        if (slot.kind !== "granted") {
          ctx.send(
            WsChannels.CHECKLIST_AUTHOR,
            { error: slot.kind === "denied" ? "storage full" : "no idle run slot" } satisfies ChecklistAuthorReply,
            message.id,
          );
          return;
        }
        try {
          const { reply, usage, workedCmd } = await runChecklistAuthor(creq, createAiTextRunner(ctx));
          const occurredAt = new Date().toISOString();
          const events: UsageReportPayload["events"] = [{ metric: UsageMetric.COMMANDS, amount: 1, occurredAt }];
          if (usage.tokens > 0) {
            events.push({
              metric: UsageMetric.AI_TOKENS,
              amount: usage.tokens,
              occurredAt,
              inputTokens: usage.input,
              outputTokens: usage.output,
              cacheReadTokens: usage.cacheRead,
              cacheCreationTokens: usage.cacheCreation,
              provider: aiProviderOf(workedCmd ?? ccmd),
              authMode: resolveClaudeAuthMode(ccfg),
            });
          }
          ctx.reportUsage(events, null);
          if (reply.error) {
            ctx.bus.push({ source: "server", kind: "log", text: `checklist-author failed: ${reply.error}`, level: "warn" });
          } else {
            ctx.bus.push({ source: "server", kind: "aires", text: `${ccmd} ›` });
          }
          ctx.send(WsChannels.CHECKLIST_AUTHOR, reply, message.id);
        } finally {
          slot.handle.release();
        }
      })().finally(() => ctx.bus.endBusy("checklist-author"));
      return true;
    }
    default:
      return false;
  }
}
