/**
 * The AI / command dispatch path (ADR-0057), extracted from the WsClient as pure functions over a
 * `WsHandlerCtx`. Handles the COMMAND_DISPATCH channel (raw command, AI prompt, or web slash
 * command), runs an AI prompt through the profile-failover path (shared by locally-typed and
 * server-dispatched prompts), runs a web-dispatched 4pm-cli slash command, and maintains the shared
 * AI memory (ADR-0245). Kept together because these pieces call each other and share the memory /
 * session-pressure helpers below.
 */
import { basename } from "node:path";
import { randomUUID as randomCommandId } from "node:crypto";
import { looksLikeJsonOrCode } from "@4pm/utils";
import { UsageMetric } from "@4pm/constants";
import {
  WsChannels,
  type CommandAnnouncePayload,
  type CommandDispatchPayload,
  type CommandHistoryPayload,
  type CommandImageRef,
  type CommandOrigin,
  type MemoryUpdatePayload,
  type ReviewResultPayload,
  type UsageReportPayload,
  type WsEnvelope,
} from "@4pm/ws";
import { runCommand } from "../executor";
import { runAiFailover, type AiRunHandlers, type AiRunResult } from "../ai-runner";
import { estimateTokens } from "../ai-stream";
import {
  getPinnedCredential,
  getWorkingCredential,
  getWorkingProfile,
  setWorkingCredential,
  setWorkingProfile,
} from "../ai-profile-state";
import {
  claudeCredentialKeys,
  claudeHomeDirs,
  folderScopeGuard,
  isUnifiedConfig,
  labelFromCredentialKey,
  planAiRun,
  profileDisplayLabel,
  resolveClaudeAuthMode,
  resolveClaudeProfiles,
} from "../../utils/ai-cli";
import { formatTimestampInZone } from "../../utils/time";
import { finishCommand, recordCommand } from "../command-history";
import { materializeImages, rewriteImagePlaceholders, sweepOldAttachments } from "../command-images";
import { appendCommandOutput } from "../command-output-store";
import {
  readProfileConfig,
  resolveMemoryConfig,
  resolveWebBlockedCommands,
} from "../../config/profile";
import { runSlashCommand } from "../../ui/slash-commands";
import type { SessionInfo } from "../../ui/session-info";
import { runMemoryCompaction } from "../memory-compact";
import { setCommitAuthor } from "../git-commit-identity";
import { logger } from "../../common/logger/logger";
import { CLI_VERSION } from "../../version";
import type { WsHandlerCtx } from "./context";
import { t } from "../../i18n";

/** Preamble prepended before the shared AI memory when seeding a fresh native session (ADR-0245). */
const MEMORY_SEED_HEADER =
  "CONTEXT MEMORY from earlier in this conversation (may span prior sessions/accounts). Use it as " +
  "background; do not repeat it back unless relevant:";

/**
 * Route COMMAND_DISPATCH: record in the local history (per cli), stream output, mark finished.
 * Returns true when the message was handled.
 */
export function handleCommandChannels(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  payload: Record<string, unknown>,
): boolean {
  if (message.channel !== WsChannels.COMMAND_DISPATCH) return false;
  const dispatch = payload as unknown as CommandDispatchPayload;
  // Idempotency: WS delivery is at-least-once, so ignore a duplicate dispatch of a
  // commandId we already accepted (a redelivery must not re-run the command — #3).
  if (ctx.hasHandledCommand(dispatch.commandId)) {
    logger.info("command.dispatch.duplicate", { commandId: dispatch.commandId });
    return true;
  }
  ctx.markCommandHandled(dispatch.commandId);
  logger.info("command.dispatch", {
    commandId: dispatch.commandId,
    cmd: dispatch.cmd,
    ai: dispatch.ai ?? false,
  });
  // AI-prompt dispatch (web AI mode): `cmd` is the raw prompt — run it through the
  // same profile-failover path as a locally-typed prompt (not a raw spawn). `aiOneShot`
  // (ADR-0249) caps a text-only run (review/compose/suggest/generators) so it can't loop;
  // `aiReadOnly` (ADR-0265) runs a read-only agent that inspects the repo but can't write.
  if (dispatch.ai) {
    // A `/…` line is a 4pm-cli slash command, not an AI prompt (ADR-0249) — run it on the
    // worker (like the TUI) unless the operator blocked it via `webBlockedCommands`.
    if (dispatch.cmd.trimStart().startsWith("/")) {
      void runWebSlashCommand(ctx, dispatch.cmd, dispatch.commandId);
    } else {
      void runAiPrompt(
        ctx,
        dispatch.cmd,
        dispatch.commandId,
        "server",
        dispatch.aiOneShot ?? false,
        dispatch.images,
        dispatch.aiConfig,
        dispatch.aiReadOnly ?? false,
        dispatch.aiBypass ?? false,
      );
    }
    return true;
  }
  recordCommand({
    commandId: dispatch.commandId,
    projectId: dispatch.projectId,
    cmd: dispatch.cmd,
    args: dispatch.args,
  });
  ctx.bus.push({
    source: "server",
    kind: "cmd",
    text: `$ ${dispatch.cmd} ${dispatch.args.join(" ")}`.trimEnd(),
  });
  ctx.bus.startBusy(dispatch.cmd);
  // Wall-clock start for the processing-time badge on the `exit` entry (ADR-0249).
  const cmdStartMs = Date.now();
  void runCommand(dispatch, (out) => {
    if (out.chunk) {
      ctx.bus.push({ source: "server", kind: "out", text: out.chunk });
      appendCommandOutput(out.commandId, out.chunk);
    }
    ctx.send(WsChannels.COMMAND_OUTPUT, out);
    if (out.done) {
      ctx.bus.endBusy(dispatch.cmd);
      const code = out.exitCode ?? -1;
      finishCommand(out.commandId, code);
      ctx.bus.push({
        source: "server",
        kind: "exit",
        text: code === 0 ? t("run.done") : t("run.failed", { code }),
        level: code === 0 ? "info" : "error",
        durationMs: Date.now() - cmdStartMs,
      });
    }
  });
  return true;
}

/**
 * Run a prompt the operator typed in the TUI input box (ADR-0057). There is no
 * command whitelist: the prompt is handed to the configured AI CLI (default
 * `claude`) so the AI agent decides whether to call gh/glab/git/etc. The command is
 * announced to the server (tracking record + history) then spawned through the
 * shared executor — streaming output to BOTH the local transcript and the server
 * (origin = local).
 */
export async function runLocalCommand(ctx: WsHandlerCtx, input: string): Promise<void> {
  const prompt = input.trim();
  if (!prompt) return;
  if (ctx.isStopped) {
    ctx.bus.log(t("session.stoppedPrompts"), "warn");
    return;
  }
  // Correct order (ADR-0064): make the session + physic project ready BEFORE spawning
  // claude. Check status → reconnect + wait if the socket dropped → then run. While
  // connected, project changes already arrive live via PHYSIC_SYNC/PHYSIC_DELETE, so
  // `physicRoot` is current without a reconnect.
  if (!ctx.isReady) {
    ctx.bus.log(t("session.reconnectingPrompt"));
    ctx.reconnectNow();
    const ready = await ctx.awaitConnected(10_000);
    if (!ready) {
      ctx.bus.log(t("session.stillNotConnected"), "warn");
      return;
    }
  }
  const commandId = randomCommandId();
  await runAiPrompt(ctx, prompt, commandId, "local");
}

/**
 * Run an AI prompt through the AI-CLI **profile-failover** path (ADR-0057). Shared by a
 * locally-typed prompt (`origin: "local"`) and a server-dispatched AI prompt
 * (`origin: "server"` — command.dispatch with `ai:true`), so the web console behaves
 * exactly like typing the prompt in the cli (tries profiles, meters real tokens) instead
 * of spawning the text as a raw command. Streams output to the transcript AND the server.
 */
export async function runAiPrompt(
  ctx: WsHandlerCtx,
  prompt: string,
  commandId: string,
  origin: CommandOrigin,
  oneShot = false,
  images?: CommandImageRef[],
  // Per-run AI execution overrides (ADR-0261) — model/thinking/temperature from the web modal,
  // layered over the profile config by planAiRun/buildRunArgs. Absent for local TUI prompts.
  aiConfig?: CommandDispatchPayload["aiConfig"],
  // Read-only agent run (ADR-0265): keep the read/inspect tools but block writes + run under
  // `--permission-mode plan` (template "Analyze impact"). Mutually exclusive with `oneShot`.
  readOnly = false,
  // Write-capable agent run (ADR-0271): a full agent under `--permission-mode bypassPermissions`
  // (codex full-auto) so file + git/gh/glab writes run headless without an approval prompt
  // (template "Update" → branch + PR). Mutually exclusive with `oneShot`/`readOnly`.
  bypass = false,
): Promise<void> {
  const config = readProfileConfig(ctx.profileDir);
  // AI-run wall-clock ceiling (ADR-0243): the serving project's override wins over the
  // machine-user default; 0 ⇒ no limit. Enforced per attempt by the executor so a hung/looping
  // AI CLI (e.g. a heavy spec review/compose) can't leave the dispatch spinning forever.
  const projectTimeoutSec = config.projectAiRunTimeoutSec ?? 0;
  const machineTimeoutSec = config.aiRunTimeoutSec ?? 0;
  const timeoutSec = projectTimeoutSec > 0 ? projectTimeoutSec : machineTimeoutSec;
  const aiRunTimeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;
  // Per-prompt token cap (ADR-0081): reject before spawning when the prompt's estimated
  // tokens exceed the project limit. Cheaper than starting a run just to abort it.
  const perPromptLimit = config.perPromptTokenLimit ?? 0;
  if (perPromptLimit > 0) {
    const estimated = estimateTokens(prompt);
    if (estimated > perPromptLimit) {
      rejectPromptOverLimit(ctx, commandId, origin, prompt, estimated, perPromptLimit);
      return;
    }
  }
  // Outbound review (ADR-0082): when the project requires it, an outbound cli must approve
  // this input before we spawn. The verdict is server-authoritative; a failure to obtain
  // one (timeout/offline) blocks (fail closed) — the input never reaches the AI.
  if (ctx.outboundReviewEnabled) {
    let verdict: ReviewResultPayload;
    try {
      verdict = await ctx.request<ReviewResultPayload>(WsChannels.REVIEW_REQUEST, {
        commandId,
        prompt,
      });
    } catch {
      verdict = { commandId, ok: false, reasons: ["unavailable"] };
    }
    if (!verdict.ok) {
      rejectByReview(ctx, commandId, origin, prompt, verdict.reasons);
      return;
    }
  }
  // Run inside the live serving-project folder (kept current by the connect handler +
  // PHYSIC_SYNC/DELETE), not the stale manual `physicPath`. Idle cli ⇒ warn and fall
  // back to the launch dir so the operator knows no project is attached.
  const cwd = ctx.physicRoot ?? config.physicPath ?? process.cwd();
  if (ctx.physicRoot) {
    ctx.ensurePhysicFolderPath(ctx.physicRoot); // (re)create if a new/removed folder
    // Set the git commit author to the machine username before the AI (which may commit)
    // runs (ADR-0097); push uses the worker's logged-in gh/glab account. Best-effort.
    await setCommitAuthor(cwd, ctx.machineUsername);
  } else {
    ctx.bus.log(t("session.noProjectDir"), "warn");
  }
  // `||` (not `??`): a blank aiCli ("mixed"/none — ADR-0182) falls back to claude. In unified
  // mode `cmd` is only used by the legacy-only branches below, so this is just a safe default.
  const cmd = config.aiCli || "claude";
  // Working-first memory (ADR-0057): the unified mixed list (ADR-0182) remembers one
  // cross-provider credential key; the legacy plan remembers the per-cmd profile dir. In
  // "priority" mode (ADR-0182) the memory is ignored so every prompt starts at the list top.
  const unified = isUnifiedConfig(config);
  const mode = config.aiFailoverMode ?? "remember";
  const workingDir = unified ? null : getWorkingProfile(ctx.profileDir, cmd);
  // Operator manual pin (ADR-0250): when set it is the working-first hint on EVERY prompt,
  // overriding aiFailoverMode (remember/priority). Absent ⇒ the mode's own behaviour: "remember"
  // starts from the auto-remembered working credential, "priority" always from the list top.
  const pinnedCred = unified ? getPinnedCredential(ctx.profileDir) : null;
  const workingCred = unified
    ? (pinnedCred ?? (mode === "remember" ? getWorkingCredential(ctx.profileDir) : null))
    : null;
  // Rotate the Claude profile under session pressure (ADR-0081): when the project set
  // sessionSwitchPct and the current 5h session utilization is at/over it, prefer the
  // NEXT candidate profile for this run instead of the near-exhausted working one. Claude-only.
  // A manual pin (ADR-0250) is the operator's explicit choice, so it bypasses this pre-rotation —
  // a real auth/limit failure still falls through to the failover backups.
  const startDir = unified ? null : profileUnderSessionPressure(ctx, config, cmd, workingDir);
  const startCred =
    unified && !pinnedCred ? credentialUnderSessionPressure(ctx, config, workingCred) : null;
  if (startDir && startDir !== workingDir) {
    ctx.bus.push({
      source: origin,
      kind: "log",
      text: `session ${ctx.usageSnapshot?.session.utilizationPct ?? 0}% ≥ ${config.sessionSwitchPct}% — switching to Claude profile "${profileDisplayLabel(startDir)}"`,
    });
  }
  if (startCred && startCred !== workingCred) {
    ctx.bus.push({
      source: origin,
      kind: "log",
      text: `session ${ctx.usageSnapshot?.session.utilizationPct ?? 0}% ≥ ${config.sessionSwitchPct}% — switching to Claude profile "${labelFromCredentialKey(startCred)}"`,
    });
  }
  // Console image attachments (ADR-0257): on a full agent run, materialize each pasted image
  // inside the served folder (so the folder-scope guard lets the agent read it) and rewrite its
  // `[Image#N]` placeholder to the on-disk path. Only the AI sees the rewrite — the transcript
  // echoes the raw prompt below. Skipped for a one-shot run (it disallows `Read`) or an idle cli.
  // Sweep stale image attachments (>24h) on each run too (ADR-0257) — cheap, best-effort.
  if (ctx.physicRoot) sweepOldAttachments(ctx.physicRoot);
  let aiBodyPrompt = prompt;
  if (images?.length && ctx.physicRoot && !oneShot) {
    const paths = await materializeImages(ctx.physicRoot, commandId, images, (imageId) =>
      ctx.imageFetch(commandId, imageId),
    );
    if (paths.size) aiBodyPrompt = rewriteImagePlaceholders(prompt, paths);
  }
  // Folder-scope hardening (project aiScope): when the project restricts the AI to its
  // folder, prepend a guard so the agent only uses content inside the served worker
  // folder. Only the AI actually sees this — the markers/announce/history below keep
  // echoing the raw operator prompt so the console shows exactly what was typed.
  const guardedPrompt =
    ctx.restrictToFolder && ctx.physicRoot
      ? folderScopeGuard(ctx.physicRoot, aiBodyPrompt)
      : aiBodyPrompt;
  const hint = unified
    ? { credential: startCred ?? workingCred }
    : { dir: startDir ?? workingDir };
  // Shared AI memory (ADR-0245): resume the native session on the SAME profile when we have one
  // (it already carries the context — no re-inject), else seed a fresh session with the compacted
  // memory. Probe the plan once to learn the first attempt's credential/provider, then decide.
  const memCfg = resolveMemoryConfig(config);
  const firstAttempt = planAiRun(guardedPrompt, config, hint, new Map(), oneShot, aiConfig, readOnly, bypass).attempts[0];
  const resumeId =
    memCfg.enabled && firstAttempt?.key && firstAttempt.cmd === "claude"
      ? ctx.sessionIdByKey.get(firstAttempt.key)
      : undefined;
  let effectivePrompt = guardedPrompt;
  let resume = new Map<string, string>();
  if (resumeId) {
    // Native session alive → resume each profile's own session; do NOT re-inject the memory.
    resume = ctx.sessionIdByKey;
  } else if (memCfg.enabled && ctx.aiMemory) {
    // Native session reset (new/failed-over profile, or memory cleared) → seed with the memory.
    effectivePrompt = `${MEMORY_SEED_HEADER}\n${ctx.aiMemory}\n\n${guardedPrompt}`;
  }
  const plan = planAiRun(effectivePrompt, config, hint, resume, oneShot, aiConfig, readOnly, bypass);
  // Representative argv for the announce/history markers (args are now per-profile —
  // the first attempt's are used; failover may run a different profile's args).
  const markerArgs = plan.attempts[0]?.args ?? [];
  // Request marker: "<yyyy/MM/dd HH:mm:ss> <cmd> ‹ <prompt>" (ADR-0249) — the leading start-time
  // stamp (org timezone; rented workers use the renter's — ADR-0132) marks when the AI began
  // processing the prompt. The TUI + web dim the stamp and color the CLI name (see AiMarkerLine /
  // colorAiLine). This is the same instant `aiStartedMs` measures the run duration from.
  const startStamp = formatTimestampInZone(new Date(), ctx.orgTimezone);
  ctx.bus.push({
    source: origin,
    kind: "aireq",
    text: `${startStamp} ${plan.cmd} ‹ ${prompt}`,
    // Carry the run's prompt + resolved flags so the web Console's clickable CLI name can open a
    // details modal (the representative first-attempt argv; failover may run a different profile's).
    aiMeta: { cmd: plan.cmd, args: markerArgs, prompt },
  });
  logger.info("command.ai", { commandId, origin, cmd: plan.cmd, profiles: plan.attempts.length });
  // A local prompt has no server record yet ⇒ announce it (ADR-0057); a server-dispatched
  // AI prompt already has a tracking record from command-0001.
  if (origin === "local") {
    ctx.send(WsChannels.COMMAND_ANNOUNCE, {
      commandId,
      cmd: plan.cmd,
      args: markerArgs,
      // The raw prompt so the web console echoes it like this TUI (ADR-0108), not "claude".
      prompt,
      origin: "local",
    } satisfies CommandAnnouncePayload);
  }
  recordCommand({ commandId, cmd: plan.cmd, args: markerArgs });
  const startedAt = new Date().toISOString();
  // Wall-clock start for the processing-time badge on the run's `exit` entry (ADR-0249).
  const aiStartedMs = Date.now();
  ctx.bus.startBusy(plan.cmd);

  // Try the profile candidates until one authenticates; stream verbatim to the
  // transcript AND the server (one commandId, a single final "done").
  let seq = 0;
  // Response marker: emitted once, right before the first output chunk, as "<cmd> ›".
  let responseHeaderShown = false;
  // Result auto-collapse (ADR-0108): decide once from the leading output whether the whole
  // response is json/code (collapse into one growing `result` block) or prose (stream as
  // `out` lines). `resultId` is the growing block's entry id while in "result" mode.
  let displayMode: "pending" | "prose" | "result" = "pending";
  let resultId: string | null = null;
  let resultBuf = "";
  // The full assistant answer text (verbatim), captured for the shared-memory compaction (ADR-0245).
  let answerText = "";
  const handlers: AiRunHandlers = {
    onChunk: (text) => {
      if (!responseHeaderShown) {
        ctx.bus.push({ source: origin, kind: "aires", text: `${plan.cmd} ›` });
        responseHeaderShown = true;
      }
      answerText += text;
      // Server stream + local history are always verbatim (display collapse is render-only).
      appendCommandOutput(commandId, text);
      ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: seq++, chunk: text });
      if (displayMode === "result") {
        resultBuf += text;
        if (resultId) ctx.bus.updateEntry(resultId, resultBuf);
        return;
      }
      if (displayMode === "prose") {
        ctx.bus.push({ source: origin, kind: "out", text });
        return;
      }
      // Pending: buffer until the first non-whitespace char, then commit to a mode.
      resultBuf += text;
      if (resultBuf.replace(/^\s+/, "").length === 0) return;
      const kind = looksLikeJsonOrCode(resultBuf);
      if (kind) {
        displayMode = "result";
        resultId = ctx.bus.push({ source: origin, kind: "result", text: resultBuf, resultKind: kind });
      } else {
        displayMode = "prose";
        ctx.bus.push({ source: origin, kind: "out", text: resultBuf });
      }
    },
    onAttemptStart: (label, index, total, cmd) => {
      // Use the attempt's OWN provider command (ADR-0197): a mixed plan must not label a codex
      // attempt as "claude". `plan.cmd` is only the first attempt's representative command.
      const text = `→ trying ${cmd} profile "${label}" (${index + 1}/${total})…`;
      ctx.bus.push({ source: origin, kind: "log", text });
      // Mirror the status line to the web console (memo #5) as a `log` frame so it shows
      // there too, without polluting the persisted transcript or the result-collapse detector.
      ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: seq++, chunk: `${text}\n`, log: true });
    },
    onAttemptFail: (label, reason) => {
      // Distinct reason per branch (ADR-0240): only a genuine `auth` classification says "failed to
      // authenticate" — a catch-all `other` (non-zero exit, hit turn cap, crash, unrecognized error)
      // must NOT be mislabeled as an auth problem, or a working credential looks broken.
      const text =
        reason === "limit"
          ? `profile "${label}" hit its session limit — trying next`
          : reason === "credits"
            ? `profile "${label}" is out of usage credits — trying next`
            : reason === "auth"
              ? `profile "${label}" failed to authenticate — trying next`
              : `profile "${label}" run failed — trying next`;
      ctx.bus.push({ source: origin, kind: "log", text, level: "warn" });
      ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: seq++, chunk: `${text}\n`, log: true });
    },
  };
  // endBusy in a `finally` so a thrown/rejected run still releases the busy state — otherwise a
  // stuck `busy` blocks the idle auto-clear indefinitely (it never clears mid-response — ADR-0244).
  let result: AiRunResult;
  try {
    result = await runAiFailover(plan, commandId, cwd, handlers, aiRunTimeoutMs);
  } finally {
    ctx.bus.endBusy(plan.cmd);
  }
  // Remember the working profile so the next prompt tries it first (ADR-0057) + show it in the
  // header. Unified plans remember one cross-provider credential key (ADR-0182); the legacy plan
  // remembers the per-cmd dir. (In "priority" mode the memory is written but ignored on read.)
  const profileLabel = result.workedDir ? profileDisplayLabel(result.workedDir) : null;
  if (result.workedDir) {
    if (unified && result.workedKey) {
      setWorkingCredential(ctx.profileDir, result.workedKey);
    } else {
      setWorkingProfile(ctx.profileDir, result.workedCmd ?? plan.cmd, result.workedDir);
    }
    ctx.bus.setActiveProfile(profileLabel ?? plan.cmd);
  }
  ctx.send(WsChannels.COMMAND_OUTPUT, {
    commandId,
    seq: seq++,
    chunk: "",
    done: true,
    exitCode: result.exitCode,
  });
  finishCommand(commandId, result.exitCode, result.usage);
  // Push a durable command-history record (rich: cmd + real tokens + exit — ADR-0072).
  ctx.send(WsChannels.COMMAND_HISTORY, {
    commandId,
    cmd: plan.cmd,
    args: markerArgs,
    status: result.exitCode === 0 ? "done" : "failed",
    exitCode: result.exitCode,
    tokens: result.usage.tokens,
    // The ai_tokens split for this run (ADR-0145); attached only when we metered real tokens.
    ...(result.usage.tokens > 0 && {
      tokensBreakdown: {
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheCreation: result.usage.cacheCreation,
      },
    }),
    startedAt,
    finishedAt: new Date().toISOString(),
  } satisfies CommandHistoryPayload);
  // Report usage so the server can meter quota + build the per-profile breakdown
  // (ADR-0020/0072); `profile` = the account/dir that worked. One AI run = 1 command;
  // ai_tokens = the run's real tokens (when known).
  const occurredAt = new Date().toISOString();
  const events: UsageReportPayload["events"] = [
    { metric: UsageMetric.COMMANDS, amount: 1, occurredAt },
  ];
  if (result.exitCode === 0 && result.usage.tokens > 0) {
    events.push({
      metric: UsageMetric.AI_TOKENS,
      amount: result.usage.tokens,
      occurredAt,
      // The ai_tokens split so the server can persist + display it (ADR-0145).
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheCreationTokens: result.usage.cacheCreation,
      // Auth mode for billing split (ADR-0192 §5): subscription (OAuth) vs api-key (API-billed).
      authMode: resolveClaudeAuthMode(config),
    });
    ctx.bus.addTokens?.(result.usage.tokens); // session token counter for the header
  }
  ctx.reportUsage(events, profileLabel);
  // Refresh the usage snapshot after any run (e.g. `/usage` rotates the token — ADR-0072).
  void ctx.pollUsage();
  // Report a friendly completion line instead of a raw exit code: on success prompt
  // for the next message; on failure surface an error (details are streamed above).
  ctx.bus.push({
    source: origin,
    kind: "exit",
    text:
      result.exitCode === 0
        ? "✓ ready — enter your next prompt"
        : `✗ ${plan.cmd} failed (exit ${result.exitCode}) — see the error above`,
    level: result.exitCode === 0 ? "info" : "error",
    durationMs: Date.now() - aiStartedMs,
  });
  // Shared AI memory (ADR-0245): remember the native session id for a same-profile `--resume`, then
  // fold the exchange into the rolling memory (a background compaction) so the next reset re-grounds
  // the AI. The reply is already shown + busy is off, so this never blocks the console.
  if (memCfg.enabled && result.exitCode === 0) {
    if (result.workedKey && result.sessionId) {
      ctx.sessionIdByKey.set(result.workedKey, result.sessionId);
    }
    void updateSharedMemory(ctx, config, prompt, answerText, memCfg.budgetChars).catch(() => {});
  }
}

/**
 * Run a `/…` 4pm-cli slash command dispatched from the web Console (ADR-0249). Mirrors the TUI's
 * `runSlashCommand` with a **server-origin** context that streams `print` output back over
 * command.output + console.sync, so a web user gets the same commands as an operator at the
 * machine — EXCEPT any the operator disabled via `webBlockedCommands`. `/claude-cmd <x>` forwards
 * `x` to the AI CLI (a real AI run). Fold ops (`/expand`/`/collapse`) are TUI-only — the web has
 * its own fold viewer — so they just print a hint. Interactive `confirm` (e.g. `/config init`) is
 * not supported from the web.
 */
export async function runWebSlashCommand(ctx: WsHandlerCtx, line: string, commandId: string): Promise<void> {
  const origin: CommandOrigin = "server";
  const config = readProfileConfig(ctx.profileDir);
  const trimmed = line.trim();
  const startedMs = Date.now();
  // Echo the command like the TUI so the web transcript shows what ran.
  ctx.bus.push({ source: origin, kind: "cmd", text: trimmed });
  recordCommand({ commandId, cmd: trimmed, args: [] });
  let seq = 0;
  // Stream one text line back to the web (command.output) + persist it for the history blob.
  const emit = (text: string): void => {
    appendCommandOutput(commandId, `${text}\n`);
    ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: seq++, chunk: `${text}\n` });
  };
  /**
   * Settle the command: send the terminal `done` (web stream resolves), record history, and push
   * an `exit` transcript entry so the Console (which renders console.sync, not command.output)
   * frees its input + shows the processing time (ADR-0246/0249).
   */
  const settle = (exitCode: number): void => {
    ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: seq++, chunk: "", done: true, exitCode });
    finishCommand(commandId, exitCode);
    ctx.send(WsChannels.COMMAND_HISTORY, {
      commandId,
      cmd: trimmed,
      args: [],
      status: exitCode === 0 ? "done" : "failed",
      exitCode,
    });
    ctx.bus.push({
      source: origin,
      kind: "exit",
      text: exitCode === 0 ? "✓ done" : `✗ failed (exit ${exitCode})`,
      level: exitCode === 0 ? "info" : "error",
      durationMs: Date.now() - startedMs,
    });
  };
  // Resolve the command name (strip `/`, first token, map the /exit alias) for the block check.
  const rawName = trimmed.replace(/^\//, "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const name = rawName === "exit" ? "quit" : rawName;
  const blocked = resolveWebBlockedCommands(config);
  if (blocked.has(name) || blocked.has(rawName)) {
    const msg = `Command /${rawName} is disabled on this worker (blocked by the machine config).`;
    ctx.bus.push({ source: origin, kind: "log", text: msg, level: "error" });
    emit(msg);
    settle(1);
    return;
  }
  // `/claude-cmd <x>` is a real AI run — forward `x` to the AI CLI on the same command id.
  if (name === "claude-cmd") {
    const rest = trimmed.replace(/^\/claude-cmd\s*/i, "").trim();
    if (!rest) {
      emit("usage: /claude-cmd /context  (forwards to the AI CLI)");
      settle(1);
      return;
    }
    await runAiPrompt(ctx, rest, commandId, origin, false);
    return; // runAiPrompt settles the command itself
  }
  // Static session info for /status·/version·/whoami (whoami over the wire isn't wired here ⇒ null).
  const info: SessionInfo = {
    version: CLI_VERSION,
    scope: ctx.bus.scope ?? "project",
    profile: basename(ctx.profileDir),
    profileDir: ctx.profileDir,
    serverUrl: ctx.serverUrl,
    physicPath: ctx.physicRoot ?? config.physicPath ?? null,
    aiCli: config.aiCli || "claude",
    whoami: async () => null,
  };
  runSlashCommand(trimmed, {
    info,
    print: (text, level) => {
      ctx.bus.push({ source: origin, kind: "log", text, level });
      emit(text);
    },
    clear: () => {
      ctx.bus.clear();
      ctx.bus.clearSession();
    },
    quit: () => {
      emit("Quit requested from the web console — the worker cli is shutting down.");
      setTimeout(() => process.exit(0), 200);
    },
    confirm: (prompt) => {
      const note = `${prompt} — interactive prompts aren't supported from the web console; run it on the machine.`;
      ctx.bus.push({ source: origin, kind: "log", text: note, level: "warn" });
      emit(note);
    },
    submitAi: () => {}, // only /claude-cmd uses this, and it is special-cased above
    // /ai-profile use/reset from the web Console updates the shared header too (ADR-0250).
    setActiveProfile: (label) => ctx.bus.setActiveProfile(label),
    reconnect: () => ctx.reconnectNow(),
    expand: () => emit("Use the web console's fold viewer to expand blocks."),
    collapse: () => emit("Use the web console's fold viewer to collapse blocks."),
    maxBlock: 0,
    live: {
      status: ctx.bus.status,
      scope: ctx.bus.scope ?? "",
      worker: ctx.bus.worker,
      project: ctx.bus.project,
      activeProfile: ctx.bus.activeProfile,
      startedAt: ctx.startedAtMs,
    },
  });
  settle(0);
}

/**
 * Fold the latest exchange into the shared AI memory (ADR-0245): a background claude compaction to a
 * budget-bounded summary, cached locally + written back to the server (`memory.update`). Best-effort —
 * a failed/empty compaction keeps the previous memory (no write). Claude-only (mirrors the design's
 * native-session focus); a non-claude worker simply never compacts.
 */
async function updateSharedMemory(
  ctx: WsHandlerCtx,
  config: ReturnType<typeof readProfileConfig>,
  userPrompt: string,
  answer: string,
  budgetChars: number,
): Promise<void> {
  if (!answer.trim()) return;
  const profiles = resolveClaudeProfiles(config, ctx.physicRoot);
  const cwd = ctx.physicRoot ?? process.cwd();
  const newMemory = await runMemoryCompaction(
    { cmd: "claude", profiles, env: config.aiEnv },
    cwd,
    { oldMemory: ctx.aiMemory, prompt: userPrompt, answer, budgetChars },
  );
  if (!newMemory) return; // compaction failed ⇒ keep the previous memory
  ctx.aiMemory = newMemory;
  ctx.send(WsChannels.MEMORY_UPDATE, { text: newMemory } satisfies MemoryUpdatePayload);
}

/**
 * Reset the shared AI memory + native sessions for a "new conversation" (ADR-0245) — a manual
 * `/clear`. Drops the cached memory + every remembered `session_id` (so the next run starts a fresh
 * native session) and clears the server-stored memory. Idle auto-clear does NOT call this
 * (display-only — ADR-0244).
 */
export function resetMemorySession(ctx: WsHandlerCtx): void {
  ctx.aiMemory = "";
  ctx.sessionIdByKey.clear();
  ctx.send(WsChannels.MEMORY_UPDATE, { text: "" } satisfies MemoryUpdatePayload);
}

/**
 * Pick the Claude profile to try first when under session pressure (ADR-0081). Returns
 * the next candidate dir (cyclically after the current working one) when the knob is set
 * and the live session utilization is at/over it AND there is more than one candidate;
 * otherwise null (keep the normal working-first ordering). Claude-only (session % is a
 * Claude subscription metric).
 */
function profileUnderSessionPressure(
  ctx: WsHandlerCtx,
  config: ReturnType<typeof readProfileConfig>,
  cmd: string,
  workingDir: string | null,
): string | null {
  const threshold = config.sessionSwitchPct ?? 0;
  if (threshold <= 0 || cmd !== "claude") return null;
  const util = ctx.usageSnapshot?.session.utilizationPct ?? 0;
  if (util < threshold) return null;
  const dirs = claudeHomeDirs(config);
  if (dirs.length < 2) return null;
  const currentIndex = workingDir ? dirs.indexOf(workingDir) : -1;
  const next = dirs[(currentIndex + 1) % dirs.length];
  return next ?? null;
}

/**
 * Unified-list equivalent of {@link profileUnderSessionPressure} (ADR-0182): under session
 * pressure, return the next **claude** credential key (cyclically after the working one) so the
 * failover starts on a fresher Claude account. Claude-only — %session is a Claude subscription
 * metric; codex/antigravity entries are unaffected. Null ⇒ keep the working-first order.
 */
function credentialUnderSessionPressure(
  ctx: WsHandlerCtx,
  config: ReturnType<typeof readProfileConfig>,
  workingCred: string | null,
): string | null {
  const threshold = config.sessionSwitchPct ?? 0;
  if (threshold <= 0) return null;
  const util = ctx.usageSnapshot?.session.utilizationPct ?? 0;
  if (util < threshold) return null;
  const keys = claudeCredentialKeys(config);
  if (keys.length < 2) return null;
  const currentIndex = workingCred ? keys.indexOf(workingCred) : -1;
  return keys[(currentIndex + 1) % keys.length] ?? null;
}

/**
 * Reject a prompt whose estimated tokens exceed the project's per-prompt limit (ADR-0081)
 * without spawning: surface it in the transcript + close the command on the server with a
 * PROMPT_TOKEN_LIMIT_EXCEEDED note (exit 1). No usage is metered (nothing ran).
 */
function rejectPromptOverLimit(
  ctx: WsHandlerCtx,
  commandId: string,
  origin: CommandOrigin,
  prompt: string,
  estimated: number,
  limit: number,
): void {
  const message = `[PROMPT_TOKEN_LIMIT_EXCEEDED] Prompt (~${estimated} tokens) exceeds the project per-prompt limit of ${limit} tokens.`;
  logger.warn("command.ai.prompt-limit", { commandId, origin, estimated, limit });
  ctx.bus.push({ source: origin, kind: "log", text: message, level: "error" });
  // A local prompt has no server record yet ⇒ announce it so the failure is trackable.
  if (origin === "local") {
    ctx.send(WsChannels.COMMAND_ANNOUNCE, {
      commandId,
      cmd: "claude",
      args: [],
      prompt,
      origin: "local",
    } satisfies CommandAnnouncePayload);
  }
  ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: 0, chunk: message });
  ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: 1, chunk: "", done: true, exitCode: 1 });
  ctx.bus.push({
    source: origin,
    kind: "exit",
    text: "✗ prompt rejected — over the project per-prompt token limit",
    level: "error",
  });
}

/**
 * Reject a prompt an outbound reviewer blocked (ADR-0082) without spawning: surface the
 * verdict + close the command on the server. `reasons` contains only violation categories
 * (never secret values); a "unavailable" reason maps to no-outbound-available.
 */
function rejectByReview(
  ctx: WsHandlerCtx,
  commandId: string,
  origin: CommandOrigin,
  prompt: string,
  reasons: string[],
): void {
  const unavailable = reasons.includes("unavailable");
  const code = unavailable ? "OUTBOUND_REVIEW_UNAVAILABLE" : "OUTBOUND_REVIEW_REJECTED";
  const detail = reasons.filter((r) => r !== "unavailable").join(", ");
  const message = unavailable
    ? `[${code}] No outbound reviewer is available — input blocked.`
    : `[${code}] Outbound review rejected the input${detail ? ` (${detail})` : ""}.`;
  logger.warn("command.ai.outbound-review", { commandId, origin, reasons });
  ctx.bus.push({ source: origin, kind: "log", text: message, level: "error" });
  if (origin === "local") {
    ctx.send(WsChannels.COMMAND_ANNOUNCE, {
      commandId,
      cmd: "claude",
      args: [],
      prompt,
      origin: "local",
    } satisfies CommandAnnouncePayload);
  }
  ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: 0, chunk: message });
  ctx.send(WsChannels.COMMAND_OUTPUT, { commandId, seq: 1, chunk: "", done: true, exitCode: 1 });
  ctx.bus.push({
    source: origin,
    kind: "exit",
    text: "✗ input blocked by outbound review",
    level: "error",
  });
}
