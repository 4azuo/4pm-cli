/**
 * Autonomous cycle runner (ADR-0319). Runs ONE unattended work cycle through the daemon's live WS
 * session — reusing its profile/quota failover (ADR-0182), token metering (ADR-0072), folder-scope
 * guard (ADR-0181) and wall-clock timeout (ADR-0243) — instead of the old raw `claude -p /auto-cycle`.
 * Triggered by `4pm auto-run` over the control socket (SessionBus `autonomous-run`), it builds the
 * cli-owned cycle prompt and dispatches it as a write-capable agent (bypass mode — ADR-0271: branch +
 * PR), then reports completion back over the socket so the cron tick can settle the tick.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WsHandlerCtx } from "./ws-client/context";
import { runAiPrompt } from "./ws-client/command-dispatch";
import {
  isInQuietHours,
  quotaExceeded,
  readAutonomousConfig,
  writeAutonomousConfig,
} from "./autonomous-config";
import { pushRecord, readHistories, todayTickCount, writeHistories, type Histories } from "./autonomous-history";

/**
 * The cli-owned autonomous cycle instructions (ADR-0319) — replaces the scaffold's
 * `.claude/commands/auto-cycle.md`. The agent runs write-capable (bypass) and folder-scoped to the
 * served project root, so all paths are relative to that root.
 */
export function buildAutonomousCyclePrompt(): string {
  return `You are running UNATTENDED as the 4PM autonomous cycle (headless, one tick). Do EXACTLY ONE small
work cycle with the steps below, then STOP. Keep each cycle to ONE small task so you never run out of
tokens mid-way. If a step fails, append a row to the **Incidents** table of \`AI_DONE.md\` and STOP —
do not push on. Write all books/docs/code in the language the project's \`CLAUDE.md\` specifies (default
English).

## Books & approval (MUST read the approvals file)
The five "book" files at the project root — \`USER_TODO.md\`, \`USER_QA.md\`, \`AI_TODO.md\`,
\`AI_PROGRESS.md\`, \`AI_DONE.md\` — have canonical templates in \`.claude/templates/\` (\`<NAME>.empty.md\`
= EMPTY, \`<NAME>.sample.md\` = example WITH DATA). To tell empty/has-work, COMPARE a book to its
\`<NAME>.empty.md\` (equal after trimming ⇒ empty). When clearing a book, overwrite it with EXACTLY the
empty template (\`cp .claude/templates/<NAME>.empty.md <NAME>\`).

The single source of truth for approval is \`.claude/.autonomous.approvals.json\` — a map
\`{ "<ID>": { "approved": true, "by": "...", "at": "..." } }\` (the user ticks rows in the web grids). A
row is APPROVED only when its ID has \`"approved": true\`. Row IDs: \`USER_TODO\` = \`REQ-…\`, \`USER_QA\`
= \`QA-…\`, \`AI_TODO\` = \`TSK-…\`. NEVER act on an unapproved row.

## Step 1 — Base branch (from the spec, ADR-0292)
The project root IS the primary repo (ADR-0314). Its currently checked-out branch is the base branch
(4PM cloned it with \`-b <branch>\`): \`BASE=$(git rev-parse --abbrev-ref HEAD)\`. Sync it:
\`git fetch origin\` then \`git pull --ff-only origin "$BASE"\` (skip the pull if the remote has no such
branch yet). Do NOT invent a separate integration/dev branch.

## Step 2 — Intake APPROVED user requests → tasks
Read \`USER_TODO.md\` (content-only columns \`ID | Group | Depends | Request\`; who/when wrote or approved a
row lives in \`.claude/.autonomous.authors.json\` / \`.autonomous.approvals.json\`, ADR-0320 — never add
provenance columns to the table). For each row that is APPROVED (its \`REQ-…\` in the approvals file) AND
whose \`Depends\` \`REQ-…\` are already handled:
- If the request is CLEAR: split it into small tasks and append them to \`AI_TODO.md\` (7 columns
  \`ID | Priority | Tag | Depends | Group | Task description | Notes\`), each with an ID
  \`TSK-{groupid:0000}-{taskid:0000}\`. **groupid** must be UNIQUE + INCREASING across all history — find
  the largest ever used in git history of \`AI_TODO.md\`/\`AI_DONE.md\`/\`AI_PROGRESS.md\`, then use max+1;
  **taskid** starts at 0001 within the group. Leave \`Tag\` blank unless a catalog tag applies; leave
  \`Priority\` = High/Medium/Low (default Medium). Then REMOVE the analysed request row from
  \`USER_TODO.md\` (if it becomes empty, reset it to the empty template).
- If the request is UNCLEAR (ambiguous/missing info/contradictory): do NOT guess. Append a row to
  \`USER_QA.md\` (content-only columns \`ID | Group | Depends | Original request | Question / options |
  Answer\`) with a new \`QA-{groupid:0000}-{qaid:0000}\` id, the original request and the question +
  options; leave \`Answer\` blank for the user. Remove the request row from \`USER_TODO.md\`. (Do NOT
  generate tasks for it.)
An unapproved request row is LEFT in place (wait for approval).

## Step 3 — Fold APPROVED answers back (USER_QA)
For each \`USER_QA.md\` row that has an \`Answer\` AND is APPROVED (its \`QA-…\` in the approvals file):
re-analyse using the answer — append the resulting tasks to \`AI_TODO.md\` (same ID rules as Step 2) —
then clear that QA row. An unanswered or unapproved QA row is left in place.

## Step 4 — Pick ONE approved task and start it
Read \`AI_TODO.md\` + the approvals file. Filter tasks that are BOTH approved (\`TSK-…\` in approvals) AND
have every \`Depends\` \`TSK-…\` already in \`AI_DONE.md\`. Run group by group (smallest eligible group
first), within a group High → Medium → Low, then line order. If NO eligible task: append a row to the
\`AI_DONE.md\` Incidents table (e.g. "only generated tasks / waiting for approval / waiting for deps")
and STOP. Otherwise move the chosen task into \`AI_PROGRESS.md\` (with a start timestamp), remove it from
\`AI_TODO.md\`, and commit on the base branch: \`git commit -am "chore(auto): start TSK-…"\`.

## Step 5 — Implement on a task branch + test
\`git checkout -b task/TSK-…\`. Implement following the project's architecture + \`CLAUDE.md\`; add/update
tests. Run the project's test command (per \`CLAUDE.md\` / the project's scripts); WAIT for it to finish
and check the result. Keep any produced report/evidence. Commit: \`git commit -am "feat(TSK-…): <desc>"\`.

## Step 6 — Pull request into the base branch (NO direct merge — ADR-0319/0271)
1. Rebase onto the freshest base to minimise conflicts: \`git fetch origin\` then
   \`git rebase origin/"$BASE"\` (on conflict you can't resolve confidently, \`git rebase --abort\`, write a
   \`USER_QA.md\` row, and STOP).
2. Push the task branch: \`git push -u origin task/TSK-…\`.
3. Open a PR into the base branch with \`gh\` (GitHub) or \`glab\` (GitLab) — e.g.
   \`gh pr create --base "$BASE" --head task/TSK-… --title "TSK-…: <desc>" --body "<summary>"\`. Do NOT
   merge it and do NOT fast-forward the base yourself — a human reviews the PR. If no remote / no
   \`gh\`/\`glab\` auth is available, keep the local task-branch commit and append an Incidents row saying
   the PR could not be opened.

## Step 7 — Update the books
On the base branch, append a row to the \`AI_DONE.md\` Done table (Timestamp, ID, Task description, Files,
Notes — include the PR link if opened) and REMOVE the task from \`AI_PROGRESS.md\` (reset it to the empty
template if nothing is in progress). Commit + push the base branch:
\`git commit -am "chore(auto): finish TSK-… (PR opened)" && git push origin "$BASE"\` (a push rejected as
non-fast-forward ⇒ \`git pull --rebase origin "$BASE"\` then push again).

## Step 8 — Stop
Print a one-line summary (task id + PR link or incident). STOP — the next cron tick runs the next cycle.
The 4PM cli serializes cycles (one at a time); you do NOT manage any run lock.`;
}

// Serialize cycles: at most one per served project at a time (replaces the old shell file-lock — ADR-0321).
const running = new Set<string>();

/**
 * Run one autonomous cycle for the daemon's served project (ADR-0321): the daemon — not the shell tick —
 * owns ALL the logic. It reads the profile-dir config, applies the cheap gates (paused / quiet-hours /
 * max-ticks / has-work) + the quota gate (session/weekly vs the config caps, via the live usage
 * snapshot), serializes, records histories (+ auto-pause), then runs the write-capable-agent cycle
 * (bypass — ADR-0271). Completion is reported over the control socket so `4pm auto-run` can settle.
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

    // --- Cheap gates (no token spend) ----------------------------------------------------------
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
    if (!(await hasWork(root))) {
      await log("[skip] no approved USER_TODO/USER_QA/AI_TODO work, AI_PROGRESS empty");
      ctx.bus.autonomousDone(false, "no work");
      return;
    }
    // Quota gate (ADR-0321): back off near the subscription limit — soft skip, retry next tick.
    if (quotaExceeded(ctx.usageSnapshot, cfg)) {
      const s = ctx.usageSnapshot?.session.utilizationPct ?? 0;
      const w = ctx.usageSnapshot?.weekly.utilizationPct ?? 0;
      await log(`[skip] quota high (session ${s}% / weekly ${w}% ≥ ${cfg.maxSessionPct}/${cfg.maxWeeklyPct})`);
      await recordRun(root, hist, "skip", "quota high", today);
      ctx.bus.autonomousDone(false, "quota high");
      return;
    }

    // --- Count a tick that actually runs, then run the cycle -----------------------------------
    hist.ticks = { day: today, count: todayTickCount(hist, today) + 1 };
    await writeHistories(root, hist);
    await log(`[run] cycle (tick ${hist.ticks.count}/${today})`);

    const commandId = randomUUID();
    const override = cfg.model ? { model: cfg.model } : undefined;
    try {
      // Write-capable agent (bypass — ADR-0271): all tools, folder-scoped; metering + failover from runAiPrompt.
      await runAiPrompt(ctx, buildAutonomousCyclePrompt(), commandId, "local", false, undefined, override, false, true);
      hist = await readHistories(root);
      hist.consecutiveFails = 0;
      await recordRun(root, hist, "success", "cycle complete", today);
      await log("[done] cycle complete");
      ctx.bus.autonomousDone(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      hist = await readHistories(root);
      hist.consecutiveFails += 1;
      await recordRun(root, hist, "failure", msg, today);
      await log(`[warn] cycle failed: ${msg}`);
      // Auto-pause after N consecutive failures (ADR-0321) — write paused=true to the profile config.
      if (cfg.stopOnConsecutiveFailures > 0 && hist.consecutiveFails >= cfg.stopOnConsecutiveFailures) {
        await writeAutonomousConfig(profileDir, { ...cfg, paused: true });
        await log(`[stop] ${hist.consecutiveFails} consecutive failures → paused`);
      }
      ctx.bus.autonomousDone(false, msg);
    }
  } catch (err) {
    ctx.bus.autonomousDone(false, err instanceof Error ? err.message : String(err));
  } finally {
    running.delete(root);
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

/** Read a JSON object (`{}` on any error). */
async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * "Has work" (ADR-0319/0321): at least one APPROVED row present in a book — an approved `REQ-` in
 * USER_TODO, an approved `QA-` in USER_QA, an approved `TSK-` in AI_TODO — or AI_PROGRESS carries a task.
 */
async function hasWork(root: string): Promise<boolean> {
  const approvals = await readJsonObject(join(root, ".claude/.autonomous.approvals.json"));
  const approved = Object.entries(approvals)
    .filter(([, v]) => v && typeof v === "object" && (v as { approved?: boolean }).approved === true)
    .map(([k]) => k);
  const read = (f: string): Promise<string> => readFile(join(root, f), "utf8").catch(() => "");
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
