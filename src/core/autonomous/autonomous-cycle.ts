/**
 * Autonomous cycle runner (ADR-0319 → reworked by ADR-0371). Runs ONE unattended cycle through the
 * daemon's live WS session (profile/quota failover, metering, folder scope, run timeout). Every git step
 * runs here in code — resolve each repo's `<base>`, books-branch protection guard, sync, the books as an
 * optimistic lock on `autonomous-books/<base>` (claim / finish / release / question / split), the task branch
 * `dev/<base>/<GROUP>/<TSK>` in the root + each submodule, WIP saves, delivery (push + PRs into each
 * base). The agent only does the intake analysis, the implementation and the split analysis. A held
 * claim is re-verified during the run and on reconnect; a lost claim stops the run without pushing.
 * Intake also writes sequence diagrams + ER change requests (numbered here), a task waits for its group's
 * change request, and an implement change request / question sequence reaches the books.
 * A whole cycle is one WorkTracker lease; a run stopped by a restart drain keeps its claim.
 * @adr 0448 @adr 0452 @adr 0453 @adr 0505
 */
import { randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { logger } from "../../common/logger/logger";
import type { WsHandlerCtx } from "../ws-client/context";
import { cancelActiveRun, runAiPrompt, type AiPromptOutcome, type AiRunOverrides } from "../ws-client/command-dispatch";
import { resolveCliPrompt } from "../ai/prompt-overrides";
import { WsChannels, type AutonomousAlertPayload, type AutonomousBookGroupsReply, type AutonomousBookUsageReply } from "@4pm/ws";
import {
  BOOK_GROUPS_PER_REQUEST,
  DOCS_SIDECAR_REL,
  LINEAGE_SIDECAR_REL,
  bookGroupCode,
  bookGroupOf,
  designGroupKey,
  isDocRowId,
  parseDocsSidecar,
  parseLineage,
} from "@4pm/dto";
import { wrapUntrusted } from "@4pm/constants";
import { cappedBookIds } from "./autonomous";
import {
  booksOnlyDirsOf,
  isInQuietHours,
  readAutonomousConfig,
  repoDirsOf,
  pauseAutonomous,
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
  hasRemoteBranch,
  publishBooks,
  publishIntake,
  pushBranch,
  remoteBook,
  resolveBases,
  stripSidecarsFromBranch,
  syncBooks,
  wipCommit,
  workFingerprint,
  type RepoBase,
} from "./autonomous-git";
import { agentEvidence, listMockups } from "./autonomous-evidence";
import {
  applyClaim,
  applyFinish,
  applyQuestion,
  applyRelease,
  applySplit,
  applyUnapprovedRelease,
  applyBlockedRelease,
  applyUnblock,
  dropClaim,
  anyWaiting,
  approvedIds,
  claimState,
  foldTaskAnswers,
  intakeIds,
  isSplitChild,
  pickTask,
  previousTaskText,
  readLocalClaim,
  stillApproved,
  booksBranch,
  taskBranch,
  writeLocalClaim,
  waitingCounts,
  type Candidate,
  type LocalClaim,
  type WaitingCounts,
} from "./autonomous-tasks";
import { autoResolveOnePr } from "./autonomous-pr-resolve";
import { autoCleanupBranches, pruneDeletedLocals } from "./autonomous-branches";
import { concludeMerge, conflictResolved, directMerge, mergeRefs, mergesCleanly, resetToHead } from "./autonomous-merge";
import { applyIntakeClaim, intakeClaimTtlMinutes, intakeHeldByOthers, releaseIntakeClaim, type IntakeClaim } from "./autonomous-intake-claims";
import { branchProtection } from "../git/git-host";
import { readProfileConfig } from "../../config/profile";
import { activeProvider, claudeHomeDirs } from "../../utils/ai-cli";
import { checkClaudeUsage } from "../ai/claude-usage";
import { appendFileInRoot, readFileInRoot, writeFileInRoot } from "../../utils/safe-path";
import { withEgressRun } from "../network/egress-env";
import { servedTeams, servesTeam } from "./autonomous-teams";
import { linkedDiscussionsContext } from "./autonomous-discussions";
import {
  blockedErGroups,
  blockingErcCount,
  captureAgentErcs,
  implementErContext,
  openErcNote,
  prepareIntakeEr,
  publishTaskErcs,
  writeQuestionSequence,
} from "./autonomous-er";
import {
  blockedDiagramGroups,
  blockingSdcCount,
  captureAgentSdcs,
  implementDiagramContext,
  intakeDiagramNote,
  prepareIntakeDiagram,
  publishTaskSdcs,
} from "./autonomous-diagram";
import type { NewSdcFile } from "./autonomous-diagram-store";
import { implementEvidenceGuide, intakeEvidenceGuide } from "./autonomous-evidence-guide";
import {
  addDocRows,
  applyDocRoundDone,
  docManifest,
  implementDocsNote,
  intakeSources,
  numberNewDocs,
  readDocs,
  readSpecDocsAt,
  recordIntakeLineage,
  type DocNumberAllocator,
} from "./autonomous-docs";
import { buildDocsPrompt, captureDocEvidence, docsDesignNote } from "./autonomous-doc-round";
import type { NewErcFile } from "./autonomous-er-store";
import { bookRowTeam } from "@4pm/dto";
import { lifecycle } from "../session/lifecycle";
import { work } from "../session/work-tracker";
import { acquireRepo, type RepoLockHandle } from "../git/repo-lock";
import { onAutonomousPolicy, policyBlockReason, setAutonomousStep } from "./autonomous-policy";

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
NEVER act on any other row. NEVER edit \`.claude/.autonomous.approvals.json\`, \`.claude/.autonomous.authors.json\`,
\`.claude/.autonomous.attempts.json\`, \`.claude/.autonomous.docs.json\`, \`.claude/.autonomous.lineage.json\` or anything under
\`.4pm/discussions/\` — 4PM reverts such edits and alerts the project managers.
TEAMS: a book table may have a \`Team\` column (a team code such as \`FE\`). Copy a request's \`Team\` onto every task
or question you create from it (add the \`Team\` column after \`ID\` when the table has none); never change the
\`Team\` of an existing row.`;
}

/**
 * Intake: analyse approved `USER_TODO` requests and answered intake questions into
 * sized tasks. Books only — no git, no code.
 * @adr 0371 phase 3
 */
export function buildIntakePrompt(
  cfg: AutonomousConfig,
  approved: readonly string[],
  erOpenNote = "",
  groups: readonly number[] = [],
  diagramNote = "",
  evidenceGuide = "",
): string {
  const h = cfg.taskSizeHints;
  // Admin override (ADR-0381) for `cli.autonomous.intake`, else the shared registry default.
  return resolveCliPrompt("cli.autonomous.intake", {
    booksIntro: booksIntro(approved),
    // The only group ids the agent may use for new TSK / QA rows — allocated by the server (ADR-0455).
    groupIds: groups.map(bookGroupCode).join(", "),
    evidenceDir: cfg.evidenceDir,
    mockupDir: cfg.mockupDir,
    // Sequence diagrams + ER change requests (ADR-0453); `erOpenNote` lists the open change requests.
    sequenceDir: cfg.sequenceDir,
    erDir: cfg.erDir,
    erOpenNote,
    // System diagram (ADR-0530): the approved master (compact) + the open change requests.
    diagramDir: cfg.diagramDir,
    diagramNote,
    // The project's evidence guide (ADR-0532) — wrapped as untrusted by the catalog.
    evidenceGuide,
    sMaxFiles: h.sMaxFiles,
    sMaxLines: h.sMaxLines,
    mMaxFiles: h.mMaxFiles,
    mMaxLines: h.mMaxLines,
  });
}

/**
 * Implementation: work + test on the prepared branches; commit only. `mockups` = the intake
 * mockups of the task's group — the design reference; `design` = the task's sequence diagram and the group's
 * ER context.
 * @adr 0371 phase 6 @adr 0418 @adr 0453
 */
function buildImplementPrompt(
  mine: LocalClaim,
  subs: { dir: string; branch: string }[],
  resumed: boolean,
  cfg: AutonomousConfig,
  mockups: string[],
  design: { sequenceNote: string; erNote: string; diagramNote?: string; evidenceGuide?: string; docsNote?: string } = { sequenceNote: "", erNote: "" },
  conflicts: readonly { dir: string; paths: string[] }[] = [],
): string {
  const subLines = subs.length
    ? subs.map((s) => `- submodule \`${s.dir}\` is on branch \`${s.branch}\` — commit changes to it INSIDE \`${s.dir}\``).join("\n")
    : "- (no submodules)";
  const resumedNote = resumed
    ? "\nThis is a CONTINUATION: earlier work for this task is already committed on the branches below — review it (git log / git diff against the base) and continue from it; do not start over.\n"
    : "";
  // The newest base was merged into the branch and stopped on conflicts (ADR-0539 §2): resolve them first.
  const conflictNote = conflicts.length
    ? "\nMERGE CONFLICTS FIRST: the cli merged the latest base branch into this task branch and the merge stopped on conflicts in the files listed below (the merge is still in progress). Resolve every conflict first — keep both sides' intent, remove every conflict marker, run the tests — then commit the merge and continue the task.\n"
    : "";
  const conflictPaths = conflicts.length
    ? `${conflicts.map((c) => c.paths.map((p) => `- ${c.dir === "." ? p : `${c.dir}/${p}`}`).join("\n")).join("\n")}\n`
    : "";
  // Re-approved after an edit (ADR-0538 §5): the earlier work followed the previous text — align it first.
  const previous = resumed ? previousTaskText(mine) : "";
  const changedNote = previous
    ? "THE TASK TEXT CHANGED after that earlier work was written. Its previous version is below; first bring the existing work in line with the CURRENT task text above (drop or adapt what no longer fits), then continue.\n"
    : "";
  // Admin override (ADR-0381) for `cli.autonomous.implement`, else the shared registry default.
  return resolveCliPrompt("cli.autonomous.implement", {
    taskId: mine.id,
    group: mine.task.group,
    attempt: mine.attempt,
    // `desc`/`notes` are wrapped as the request by the registry (ADR-0421).
    desc: mine.task.desc,
    notes: mine.task.notes || "(none)",
    resumedNote: resumedNote + changedNote,
    previousTask: previous ? `${previous}\n` : "",
    conflictNote,
    conflictPaths,
    branch: mine.branch,
    subLines,
    evidenceDir: cfg.evidenceDir,
    mockupNote: mockups.length
      ? `\nUI MOCKUPS for this task's group (the design reference — follow their layout, fields and states; do not edit them):\n${mockups.map((m) => `- \`${m}\``).join("\n")}\n`
      : "",
    sequenceNote: design.sequenceNote,
    erNote: design.erNote,
    diagramNote: design.diagramNote ?? "",
    // The accepted docs of the task's request (ADR-0536).
    docsNote: design.docsNote ?? "",
    evidenceGuide: design.evidenceGuide ?? "",
    diagramDir: cfg.diagramDir,
    erDir: cfg.erDir,
    sequenceDir: cfg.sequenceDir,
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
const watch: { commandId: string | null; claim: LocalClaim | null; root: string | null; lost: boolean; unapproved: boolean } = {
  commandId: null,
  claim: null,
  root: null,
  lost: false,
  unapproved: false,
};

/** Approvals sidecar on the books branch. @adr 0438 */
const APPROVALS_REL = ".claude/.autonomous.approvals.json";

/** Was the claimed task's approval withdrawn on the remote books? False when unreadable (keep working). @adr 0538 */
async function remoteApprovalLost(root: string, claim: LocalClaim): Promise<boolean> {
  return stillApproved(await remoteBook(root, claim.base, APPROVALS_REL), claim.id) === false;
}

/**
 * Is the held claim still ours on the remote books, and is the task still approved? Lost ⇒ stop the
 * running agent (nothing pushed); unapproved ⇒ stop it too, the work is saved as WIP after the run.
 * @adr 0371 §2 @adr 0538
 */
async function verifyHeldClaim(ctx: WsHandlerCtx): Promise<void> {
  const { claim, root, commandId } = watch;
  if (!claim || !root || !commandId || watch.lost || watch.unapproved) return;
  const prog = await remoteBook(root, claim.base, "AI_PROGRESS.md");
  if (!prog) return; // unreadable (offline) — keep working, the next check / deliver re-verifies
  const row = B.parseClaims(prog).claims.find((c) => c.id === claim.id);
  if (!row || row.claim !== claim.claim) {
    watch.lost = true;
    ctx.bus.log(`autonomous: claim of ${claim.id} was taken over — stopping this run`, "warn");
    cancelActiveRun(commandId);
    return;
  }
  if (await remoteApprovalLost(root, claim)) {
    watch.unapproved = true;
    ctx.bus.log(`autonomous: ${claim.id} was unapproved — stopping this run`, "warn");
    cancelActiveRun(commandId);
  }
}

/**
 * Re-verify the held claim now: on reconnect (a worker that was offline) and on the server's
 * `autonomous.verify` nudge after an unapprove.
 * @adr 0371 @adr 0538
 */
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

/** The book group of a task / docs id (`TSK-000123-…` / `DOC-000123-…` → `TSK-000123`), "" when none. */
function taskGroup(taskId: string): string {
  return designGroupKey(taskId);
}

/**
 * Report a cycle event for automation rules over the alert channel — informational, the server
 * notifies nobody for it. Best-effort.
 * @adr 0458
 */
function emitEvent(ctx: WsHandlerCtx, type: string, task: string | undefined, fields: Record<string, string | number | boolean>): void {
  alert(ctx, { kind: "event", ...(task ? { task } : {}), message: type, event: { type, fields } });
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
 * Report a reverted sidecar edit by an agent run: a `[guard]` line in the tick log + a
 * `sidecar-tamper` alert to the project's managers.
 */
async function reportSidecarTamper(ctx: WsHandlerCtx, root: string, files: string[], task?: string): Promise<void> {
  if (files.length === 0) return;
  await dayLog(root, `[guard] ${task ? `${task}: ` : ""}agent edited ${files.join(", ")} — reverted`);
  alert(ctx, { kind: "sidecar-tamper", ...(task ? { task } : {}), message: `An agent run edited ${files.join(", ")}; the change was reverted.` });
}

/** Save + push the work in progress of a task (root + submodules) — no PR. Best-effort. */
async function pushWip(
  ctx: WsHandlerCtx,
  root: string,
  mine: LocalClaim,
  subs: { sub: RepoBase; branch: string }[],
  note: string,
  booksOnly: readonly string[] = [],
): Promise<void> {
  for (const s of subs) {
    const abs = join(root, s.sub.dir);
    if ((await currentBranch(abs)) !== s.branch) continue;
    await wipCommit(abs, `wip(${mine.id}): ${note}`);
    if ((await aheadOf(abs, s.branch, s.sub.base)) > 0) await pushBranch(abs, s.branch).catch(() => undefined);
  }
  if ((await currentBranch(root)) === mine.branch) {
    await wipCommit(root, `wip(${mine.id}): ${note}`);
    await reportSidecarTamper(ctx, root, await stripSidecarsFromBranch(root, mine.base, mine.id, booksOnly), mine.id);
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
/** The offline skip is logged once per outage, not on every tick. @adr 0505 */
let offlineLogged = false;
/** The AI run the cycle is waiting on now — cancelled when the policy turns blocking. @adr 0507 */
let currentCycleRun: string | null = null;

/** A fresh command id for a cycle AI run, remembered as the current one. */
function cycleRunId(): string {
  currentCycleRun = randomUUID();
  return currentCycleRun;
}

/** True when a cancelled run was stopped by a restart drain or a blocking policy (keep the work). @adr 0505 @adr 0507 */
function stoppedFromOutside(out: AiPromptOutcome): boolean {
  return out.cancelled && (lifecycle.stopping || policyBlockReason() !== null);
}

/**
 * Run one autonomous cycle: gates → guard (books-branch protection) → sync the books branch → resume / release a
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
  // The daemon is draining for a restart / update: start nothing (ADR-0505).
  if (lifecycle.stopping) {
    ctx.bus.autonomousDone(false, "cli restarting");
    return;
  }
  running.add(root);
  // The whole cycle — git phases included — is one WorkTracker lease, so a restart waits for it.
  const lease = work.begin("autonomousCycle", "autonomous-cycle");
  let repo: RepoLockHandle | null = null;
  const log = (line: string): Promise<void> => dayLog(root, line);
  // The policy turns blocking mid-cycle (project paused / switched off — ADR-0507): stop the AI run now.
  const offPolicy = onAutonomousPolicy(() => {
    if (policyBlockReason() && currentCycleRun) cancelActiveRun(currentCycleRun);
  });
  try {
    const cfg = await readAutonomousConfig(profileDir);
    await pruneLogs(root, cfg.logRetentionDays);
    const today = new Date().toISOString().slice(0, 10);
    const worker = ctx.machineUsername || "worker";

    // --- Preconditions + cheap gates (no token spend) ------------------------------------------
    if (!ctx.isReady) {
      if (!offlineLogged) await log("[skip] cli offline (no WS connection)");
      offlineLogged = true;
      ctx.bus.autonomousDone(false, "cli offline");
      return;
    }
    offlineLogged = false;
    if (cfg.paused) {
      await log("[skip] paused");
      ctx.bus.autonomousDone(false, "paused");
      return;
    }
    // The server's policy (ADR-0507): the project switch and this worker's `allowed`.
    const blocked = policyBlockReason();
    if (blocked) {
      await log(blocked === "projectDisabled" ? "[skip] autonomous paused for the project" : `[skip] not allowed by the server (${blocked})`);
      ctx.bus.autonomousDone(false, `policy: ${blocked}`);
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
    // The books live on `autonomous-books/<base>` of the root (ADR-0448): `<base>` may be protected (it
    // only changes through PRs), but the books branch must accept the worker's pushes.
    const books = booksBranch(rootBase.base);
    if (rootBase.url && (await branchProtection(rootBase.url, books)) === true) {
      await log(`[stop] books branch "${books}" is protected — the books cannot be pushed`);
      alert(ctx, { kind: "books-protected", repo: "root", branch: books, message: `The books branch "${books}" is protected; autonomous cannot record its tasks there.` });
      await recordRun(root, hist, "skip", `books-protected: ${books}`, today); // surfaced as status.booksProtected
      ctx.bus.autonomousDone(false, "books branch protected");
      return;
    }

    // --- The repo lock (ADR-0506): from Sync to its last publish the cycle owns the working tree; Console
    // runs, git writes and clones wait in the lock's FIFO meanwhile.
    try {
      repo = await acquireRepo(root, { holder: "autonomous", label: "autonomous-cycle" });
    } catch (err) {
      await log(`[skip] project working tree busy (${err instanceof Error ? err.message : String(err)})`);
      ctx.bus.autonomousDone(false, "working tree busy");
      return;
    }

    // --- Phase 1: sync the books branch (current books + current <base>) -------------------------
    const stashed = await syncBooks(root, rootBase.base);
    if (stashed) {
      await log(`[autosave] uncommitted changes were stashed as "${stashed}"`);
      alert(ctx, { kind: "autosave", message: `Uncommitted changes in the project folder were stashed by the autonomous cycle as "${stashed}" (git stash list).` });
    }

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

    // --- Daily cleanup of dead 4PM task branches (ADR-0540) — once per UTC day across the workers ---
    await autoCleanupBranches(root, rootBase, bases.subs, cfg.branchCleanup, log).catch((e) => log(`[warn] branch cleanup: ${String(e)}`));
    // Local copies of branches deleted from another worker go too (when safe).
    await pruneDeletedLocals(root, rootBase, bases.subs).catch(() => undefined);

    // --- Auto-resolve one conflicting 4PM PR before any new work (ADR-0539 §5) ---------------------
    if (!mine && cfg.autoResolvePrConflicts && !(await allAiProfilesExhausted(ctx, cfg))) {
      if (await autoResolveOnePr(ctx, root, rootBase, worker, cfg.runTimeoutMinutes * 60_000, log)) {
        ctx.bus.autonomousDone(true, "pr resolve");
        return;
      }
    }

    // --- Has work? + quota gate ----------------------------------------------------------------
    if (!mine && !(await hasWork(root, profileDir))) {
      // Nothing runnable — but rows may be waiting on people (approval, ER, answers, dependencies — ADR-0529).
      const waiting = await waitingNow(root, profileDir, cfg);
      if (anyWaiting(waiting)) {
        await log(`[skip] waiting for people (${waitingText(waiting)})`);
        ctx.bus.autonomousDone(false, "waiting", { waiting });
      } else {
        await log("[skip] no approved USER_TODO/USER_QA/AI_TODO work");
        ctx.bus.autonomousDone(false, "no work");
      }
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
    setAutonomousStep("cycle");

    // The folders committed with the books: evidence roots + mockups (ADR-0418).
    const dirs = repoDirsOf(cfg);
    let resumed = !!mine;
    // What this cycle's intake produced / who holds the wanted intake ids — for the Last check (ADR-0529).
    let intakeDone: IntakeProduced | null = null;
    let intakeTakenBy: string | null = null;
    // The books whose subscription limit held back an intake this cycle — named in every Last check (ADR-0541).
    let capReached: ("AI_TODO" | "USER_QA")[] = [];
    const capDetail = (): { capReached?: ("AI_TODO" | "USER_QA")[] } => (capReached.length ? { capReached } : {});
    if (!mine) {
      // --- Fold answered task questions into their tasks (cli) ------------------------------------
      const folded = await publishBooks(root, rootBase.base, "chore(auto): fold answered task questions", () => foldTaskAnswers(root));
      if (folded === "pushed") await log("[fold] task-question answers folded into their tasks");

      // --- Phase 3: intake (agent) --------------------------------------------------------------
      const usage = await readBookUsage(ctx);
      const capped = (["AI_TODO", "USER_QA"] as const).filter((b) => {
        const c = usage?.books[b];
        return !!c && c.limit !== null && c.used >= c.limit;
      });
      const intakeBlocked = capped.length > 0;
      const wanted = intakeBlocked ? [] : await intakeIds(root, profileDir);
      if (intakeBlocked) {
        await log(`[cap] monthly ${capped.join("/")} limit reached — intake skipped this cycle`);
        // Requests wait only because of the subscription limit: say so to the managers + in the Last check (ADR-0541).
        const waitingIntake = await intakeIds(root, profileDir);
        if (waitingIntake.length) {
          capReached = [...capped];
          alert(ctx, {
            kind: "book-cap",
            message: `The monthly limit of new ${capped.join(" / ")} rows of the subscription is reached — ${waitingIntake.length} request(s) / answer(s) wait for intake until the reset or an upgrade.`,
          });
        }
      }
      else if (wanted.length > 0) {
        // Claim the ids in AI_PROGRESS first (ADR-0529): ids another worker is taking in are skipped, and a
        // lost race costs neither an agent run nor server group ids.
        const intakeTtl = intakeClaimTtlMinutes(cfg.runTimeoutMinutes);
        const held = intakeHeldByOthers(await B.readBook(root, "AI_PROGRESS.md"), worker, intakeTtl);
        const free = wanted.filter((id) => !held.has(id)).slice(0, BOOK_GROUPS_PER_REQUEST);
        if (free.length === 0) {
          intakeTakenBy = held.get(wanted[0]!) ?? null;
          await log(`[intake] ${wanted.join(", ")} already taken in by ${[...new Set(wanted.map((id) => held.get(id)))].join(", ")}`);
        } else {
          const [userTodoNow, userQaNow] = await Promise.all([B.readBook(root, "USER_TODO.md"), B.readBook(root, "USER_QA.md")]);
          const teamOf = (id: string): string => bookRowTeam(id.startsWith("REQ-") ? userTodoNow : userQaNow, id);
          const intakeClaim: IntakeClaim = { claim: randomUUID(), worker, started: B.stamp(), ids: [] };
          const claimed = await publishBooks(
            root,
            rootBase.base,
            () => `chore(auto): intake ${intakeClaim.ids.join(", ")} claimed by ${worker}`,
            () => applyIntakeClaim(root, free, intakeClaim, intakeTtl, teamOf),
          );
          if (claimed !== "pushed") {
            await log(`[intake] could not claim ${free.join(", ")} (${claimed}) — skipped this cycle`);
          } else {
            await log(`[intake] claimed ${intakeClaim.ids.join(", ")}`);
            setAutonomousStep("intake", intakeClaim.ids);
            try {
              const res = await runIntake(ctx, root, rootBase.base, cfg, intakeClaim.ids, dirs, log);
              if (res.stop) {
                ctx.bus.autonomousDone(false, res.stop);
                return;
              }
              intakeDone = res.produced;
            } finally {
              // The claim rows go in their own commit (success or not): removing them inside the intake commit
              // would conflict with a task claim pushed meanwhile and discard the whole intake.
              await releaseIntakeClaim(root, rootBase.base, intakeClaim);
              setAutonomousStep("cycle");
            }
          }
        }
        await syncBooks(root, rootBase.base);
      }

      // --- Phase 4: claim (race-safe) -----------------------------------------------------------
      // A conflict-blocked task whose branch merges cleanly again is released for picking (ADR-0539 §2).
      await unblockCleanMerges(root, rootBase.base).catch((e) => log(`[warn] unblock check: ${String(e)}`));
      const skip = new Set<string>();
      for (let i = 0; i < 5 && !mine; i++) {
        // A group whose ER change request is not applied yet waits (ADR-0453).
        // … and so does one whose system-diagram change request is not applied yet (ADR-0530).
        const blockedGroups = new Set([
          ...(await blockedErGroups(root, cfg.erDir).catch(() => new Set<string>())),
          ...(await blockedDiagramGroups(root, cfg.diagramDir).catch(() => new Set<string>())),
        ]);
        const cand: Candidate | null = await pickTask(root, rootBase, { worker, ttlHours: cfg.claimTtlHours, maxAttempts: cfg.maxTaskAttempts, skip, profileDir, blockedGroups });
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
          // The text the branch's earlier work followed (ADR-0538); a take-over continues the same claim's text.
          ...(!cand.takeover && attempts[cand.task.id]?.task ? { prevTask: attempts[cand.task.id]!.task } : {}),
        };
        const res = await publishBooks(root, rootBase.base, `chore(auto): claim ${cand.task.id} by ${worker}`, () =>
          applyClaim(root, cand, claim, cfg.claimTtlHours),
        );
        if (res === "pushed") {
          mine = { ...claim, from: cand.from };
          await writeLocalClaim(profileDir, mine);
          await log(`[claim] ${mine.id}${cand.takeover ? ` (taken over from ${cand.takeover.worker})` : ""} attempt ${mine.attempt}`);
          emitEvent(ctx, "task.claimed", mine.id, { taskId: mine.id, group: taskGroup(mine.id), attempt: mine.attempt });
        } else skip.add(cand.task.id);
      }
      if (!mine) {
        const waiting = await waitingNow(root, profileDir, cfg);
        await log(`[idle] no eligible task (${anyWaiting(waiting) ? `waiting for people: ${waitingText(waiting)}` : "waiting for dependencies"})`);
        hist = await readHistories(root);
        await recordRun(root, hist, "success", "no eligible task", today);
        // The Last check names what happened (ADR-0529): the intake's result, else why nothing could be claimed.
        if (intakeDone) ctx.bus.autonomousDone(true, "intake done", { intake: intakeDone, waiting, ...capDetail() });
        else if (intakeTakenBy && !anyWaiting(waiting)) ctx.bus.autonomousDone(false, "intake taken", { by: intakeTakenBy, ...capDetail() });
        else ctx.bus.autonomousDone(true, "idle", { waiting, ...capDetail() });
        return;
      }
      resumed = false;
    }

    // --- Phase 5: task branches (root + submodules) --------------------------------------------
    repo.setTask(mine.id); // waiters see which task holds the tree
    setAutonomousStep("cycle", [mine.id]);
    const from = mine.from ?? null;
    await checkoutTaskBranch(root, mine.branch, rootBase.base, from);
    const hadWork = (await aheadOf(root, mine.branch, rootBase.base)) > 0;
    await gitQuiet(root, ["submodule", "update", "--init", "-q"], 300_000);
    // A DOC round writes the root's docs only — no submodule branches (ADR-0536).
    const isDoc = isDocRowId(mine.id);
    const subs = isDoc ? [] : subBranches(bases.subs, mine.id, from);
    for (const s of subs) await checkoutTaskBranch(join(root, s.sub.dir), s.branch, s.sub.base, s.from).catch((e) => log(`[warn] submodule ${s.sub.dir}: ${String(e)}`));

    // A resumed claim may have been unapproved while this worker was away (ADR-0538): stop before running.
    if (await remoteApprovalLost(root, mine)) {
      await stopUnapproved(ctx, root, rootBase, subs, mine, cfg, log);
      return;
    }

    // --- Phase 5b: a resumed branch takes the newest <base> first (ADR-0539 §1) -----------------
    const conflicts = await syncResumedBranches(root, rootBase, subs, mine, hadWork, log);

    // --- Phase 6: implement (agent) — or a docs round for a DOC row (ADR-0536) — claim watched ----
    const commandId = cycleRunId();
    setAutonomousStep(isDoc ? "docs" : "implement", [mine.id]);
    Object.assign(watch, { commandId, claim: mine, root, lost: false, unapproved: false });
    // Work state before the run: a timeout is judged by whether it changed (ADR-0452).
    const workDirs = [root, ...subs.map((s) => join(root, s.sub.dir))];
    const workBefore = await workFingerprint(workDirs);
    const timer = setInterval(() => void verifyHeldClaim(ctx).catch(() => undefined), cfg.claimCheckMinutes * 60_000);
    timer.unref?.();
    let out: AiPromptOutcome;
    try {
      if (isDoc) {
        out = await withEgressRun({ taskId: mine.id }, async () =>
          runAiPrompt(ctx, await docsRoundPrompt(root, rootBase.base, cfg, mine!, conflicts), commandId, "local", false, undefined, undefined, false, true, runOverrides(cfg)),
        );
      } else {
        // The intake mockups of this task's group (`<mockupDir>/TSK-<group>--*.html` — ADR-0418).
        const group = /^(TSK-\d{6})-/.exec(mine.id)?.[1] ?? "";
        const mockups = group ? (await listMockups(root, rootBase.base, cfg.mockupDir).catch(() => [])).filter((m) => m.split("/").pop()?.startsWith(`${group}--`)) : [];
        // The task's sequence diagram + the group's ER, read from the books branch (ADR-0453).
        const design = await implementErContext(root, rootBase.base, cfg, mine.id).catch(() => ({ sequenceNote: "", erNote: "" }));
        // The group's system-diagram changes (ADR-0530).
        const diagramNote = await implementDiagramContext(root, rootBase.base, cfg.diagramDir, group).catch(() => "");
        // The accepted docs of the task's request (ADR-0536) — on the DOC branch the task started from.
        const docsNote = implementDocsNote(parseDocsSidecar(await remoteBook(root, rootBase.base, DOCS_SIDECAR_REL)), mine.id);
        // The project's evidence guide, reduced to what this task produces (ADR-0532).
        const evidenceGuide = await implementEvidenceGuide(root, rootBase.base, {
          mockups: mockups.length > 0,
          sequence: Boolean(design.sequenceNote),
          er: Boolean(design.erNote),
          diagram: Boolean(diagramNote),
        }).catch(() => "");
        const prompt = buildImplementPrompt(
          mine,
          subs.map((s) => ({ dir: s.sub.dir, branch: s.branch })),
          resumed || hadWork,
          cfg,
          mockups,
          { ...design, diagramNote, evidenceGuide, docsNote },
          conflicts.map((c) => ({ dir: c.dir, paths: c.paths })),
        );
        // No model override: each AI profile's own model applies (ADR-0418).
        // Egress (ADR-0439): the run's connections are logged under this task.
        out = await withEgressRun({ taskId: mine.id }, () => runAiPrompt(ctx, prompt, commandId, "local", false, undefined, undefined, false, true, runOverrides(cfg)));
      }
    } finally {
      clearInterval(timer);
      setAutonomousStep("cycle", [mine.id]);
    }
    const lost = watch.lost;
    const unapproved = watch.unapproved;
    Object.assign(watch, { commandId: null, claim: null, root: null, lost: false, unapproved: false });
    // The agent must stay on the prepared branches — put them back if it wandered.
    if ((await currentBranch(root)) !== mine.branch) await gitQuiet(root, ["checkout", "-q", mine.branch]);
    // The resume merge (ADR-0539 §2): kept when the agent resolved it, else back to the pre-merge WIP.
    let unresolved = false;
    for (const c of conflicts) {
      if (await conflictResolved(c.cwd, c.paths)) await concludeMerge(c.cwd).catch((e) => log(`[warn] ${c.dir}: merge commit failed: ${String(e)}`));
      else {
        await resetToHead(c.cwd, c.head).catch((e) => log(`[warn] ${c.dir}: reset failed: ${String(e)}`));
        unresolved = true;
      }
    }

    if (lost) {
      // --- Phase 9: lost the claim mid-run — push nothing -------------------------------------
      await log(`[lost] ${mine.id} was taken over while running — stopped, nothing pushed`);
      alert(ctx, { kind: "claim-lost", task: mine.id, message: `${worker} lost its claim of ${mine.id} while working; its work was not pushed.` });
      await writeLocalClaim(profileDir, null);
      await syncBooks(root, rootBase.base);
      ctx.bus.autonomousDone(false, "claim lost");
      return;
    }
    if (unapproved) {
      await stopUnapproved(ctx, root, rootBase, subs, mine, cfg, log);
      return;
    }
    if (unresolved && !out.exhausted && !stoppedFromOutside(out)) {
      await blockForConflict(ctx, root, rootBase, subs, mine, cfg, log);
      return;
    }
    if (stoppedFromOutside(out)) {
      // Stopped by the restart drain (ADR-0505) or a blocking policy (ADR-0507): like running out of time —
      // keep the claim + save the work; the next allowed cycle resumes it. Not a failure, no attempt counted.
      const why = lifecycle.stopping ? "cli restart" : "autonomous paused";
      for (const s of subs) await wipCommit(join(root, s.sub.dir), `wip(${mine.id}): ${why}`);
      await wipCommit(root, `wip(${mine.id}): ${why}`);
      await log(`[wait] ${mine.id}: ${why} — claim kept, resumes later`);
      ctx.bus.autonomousDone(false, `${why} — task kept`);
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
    const reply = parseJsonReply<{ status?: string; summary?: string; question?: string; sequence?: string }>(out.output);
    const status = out.cancelled ? "failed" : out.exitCode !== 0 ? "failed" : (reply?.status ?? "failed");

    if (status === "needs-input") {
      await pushWip(ctx, root, mine, subs, "waiting for an answer", booksOnlyDirsOf(cfg));
      await syncBooks(root, rootBase.base);
      const question = reply?.question?.trim() || reply?.summary?.trim() || "The agent needs a decision to continue.";
      let qaId: string | null = null;
      await publishBooks(
        root,
        rootBase.base,
        `chore(auto): ${mine.id} asks a question`,
        async () => {
          qaId = await applyQuestion(root, mine!, question);
          // The sequence diagram the agent returned with its question (ADR-0453).
          if (qaId) await writeQuestionSequence(root, cfg.sequenceDir, qaId, reply?.sequence);
          return qaId !== null;
        },
        { dirs },
      );
      await writeLocalClaim(profileDir, null);
      await log(`[question] ${mine.id} parked on ${qaId ?? "?"}`);
      alert(ctx, { kind: "task-question", task: mine.id, message: `${mine.id} waits for an answer (${qaId ?? "QA"}): ${question.slice(0, 200)}` });
      hist = await readHistories(root);
      await recordRun(root, hist, "success", `${mine.id} needs input`, today);
      ctx.bus.autonomousDone(true, "task question", { taskId: mine.id, ...(intakeDone ? { intake: intakeDone } : {}), ...capDetail() });
      return;
    }
    if (status !== "done") {
      // A timeout that changed the work state is progress, not a broken worker: it counts an attempt
      // but not towards auto-pause (ADR-0452). Judged before the release commits the WIP.
      const timedOut = out.timedOut && !out.cancelled;
      const progressed = timedOut && (await workFingerprint(workDirs)) !== workBefore;
      const reason = timedOut
        ? `timed out after ${cfg.runTimeoutMinutes} min (${progressed ? "progress kept" : "no progress"})`
        : reply?.summary?.trim() || (out.cancelled ? "run stopped" : `agent run failed (exit ${out.exitCode})`);
      await releaseTask(ctx, root, rootBase, bases.subs, mine, reason, cfg);
      emitEvent(ctx, timedOut ? "task.timeout" : "task.failed", mine.id, { taskId: mine.id, group: taskGroup(mine.id), reason: reason.slice(0, 300) });
      hist = await readHistories(root);
      if (!progressed) hist.consecutiveFails += 1;
      await recordRun(root, hist, "failure", `${mine.id}: ${reason}`, today);
      await maybeAutoPause(root, profileDir, cfg, hist, log, (reason) => {
        emitEvent(ctx, "cycle.paused", undefined, { reason });
        alert(ctx, { kind: "auto-paused", message: `${worker} paused its autonomous mode after ${reason}.` });
      });
      ctx.bus.autonomousDone(false, reason);
      return;
    }

    // --- A docs round ends in review, never in a delivery (ADR-0536) ----------------------------
    if (isDoc) {
      await finishDocRound(ctx, root, rootBase, mine, cfg, reply?.summary ?? "", log, capDetail());
      return;
    }

    // --- Phase 7: deliver (verify the claim first) ---------------------------------------------
    if (await remoteClaimLost(root, mine)) {
      await log(`[lost] ${mine.id} was taken over before delivery — nothing pushed`);
      alert(ctx, { kind: "claim-lost", task: mine.id, message: `${worker} lost its claim of ${mine.id} before delivering.` });
      await writeLocalClaim(profileDir, null);
      await syncBooks(root, rootBase.base);
      ctx.bus.autonomousDone(false, "claim lost");
      return;
    }
    // The run may end before the next approval check: re-check once before anything is delivered (ADR-0538).
    if (await remoteApprovalLost(root, mine)) {
      await stopUnapproved(ctx, root, rootBase, subs, mine, cfg, log);
      return;
    }
    setAutonomousStep("deliver", [mine.id]);
    let delivered: { files: string; notes: string; evidence: string[]; ercs: NewErcFile[]; sdcs: NewSdcFile[]; prUrl?: string };
    try {
      delivered = await deliver(ctx, root, rootBase, subs, mine, reply?.summary ?? "", cfg);
    } catch (err) {
      const reason = `delivery failed: ${String(err instanceof Error ? err.message : err)}`;
      await releaseTask(ctx, root, rootBase, bases.subs, mine, reason, cfg);
      emitEvent(ctx, "task.failed", mine.id, { taskId: mine.id, group: taskGroup(mine.id), reason: reason.slice(0, 300) });
      ctx.bus.autonomousDone(false, reason);
      return;
    }

    if (delivered.prUrl) {
      emitEvent(ctx, "task.delivered", mine.id, { taskId: mine.id, group: taskGroup(mine.id), prUrl: delivered.prUrl, branch: mine.branch });
      emitEvent(ctx, "pr.opened", mine.id, { repo: "root", prUrl: delivered.prUrl, branch: mine.branch, taskId: mine.id });
    }

    // --- Phase 8: finish -----------------------------------------------------------------------
    await syncBooks(root, rootBase.base);
    let taskErcs: string[] = [];
    let taskSdcs: string[] = [];
    const fin = await publishBooks(
      root,
      rootBase.base,
      `chore(auto): finish ${mine.id}`,
      async () => {
        if (!(await applyFinish(root, mine!, delivered, cfg.evidenceDir))) return false;
        // The agent's change request goes to the books for approval (ADR-0453).
        taskErcs = await publishTaskErcs(root, cfg.erDir, delivered.ercs, mine!.id, mine!.task.team, cfg.erAutoApprove);
        // … and so does its system-diagram change (applied at once under auto-approve — ADR-0530).
        taskSdcs = await publishTaskSdcs(root, cfg, delivered.sdcs, mine!.id, mine!.task.team);
        return true;
      },
      { dirs },
    );
    if (taskErcs.length) await log(`[er] ${mine.id} proposed ${taskErcs.join(", ")}`);
    if (taskSdcs.length) await log(`[diagram] ${mine.id} proposed ${taskSdcs.join(", ")}`);
    await writeLocalClaim(profileDir, null);
    await log(`[done] ${mine.id} — ${delivered.notes} (${fin})`);
    emitEvent(ctx, "task.done", mine.id, { taskId: mine.id, group: taskGroup(mine.id), prUrl: delivered.prUrl ?? "" });
    hist = await readHistories(root);
    hist.consecutiveFails = 0;
    await recordRun(root, hist, "success", `${mine.id} delivered`, today);
    ctx.bus.autonomousDone(true, "task done", { taskId: mine.id, ...(intakeDone ? { intake: intakeDone } : {}), ...capDetail() });
  } catch (err) {
    await dayLog(root, `[warn] cycle error: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
    ctx.bus.autonomousDone(false, err instanceof Error ? err.message : String(err));
  } finally {
    setAutonomousStep(null);
    offPolicy();
    currentCycleRun = null;
    repo?.release();
    running.delete(root);
    lease.end();
  }
}

/** Is the claim gone from the REMOTE books (read without leaving the task branch)? Unknown ⇒ false. */
async function remoteClaimLost(root: string, mine: LocalClaim): Promise<boolean> {
  const prog = await remoteBook(root, mine.base, "AI_PROGRESS.md");
  if (!prog) return false; // unreadable — the finish step re-verifies on the books branch
  const row = B.parseClaims(prog).claims.find((c) => c.id === mine.id);
  return !row || row.claim !== mine.claim;
}

/**
 * Merge the newest `<base>` into a finished branch just before it is delivered (the base may have moved during
 * the run). Clean ⇒ committed, true; conflict ⇒ the merge is aborted and false (the work is delivered as a PR
 * that shows the conflict).
 * @adr 0539 §3
 */
async function syncBeforeDelivery(cwd: string, base: string, taskId: string): Promise<boolean> {
  await gitQuiet(cwd, ["fetch", "-q", "origin", base]);
  try {
    const res = await mergeRefs(cwd, [`origin/${base}`], `Merge ${base} into ${taskId} (4PM autonomous)`);
    if (res.kind === "clean") return true;
  } catch {
    /* not a conflict — deliver as it is */
    return true;
  }
  await gitQuiet(cwd, ["merge", "--abort"]);
  return false;
}

/**
 * Deliver: in each submodule then the root, commit leftovers, merge the newest base, push the task
 * branch and either open its PR into the base, or — with `skipPullRequest` — merge it `--no-ff` straight into the
 * base (the root's submodule links move to the submodules' merge commits). A conflict before delivery, or a direct
 * merge that fails, falls back to a PR. Returns the AI_DONE Files + Notes.
 * @adr 0371 phase 7 @adr 0539
 */
async function deliver(
  ctx: WsHandlerCtx,
  root: string,
  rootBase: RepoBase,
  subs: { sub: RepoBase; branch: string }[],
  mine: LocalClaim,
  summary: string,
  cfg: AutonomousConfig,
): Promise<{ files: string; notes: string; evidence: string[]; ercs: NewErcFile[]; sdcs: NewSdcFile[]; prUrl?: string }> {
  const evRoot = cfg.evidenceDir;
  const title = `${mine.id}: ${mine.task.desc}`.replace(/\s+/g, " ").slice(0, 100);
  const mergeMessage = `Merge ${mine.id} (4PM autonomous): ${mine.task.desc}`.replace(/\s+/g, " ").slice(0, 200);
  const subPrs: string[] = [];
  const pointers: { dir: string; sha: string }[] = [];
  // Conflicts with the base found just before delivery (ADR-0539 §3) — those repos go out as PRs.
  const conflicted: string[] = [];
  // A direct merge that fell back to a PR (ADR-0539 §4).
  const fallbacks: string[] = [];
  let direct = cfg.skipPullRequest;
  for (const s of subs) {
    const abs = join(root, s.sub.dir);
    if ((await currentBranch(abs)) !== s.branch) continue;
    await wipCommit(abs, `feat(${mine.id}): ${summary || mine.task.desc}`.slice(0, 200));
    if ((await aheadOf(abs, s.branch, s.sub.base)) === 0) continue;
    if (!(await syncBeforeDelivery(abs, s.sub.base, mine.id))) conflicted.push(s.sub.dir);
    await pushBranch(abs, s.branch);
    if (direct && !conflicted.includes(s.sub.dir)) {
      const merged = await directMerge(abs, s.branch, s.sub.base, mergeMessage);
      if (merged.ok) {
        pointers.push({ dir: s.sub.dir, sha: merged.sha });
        subPrs.push(`${s.sub.dir}: merged ${merged.sha.slice(0, 10)}`);
        continue;
      }
      fallbacks.push(`${s.sub.dir} (${merged.reason})`);
    }
    // A submodule on a PR ⇒ the root goes out as a PR too (its pointer would not be on the submodule's base).
    direct = false;
    const pr = await deliverPr(abs, s.sub.url, s.branch, s.sub.base, title, `${summary}\n\nTask ${mine.id} (4PM autonomous).`);
    if (pr.error) throw new Error(`submodule ${s.sub.dir} PR: ${pr.error}`);
    subPrs.push(`${s.sub.dir}: ${pr.url ?? s.branch}`);
  }
  // Root: pointer bumps + any uncommitted leftovers, then push + PR / merge.
  await wipCommit(root, `feat(${mine.id}): ${summary || mine.task.desc}`.slice(0, 200));
  // The agent's change requests travel to the books, never to `<base>` (ADR-0453) — read them before the strip.
  const ercs = await captureAgentErcs(root, cfg.erDir);
  const sdcs = await captureAgentSdcs(root, cfg.diagramDir);
  // The agent's own commits may carry sidecar edits — restore them before the push / PR (ADR-0438); the ER +
  // sequence folders are books-only (ADR-0453). An edit there other than a new change request is reported.
  const stripped = await stripSidecarsFromBranch(root, rootBase.base, mine.id, booksOnlyDirsOf(cfg));
  await reportSidecarTamper(
    ctx,
    root,
    stripped.filter((p) => !(ercs.length && p === cfg.erDir) && !(sdcs.length && p === cfg.diagramDir)),
    mine.id,
  );
  // The agent's own evidence on the task branch (ADR-0404) — listed in AI Done's Evidence column.
  const evidence = await agentEvidence(root, mine.id, evRoot);
  if ((await aheadOf(root, mine.branch, rootBase.base)) === 0) {
    return { files: "", notes: `no changes needed; branch: ${mine.branch}${subPrs.length ? `; submodules: ${subPrs.join(", ")}` : ""}`, evidence: [], ercs, sdcs };
  }
  if (!(await syncBeforeDelivery(root, rootBase.base, mine.id))) conflicted.push(".");
  const files = (await gitQuiet(root, ["diff", "--name-only", `origin/${rootBase.base}...${mine.branch}`])).split("\n").filter(Boolean);
  const filesCell = files.slice(0, 20).join(", ") + (files.length > 20 ? ` (+${files.length - 20})` : "");
  await pushBranch(root, mine.branch);
  if (conflicted.length) {
    alert(ctx, { kind: "pr-conflict", task: mine.id, message: `${mine.id} conflicts with the base in ${conflicted.join(", ")} — delivered as a PR.` });
  }
  if (direct && !conflicted.length) {
    const merged = await directMerge(root, mine.branch, rootBase.base, mergeMessage, pointers);
    if (merged.ok) {
      return {
        files: filesCell,
        notes: `merged into ${rootBase.base}: ${merged.sha.slice(0, 10)}; branch: ${mine.branch}${subPrs.length ? `; submodules: ${subPrs.join(", ")}` : ""}`,
        evidence,
        ercs,
        sdcs,
      };
    }
    fallbacks.push(`root (${merged.reason})`);
  }
  if (fallbacks.length) {
    alert(ctx, { kind: "direct-merge-failed", task: mine.id, message: `${mine.id} could not be merged directly (${fallbacks.join(", ")}) — a PR was opened instead.` });
  }
  const body = `${summary}\n\nTask ${mine.id} (4PM autonomous).${subPrs.length ? `\n\nSubmodules:\n${subPrs.map((p) => `- ${p}`).join("\n")}` : ""}`;
  const pr = await deliverPr(root, rootBase.url, mine.branch, rootBase.base, title, body);
  if (pr.error) throw new Error(`PR: ${pr.error}`);
  const notes = [
    `branch: ${mine.branch}; PR: ${pr.url ?? "opened"}`,
    ...(subPrs.length ? [`submodules: ${subPrs.join(", ")}`] : []),
    ...(conflicted.length ? [`PR conflicts with ${rootBase.base} (${conflicted.join(", ")})`] : []),
    ...(fallbacks.length ? [`direct merge failed: ${fallbacks.join(", ")}`] : []),
  ].join("; ");
  return { files: filesCell, notes, evidence, ercs, sdcs, ...(pr.url ? { prUrl: pr.url } : {}) };
}

/** One repo whose resume merge stopped on conflicts: where, its pre-merge head, the conflicted paths. */
interface ResumeConflict {
  cwd: string;
  /** "." for the root, else the submodule folder. */
  dir: string;
  head: string;
  paths: string[];
}

/**
 * Merge the newest `<base>` (and an unmerged dependency branch) into every task branch that already holds work —
 * the root and each submodule — before the agent runs. Merge, never rebase: the WIP is shared on the remote. A
 * clean merge is committed; a conflict is left in progress for the agent and returned.
 * @adr 0539 §1
 */
async function syncResumedBranches(
  root: string,
  rootBase: RepoBase,
  subs: { sub: RepoBase; branch: string; from: string | null }[],
  mine: LocalClaim,
  rootHasWork: boolean,
  log: (l: string) => Promise<void>,
): Promise<ResumeConflict[]> {
  const repos: { cwd: string; dir: string; base: string; branch: string; from: string | null; hasWork: boolean }[] = [
    { cwd: root, dir: ".", base: rootBase.base, branch: mine.branch, from: mine.from ?? null, hasWork: rootHasWork },
    ...subs.map((s) => ({ cwd: join(root, s.sub.dir), dir: s.sub.dir, base: s.sub.base, branch: s.branch, from: s.from, hasWork: false })),
  ];
  const out: ResumeConflict[] = [];
  for (const r of repos) {
    // Only a branch that is checked out and already holds work (a fresh branch starts from the newest base).
    if ((await currentBranch(r.cwd)) !== r.branch) continue;
    if (!r.hasWork && (await aheadOf(r.cwd, r.branch, r.base)) === 0) continue;
    await gitQuiet(r.cwd, ["fetch", "-q", "origin", r.base]);
    const head = (await gitQuiet(r.cwd, ["rev-parse", "HEAD"])).trim();
    const refs = [`origin/${r.base}`, ...(r.from && (await hasRemoteBranch(r.cwd, r.from)) ? [`origin/${r.from}`] : [])];
    try {
      const res = await mergeRefs(r.cwd, refs, `Merge ${r.base} into ${mine.id} (4PM autonomous)`);
      if (res.kind === "conflict") {
        out.push({ cwd: r.cwd, dir: r.dir, head, paths: res.paths });
        await log(`[sync] ${mine.id}: merging ${r.base} into ${r.dir} conflicts in ${res.paths.length} file(s) — the agent resolves them first`);
      }
    } catch (err) {
      await log(`[warn] ${mine.id}: could not merge ${r.base} into ${r.dir}: ${String(err)}`);
    }
  }
  return out;
}

// ── DOC rounds (ADR-0536) ─────────────────────────────────────────────────────────────────────────

/** Doc numbers from the server's per-type counters, over the `autonomous.bookGroups` channel (`count: 0`). */
function docNumberAllocator(ctx: WsHandlerCtx): DocNumberAllocator {
  return async (req) => {
    try {
      const reply = await ctx.request<AutonomousBookGroupsReply>(WsChannels.AUTONOMOUS_BOOK_GROUPS, { count: 0, docNumbers: req });
      if (!reply.docNumbers) return null;
      const out = new Map(reply.docNumbers.map((d) => [d.type, d.values] as const));
      return req.every((r) => (out.get(r.type)?.length ?? 0) >= r.count) ? out : null;
    } catch {
      return null;
    }
  };
}

/**
 * The prompt of one docs round: the spec's Docs section, the request from the lineage, the group's evidences,
 * the earlier rounds and their reviews; a resume merge that stopped on conflicts comes first.
 */
async function docsRoundPrompt(root: string, base: string, cfg: AutonomousConfig, mine: LocalClaim, conflicts: readonly ResumeConflict[]): Promise<string> {
  const [spec, docsText, lineageText] = await Promise.all([
    readSpecDocsAt(root, base),
    remoteBook(root, base, DOCS_SIDECAR_REL),
    remoteBook(root, base, LINEAGE_SIDECAR_REL),
  ]);
  const entry = parseDocsSidecar(docsText)[mine.id];
  const lin = parseLineage(lineageText)[bookGroupOf(mine.id) ?? ""];
  const request = lin ? `${lin.source}: ${lin.request}` : "";
  const designNote = await docsDesignNote(root, base, cfg, mine.id).catch(() => "");
  const evidenceGuide = await intakeEvidenceGuide(root, base).catch(() => "");
  // The newest base was merged into the DOC branch and stopped on conflicts (ADR-0539 §2): resolve them first.
  const conflictNote = conflicts.length
    ? `MERGE CONFLICTS FIRST: the cli merged the latest base branch into this docs branch and the merge stopped on conflicts in these files (the merge is still in progress). Resolve every conflict first — keep both sides' intent, remove every conflict marker — commit the merge, then do the round below.
${wrapUntrusted(conflicts.flatMap((c) => c.paths.map((p) => `- ${c.dir === "." ? p : `${c.dir}/${p}`}`)).join("\n"), { kind: "data", source: "cli.autonomous.docs.conflictPaths" })}

`
    : "";
  return conflictNote + buildDocsPrompt(cfg, mine, spec, entry, request, designNote, evidenceGuide);
}

/**
 * End of a successful docs round: commit leftovers; move the group's rewritten evidences and new change requests to
 * the books; strip the books-only folders from the DOC branch; number the new numbered docs; re-check the claim and
 * the approval; push the DOC branch; then on the books record the round (manifest, head, overlaps) and park the row
 * in `review` — a person reviews it from AI Todo. A round that produced no doc file is a failure.
 * @adr 0536
 */
async function finishDocRound(
  ctx: WsHandlerCtx,
  root: string,
  rootBase: RepoBase,
  mine: LocalClaim,
  cfg: AutonomousConfig,
  summary: string,
  log: (l: string) => Promise<void>,
  extra: { capReached?: ("AI_TODO" | "USER_QA")[] } = {},
): Promise<void> {
  const base = rootBase.base;
  const worker = mine.worker;
  await wipCommit(root, `docs(${mine.id}): ${summary || "docs round"}`.replace(/\s+/g, " ").slice(0, 200));
  // The group's evidences + the agent's change requests belong to the books branch — read them before the strip.
  const evidence = await captureDocEvidence(root, base, cfg, mine.id).catch(() => []);
  const ercs = await captureAgentErcs(root, cfg.erDir);
  const sdcs = await captureAgentSdcs(root, cfg.diagramDir);
  const stripped = await stripSidecarsFromBranch(root, base, mine.id, [...booksOnlyDirsOf(cfg), cfg.mockupDir]);
  await reportSidecarTamper(
    ctx,
    root,
    stripped.filter(
      (p) =>
        !(ercs.length && p === cfg.erDir) &&
        !(sdcs.length && p === cfg.diagramDir) &&
        !(evidence.length && (p === cfg.mockupDir || p === cfg.sequenceDir)),
    ),
    mine.id,
  );
  await numberNewDocs(root, base, mine.id, docNumberAllocator(ctx), log);
  const prev = parseDocsSidecar(await remoteBook(root, base, DOCS_SIDECAR_REL))[mine.id];
  const files = await docManifest(root, base, prev?.files ?? []);
  if (files.length === 0) {
    await releaseTask(ctx, root, rootBase, [], mine, "the docs round wrote no doc file", cfg);
    ctx.bus.autonomousDone(false, "docs round wrote nothing");
    return;
  }
  if (await remoteClaimLost(root, mine)) {
    await log(`[lost] ${mine.id} was taken over before its docs were published — nothing pushed`);
    alert(ctx, { kind: "claim-lost", task: mine.id, message: `${worker} lost its claim of ${mine.id} before publishing its docs.` });
    await writeLocalClaim(ctx.profileDir, null);
    await syncBooks(root, base);
    ctx.bus.autonomousDone(false, "claim lost");
    return;
  }
  if (await remoteApprovalLost(root, mine)) {
    await stopUnapproved(ctx, root, rootBase, [], mine, cfg, log);
    return;
  }
  await pushBranch(root, mine.branch);
  const head = (await gitQuiet(root, ["rev-parse", "HEAD"])).trim();
  await syncBooks(root, base);
  const round = (prev?.round ?? 0) + 1;
  let taskErcs: string[] = [];
  let taskSdcs: string[] = [];
  const res = await publishBooks(
    root,
    base,
    `chore(auto): ${mine.id} docs round ${round} ready for review`,
    async () => {
      if (!(await dropClaim(root, mine))) return false;
      await applyDocRoundDone(root, mine.task, { branch: mine.branch, head, files });
      for (const e of evidence) await writeFileInRoot(root, join(root, e.path), e.content);
      taskErcs = await publishTaskErcs(root, cfg.erDir, ercs, mine.id, mine.task.team, cfg.erAutoApprove);
      taskSdcs = await publishTaskSdcs(root, cfg, sdcs, mine.id, mine.task.team);
      return true;
    },
    { dirs: repoDirsOf(cfg) },
  );
  if (taskErcs.length) await log(`[er] ${mine.id} proposed ${taskErcs.join(", ")}`);
  if (taskSdcs.length) await log(`[diagram] ${mine.id} proposed ${taskSdcs.join(", ")}`);
  await writeLocalClaim(ctx.profileDir, null);
  await log(`[docs] ${mine.id} round ${round}: ${files.length} file(s) on ${mine.branch} — waiting for review (${res})`);
  alert(ctx, { kind: "docs-review", task: mine.id, message: `${mine.id} round ${round}: ${files.length} doc file(s) ready for review.` });
  const hist = await readHistories(root);
  hist.consecutiveFails = 0;
  await recordRun(root, hist, "success", `${mine.id} docs round ${round}`, new Date().toISOString().slice(0, 10));
  ctx.bus.autonomousDone(true, "docs round", { taskId: mine.id, ...extra });
}

/**
 * The resume merge could not be resolved: push the pre-merge WIP, return the task to `AI_TODO` blocked
 * (`merge-conflict`, no attempt counted) and alert the managers; a person resolves and presses Retry.
 * @adr 0539 §2
 */
async function blockForConflict(
  ctx: WsHandlerCtx,
  root: string,
  rootBase: RepoBase,
  subs: { sub: RepoBase; branch: string }[],
  mine: LocalClaim,
  cfg: AutonomousConfig,
  log: (l: string) => Promise<void>,
): Promise<void> {
  await pushWip(ctx, root, mine, subs, "merge conflict with base", booksOnlyDirsOf(cfg));
  const head = (await gitQuiet(root, ["rev-parse", mine.branch])).trim();
  await syncBooks(root, rootBase.base);
  const base = (await gitQuiet(root, ["rev-parse", `origin/${rootBase.base}`])).trim();
  await publishBooks(root, rootBase.base, `chore(auto): ${mine.id} blocked — conflicts with ${rootBase.base}`, async () =>
    applyBlockedRelease(root, mine, { base, head }),
  );
  alert(ctx, { kind: "merge-conflict", task: mine.id, message: `${mine.id} conflicts with ${rootBase.base} and the AI could not resolve it.` });
  await writeLocalClaim(ctx.profileDir, null);
  await log(`[blocked] ${mine.id}: conflicts with ${rootBase.base} — resolve on ${mine.branch}, then Retry`);
  ctx.bus.autonomousDone(false, "merge-conflict");
}

/**
 * Release the conflict-blocked tasks whose branch now merges cleanly into `<base>` (the base or the branch moved
 * since the block — e.g. a person resolved it). A dry merge, nothing is written to a branch.
 * @adr 0539 §2
 */
async function unblockCleanMerges(root: string, base: string): Promise<void> {
  const attempts = await B.readAttempts(root);
  const blocked = Object.entries(attempts).filter(([, a]) => a.blocked);
  if (!blocked.length) return;
  await gitQuiet(root, ["fetch", "-q", "origin", base]);
  const baseSha = (await gitQuiet(root, ["rev-parse", `origin/${base}`])).trim();
  const clean: string[] = [];
  for (const [id, a] of blocked) {
    const branch = taskBranch(base, id);
    if (!(await hasRemoteBranch(root, branch))) continue;
    await gitQuiet(root, ["fetch", "-q", "origin", branch]);
    const head = (await gitQuiet(root, ["rev-parse", `origin/${branch}`])).trim();
    if (head === a.blocked!.head && baseSha === a.blocked!.base) continue;
    if ((await mergesCleanly(root, base, `origin/${branch}`)) === true) clean.push(id);
  }
  if (clean.length) await publishBooks(root, base, `chore(auto): unblock ${clean.join(", ")} (merges cleanly)`, async () => applyUnblock(root, clean));
}

/**
 * Stop for a withdrawn approval: push the work as WIP on the task branch, drop the claim and return the row
 * unchanged to `AI_TODO`. Not a failure — no attempt, no `consecutiveFails`.
 * @adr 0538 §5
 */
async function stopUnapproved(
  ctx: WsHandlerCtx,
  root: string,
  rootBase: RepoBase,
  subs: { sub: RepoBase; branch: string }[],
  mine: LocalClaim,
  cfg: AutonomousConfig,
  log: (l: string) => Promise<void>,
): Promise<void> {
  await pushWip(ctx, root, mine, subs, "unapproved", booksOnlyDirsOf(cfg));
  await syncBooks(root, rootBase.base);
  await publishBooks(root, rootBase.base, `chore(auto): ${mine.id} unapproved — stopped`, async () => applyUnapprovedRelease(root, mine));
  await writeLocalClaim(ctx.profileDir, null);
  await log(`[unapproved] ${mine.id} was unapproved — stopped, WIP pushed on ${mine.branch}`);
  ctx.bus.autonomousDone(false, "unapproved");
}

/**
 * Release a task after a failure / overrun: push its WIP, then on the books branch either return it
 * to `AI_TODO` (attempts+1) or — at the attempt limit — split it (a split child becomes a QA question).
 * @adr 0371 §4
 */
async function releaseTask(ctx: WsHandlerCtx, root: string, rootBase: RepoBase, allSubs: RepoBase[], mine: LocalClaim, reason: string, cfg: AutonomousConfig): Promise<void> {
  const subs = subBranches(allSubs, mine.id, null);
  await pushWip(ctx, root, mine, subs, reason.slice(0, 80), booksOnlyDirsOf(cfg));
  await syncBooks(root, rootBase.base); // the books (and attempts) as on the remote
  const attempts = await B.readAttempts(root);
  const next = (attempts[mine.id]?.count ?? 0) + 1;
  const reasons = `${attempts[mine.id]?.last ?? ""}; ${reason}`;
  if (next >= cfg.maxTaskAttempts) {
    // A docs row is never split: at the limit a person decides (ADR-0536).
    if (isSplitChild(mine.task) || isDocRowId(mine.id)) {
      const q = isDocRowId(mine.id)
        ? `The docs round of ${mine.id} failed ${next} times — last: ${reason}. How should the docs be handled (narrow what they cover, change the approach, or skip them)?`
        : `${mine.id} (a task already split from a bigger one) failed ${next} times — last: ${reason}. How should it be handled (narrow the scope, change the approach, or drop it)?`;
      await publishBooks(root, rootBase.base, `chore(auto): ${mine.id} needs a decision`, async () => (await applyQuestion(root, mine, q, true)) !== null);
      alert(ctx, { kind: "task-failed-limit", task: mine.id, message: `${mine.id} failed ${next} times; a decision was requested in USER_QA.` });
    } else {
      const out = await runAiPrompt(ctx, buildSplitPrompt(mine, reasons, await wipDiff(root, mine)), cycleRunId(), "local", false, undefined, undefined, true, false, runOverrides(cfg));
      const children = parseJsonReply<{ children?: { desc: string; priority?: string; size?: string; notes?: string }[] }>(out.output)?.children?.filter((c) => c?.desc?.trim()) ?? [];
      await syncBooks(root, rootBase.base);
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

/** The cycle's own run budget: `runTimeoutMinutes`, and no profile failover on a timeout. @adr 0452 */
function runOverrides(cfg: AutonomousConfig): AiRunOverrides {
  return { timeoutMs: cfg.runTimeoutMinutes * 60_000, failoverOnTimeout: false, source: "autonomous" };
}

/** Auto-pause after N consecutive failures. @adr 0321 */
async function maybeAutoPause(
  root: string,
  profileDir: string,
  cfg: AutonomousConfig,
  hist: Histories,
  log: (l: string) => Promise<void>,
  onPaused?: (reason: string) => void,
): Promise<void> {
  if (cfg.stopOnConsecutiveFailures > 0 && hist.consecutiveFails >= cfg.stopOnConsecutiveFailures) {
    // A patch of `paused` only (ADR-0507): never reverts a Settings save made during the cycle.
    await pauseAutonomous(profileDir, "auto", `${hist.consecutiveFails} consecutive failed cycles`);
    await log(`[stop] ${hist.consecutiveFails} consecutive failures → paused`);
    onPaused?.(`${hist.consecutiveFails} consecutive failures`);
  }
  await writeHistories(root, hist);
}

/** Fresh book group numbers for an intake run from the server; null when unavailable (intake waits). @adr 0455 */
async function allocateIntakeGroups(ctx: WsHandlerCtx, count: number): Promise<number[] | null> {
  try {
    const reply = await ctx.request<AutonomousBookGroupsReply>(WsChannels.AUTONOMOUS_BOOK_GROUPS, {
      count: Math.min(Math.max(count, 1), BOOK_GROUPS_PER_REQUEST),
    });
    return reply.groups?.length ? reply.groups : null;
  } catch {
    return null;
  }
}

/** The intake's new AI_TODO / USER_QA ids whose group is not one of `groups`. @adr 0455 */
async function strayIntakeIds(root: string, before: Awaited<ReturnType<typeof cappedBookIds>>, groups: readonly number[]): Promise<string[]> {
  const allowed = new Set(groups.map(bookGroupCode));
  const after = await cappedBookIds(root);
  const out: string[] = [];
  for (const book of ["AI_TODO", "USER_QA"] as const) {
    for (const id of after[book]) {
      if (before[book].has(id)) continue;
      const g = bookGroupOf(id);
      if (!g || !allowed.has(g)) out.push(id);
    }
  }
  return out;
}

/** Read the org's monthly autonomous-book counters; null when unavailable (fail open). @adr 0365 */
async function readBookUsage(ctx: WsHandlerCtx): Promise<AutonomousBookUsageReply | null> {
  try {
    return await ctx.request<AutonomousBookUsageReply>(WsChannels.AUTONOMOUS_BOOK_USAGE, {});
  } catch {
    return null;
  }
}

/** What one intake published: new tasks, new questions, new ER change requests. @adr 0529 */
interface IntakeProduced {
  tasks: number;
  questions: number;
  changeRequests: number;
}

/**
 * Run the intake agent on the claimed `ids` and publish its book edits: one server-allocated group per id,
 * the linked discussions as context, the cli's ER post-step. Returns a skip note when the cycle must stop
 * (restart / pause, usage limit), else what was published (null = nothing). The caller owns the intake
 * claim and releases it.
 * @adr 0529 @adr 0455 @adr 0454 @adr 0453
 */
async function runIntake(
  ctx: WsHandlerCtx,
  root: string,
  base: string,
  cfg: AutonomousConfig,
  ids: string[],
  dirs: string[],
  log: (line: string) => Promise<void>,
): Promise<{ stop?: string; produced: IntakeProduced | null }> {
  const before = await cappedBookIds(root);
  const groups = await allocateIntakeGroups(ctx, ids.length);
  if (!groups) {
    await log("[skip] intake: could not allocate book group ids from the server");
    return { produced: null };
  }
  const context = await linkedDiscussionsContext(root, base, ids);
  // Where each id came from — the intake removes the rows (the lineage + the DOC rows need them — ADR-0536/0537).
  const sources = intakeSources(ids, await B.readBook(root, "USER_TODO.md"), await B.readBook(root, "USER_QA.md"));
  const erOpenNote = await openErcNote(root, cfg.erDir).catch(() => "");
  const diagramNote = await intakeDiagramNote(root, cfg.diagramDir).catch(() => "");
  const evidenceGuide = await intakeEvidenceGuide(root, base).catch(() => "");
  const out = await runAiPrompt(ctx, buildIntakePrompt(cfg, ids, erOpenNote, groups, diagramNote, evidenceGuide) + context, cycleRunId(), "local", false, undefined, undefined, false, true, runOverrides(cfg));
  if (stoppedFromOutside(out)) {
    // Stopped by a restart or the policy: drop the half intake, nothing counted (re-run later).
    await gitQuiet(root, ["checkout", "--", "."]);
    await log("[stop] intake stopped (cli restart / autonomous paused)");
    return { stop: "stopped", produced: null };
  }
  if (out.exhausted) {
    await gitQuiet(root, ["checkout", "--", "."]);
    await log("[skip] usage limit during intake");
    return { stop: "usage limit", produced: null };
  }
  // New TSK / QA rows must use the allocated groups — anything else is discarded (re-run next cycle).
  const stray = await strayIntakeIds(root, before, groups);
  if (stray.length) {
    await gitQuiet(root, ["checkout", "--", "."]);
    await log(`[skip] intake used group ids it was not given (${stray.slice(0, 5).join(", ")}) — discarded`);
    return { produced: null };
  }
  await fillIntakeTeams(root, ctx.profileDir, ids, before);
  let ercs = 0;
  const res = await publishIntake(
    root,
    base,
    "chore(auto): intake requests into tasks",
    dirs,
    (files) => reportSidecarTamper(ctx, root, files),
    // The approved ER stays as it was; the agent's new change requests get their numbers (ADR-0453).
    async (ref) => {
      // AI_PROGRESS is the cli's (claims) — never an intake agent's edit (ADR-0529).
      await gitQuiet(root, ["checkout", ref, "--", "AI_PROGRESS.md"]);
      const er = await prepareIntakeEr(root, ref, cfg.erDir, undefined, cfg.erAutoApprove);
      if (er.tampered) await reportSidecarTamper(ctx, root, [cfg.erDir]);
      if (er.created.length) await log(`[er] change requests ${er.created.join(", ")} proposed`);
      for (const sk of er.skipped) await log(`[er] skipped ${sk.name}: ${sk.reason}`);
      // The system diagram the same way; new changes are applied at once under auto-approve (ADR-0530).
      const sd = await prepareIntakeDiagram(root, ref, cfg);
      if (sd.tampered) await reportSidecarTamper(ctx, root, [cfg.diagramDir]);
      if (sd.created.length) await log(`[diagram] change requests ${sd.created.join(", ")} proposed`);
      for (const sk of sd.skipped) await log(`[diagram] skipped ${sk.name}: ${sk.reason}`);
      ercs = er.created.length + sd.created.length;
      // The lineage of the groups this intake used, and one DOC row per new task group (ADR-0536/0537).
      const now = await cappedBookIds(root);
      const used = new Set(
        (["AI_TODO", "USER_QA"] as const).flatMap((b) => [...now[b]].filter((id) => !before[b].has(id)).map((id) => bookGroupOf(id) ?? "")),
      );
      await recordIntakeLineage(root, sources, groups, used);
      if (cfg.docsPhase) {
        const spec = await readSpecDocsAt(root, base);
        if (spec.types.length) {
          const docIds = await addDocRows(root, before.AI_TODO, spec, (g) => sources[groups.findIndex((x) => bookGroupCode(x) === g)]);
          if (docIds.length) await log(`[docs] added ${docIds.join(", ")}`);
        }
      }
    },
  );
  await log(`[intake] ${res}`);
  if (res !== "pushed") return { produced: null };
  await reportNewBookRows(ctx, root, before);
  const after = await cappedBookIds(root);
  const added = (book: keyof typeof after): number => [...after[book]].filter((id) => !before[book].has(id)).length;
  return { produced: { tasks: added("AI_TODO"), questions: added("USER_QA"), changeRequests: ercs } };
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
  // Also a structured cli log record, so tick decisions leave the worker with the log upload (ADR-0509).
  logger.info("autonomous.tick", { project: basename(root), line: line.slice(0, 1000) });
  try {
    const day = new Date().toISOString().slice(0, 10);
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    // Symlink-safe + shared with the agent (ADR-0430 phase 0, ADR-0487).
    await appendFileInRoot(root, join(root, ".claude", "logs", `autonomous-tick-${day}.log`), `${ts} ${line}\n`);
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
 * The served rows waiting on people right now (ER + system-diagram change requests counted from the books
 * checkout). @adr 0529 @adr 0530
 */
async function waitingNow(root: string, profileDir: string, cfg: Pick<AutonomousConfig, "erDir" | "diagramDir">): Promise<WaitingCounts> {
  const ercs = (await blockingErcCount(root, cfg.erDir).catch(() => 0)) + (await blockingSdcCount(root, cfg.diagramDir).catch(() => 0));
  return waitingCounts(root, profileDir, ercs).catch(() => ({ approval: 0, changeRequests: ercs, answers: 0, dependencies: 0, blocked: 0 }));
}

/** One tick-log line for the waiting counts (non-zero ones only). */
function waitingText(w: WaitingCounts): string {
  const parts = [
    w.approval ? `${w.approval} to approve` : "",
    w.changeRequests ? `${w.changeRequests} change request(s)` : "",
    w.answers ? `${w.answers} waiting for answers` : "",
    w.dependencies ? `${w.dependencies} waiting for dependencies` : "",
    w.blocked ? `${w.blocked} blocked by a conflict with the base` : "",
  ].filter(Boolean);
  return parts.join(", ") || "nothing";
}

/**
 * "Has work": at least one APPROVED row present in a book — an approved `REQ-` in
 * USER_TODO, an approved `QA-` in USER_QA, an approved `TSK-` (or a pending `DOC-`) in AI_TODO — or AI_PROGRESS
 * carries a task.
 * @adr 0319 @adr 0321 @adr 0438 @adr 0536
 */
async function hasWork(root: string, profileDir: string): Promise<boolean> {
  // Verified approvals only (ADR-0438) — a forged or edited entry is no work.
  const approvedAll = [...(await approvedIds(root))];
  const read = (f: string): Promise<string> => readFileInRoot(root, join(root, f), "utf8").catch(() => "");
  const [userTodo, userQa, aiTodo, aiProgress] = await Promise.all([
    read("USER_TODO.md"),
    read("USER_QA.md"),
    read("AI_TODO.md"),
    read("AI_PROGRESS.md"),
  ]);
  // A team-restricted worker counts only its teams' rows (ADR-0450).
  const approved = approvedAll.filter((id) => {
    const md = id.startsWith("REQ-") ? userTodo : id.startsWith("QA-") ? userQa : aiTodo;
    return servesTeam(profileDir, bookRowTeam(md, id));
  });
  const anyApproved = (prefix: string, text: string): boolean =>
    approved.some((id) => id.startsWith(prefix) && text.includes(id));
  // A DOC row in review waits for a person, not for a cycle (ADR-0536).
  const docs = await readDocs(root);
  const docWork = approved.some((id) => id.startsWith("DOC-") && aiTodo.includes(id) && (docs[id]?.state ?? "pending") === "pending");
  return (
    anyApproved("REQ-", userTodo) ||
    anyApproved("QA-", userQa) ||
    anyApproved("TSK-", aiTodo) ||
    docWork ||
    B.parseClaims(aiProgress).claims.length > 0
  );
}

/**
 * After an intake run, give the rows it created a `Team` when the agent left it empty and the team is
 * unambiguous: the worker serves exactly one team, or every request / question taken in shares one team.
 * @adr 0450
 */
async function fillIntakeTeams(
  root: string,
  profileDir: string,
  intake: readonly string[],
  before: Awaited<ReturnType<typeof cappedBookIds>>,
): Promise<void> {
  const served = servedTeams(profileDir);
  const [userTodo, userQa] = await Promise.all([B.readBook(root, "USER_TODO.md"), B.readBook(root, "USER_QA.md")]);
  const sourceTeams = new Set(intake.map((id) => bookRowTeam(id.startsWith("REQ-") ? userTodo : userQa, id)).filter(Boolean));
  const team = served && served.length === 1 ? served[0]! : sourceTeams.size === 1 ? [...sourceTeams][0]! : "";
  if (!team) return;
  const todo = await B.readBook(root, "AI_TODO.md");
  const { tasks } = B.parseTasks(todo);
  if (tasks.some((t) => !before.AI_TODO.has(t.id) && !t.team)) {
    await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, tasks.map((t) => (!before.AI_TODO.has(t.id) && !t.team ? { ...t, team } : t))));
  }
  const qa = await B.readBook(root, "USER_QA.md");
  const { rows } = B.parseQa(qa);
  if (rows.some((q) => !before.USER_QA.has(q.id) && !q.team)) {
    await B.writeBook(root, "USER_QA.md", B.writeQa(qa, rows.map((q) => (!before.USER_QA.has(q.id) && !q.team ? { ...q, team } : q))));
  }
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
