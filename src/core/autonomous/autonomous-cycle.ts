/**
 * Autonomous cycle runner (ADR-0319 → reworked by ADR-0371). Runs ONE unattended cycle through the
 * daemon's live WS session (profile/quota failover, metering, folder scope, run timeout). Every git step
 * runs here in code — resolve each repo's `<base>`, protection guard, sync, the books as an optimistic
 * lock on `<base>` (claim / finish / release / question / split), the task branch
 * `dev/<base>/<GROUP>/<TSK>` in the root + each submodule, WIP saves, delivery (push + PRs into each
 * base). The agent only does the intake analysis, the implementation and the split analysis. A held
 * claim is re-verified during the run and on reconnect; a lost claim stops the run without pushing.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WsHandlerCtx } from "../ws-client/context";
import { cancelActiveRun, runAiPrompt, type AiPromptOutcome } from "../ws-client/command-dispatch";
import { resolveCliPrompt } from "../ai/prompt-overrides";
import { WsChannels, type AutonomousAlertPayload, type AutonomousBookUsageReply } from "@4pm/ws";
import { cappedBookIds } from "./autonomous";
import {
  isInQuietHours,
  readAutonomousConfig,
  repoDirsOf,
  writeAutonomousConfig,
  type AutonomousConfig,
} from "./autonomous-config";
import { pushRecord, readHistories, todayTickCount, writeHistories, type Histories } from "./autonomous-history";
import * as B from "./autonomous-books";
import {
  aheadOf,
  checkoutTaskBranch,
  currentBranch,
  deliverPr,
  gitQuiet,
  publishBooks,
  publishIntake,
  pushBranch,
  remoteBook,
  resolveBases,
  stripSidecarsFromBranch,
  syncBase,
  wipCommit,
  type RepoBase,
} from "./autonomous-git";
import { agentEvidence, listMockups } from "./autonomous-evidence";
import {
  applyClaim,
  applyFinish,
  applyQuestion,
  applyRelease,
  applySplit,
  approvedIds,
  claimState,
  foldTaskAnswers,
  hasIntakeWork,
  isSplitChild,
  pickTask,
  readLocalClaim,
  taskBranch,
  writeLocalClaim,
  type Candidate,
  type LocalClaim,
} from "./autonomous-tasks";
import { branchProtection } from "../git/git-host";
import { readProfileConfig } from "../../config/profile";
import { activeProvider, claudeHomeDirs } from "../../utils/ai-cli";
import { checkClaudeUsage } from "../ai/claude-usage";
import { readFileInRoot } from "../../utils/safe-path";

// ── Prompts (the agent's parts only) ──────────────────────────────────────────────────────────────

/**
 * Shared books preamble for the intake agent. The approved ids come from the cli's own verification
 * (signed + unchanged rows), never from the agent reading the approvals file; the sidecars are off-limits.
 * @adr 0438
 */
function booksIntro(approved: readonly string[]): string {
  const list = approved.length ? approved.join(", ") : "(none)";
  return `The five "book" files at the project root — \`USER_TODO.md\`, \`USER_QA.md\`, \`AI_TODO.md\`,
\`AI_PROGRESS.md\`, \`AI_DONE.md\` — have canonical templates in \`.claude/templates/\` (\`<NAME>.empty.md\`
= EMPTY, \`<NAME>.sample.md\` = example WITH DATA). When clearing a book, overwrite it with EXACTLY the
empty template. The APPROVED rows are exactly these ids (verified by 4PM): ${list}.
NEVER act on any other row. NEVER edit \`.claude/.autonomous.approvals.json\`, \`.claude/.autonomous.authors.json\`
or \`.claude/.autonomous.attempts.json\` — 4PM reverts such edits and alerts the project managers.`;
}

/**
 * Intake: analyse approved `USER_TODO` requests and answered intake questions into
 * sized tasks. Books only — no git, no code.
 * @adr 0371 phase 3
 */
export function buildIntakePrompt(cfg: AutonomousConfig, approved: readonly string[]): string {
  const h = cfg.taskSizeHints;
  // Admin override (ADR-0381) for `cli.autonomous.intake`, else the shared registry default.
  return resolveCliPrompt("cli.autonomous.intake", {
    booksIntro: booksIntro(approved),
    evidenceDir: cfg.evidenceDir,
    mockupDir: cfg.mockupDir,
    sMaxFiles: h.sMaxFiles,
    sMaxLines: h.sMaxLines,
    mMaxFiles: h.mMaxFiles,
    mMaxLines: h.mMaxLines,
  });
}

/**
 * Implementation: work + test on the prepared branches; commit only. `mockups` = the intake
 * mockups of the task's group — the design reference.
 * @adr 0371 phase 6 @adr 0418
 */
function buildImplementPrompt(
  mine: LocalClaim,
  subs: { dir: string; branch: string }[],
  resumed: boolean,
  cfg: AutonomousConfig,
  mockups: string[],
): string {
  const subLines = subs.length
    ? subs.map((s) => `- submodule \`${s.dir}\` is on branch \`${s.branch}\` — commit changes to it INSIDE \`${s.dir}\``).join("\n")
    : "- (no submodules)";
  const resumedNote = resumed
    ? "\nThis is a CONTINUATION: earlier work for this task is already committed on the branches below — review it (git log / git diff against the base) and continue from it; do not start over.\n"
    : "";
  // Admin override (ADR-0381) for `cli.autonomous.implement`, else the shared registry default.
  return resolveCliPrompt("cli.autonomous.implement", {
    taskId: mine.id,
    group: mine.task.group,
    attempt: mine.attempt,
    // `desc`/`notes` are wrapped as the request by the registry (ADR-0421).
    desc: mine.task.desc,
    notes: mine.task.notes || "(none)",
    resumedNote,
    branch: mine.branch,
    subLines,
    evidenceDir: cfg.evidenceDir,
    mockupNote: mockups.length
      ? `\nUI MOCKUPS for this task's group (the design reference — follow their layout, fields and states; do not edit them):\n${mockups.map((m) => `- \`${m}\``).join("\n")}\n`
      : "",
  });
}

/** Split analysis: read-only — propose smaller child tasks. @adr 0371 §6 */
function buildSplitPrompt(mine: LocalClaim, reasons: string, diff: string): string {
  // Admin override (ADR-0381) for `cli.autonomous.split`, else the shared registry default.
  return resolveCliPrompt("cli.autonomous.split", {
    taskId: mine.id,
    // Task text = request, failure reasons + WIP diff = data — wrapped by the registry (ADR-0421).
    desc: mine.task.desc,
    notes: mine.task.notes || "(none)",
    reasons: reasons || "(unknown)",
    branch: mine.branch,
    diff: diff || "(no changes yet)",
  });
}

/** Extract the last fenced json block (or the last `{…}`) from an agent reply. */
function parseJsonReply<T>(text: string): T | null {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)].map((m) => m[1]!.trim());
  const candidates = fenced.length ? fenced.reverse() : [text.slice(text.lastIndexOf("{"), text.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // try the next
    }
  }
  return null;
}

// ── Claim watch (during the run + on reconnect) ───────────────────────────────────────────────────

/** The run currently implementing a claimed task (one per daemon). */
const watch: { commandId: string | null; claim: LocalClaim | null; root: string | null; lost: boolean } = {
  commandId: null,
  claim: null,
  root: null,
  lost: false,
};

/** Is the held claim still ours on the remote books? Lost ⇒ stop the running agent. @adr 0371 §2 */
async function verifyHeldClaim(ctx: WsHandlerCtx): Promise<void> {
  const { claim, root, commandId } = watch;
  if (!claim || !root || !commandId || watch.lost) return;
  const prog = await remoteBook(root, claim.base, "AI_PROGRESS.md");
  if (!prog) return; // unreadable (offline) — keep working, the next check / deliver re-verifies
  const row = B.parseClaims(prog).claims.find((c) => c.id === claim.id);
  if (!row || row.claim !== claim.claim) {
    watch.lost = true;
    ctx.bus.log(`autonomous: claim of ${claim.id} was taken over — stopping this run`, "warn");
    cancelActiveRun(commandId);
  }
}

/** Reconnect hook: a worker that was offline re-verifies its claim before working on. @adr 0371 */
export function onReconnectVerifyClaim(ctx: WsHandlerCtx): void {
  void verifyHeldClaim(ctx).catch(() => undefined);
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────

/** Send an alert to the server (the project's managers are notified, deduplicated per day). */
function alert(ctx: WsHandlerCtx, payload: AutonomousAlertPayload): void {
  try {
    ctx.send(WsChannels.AUTONOMOUS_ALERT, payload);
  } catch {
    // best-effort
  }
}

/** Branches per submodule for a task, and the source each starts from (the dependency's / parent's). */
function subBranches(subs: RepoBase[], taskId: string, rootFrom: string | null): { sub: RepoBase; branch: string; from: string | null }[] {
  // The root's `from` is `dev/<base>/<GROUP>/<TSK-x>` — use the same TSK-x's branch in each submodule.
  const fromTask = rootFrom ? rootFrom.split("/").pop() ?? null : null;
  return subs
    .filter((s) => s.base)
    .map((s) => ({ sub: s, branch: taskBranch(s.base, taskId), from: fromTask ? taskBranch(s.base, fromTask) : null }));
}

/**
 * Report a reverted sidecar edit by an agent run (ADR-0438): a `[guard]` line in the tick log + a
 * `sidecar-tamper` alert to the project's managers.
 */
async function reportSidecarTamper(ctx: WsHandlerCtx, root: string, files: string[], task?: string): Promise<void> {
  if (files.length === 0) return;
  await dayLog(root, `[guard] ${task ? `${task}: ` : ""}agent edited ${files.join(", ")} — reverted`);
  alert(ctx, { kind: "sidecar-tamper", ...(task ? { task } : {}), message: `An agent run edited ${files.join(", ")}; the change was reverted.` });
}

/** Save + push the work in progress of a task (root + submodules) — no PR. Best-effort. */
async function pushWip(ctx: WsHandlerCtx, root: string, mine: LocalClaim, subs: { sub: RepoBase; branch: string }[], note: string): Promise<void> {
  for (const s of subs) {
    const abs = join(root, s.sub.dir);
    if ((await currentBranch(abs)) !== s.branch) continue;
    await wipCommit(abs, `wip(${mine.id}): ${note}`);
    if ((await aheadOf(abs, s.branch, s.sub.base)) > 0) await pushBranch(abs, s.branch).catch(() => undefined);
  }
  if ((await currentBranch(root)) === mine.branch) {
    await wipCommit(root, `wip(${mine.id}): ${note}`);
    await reportSidecarTamper(ctx, root, await stripSidecarsFromBranch(root, mine.base, mine.id), mine.id);
    await pushBranch(root, mine.branch).catch(() => undefined);
  }
}

/** Short diff of a task branch against its base, for the split analysis. */
async function wipDiff(root: string, mine: LocalClaim): Promise<string> {
  const stat = await gitQuiet(root, ["diff", "--stat", `origin/${mine.base}...${mine.branch}`]);
  const patch = await gitQuiet(root, ["diff", `origin/${mine.base}...${mine.branch}`]);
  return `${stat}\n${patch}`.slice(0, 20_000);
}

// ── The cycle ─────────────────────────────────────────────────────────────────────────────────────

// Serialize cycles: at most one per served project at a time (ADR-0321).
const running = new Set<string>();

/**
 * Run one autonomous cycle: gates → guard (protection) → sync `<base>` → resume / release a
 * held claim → fold task answers → intake → claim (race-safe) → task branches → implement (claim watched)
 * → deliver PRs → finish; failures release the task (WIP pushed, attempts+1) and split it at the limit;
 * a question parks it on a `QA-…`.
 * @adr 0371
 */
export async function runAutonomousCycle(ctx: WsHandlerCtx): Promise<void> {
  const root = ctx.physicRoot;
  const profileDir = ctx.profileDir;
  if (!root) {
    ctx.bus.autonomousDone(false, "no served project");
    return;
  }
  if (running.has(root)) {
    ctx.bus.autonomousDone(false, "a cycle is already running");
    return;
  }
  running.add(root);
  const log = (line: string): Promise<void> => dayLog(root, line);
  try {
    const cfg = await readAutonomousConfig(profileDir);
    await pruneLogs(root, cfg.logRetentionDays);
    const today = new Date().toISOString().slice(0, 10);
    const worker = ctx.machineUsername || "worker";

    // --- Preconditions + cheap gates (no token spend) ------------------------------------------
    if (!ctx.isReady) {
      await log("[skip] cli offline (no WS connection)");
      ctx.bus.autonomousDone(false, "cli offline");
      return;
    }
    if (cfg.paused) {
      await log("[skip] paused");
      ctx.bus.autonomousDone(false, "paused");
      return;
    }
    if (isInQuietHours(cfg.quietHours)) {
      await log("[skip] within quiet hours");
      ctx.bus.autonomousDone(false, "quiet hours");
      return;
    }
    let hist = await readHistories(root);
    if (cfg.maxTicksPerDay > 0 && todayTickCount(hist, today) >= cfg.maxTicksPerDay) {
      await log(`[skip] reached max ticks/day (${cfg.maxTicksPerDay})`);
      ctx.bus.autonomousDone(false, "max ticks reached");
      return;
    }

    // --- Phase 0: bases + protection guard -----------------------------------------------------
    const bases = await resolveBases(root);
    const rootBase = bases.root;
    if (!rootBase.base) {
      await log("[skip] base branch unknown (no spec branch, no origin/HEAD)");
      ctx.bus.autonomousDone(false, "base branch unknown");
      return;
    }
    for (const r of [rootBase, ...bases.subs]) {
      if (!r.base || !r.url) continue;
      if ((await branchProtection(r.url, r.base)) === true) {
        const repo = r.dir || "root";
        await log(`[stop] base branch "${r.base}" is protected in ${repo} — the books cannot be pushed`);
        alert(ctx, { kind: "base-protected", repo, branch: r.base, message: `The base branch "${r.base}" (${repo}) is protected; autonomous cannot record its tasks there.` });
        await recordRun(root, hist, "skip", `base-protected: ${r.base} (${repo})`, today); // surfaced as status.baseProtected
        ctx.bus.autonomousDone(false, "base branch protected");
        return;
      }
    }

    // --- Phase 1: sync <base> ------------------------------------------------------------------
    await syncBase(root, rootBase.base);

    // --- Phase 2: a held claim? (resume / release / lost) ----------------------------------------
    let mine = await readLocalClaim(profileDir);
    if (mine && mine.base !== rootBase.base) mine = null; // a claim of another project / base
    if (mine) {
      const state = await claimState(root, mine, cfg.claimTtlHours);
      if (state === "lost") {
        await log(`[lost] claim of ${mine.id} was taken over — dropping local work (kept on ${mine.branch} locally)`);
        await publishBooks(root, rootBase.base, `chore(auto): incident — ${mine.id} claim lost by ${worker}`, async () => {
          await B.writeBook(root, "AI_DONE.md", B.appendIncident(await B.readBook(root, "AI_DONE.md"), `${worker} lost its claim of ${mine!.id} (taken over); its local work was not pushed.`));
          return true;
        });
        alert(ctx, { kind: "claim-lost", task: mine.id, message: `${worker} lost its claim of ${mine.id}.` });
        await writeLocalClaim(profileDir, null);
        mine = null;
      } else if (state === "expired") {
        await log(`[release] claim of ${mine.id} reached ${cfg.claimTtlHours} h — pushing WIP and returning the task`);
        await checkoutTaskBranch(root, mine.branch, rootBase.base, null).catch(() => undefined);
        await releaseTask(ctx, root, rootBase, bases.subs, mine, `not finished within ${cfg.claimTtlHours} h`, cfg);
        ctx.bus.autonomousDone(false, "claim expired — task returned");
        return;
      }
    }

    // --- Has work? + quota gate ----------------------------------------------------------------
    if (!mine && !(await hasWork(root))) {
      await log("[skip] no approved USER_TODO/USER_QA/AI_TODO work");
      ctx.bus.autonomousDone(false, "no work");
      return;
    }
    if (await allAiProfilesExhausted(ctx, cfg)) {
      // A held claim is kept while waiting for the reset; the TTL release above bounds it.
      await log(`[skip] all AI profiles over usage limit (≥ ${cfg.maxSessionPct}%/${cfg.maxWeeklyPct}%)${mine ? ` — ${mine.id} kept` : ""}`);
      await recordRun(root, hist, "skip", "all AI profiles over usage limit", today);
      ctx.bus.autonomousDone(false, "usage limit");
      return;
    }
    hist.ticks = { day: today, count: todayTickCount(hist, today) + 1 };
    await writeHistories(root, hist);
    await log(`[run] cycle (tick ${hist.ticks.count}/${today})`);

    // The folders committed with the books: evidence roots + mockups (ADR-0418).
    const dirs = repoDirsOf(cfg);
    let resumed = !!mine;
    if (!mine) {
      // --- Fold answered task questions into their tasks (cli) ------------------------------------
      const folded = await publishBooks(root, rootBase.base, "chore(auto): fold answered task questions", () => foldTaskAnswers(root));
      if (folded === "pushed") await log("[fold] task-question answers folded into their tasks");

      // --- Phase 3: intake (agent) --------------------------------------------------------------
      const usage = await readBookUsage(ctx);
      const intakeBlocked = (["AI_TODO", "USER_QA"] as const).some((b) => {
        const c = usage?.books[b];
        return !!c && c.limit !== null && c.used >= c.limit;
      });
      if (intakeBlocked) await log("[cap] monthly AI_TODO/USER_QA limit reached — intake skipped this cycle");
      else if (await hasIntakeWork(root)) {
        const before = await cappedBookIds(root);
        const out = await runAiPrompt(ctx, buildIntakePrompt(cfg, [...(await approvedIds(root))].filter((id) => !id.startsWith("TSK-")).sort()), randomUUID(), "local", false, undefined, undefined, false, true);
        if (out.exhausted) {
          await gitQuiet(root, ["checkout", "--", "."]);
          await log("[skip] usage limit during intake");
          ctx.bus.autonomousDone(false, "usage limit");
          return;
        }
        const res = await publishIntake(root, rootBase.base, "chore(auto): intake requests into tasks", dirs, (files) =>
          reportSidecarTamper(ctx, root, files),
        );
        await log(`[intake] ${res}`);
        if (res === "pushed") await reportNewBookRows(ctx, root, before);
        await syncBase(root, rootBase.base);
      }

      // --- Phase 4: claim (race-safe) -----------------------------------------------------------
      const skip = new Set<string>();
      for (let i = 0; i < 5 && !mine; i++) {
        const cand: Candidate | null = await pickTask(root, rootBase, { worker, ttlHours: cfg.claimTtlHours, maxAttempts: cfg.maxTaskAttempts, skip });
        if (!cand) break;
        const attempts = await B.readAttempts(root);
        const claim: LocalClaim = {
          id: cand.task.id,
          claim: randomUUID(),
          worker,
          started: B.stamp(),
          attempt: (attempts[cand.task.id]?.count ?? 0) + 1 + (cand.takeover ? 1 : 0),
          branch: taskBranch(rootBase.base, cand.task.id),
          base: rootBase.base,
          task: cand.task,
        };
        const res = await publishBooks(root, rootBase.base, `chore(auto): claim ${cand.task.id} by ${worker}`, () =>
          applyClaim(root, cand, claim, cfg.claimTtlHours),
        );
        if (res === "pushed") {
          mine = { ...claim, from: cand.from };
          await writeLocalClaim(profileDir, mine);
          await log(`[claim] ${mine.id}${cand.takeover ? ` (taken over from ${cand.takeover.worker})` : ""} attempt ${mine.attempt}`);
        } else skip.add(cand.task.id);
      }
      if (!mine) {
        await log("[idle] no eligible task (waiting for approval / dependencies / answers)");
        hist = await readHistories(root);
        await recordRun(root, hist, "success", "no eligible task", today);
        ctx.bus.autonomousDone(true);
        return;
      }
      resumed = false;
    }

    // --- Phase 5: task branches (root + submodules) --------------------------------------------
    const from = mine.from ?? null;
    await checkoutTaskBranch(root, mine.branch, rootBase.base, from);
    const hadWork = (await aheadOf(root, mine.branch, rootBase.base)) > 0;
    await gitQuiet(root, ["submodule", "update", "--init", "-q"], 300_000);
    const subs = subBranches(bases.subs, mine.id, from);
    for (const s of subs) await checkoutTaskBranch(join(root, s.sub.dir), s.branch, s.sub.base, s.from).catch((e) => log(`[warn] submodule ${s.sub.dir}: ${String(e)}`));

    // --- Phase 6: implement (agent), claim watched ---------------------------------------------
    const commandId = randomUUID();
    Object.assign(watch, { commandId, claim: mine, root, lost: false });
    const timer = setInterval(() => void verifyHeldClaim(ctx).catch(() => undefined), cfg.claimCheckMinutes * 60_000);
    timer.unref?.();
    let out: AiPromptOutcome;
    try {
      // The intake mockups of this task's group (`<mockupDir>/TSK-<group>--*.html` — ADR-0418).
      const group = /^(TSK-\d{4})-/.exec(mine.id)?.[1] ?? "";
      const mockups = group ? (await listMockups(root, rootBase.base, cfg.mockupDir).catch(() => [])).filter((m) => m.split("/").pop()?.startsWith(`${group}--`)) : [];
      const prompt = buildImplementPrompt(mine, subs.map((s) => ({ dir: s.sub.dir, branch: s.branch })), resumed || hadWork, cfg, mockups);
      // No model override: each AI profile's own model applies (ADR-0418).
      out = await runAiPrompt(ctx, prompt, commandId, "local", false, undefined, undefined, false, true);
    } finally {
      clearInterval(timer);
    }
    const lost = watch.lost;
    Object.assign(watch, { commandId: null, claim: null, root: null, lost: false });
    // The agent must stay on the prepared branches — put them back if it wandered.
    if ((await currentBranch(root)) !== mine.branch) await gitQuiet(root, ["checkout", "-q", mine.branch]);

    if (lost) {
      // --- Phase 9: lost the claim mid-run — push nothing -------------------------------------
      await log(`[lost] ${mine.id} was taken over while running — stopped, nothing pushed`);
      alert(ctx, { kind: "claim-lost", task: mine.id, message: `${worker} lost its claim of ${mine.id} while working; its work was not pushed.` });
      await writeLocalClaim(profileDir, null);
      await syncBase(root, rootBase.base);
      ctx.bus.autonomousDone(false, "claim lost");
      return;
    }
    if (out.exhausted) {
      // Out of tokens: keep the claim + save the work; the next cycle resumes it.
      for (const s of subs) await wipCommit(join(root, s.sub.dir), `wip(${mine.id}): out of tokens`);
      await wipCommit(root, `wip(${mine.id}): out of tokens`);
      await log(`[wait] ${mine.id}: usage limit — claim kept, resumes after the reset`);
      ctx.bus.autonomousDone(false, "usage limit — task kept");
      return;
    }
    const reply = parseJsonReply<{ status?: string; summary?: string; question?: string }>(out.output);
    const status = out.cancelled ? "failed" : out.exitCode !== 0 ? "failed" : (reply?.status ?? "failed");

    if (status === "needs-input") {
      await pushWip(ctx, root, mine, subs, "waiting for an answer");
      await syncBase(root, rootBase.base);
      const question = reply?.question?.trim() || reply?.summary?.trim() || "The agent needs a decision to continue.";
      let qaId: string | null = null;
      await publishBooks(root, rootBase.base, `chore(auto): ${mine.id} asks a question`, async () => {
        qaId = await applyQuestion(root, mine!, question);
        return qaId !== null;
      });
      await writeLocalClaim(profileDir, null);
      await log(`[question] ${mine.id} parked on ${qaId ?? "?"}`);
      alert(ctx, { kind: "task-question", task: mine.id, message: `${mine.id} waits for an answer (${qaId ?? "QA"}): ${question.slice(0, 200)}` });
      hist = await readHistories(root);
      await recordRun(root, hist, "success", `${mine.id} needs input`, today);
      ctx.bus.autonomousDone(true);
      return;
    }
    if (status !== "done") {
      const reason = reply?.summary?.trim() || (out.cancelled ? "run stopped" : `agent run failed (exit ${out.exitCode})`);
      await releaseTask(ctx, root, rootBase, bases.subs, mine, reason, cfg);
      hist = await readHistories(root);
      hist.consecutiveFails += 1;
      await recordRun(root, hist, "failure", `${mine.id}: ${reason}`, today);
      await maybeAutoPause(root, profileDir, cfg, hist, log);
      ctx.bus.autonomousDone(false, reason);
      return;
    }

    // --- Phase 7: deliver (verify the claim first) ---------------------------------------------
    if (await remoteClaimLost(root, mine)) {
      await log(`[lost] ${mine.id} was taken over before delivery — nothing pushed`);
      alert(ctx, { kind: "claim-lost", task: mine.id, message: `${worker} lost its claim of ${mine.id} before delivering.` });
      await writeLocalClaim(profileDir, null);
      await syncBase(root, rootBase.base);
      ctx.bus.autonomousDone(false, "claim lost");
      return;
    }
    let delivered: { files: string; notes: string; evidence: string[] };
    try {
      delivered = await deliver(ctx, root, rootBase, subs, mine, reply?.summary ?? "", cfg.evidenceDir);
    } catch (err) {
      const reason = `delivery failed: ${String(err instanceof Error ? err.message : err)}`;
      await releaseTask(ctx, root, rootBase, bases.subs, mine, reason, cfg);
      ctx.bus.autonomousDone(false, reason);
      return;
    }

    // --- Phase 8: finish -----------------------------------------------------------------------
    await syncBase(root, rootBase.base);
    const fin = await publishBooks(root, rootBase.base, `chore(auto): finish ${mine.id}`, () => applyFinish(root, mine!, delivered, cfg.evidenceDir), { dirs });
    await writeLocalClaim(profileDir, null);
    await log(`[done] ${mine.id} — ${delivered.notes} (${fin})`);
    hist = await readHistories(root);
    hist.consecutiveFails = 0;
    await recordRun(root, hist, "success", `${mine.id} delivered`, today);
    ctx.bus.autonomousDone(true);
  } catch (err) {
    await dayLog(root, `[warn] cycle error: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
    ctx.bus.autonomousDone(false, err instanceof Error ? err.message : String(err));
  } finally {
    running.delete(root);
  }
}

/** Is the claim gone from the REMOTE books (read without leaving the task branch)? Unknown ⇒ false. */
async function remoteClaimLost(root: string, mine: LocalClaim): Promise<boolean> {
  const prog = await remoteBook(root, mine.base, "AI_PROGRESS.md");
  if (!prog) return false; // unreadable — the finish step re-verifies on <base>
  const row = B.parseClaims(prog).claims.find((c) => c.id === mine.id);
  return !row || row.claim !== mine.claim;
}

/**
 * Deliver: push each submodule's task branch that has commits + open its PR into the
 * submodule's base; in the root commit the pointer bumps, push, and open the PR into `<base>` linking the
 * submodule PRs. Returns the AI_DONE Files + Notes.
 * @adr 0371 phase 7
 */
async function deliver(
  ctx: WsHandlerCtx,
  root: string,
  rootBase: RepoBase,
  subs: { sub: RepoBase; branch: string }[],
  mine: LocalClaim,
  summary: string,
  evRoot: string,
): Promise<{ files: string; notes: string; evidence: string[] }> {
  const title = `${mine.id}: ${mine.task.desc}`.replace(/\s+/g, " ").slice(0, 100);
  const subPrs: string[] = [];
  for (const s of subs) {
    const abs = join(root, s.sub.dir);
    if ((await currentBranch(abs)) !== s.branch) continue;
    await wipCommit(abs, `feat(${mine.id}): ${summary || mine.task.desc}`.slice(0, 200));
    if ((await aheadOf(abs, s.branch, s.sub.base)) === 0) continue;
    await pushBranch(abs, s.branch);
    const pr = await deliverPr(abs, s.sub.url, s.branch, s.sub.base, title, `${summary}\n\nTask ${mine.id} (4PM autonomous).`);
    if (pr.error) throw new Error(`submodule ${s.sub.dir} PR: ${pr.error}`);
    subPrs.push(`${s.sub.dir}: ${pr.url ?? s.branch}`);
  }
  // Root: pointer bumps + any uncommitted leftovers, then push + PR.
  await wipCommit(root, `feat(${mine.id}): ${summary || mine.task.desc}`.slice(0, 200));
  // The agent's own commits may carry sidecar edits — restore them before the push / PR (ADR-0438).
  await reportSidecarTamper(ctx, root, await stripSidecarsFromBranch(root, rootBase.base, mine.id), mine.id);
  const files = (await gitQuiet(root, ["diff", "--name-only", `origin/${rootBase.base}...${mine.branch}`])).split("\n").filter(Boolean);
  // The agent's own evidence on the task branch (ADR-0404) — listed in AI Done's Evidence column.
  const evidence = await agentEvidence(root, mine.id, evRoot);
  if ((await aheadOf(root, mine.branch, rootBase.base)) === 0) {
    return { files: "", notes: `no changes needed; branch: ${mine.branch}${subPrs.length ? `; sub PRs: ${subPrs.join(", ")}` : ""}`, evidence: [] };
  }
  await pushBranch(root, mine.branch);
  const body = `${summary}\n\nTask ${mine.id} (4PM autonomous).${subPrs.length ? `\n\nSubmodule PRs:\n${subPrs.map((p) => `- ${p}`).join("\n")}` : ""}`;
  const pr = await deliverPr(root, rootBase.url, mine.branch, rootBase.base, title, body);
  if (pr.error) throw new Error(`PR: ${pr.error}`);
  return {
    files: files.slice(0, 20).join(", ") + (files.length > 20 ? ` (+${files.length - 20})` : ""),
    notes: `branch: ${mine.branch}; PR: ${pr.url ?? "opened"}${subPrs.length ? `; sub PRs: ${subPrs.join(", ")}` : ""}`,
    evidence,
  };
}

/**
 * Release a task after a failure / overrun: push its WIP, then on `<base>` either return it
 * to `AI_TODO` (attempts+1) or — at the attempt limit — split it (a split child becomes a QA question).
 * @adr 0371 §4
 */
async function releaseTask(ctx: WsHandlerCtx, root: string, rootBase: RepoBase, allSubs: RepoBase[], mine: LocalClaim, reason: string, cfg: AutonomousConfig): Promise<void> {
  const subs = subBranches(allSubs, mine.id, null);
  await pushWip(ctx, root, mine, subs, reason.slice(0, 80));
  await syncBase(root, rootBase.base); // the books (and attempts) as on the remote
  const attempts = await B.readAttempts(root);
  const next = (attempts[mine.id]?.count ?? 0) + 1;
  const reasons = `${attempts[mine.id]?.last ?? ""}; ${reason}`;
  if (next >= cfg.maxTaskAttempts) {
    if (isSplitChild(mine.task)) {
      const q = `${mine.id} (a task already split from a bigger one) failed ${next} times — last: ${reason}. How should it be handled (narrow the scope, change the approach, or drop it)?`;
      await publishBooks(root, rootBase.base, `chore(auto): ${mine.id} needs a decision`, async () => (await applyQuestion(root, mine, q, true)) !== null);
      alert(ctx, { kind: "task-failed-limit", task: mine.id, message: `${mine.id} failed ${next} times; a decision was requested in USER_QA.` });
    } else {
      const out = await runAiPrompt(ctx, buildSplitPrompt(mine, reasons, await wipDiff(root, mine)), randomUUID(), "local", false, undefined, undefined, true, false);
      const children = parseJsonReply<{ children?: { desc: string; priority?: string; size?: string; notes?: string }[] }>(out.output)?.children?.filter((c) => c?.desc?.trim()) ?? [];
      await syncBase(root, rootBase.base);
      if (children.length >= 2) {
        let ids: string[] | null = null;
        await publishBooks(
          root,
          rootBase.base,
          `chore(auto): split ${mine.id}`,
          async () => {
            ids = await applySplit(root, mine, children, cfg.evidenceDir);
            return ids !== null;
          },
          { dirs: repoDirsOf(cfg) },
        );
        alert(ctx, { kind: "task-split", task: mine.id, message: `${mine.id} was split into ${(ids ?? []).join(", ")} — approve the new tasks.` });
      } else {
        const q = `${mine.id} failed ${next} times and could not be split automatically — last: ${reason}. How should it be handled?`;
        await publishBooks(root, rootBase.base, `chore(auto): ${mine.id} needs a decision`, async () => (await applyQuestion(root, mine, q, true)) !== null);
        alert(ctx, { kind: "task-failed-limit", task: mine.id, message: `${mine.id} failed ${next} times; a decision was requested in USER_QA.` });
      }
    }
  } else {
    await publishBooks(root, rootBase.base, `chore(auto): release ${mine.id} (attempt ${next})`, async () => (await applyRelease(root, mine, reason, cfg.maxTaskAttempts)) !== null);
  }
  await writeLocalClaim(ctx.profileDir, null);
  await dayLog(root, `[release] ${mine.id} attempt ${next}: ${reason}`);
}

/** Auto-pause after N consecutive failures. @adr 0321 */
async function maybeAutoPause(root: string, profileDir: string, cfg: AutonomousConfig, hist: Histories, log: (l: string) => Promise<void>): Promise<void> {
  if (cfg.stopOnConsecutiveFailures > 0 && hist.consecutiveFails >= cfg.stopOnConsecutiveFailures) {
    await writeAutonomousConfig(profileDir, { ...cfg, paused: true });
    await log(`[stop] ${hist.consecutiveFails} consecutive failures → paused`);
  }
  await writeHistories(root, hist);
}

/** Read the org's monthly autonomous-book counters; null when unavailable (fail open). @adr 0365 */
async function readBookUsage(ctx: WsHandlerCtx): Promise<AutonomousBookUsageReply | null> {
  try {
    return await ctx.request<AutonomousBookUsageReply>(WsChannels.AUTONOMOUS_BOOK_USAGE, {});
  } catch {
    return null;
  }
}

/** Report the rows the cycle added per capped book (ids present now, absent before). Best-effort. */
async function reportNewBookRows(
  ctx: WsHandlerCtx,
  root: string,
  before: Awaited<ReturnType<typeof cappedBookIds>>,
): Promise<void> {
  try {
    const after = await cappedBookIds(root);
    const added: Partial<Record<keyof typeof after, number>> = {};
    for (const book of Object.keys(after) as (keyof typeof after)[]) {
      const n = [...after[book]].filter((id) => !before[book].has(id)).length;
      if (n > 0) added[book] = n;
    }
    if (Object.keys(added).length > 0) await ctx.request(WsChannels.AUTONOMOUS_BOOK_USAGE, { added });
  } catch {
    /* best-effort — an unreported tick only under-counts */
  }
}

/** Append a line to the per-day tick log (`<root>/.claude/logs/autonomous-tick-<day>.log`). Best-effort. */
async function dayLog(root: string, line: string): Promise<void> {
  try {
    const dir = join(root, ".claude", "logs");
    await mkdir(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    await appendFile(join(dir, `autonomous-tick-${day}.log`), `${ts} ${line}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

/** Delete per-day tick logs older than `retentionDays` (0/negative = keep forever). Best-effort. */
async function pruneLogs(root: string, retentionDays: number): Promise<void> {
  if (!(retentionDays > 0)) return;
  try {
    const dir = join(root, ".claude", "logs");
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const f of await readdir(dir)) {
      if (!/^autonomous-tick-.*\.log$/.test(f)) continue;
      const st = await stat(join(dir, f)).catch(() => null);
      if (st && st.mtimeMs < cutoff) await rm(join(dir, f), { force: true }).catch(() => undefined);
    }
  } catch {
    /* best-effort */
  }
}

/** Append a run record + persist histories. */
async function recordRun(
  root: string,
  hist: Histories,
  status: "success" | "failure" | "skip",
  note: string,
  today: string,
): Promise<void> {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  pushRecord(hist, { ts, status, note, tick: `${today} #${hist.ticks.count}` });
  await writeHistories(root, hist);
}

/**
 * "Has work": at least one APPROVED row present in a book — an approved `REQ-` in
 * USER_TODO, an approved `QA-` in USER_QA, an approved `TSK-` in AI_TODO — or AI_PROGRESS carries a task.
 * @adr 0319 @adr 0321 @adr 0438
 */
async function hasWork(root: string): Promise<boolean> {
  // Verified approvals only (ADR-0438) — a forged or edited entry is no work.
  const approved = [...(await approvedIds(root))];
  const read = (f: string): Promise<string> => readFileInRoot(root, join(root, f), "utf8").catch(() => "");
  const [userTodo, userQa, aiTodo, aiProgress] = await Promise.all([
    read("USER_TODO.md"),
    read("USER_QA.md"),
    read("AI_TODO.md"),
    read("AI_PROGRESS.md"),
  ]);
  const anyApproved = (prefix: string, text: string): boolean =>
    approved.some((id) => id.startsWith(prefix) && text.includes(id));
  return (
    anyApproved("REQ-", userTodo) ||
    anyApproved("QA-", userQa) ||
    anyApproved("TSK-", aiTodo) ||
    /TSK-\d{4}-\d{4}/.test(aiProgress)
  );
}

/** True when the config has a usable (enabled, non-blank) codex profile — mixed list or legacy list. */
function hasUsableCodex(config: ReturnType<typeof readProfileConfig>): boolean {
  const mixed = config.aiProfiles?.some(
    (c) => c.provider === "codex" && c.enabled !== false && Boolean(c.profile?.trim()),
  );
  const legacy = (config.codexHome ?? []).some((p) => p.enabled !== false && Boolean(p.profile?.trim()));
  return Boolean(mixed || legacy);
}

/**
 * True when EVERY usable AI profile is over the session/weekly caps — the quota gate is
 * checked **per profile**, so autonomous only backs off when there is no profile left to run. Each
 * Claude profile is checked against its own usage snapshot; a profile whose usage can't be read is
 * treated as available (fail-open, so a transient fetch error never halts autonomous). Codex/antigravity
 * have no session/weekly limit, so an active/available one means the gate does not apply.
 * @adr 0321
 */
async function allAiProfilesExhausted(ctx: WsHandlerCtx, cfg: AutonomousConfig): Promise<boolean> {
  const config = readProfileConfig(ctx.profileDir);
  const active = activeProvider(config);
  if (active === "codex" || active === "antigravity") return false;
  if (active === null && hasUsableCodex(config)) return false; // mixed with a codex fallback
  const dirs = claudeHomeDirs(config);
  if (dirs.length === 0) return false;
  const usages = await Promise.all(dirs.map((d) => checkClaudeUsage([d]).catch(() => null)));
  let readAny = false;
  for (const u of usages) {
    if (!u) continue; // unreadable ⇒ treat as available (fail-open)
    readAny = true;
    if (u.session.utilizationPct < cfg.maxSessionPct && u.weekly.utilizationPct < cfg.maxWeeklyPct) {
      return false; // this profile is still under the caps ⇒ available
    }
  }
  return readAny; // skip only when ≥1 profile was read and none were under the caps
}
