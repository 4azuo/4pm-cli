/**
 * Research channel handler (ADR-0380) — the org AI Research run. On a `research.ask` request the cli
 * takes an org run slot (ADR-0359/0362), screens the question against the content policy (research-guard
 * backstop), runs `claude` with read-only web tools streaming the answer back over `research.progress`
 * for the live SSE, screens the answer, meters the run to the org (COMMANDS + AI_TOKENS — projectId=null
 * on an org-AI-pool cli), and replies with the markdown answer or a structured refusal.
 */
import {
  WsChannels,
  type ResearchAskReply,
  type ResearchAskRequest,
  type ResearchProgressPayload,
  type UsageReportPayload,
  type WsEnvelope,
} from "@4pm/ws";
import { UsageMetric } from "@4pm/constants";
import { readProfileConfig } from "../../../config/profile";
import { getWorkingProfile } from "../../ai-profile-state";
import { aiProviderOf } from "../../ai-stream";
import { resolveClaudeAuthMode, resolveClaudeProfiles } from "../../../utils/ai-cli";
import { acquireRunSlot } from "../run-slot";
import { runResearch } from "../../research-run";
import { screenAnswer, screenQuestion } from "../../research-guard";
import type { WsHandlerCtx } from "../context";

/** Route the research channel; returns true when the message was handled. */
export function handleResearchChannels(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  payload: Record<string, unknown>,
): boolean {
  if (message.channel !== WsChannels.RESEARCH_ASK) return false;
  const req = payload as unknown as ResearchAskRequest;
  const config = readProfileConfig(ctx.profileDir);
  const cmd = config.aiCli || "claude";
  ctx.bus.push({ source: "server", kind: "aireq", text: `${cmd} ‹ research` });
  ctx.bus.startBusy("research");
  void run(ctx, message, req, config, cmd).finally(() => ctx.bus.endBusy("research"));
  return true;
}

/** Run the research, stream progress, meter it, and reply. */
async function run(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  req: ResearchAskRequest,
  config: ReturnType<typeof readProfileConfig>,
  cmd: string,
): Promise<void> {
  const emit = (p: Omit<ResearchProgressPayload, "queryId">): void =>
    ctx.send(WsChannels.RESEARCH_PROGRESS, { queryId: req.queryId, ...p });
  const reply = (r: ResearchAskReply): void => ctx.send(WsChannels.RESEARCH_ASK, r, message.id);

  // Pre-screen the question (attack-intent backstop) — refuse before spending a slot / tokens.
  const pre = screenQuestion(req.question);
  if (pre.blocked) {
    reply({ refused: true, refusalReason: pre.reason });
    return;
  }

  // Take one org run slot (ADR-0359) — research competes with every other AI run.
  const slot = await acquireRunSlot(ctx, (info) => emit({ message: `queued #${info.position}` }));
  if (slot.kind !== "granted") {
    reply({ error: slot.kind === "denied" ? "storage full" : "no idle run slot" });
    return;
  }

  try {
    const ai = {
      cmd,
      profiles: resolveClaudeProfiles(config, getWorkingProfile(ctx.profileDir, cmd)),
      env: config.aiEnv,
    };
    const result = await runResearch(req.question, ai, (delta) => emit({ chunk: delta }));

    // Meter the run (ADR-0020/0380): one command + the real tokens; reported with projectId=null (the
    // org-AI-pool cli serves no project), so it counts against the org's AI usage/quota.
    const occurredAt = new Date().toISOString();
    const events: UsageReportPayload["events"] = [{ metric: UsageMetric.COMMANDS, amount: 1, occurredAt }];
    if (result.usage.tokens > 0) {
      events.push({
        metric: UsageMetric.AI_TOKENS,
        amount: result.usage.tokens,
        occurredAt,
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        cacheReadTokens: result.usage.cacheRead,
        cacheCreationTokens: result.usage.cacheCreation,
        provider: aiProviderOf(cmd),
        authMode: resolveClaudeAuthMode(config),
      });
    }
    ctx.reportUsage(events, null);

    if (result.error || !result.text) {
      ctx.bus.push({ source: "server", kind: "log", text: `research failed: ${result.error ?? "empty"}`, level: "warn" });
      reply({ error: result.error || "empty answer", tokens: result.usage.tokens });
      return;
    }
    // Post-screen the answer — a structured `REFUSED:` or an attack-intent slip becomes a refusal.
    const post = screenAnswer(result.text);
    if (post.blocked) {
      reply({ refused: true, refusalReason: post.reason, tokens: result.usage.tokens });
      return;
    }
    ctx.bus.push({ source: "server", kind: "aires", text: `${cmd} ›` });
    reply({ answer: result.text, tokens: result.usage.tokens });
  } catch (err) {
    reply({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    slot.handle.release();
  }
}
