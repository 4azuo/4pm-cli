/**
 * AI-compose channel handlers that spawn `claude` with the operator's configured profiles (working-
 * first + failover, ADR-0057): SUPPORT_ANSWER — a support agent answers a "how to use 4PM" question
 * from the shared docs/FAQ repo, isolated from any customer project (ADR-0170); KNOWLEDGE_COMPOSE —
 * distil the served project into a knowledge article, run in its working dir (ADR-0190). Both echo
 * the Q/A into the transcript like a normal AI dispatch so the operator sees it.
 */
import {
  WsChannels,
  type KnowledgeComposeRequest,
  type SupportAnswerRequest,
  type WsEnvelope,
} from "@4pm/ws";
import { runSupportAnswer } from "../../support-answer";
import { runKnowledgeCompose } from "../../knowledge-compose";
import { reportToolResult } from "../../tool-health";
import { getWorkingProfile } from "../../ai-profile-state";
import { resolveClaudeProfiles } from "../../../utils/ai-cli";
import { readProfileConfig } from "../../../config/profile";
import type { WsHandlerCtx } from "../context";

/** Route the AI-compose channels; returns true when the message was handled. */
export function handleSupportChannels(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  payload: Record<string, unknown>,
): boolean {
  switch (message.channel) {
    case WsChannels.SUPPORT_ANSWER: {
      // Request/reply (ADR-0170): a support agent answers a "how to use 4PM" question by
      // reading the shared docs/FAQ repo. Isolated from any customer project (own cache dir).
      // Resolve the operator's configured claude profiles (working-first) so claude runs with a
      // signed-in account (CLAUDE_CONFIG_DIR) + its model and fails over on auth/limit — the same
      // profile handling as the normal AI dispatch (ADR-0057), which a bare `claude` lacked.
      const req = payload as unknown as SupportAnswerRequest;
      const supportConfig = readProfileConfig(ctx.profileDir);
      const supportCmd = supportConfig.aiCli || "claude";
      const supportAi = {
        cmd: supportCmd,
        profiles: resolveClaudeProfiles(supportConfig, getWorkingProfile(ctx.profileDir, supportCmd)),
        env: supportConfig.aiEnv,
      };
      // Echo the Q&A into the transcript like a normal AI dispatch (ADR-0057/0108) so the
      // operator at the support machine sees the question and the composed answer, not just
      // the "processing" spinner. Server-dispatched ⇒ source "server".
      ctx.bus.push({ source: "server", kind: "aireq", text: `${supportCmd} ‹ ${req.question}` });
      ctx.bus.startBusy("support-answer");
      void runSupportAnswer(req, supportAi, ctx.profileDir)
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
          // Surface the AI CLI's health to the admin pool (ADR-0223) — the support agent's most
          // common failure ("Not logged in") is exactly what an operator needs to see.
          reportToolResult(supportCmd, !reply.error, reply.error);
          ctx.send(WsChannels.SUPPORT_ANSWER, reply, message.id);
        })
        .finally(() => ctx.bus.endBusy("support-answer"));
      return true;
    }
    case WsChannels.KNOWLEDGE_COMPOSE: {
      // Request/reply (ADR-0190): AI-distil this project into a knowledge article, run in the
      // project's working dir so the model can read the code/docs. Same profile handling as the
      // normal AI dispatch (ADR-0057). No physic root (idle cli) ⇒ error ⇒ server templates it.
      const kreq = payload as unknown as KnowledgeComposeRequest;
      if (!ctx.physicRoot) {
        ctx.send(WsChannels.KNOWLEDGE_COMPOSE, { bodyMarkdown: "", error: "no project" }, message.id);
        return true;
      }
      const kcfg = readProfileConfig(ctx.profileDir);
      const kcmd = kcfg.aiCli || "claude";
      const kai = {
        cmd: kcmd,
        profiles: resolveClaudeProfiles(kcfg, getWorkingProfile(ctx.profileDir, kcmd)),
        env: kcfg.aiEnv,
      };
      ctx.bus.push({ source: "server", kind: "aireq", text: `${kcmd} ‹ distil knowledge` });
      ctx.bus.startBusy("knowledge-compose");
      void runKnowledgeCompose(kreq, kai, ctx.physicRoot)
        .then((reply) => {
          if (reply.error) {
            ctx.bus.push({ source: "server", kind: "log", text: `knowledge-compose failed: ${reply.error}`, level: "warn" });
          } else {
            ctx.bus.push({ source: "server", kind: "aires", text: `${kcmd} ›` });
          }
          ctx.send(WsChannels.KNOWLEDGE_COMPOSE, reply, message.id);
        })
        .finally(() => ctx.bus.endBusy("knowledge-compose"));
      return true;
    }
    default:
      return false;
  }
}
