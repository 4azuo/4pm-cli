/**
 * AI resolve for pull-request conflicts: in the worker's working tree (under the repo lock, like a cycle),
 * check out the PR's head branch, merge its target, let a full agent resolve the conflicts, accept the result
 * only when no unmerged path / conflict marker is left, and push the head branch (never forced). Started by a
 * person from the Git tab (`git.prResolve`), or once per cycle for a conflicting 4PM task PR when the project's
 * `autoResolvePrConflicts` is on — each (head, base) state is tried once, recorded in the attempts sidecar
 * through `publishBooks` so two workers never resolve the same PR.
 * @adr 0539 §5
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WsHandlerCtx } from "../ws-client/context";
import { runAiPrompt } from "../ws-client/command-dispatch";
import { resolveCliPrompt } from "../ai/prompt-overrides";
import { acquireRepo } from "../git/repo-lock";
import { conflictingPullRequests, type ConflictingPr } from "../git/git-host";
import { WsChannels, type AutonomousAlertPayload, type GitPrResolveReply, type GitPrResolveRequest } from "@4pm/ws";
import * as B from "./autonomous-books";
import { currentBranch, git, gitQuiet, publishBooks, type RepoBase } from "./autonomous-git";
import { concludeMerge, conflictResolved, mergeInProgress, mergeRefs } from "./autonomous-merge";

/** A branch / ref name the cli accepts from the server (no options, no `..`). */
const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** Outcome of one resolve. */
export type PrResolveOutcome = { ok: true; merged: "clean" | "resolved" } | { ok: false; reason: string };

/**
 * Resolve one PR in `cwd` (the caller holds the repo lock). The tree must be clean; it is put back on the branch
 * it was on, and the temporary local branch is removed.
 */
export async function resolvePullRequest(
  ctx: WsHandlerCtx,
  cwd: string,
  pr: { number: number; head: string; base: string; title: string },
  timeoutMs: number,
): Promise<PrResolveOutcome> {
  if (!REF_RE.test(pr.head) || !REF_RE.test(pr.base)) return { ok: false, reason: "invalid branch name" };
  if ((await gitQuiet(cwd, ["status", "--porcelain"])).trim()) return { ok: false, reason: "the working tree has local changes" };
  const prev = (await currentBranch(cwd)) || (await gitQuiet(cwd, ["rev-parse", "HEAD"])).trim();
  const local = `4pm-pr-${pr.number}`;
  try {
    await git(cwd, ["fetch", "-q", "origin", pr.head, pr.base], 180_000);
    await git(cwd, ["checkout", "-q", "-B", local, `origin/${pr.head}`]);
    const res = await mergeRefs(cwd, [`origin/${pr.base}`], `Merge ${pr.base} into ${pr.head} (4PM AI conflict resolve)`);
    let merged: "clean" | "resolved" = "clean";
    if (res.kind === "conflict") {
      // Admin override (ADR-0381) for `cli.git.prResolve`; the title and paths are wrapped as data (ADR-0421).
      const prompt = resolveCliPrompt("cli.git.prResolve", {
        number: pr.number,
        head: pr.head,
        base: pr.base,
        title: pr.title || "(none)",
        conflictPaths: res.paths.map((p) => `- ${p}`).join("\n"),
      });
      const out = await runAiPrompt(ctx, prompt, randomUUID(), "local", false, undefined, undefined, false, true, {
        timeoutMs,
        failoverOnTimeout: false,
        source: "autonomous",
      });
      if ((await currentBranch(cwd)) !== local) await gitQuiet(cwd, ["checkout", "-q", local]);
      if (out.exitCode !== 0 || out.cancelled || !(await conflictResolved(cwd, res.paths))) {
        return { ok: false, reason: out.timedOut ? "the AI run timed out" : "the AI could not resolve every conflict" };
      }
      await concludeMerge(cwd);
      merged = "resolved";
    }
    await git(cwd, ["push", "-q", "origin", `HEAD:refs/heads/${pr.head}`], 180_000);
    return { ok: true, merged };
  } catch (err) {
    return { ok: false, reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  } finally {
    if (await mergeInProgress(cwd)) await gitQuiet(cwd, ["merge", "--abort"]);
    await gitQuiet(cwd, ["reset", "-q", "--hard"]);
    if (prev) await gitQuiet(cwd, ["checkout", "-q", prev]);
    await gitQuiet(cwd, ["branch", "-D", local]);
  }
}

/** The attempts-sidecar key of a PR (`PR-<number>`) — kept apart from the task ids. */
function prKey(number: number): string {
  return `PR-${number}`;
}

/**
 * Record that this worker tries `pr` at its current state; false when that state was already tried (by any
 * worker). Runs inside `publishBooks`, so the books push is the lock.
 */
async function recordPrAttempt(root: string, pr: ConflictingPr, baseSha: string): Promise<boolean> {
  const attempts = await B.readAttempts(root);
  const state = `${pr.headSha}:${baseSha}`;
  if (attempts[prKey(pr.number)]?.last === state) return false;
  attempts[prKey(pr.number)] = { count: (attempts[prKey(pr.number)]?.count ?? 0) + 1, last: state, at: new Date().toISOString() };
  await B.writeAttempts(root, attempts);
  return true;
}

/**
 * Auto mode (`autoResolvePrConflicts`): resolve at most one conflicting PR of a 4PM task branch of `<base>`
 * whose current state nobody tried yet. Returns whether a resolve ran (the cycle then ends).
 */
export async function autoResolveOnePr(
  ctx: WsHandlerCtx,
  root: string,
  rootBase: RepoBase,
  worker: string,
  timeoutMs: number,
  log: (line: string) => Promise<void>,
): Promise<boolean> {
  const prefix = `dev/${rootBase.base}/`;
  const prs = (await conflictingPullRequests(rootBase.url)).filter((p) => p.head.startsWith(prefix) && p.base === rootBase.base);
  if (!prs.length) return false;
  await gitQuiet(root, ["fetch", "-q", "origin", rootBase.base]);
  const baseSha = (await gitQuiet(root, ["rev-parse", `origin/${rootBase.base}`])).trim();
  const attempts = await B.readAttempts(root);
  const pr = prs.find((p) => attempts[prKey(p.number)]?.last !== `${p.headSha}:${baseSha}`);
  if (!pr) return false;
  const claimed = await publishBooks(root, rootBase.base, `chore(auto): resolve PR #${pr.number} by ${worker}`, () => recordPrAttempt(root, pr, baseSha));
  if (claimed !== "pushed") return false;
  await log(`[resolve] PR #${pr.number} (${pr.head}) conflicts with ${rootBase.base} — the AI resolves it`);
  const out = await resolvePullRequest(ctx, root, pr, timeoutMs);
  if (out.ok) await log(`[resolve] PR #${pr.number}: ${out.merged === "clean" ? "merged cleanly" : "conflicts resolved"} and pushed`);
  else {
    await log(`[resolve] PR #${pr.number}: not resolved — ${out.reason}`);
    alertFailure(ctx, pr.number, pr.head, out.reason);
  }
  return true;
}

/** Tell the managers a PR could not be resolved. */
function alertFailure(ctx: WsHandlerCtx, number: number, head: string, reason: string): void {
  try {
    ctx.send(WsChannels.AUTONOMOUS_ALERT, {
      kind: "pr-resolve-failed",
      branch: head,
      message: `PR #${number} (${head}): ${reason}`.slice(0, 500),
    } satisfies AutonomousAlertPayload);
  } catch {
    /* best effort */
  }
}

/**
 * `git.prResolve` from the Git tab: validate, take the repo lock and resolve in the background; the reply only
 * says whether it started. A failure is reported as a `pr-resolve-failed` alert.
 * @api machine-0091
 */
export function handlePrResolve(ctx: WsHandlerCtx, req: GitPrResolveRequest, timeoutMs: number): GitPrResolveReply {
  const root = ctx.physicRoot;
  if (!root) return { started: false, error: "This worker has no project folder." };
  if (!REF_RE.test(req.head) || !REF_RE.test(req.base)) return { started: false, error: "invalid branch name" };
  if (req.repo && (!REF_RE.test(req.repo) || req.repo.startsWith("/"))) return { started: false, error: "invalid repo" };
  const cwd = req.repo ? join(root, req.repo) : root;
  void (async () => {
    const handle = await acquireRepo(root, { holder: "git", label: `resolve PR #${req.number}` });
    try {
      const out = await resolvePullRequest(ctx, cwd, req, timeoutMs);
      if (!out.ok) alertFailure(ctx, req.number, req.head, out.reason);
    } finally {
      handle.release();
    }
  })().catch((err) => alertFailure(ctx, req.number, req.head, String(err)));
  return { started: true };
}
