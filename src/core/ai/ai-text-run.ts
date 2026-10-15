/**
 * The shared text runner of the restricted cli runners (support answer, checklist author, research, FAQ
 * compose, memory compaction): reads the worker config, applies the operator pin / working-first hint,
 * plans the prompt with the runner's policy (`planPolicyRun`), installs a missing AI CLI, leases each
 * attempt's AI account and runs the one failover loop (`runAiFailover`). Returns the text of the
 * successful attempt only, with its usage. Each runner keeps its own prompt, working dir, timeout,
 * policy and result handling.
 * @adr 0520 @adr 0518
 */
import { randomUUID } from "node:crypto";
import { logger } from "../../common/logger/logger";
import { readProfileConfig } from "../../config/profile";
import { agentEnv } from "../agent/agent-sandbox";
import type { EgressRunKind } from "../network/egress-state";
import type { AiRunSource } from "@4pm/ws";
import { ensureAiClisFor } from "../worker/toolchain";
import type { WsHandlerCtx } from "../ws-client/context";
import { isUnifiedConfig, planPolicyRun, type AiRunPolicy } from "../../utils/ai-cli";
import { createAccountLeaser } from "./ai-account-lease";
import { getPinnedCredential, getWorkingCredential, getWorkingProfile } from "./ai-profile-state";
import { runAiFailover, type AiRunHandlers } from "./ai-runner";
import type { AiUsage } from "./ai-stream";

/** How one restricted run is executed. */
export interface AiTextRunOptions {
  /** Short name for logs / the command id (e.g. "support-answer"). */
  label: string;
  /** What the run is, for the worker's live AI state. @adr 0522 */
  source: AiRunSource;
  /** The runner's provider args. */
  policy: AiRunPolicy;
  /** Working dir of the AI CLI. */
  cwd: string;
  /** Wall-clock cap per attempt (ms); 0 ⇒ none. */
  timeoutMs: number;
  /** Egress tag + allow-list of the run's base env. */
  envKind: EgressRunKind;
  /** Readable deltas as they stream (a failed attempt's deltas included). */
  onChunk?: (delta: string) => void;
  /** Re-run on the next account after a timeout (default false — a timeout is about the work's size). */
  failoverOnTimeout?: boolean;
  /** A clean exit with no text still succeeds (an edit-only agent whose work is in the files). */
  allowEmpty?: boolean;
  /** Keep the console transcript clean (a background housekeeping run) — failover lines go to the log only. */
  quiet?: boolean;
}

/** The outcome of a restricted run. */
export interface AiTextRunResult {
  /** Exit 0 with a non-empty answer (or any answer when `allowEmpty`). */
  ok: boolean;
  /** The successful attempt's text (trimmed); on failure, the last attempt's. */
  text: string;
  usage: AiUsage;
  /** Profile dir / provider that produced the answer, or null. */
  workedDir: string | null;
  workedCmd: string | null;
  /** Why it failed (exit code + the output head), when `ok` is false. */
  error?: string;
}

/** Runs one prompt through the shared AI path. */
export type AiTextRunner = (prompt: string, opts: AiTextRunOptions) => Promise<AiTextRunResult>;

/** Create the text runner bound to a cli session (config, transport, usage snapshot, transcript). */
export function createAiTextRunner(ctx: WsHandlerCtx): AiTextRunner {
  return async (prompt, opts) => {
    const config = readProfileConfig(ctx.profileDir);
    const unified = isUnifiedConfig(config);
    const pinned = unified ? getPinnedCredential(ctx.profileDir) : null;
    // Working-first, as for a dispatched run (ADR-0057/0182/0250): the pin, else the remembered credential.
    const hint = unified
      ? { credential: pinned ?? ((config.aiFailoverMode ?? "remember") === "remember" ? getWorkingCredential(ctx.profileDir) : null) }
      : { dir: getWorkingProfile(ctx.profileDir, config.aiCli || "claude") };
    const plan = planPolicyRun(prompt, config, hint, opts.policy);
    // On-use self-install (ADR-0396): a missing AI CLI is installed before the first attempt spawns.
    await ensureAiClisFor(ctx.profileDir, plan.attempts.map((a) => a.cmd), (line) =>
      opts.quiet ? logger.info("ai.text.install", { run: opts.label, line }) : ctx.bus.log(line),
    );
    let text = "";
    const handlers: AiRunHandlers = {
      onChunk: (chunk) => {
        text += chunk;
        opts.onChunk?.(chunk);
      },
      // A retry starts fresh — keep only the successful attempt's answer.
      onAttemptStart: (_label, index) => {
        if (index > 0) text = "";
      },
      onAttemptFail: (label, reason) => {
        const text = `${opts.label}: profile "${label}" failed (${reason}) — trying next`;
        if (opts.quiet) logger.warn("ai.text.attemptFailed", { run: opts.label, reason });
        else ctx.bus.push({ source: "system", kind: "log", text, level: "warn" });
      },
    };
    const result = await runAiFailover(plan, `${opts.label}-${randomUUID()}`, opts.cwd, handlers, {
      timeoutMs: opts.timeoutMs,
      failoverOnTimeout: opts.failoverOnTimeout ?? false,
      leaser: createAccountLeaser(ctx, { pinnedCredential: pinned, usage: () => ctx.usageSnapshot }),
      baseEnv: agentEnv(undefined, undefined, { kind: opts.envKind }),
      source: opts.source,
    });
    const trimmed = text.trim();
    const ok = result.exitCode === 0 && (trimmed.length > 0 || opts.allowEmpty === true);
    return {
      ok,
      text: trimmed,
      usage: result.usage,
      workedDir: result.workedDir,
      workedCmd: result.workedCmd,
      ...(ok ? {} : { error: `exited ${result.exitCode}: ${trimmed.slice(0, 500) || "no output"}` }),
    };
  };
}
