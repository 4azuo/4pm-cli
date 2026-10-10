/**
 * AI task runner — runs a cli-internal, one-shot AI generation (the scaffold's AI init) on the
 * **standard AI run path**: the `config.json` profile list with working-first order + any-error failover
 * (`planAiRun` → `runAiFailover`), usage reported to the server so quota meters it, and transcript entries
 * for the operator. It also exposes the org run slot so a caller holding several AI calls (AI init writes
 * README + the guide file) takes ONE slot for all of them.
 * @adr 0362
 */
import { randomUUID } from "node:crypto";
import { UsageMetric } from "@4pm/constants";
import type { UsageReportPayload } from "@4pm/ws";
import { runAiFailover, type AiRunHandlers } from "./ai-runner";
import { aiProviderOf } from "./ai-stream";
import { getPinnedCredential, getWorkingCredential, getWorkingProfile } from "./ai-profile-state";
import { isUnifiedConfig, planAiRun, profileDisplayLabel, resolveClaudeAuthMode } from "../../utils/ai-cli";
import { readProfileConfig } from "../../config/profile";
import { acquireRunSlot, type RunSlotOutcome, type RunSlotQueueInfo } from "../ws-client/run-slot";
import type { WsHandlerCtx } from "../ws-client/context";
import { ensureAiClisFor } from "../worker/toolchain";

/** What a cli-internal AI caller needs: the org run slot + one-shot generations on the standard path. */
export interface AiTaskRunner {
  /** Take one org run slot (FIFO queue over the plan limit); `onQueued` reports position changes. */
  acquireSlot(onQueued: (info: RunSlotQueueInfo) => void): Promise<RunSlotOutcome>;
  /** Run one one-shot generation in `cwd`; resolves the text, or null when every profile failed. */
  generate(prompt: string, cwd: string, label: string): Promise<string | null>;
}

/** Build the runner over a connected WS handler context. */
export function createAiTaskRunner(ctx: WsHandlerCtx): AiTaskRunner {
  return {
    acquireSlot: (onQueued) => acquireRunSlot(ctx, onQueued),
    generate: (prompt, cwd, label) => generate(ctx, prompt, cwd, label),
  };
}

/** One one-shot generation through `runAiFailover`, metered like a dispatched AI run. */
async function generate(ctx: WsHandlerCtx, prompt: string, cwd: string, label: string): Promise<string | null> {
  const config = readProfileConfig(ctx.profileDir);
  const cmd = config.aiCli || "claude";
  // Working-first hint, as for a dispatched run (ADR-0057/0182/0250): the operator's pin, else the
  // remembered working credential / profile dir.
  const unified = isUnifiedConfig(config);
  const hint = unified
    ? {
        credential:
          getPinnedCredential(ctx.profileDir) ??
          ((config.aiFailoverMode ?? "remember") === "remember" ? getWorkingCredential(ctx.profileDir) : null),
      }
    : { dir: getWorkingProfile(ctx.profileDir, cmd) };
  const plan = planAiRun(prompt, config, hint, new Map(), true);
  // On-use self-install (ADR-0396): a missing AI CLI is installed before the first attempt spawns.
  await ensureAiClisFor(ctx.profileDir, plan.attempts.map((a) => a.cmd), (line) => ctx.bus.log(line));
  const timeoutSec = config.projectAiRunTimeoutSec || config.aiRunTimeoutSec || 0;
  ctx.bus.push({ source: "system", kind: "aireq", text: `${plan.cmd} ‹ ${label}` });
  let text = "";
  const handlers: AiRunHandlers = {
    onChunk: (chunk) => {
      text += chunk;
    },
    onAttemptStart: (profile, index, total, attemptCmd) => {
      ctx.bus.push({ source: "system", kind: "log", text: `→ trying ${attemptCmd} profile "${profile}" (${index + 1}/${total})…` });
      if (index > 0) text = ""; // a retry starts fresh — keep only the successful attempt's answer
    },
    onAttemptFail: (profile) => {
      ctx.bus.push({ source: "system", kind: "log", text: `profile "${profile}" failed — trying next`, level: "warn" });
    },
  };
  ctx.bus.startBusy(plan.cmd);
  let result;
  try {
    result = await runAiFailover(plan, `ai-task-${randomUUID()}`, cwd, handlers, timeoutSec * 1000);
  } finally {
    ctx.bus.endBusy(plan.cmd);
  }
  // Meter it like any AI run (ADR-0020/0072/0340): one command + the real tokens on success.
  const occurredAt = new Date().toISOString();
  const events: UsageReportPayload["events"] = [{ metric: UsageMetric.COMMANDS, amount: 1, occurredAt }];
  if (result.exitCode === 0 && result.usage.tokens > 0) {
    events.push({
      metric: UsageMetric.AI_TOKENS,
      amount: result.usage.tokens,
      occurredAt,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheCreationTokens: result.usage.cacheCreation,
      provider: aiProviderOf(result.workedCmd ?? plan.cmd),
      authMode: resolveClaudeAuthMode(config),
    });
  }
  ctx.reportUsage(events, result.workedDir ? profileDisplayLabel(result.workedDir) : null);
  const ok = result.exitCode === 0 && text.trim().length > 0;
  ctx.bus.push({
    source: "system",
    kind: ok ? "aires" : "log",
    text: ok ? `${plan.cmd} › ${label} ✓` : `${label}: AI run failed (exit ${result.exitCode}) — using the fallback`,
    ...(ok ? {} : { level: "warn" as const }),
  });
  return ok ? text.trim() : null;
}
