/**
 * Autonomous task rules (ADR-0371) — the book transitions the cli performs in code: eligibility
 * (approval, attempts, `TSK-…` dependencies — one done / two-or-more merged — and `QA-…` answers),
 * claim / take-over of an expired claim, finish, release (failure / overrun), task question (`QA-…` into
 * `Depends`), auto-split, and the fold of task-question answers. Every mutator edits the book files in
 * the working tree and is meant to run inside `publishBooks` (which pushes them as the lock). The
 * worker's own live claim is mirrored in `<profileDir>/autonomous-claim.json` for resume / reconnect.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as B from "./autonomous-books";
import { isMerged, type RepoBase } from "./autonomous-git";
import { evidenceCell, moveTaskEvidence, rehomeTaskLinks } from "./autonomous-evidence";

/** The approvals sidecar. */
const APPROVALS_REL = ".claude/.autonomous.approvals.json";

/** This worker's live claim, mirrored locally (resume after a restart / reconnect). */
export interface LocalClaim {
  id: string;
  claim: string;
  worker: string;
  started: string;
  attempt: number;
  branch: string;
  base: string;
  task: B.TaskRow;
  /** Where the task branch starts when it has no WIP yet (the single unmerged dependency / split parent). */
  from?: string | null;
}

/** Local claim file path. */
function claimPath(profileDir: string): string {
  return join(profileDir, "autonomous-claim.json");
}

/** Read this worker's local claim (null when none). */
export async function readLocalClaim(profileDir: string): Promise<LocalClaim | null> {
  try {
    return JSON.parse(await readFile(claimPath(profileDir), "utf8")) as LocalClaim;
  } catch {
    return null;
  }
}

/** Save / clear this worker's local claim. */
export async function writeLocalClaim(profileDir: string, c: LocalClaim | null): Promise<void> {
  if (c) await writeFile(claimPath(profileDir), `${JSON.stringify(c, null, 2)}\n`, "utf8");
  else await rm(claimPath(profileDir), { force: true });
}

/** Group id of a task: `TSK-gggg-tttt` ⇒ `GRP-gggg` (deterministic — dependency branches derive from it). */
export function groupOf(taskId: string): string {
  const m = /^TSK-(\d+)-\d+/.exec(taskId);
  return m ? `GRP-${m[1]}` : "GRP-0000";
}

/** The task branch `dev/<base>/<GROUP>/<TSK>` (ADR-0371 §1, named per ADR-0372 — `<base>/…` can't coexist with `<base>`). */
export function taskBranch(base: string, taskId: string): string {
  return `dev/${base}/${groupOf(taskId)}/${taskId}`;
}

/** A `from: <branch>` hint in Notes (split children continue the parent's WIP), or null. */
export function fromHint(notes: string): string | null {
  return /(?:^|;\s*)from:\s*(\S+)/.exec(notes)?.[1] ?? null;
}

/** The branch recorded in an `AI_DONE` Notes cell (`branch: …`), or null. */
function doneBranch(notes: string): string | null {
  return /branch:\s*([^\s;]+)/.exec(notes)?.[1] ?? null;
}

/** Approved ids from the approvals sidecar. */
export async function approvedIds(root: string): Promise<Set<string>> {
  try {
    const map = JSON.parse(await readFile(join(root, APPROVALS_REL), "utf8")) as Record<string, { approved?: boolean }>;
    return new Set(Object.entries(map).filter(([, v]) => v?.approved === true).map(([k]) => k));
  } catch {
    return new Set();
  }
}

/** Age of a claim row in hours (Infinity when unparsable). */
export function claimAgeHours(c: B.ClaimRow): number {
  const t = B.parseStamp(c.started);
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : Infinity;
}

/** Is this worker's claim still live on the current books (same claim id, within the TTL)? */
export async function claimState(root: string, mine: LocalClaim, ttlHours: number): Promise<"live" | "expired" | "lost"> {
  const row = B.parseClaims(await B.readBook(root, "AI_PROGRESS.md")).claims.find((c) => c.id === mine.id);
  if (!row || row.claim !== mine.claim) return "lost";
  return claimAgeHours(row) >= ttlHours ? "expired" : "live";
}

/** A task the cycle may take: a fresh one from `AI_TODO`, or an expired claim to take over. */
export interface Candidate {
  task: B.TaskRow;
  takeover: B.ClaimRow | null;
  /** The single unmerged dependency's branch to start from (null ⇒ `<base>`). */
  from: string | null;
}

/**
 * Pick the next eligible task (ADR-0371 §5): expired claims first (take-over), then `AI_TODO` in order
 * (smallest group, High → Medium → Low, line order). A task needs approval, attempts below the limit (and
 * not split-pending), its `QA-…` deps answered + approved (or folded), and its `TSK-…` deps satisfied:
 * one ⇒ done (its PR opened), two or more ⇒ all merged into `<base>`.
 */
export async function pickTask(
  root: string,
  rootBase: RepoBase,
  opts: { worker: string; ttlHours: number; maxAttempts: number; skip?: Set<string> },
): Promise<Candidate | null> {
  const [todo, prog, done, qa, attempts, approved] = await Promise.all([
    B.readBook(root, "AI_TODO.md"),
    B.readBook(root, "AI_PROGRESS.md"),
    B.readBook(root, "AI_DONE.md"),
    B.readBook(root, "USER_QA.md"),
    B.readAttempts(root),
    approvedIds(root),
  ]);
  const claims = B.parseClaims(prog).claims;
  const skip = opts.skip ?? new Set<string>();
  // 1. Expired claims (a dead / overrun worker) — take over, resuming its WIP branch.
  for (const c of claims) {
    if (skip.has(c.id) || c.worker === opts.worker || claimAgeHours(c) < opts.ttlHours) continue;
    const snap = attempts[c.id]?.task;
    const task = snap ?? { id: c.id, priority: "Medium", tag: "", depends: [], group: groupOf(c.id), desc: c.desc, notes: "" };
    return { task, takeover: c, from: null };
  }
  // 2. Fresh tasks.
  const doneMap = B.doneRows(done);
  const qaRows = new Map(B.parseQa(qa).rows.map((q) => [q.id, q]));
  const claimed = new Set(claims.map((c) => c.id));
  const rank = (p: string): number => ({ high: 0, medium: 1, low: 2 })[p.trim().toLowerCase()] ?? 1;
  const groupNum = (id: string): number => Number(/^TSK-(\d+)/.exec(id)?.[1] ?? 9999);
  const tasks = B.parseTasks(todo)
    .tasks.map((t, i) => ({ t, i }))
    .sort((a, b) => groupNum(a.t.id) - groupNum(b.t.id) || rank(a.t.priority) - rank(b.t.priority) || a.i - b.i);
  for (const { t } of tasks) {
    if (skip.has(t.id) || claimed.has(t.id) || !approved.has(t.id)) continue;
    const a = attempts[t.id];
    if (a && (a.splitPending || a.count >= opts.maxAttempts)) continue;
    // QA deps: answered + approved, or already folded (absent — QA ids are never reused).
    const qaOk = t.depends
      .filter((d) => d.startsWith("QA-"))
      .every((d) => {
        const q = qaRows.get(d);
        return !q || (q.answer.trim().length > 0 && approved.has(d));
      });
    if (!qaOk) continue;
    const deps = t.depends.filter((d) => d.startsWith("TSK-"));
    if (deps.some((d) => !doneMap.has(d))) continue;
    let from: string | null = null;
    if (deps.length === 1) {
      const dep = deps[0]!;
      const branch = doneBranch(doneMap.get(dep) ?? "") ?? taskBranch(rootBase.base, dep);
      // Continue from the dependency's branch while its PR is not merged yet.
      if (!(await isMerged(root, rootBase.url, branch, rootBase.base))) from = branch;
    } else if (deps.length >= 2) {
      let allMerged = true;
      for (const dep of deps) {
        const branch = doneBranch(doneMap.get(dep) ?? "") ?? taskBranch(rootBase.base, dep);
        if (!(await isMerged(root, rootBase.url, branch, rootBase.base))) {
          allMerged = false;
          break;
        }
      }
      if (!allMerged) continue;
    }
    return { task: t, takeover: null, from: fromHint(t.notes) ?? from };
  }
  return null;
}

/** Claim a candidate on the books (inside `publishBooks`): false when it is no longer free. */
export async function applyClaim(root: string, cand: Candidate, mine: Omit<LocalClaim, "branch" | "base" | "task" | "from">, ttlHours: number): Promise<boolean> {
  const [todo, prog, done, attempts] = await Promise.all([
    B.readBook(root, "AI_TODO.md"),
    B.readBook(root, "AI_PROGRESS.md"),
    B.readBook(root, "AI_DONE.md"),
    B.readAttempts(root),
  ]);
  const claims = B.parseClaims(prog).claims;
  const existing = claims.find((c) => c.id === cand.task.id);
  let incident: string | null = null;
  if (cand.takeover) {
    // Still the same expired claim? (another worker may have taken it over already)
    if (!existing || existing.claim !== cand.takeover.claim || claimAgeHours(existing) < ttlHours) return false;
    incident = `Claim of ${cand.task.id} by ${existing.worker} expired (${ttlHours} h) — taken over by ${mine.worker}.`;
    attempts[cand.task.id] = { ...(attempts[cand.task.id] ?? {}), count: (attempts[cand.task.id]?.count ?? 0) + 1, last: "claim expired (taken over)", at: new Date().toISOString() };
  } else {
    if (existing) return false;
    const { tasks } = B.parseTasks(todo);
    if (!tasks.some((t) => t.id === cand.task.id)) return false;
    await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, tasks.filter((t) => t.id !== cand.task.id)));
    attempts[cand.task.id] = { ...(attempts[cand.task.id] ?? { count: 0, last: "", at: "" }), task: cand.task };
  }
  const row: B.ClaimRow = { started: mine.started, id: cand.task.id, worker: mine.worker, claim: mine.claim, attempt: mine.attempt, desc: cand.task.desc };
  await B.writeBook(root, "AI_PROGRESS.md", B.writeClaims(prog, [...claims.filter((c) => c.id !== cand.task.id), row]));
  if (cand.takeover) attempts[cand.task.id] = { ...attempts[cand.task.id]!, task: attempts[cand.task.id]?.task ?? cand.task };
  await B.writeAttempts(root, attempts);
  if (incident) await B.writeBook(root, "AI_DONE.md", B.appendIncident(done, incident));
  return true;
}

/** Remove this worker's claim row; false when it is no longer ours (lost). */
async function dropClaim(root: string, mine: LocalClaim): Promise<boolean> {
  const prog = await B.readBook(root, "AI_PROGRESS.md");
  const claims = B.parseClaims(prog).claims;
  const row = claims.find((c) => c.id === mine.id);
  if (!row || row.claim !== mine.claim) return false;
  await B.writeBook(root, "AI_PROGRESS.md", B.writeClaims(prog, claims.filter((c) => c.id !== mine.id)));
  return true;
}

/**
 * Finish (ADR-0371 phase 8): claim → `AI_DONE` with branch + PR links; attempts cleared. The task's
 * attachments move from `AI_TODO/<TSK>/` to `AI_DONE/<TSK>/` and, with the agent's own files on the task
 * branch, fill the `Evidence` column (ADR-0404).
 */
export async function applyFinish(
  root: string,
  mine: LocalClaim,
  done: { files: string; notes: string; evidence: string[] },
  evRoot: string,
): Promise<boolean> {
  if (!(await dropClaim(root, mine))) return false;
  const moved = await moveTaskEvidence(root, mine.id, evRoot);
  await B.writeBook(root, "AI_DONE.md", B.appendDone(await B.readBook(root, "AI_DONE.md"), { id: mine.id, group: mine.task.group, depends: mine.task.depends, desc: rehomeTaskLinks(mine.task.desc, mine.id), files: done.files, evidence: evidenceCell([...moved, ...done.evidence]), notes: done.notes }));
  const attempts = await B.readAttempts(root);
  delete attempts[mine.id];
  await B.writeAttempts(root, attempts);
  return true;
}

/**
 * Release (failure / overrun — ADR-0371 §4): the task goes back to `AI_TODO` (a note appended), attempts+1,
 * an Incident row. Returns the new attempt count, or null when the claim is no longer ours.
 */
export async function applyRelease(root: string, mine: LocalClaim, reason: string, maxAttempts: number): Promise<number | null> {
  if (!(await dropClaim(root, mine))) return null;
  const attempts = await B.readAttempts(root);
  const count = (attempts[mine.id]?.count ?? 0) + 1;
  attempts[mine.id] = { ...(attempts[mine.id] ?? {}), count, last: reason.slice(0, 300), at: new Date().toISOString(), ...(count >= maxAttempts ? { splitPending: true } : {}) };
  await B.writeAttempts(root, attempts);
  const todo = await B.readBook(root, "AI_TODO.md");
  const { tasks } = B.parseTasks(todo);
  const back: B.TaskRow = { ...mine.task, notes: appendNote(mine.task.notes, `attempt ${count} ended: ${reason.slice(0, 160)}; WIP on ${mine.branch}`) };
  await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, [...tasks.filter((t) => t.id !== mine.id), back]));
  await B.writeBook(root, "AI_DONE.md", B.appendIncident(await B.readBook(root, "AI_DONE.md"), `${mine.id} attempt ${count} by ${mine.worker}: ${reason.slice(0, 200)} — returned to AI_TODO (WIP pushed on ${mine.branch}).`));
  return count;
}

/** The next free id `<prefix>-<group>-<n>` across the given texts (ids are never reused). */
function nextId(prefix: "TSK" | "QA", group: string, texts: string[]): string {
  const re = new RegExp(`${prefix}-${group}-(\\d+)`, "g");
  let max = 0;
  for (const t of texts) for (const m of t.matchAll(re)) max = Math.max(max, Number(m[1]));
  return `${prefix}-${group}-${String(max + 1).padStart(4, "0")}`;
}

/** Append to a Notes cell. */
function appendNote(notes: string, add: string): string {
  return notes.trim() ? `${notes.trim()}; ${add}` : add;
}

/**
 * Task question (ADR-0371 §8): a `USER_QA` row for the decision, its id added to the task's `Depends`, the
 * task back in `AI_TODO` (no attempt counted). Returns the QA id, or null when the claim is no longer ours.
 */
export async function applyQuestion(root: string, mine: LocalClaim, question: string, resetAttempts = false): Promise<string | null> {
  if (!(await dropClaim(root, mine))) return null;
  if (resetAttempts) {
    // A split child that hit the limit becomes a human decision (ADR-0371 §6): once answered it may run again.
    const attempts = await B.readAttempts(root);
    delete attempts[mine.id];
    await B.writeAttempts(root, attempts);
  }
  const [todo, qa, done, attemptsText] = await Promise.all([
    B.readBook(root, "AI_TODO.md"),
    B.readBook(root, "USER_QA.md"),
    B.readBook(root, "AI_DONE.md"),
    B.readBook(root, B.ATTEMPTS_REL),
  ]);
  const g = /^TSK-(\d+)/.exec(mine.id)?.[1] ?? "0000";
  const qaId = nextId("QA", g, [qa, todo, done, attemptsText]);
  const { rows } = B.parseQa(qa);
  const qaDeps = mine.task.depends.filter((d) => d.startsWith("QA-")).join(", ");
  await B.writeBook(root, "USER_QA.md", B.writeQa(qa, [...rows, { id: qaId, group: mine.task.group, depends: qaDeps, original: `${mine.id}: ${mine.task.desc}`, question, answer: "" }]));
  const { tasks } = B.parseTasks(todo);
  const back: B.TaskRow = { ...mine.task, depends: [...mine.task.depends.filter((d) => d !== qaId), qaId], notes: appendNote(mine.task.notes, `waiting for ${qaId}; WIP on ${mine.branch}`) };
  await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, [...tasks.filter((t) => t.id !== mine.id), back]));
  return qaId;
}

/**
 * Fold task-question answers (ADR-0371 §8): each answered + approved `QA-…` that some task depends on is
 * appended to those tasks' Notes and removed from `USER_QA` (an absent QA counts as resolved). Returns true
 * when the books changed. Intake questions (no dependent task) are left for the intake agent.
 */
export async function foldTaskAnswers(root: string): Promise<boolean> {
  const [todo, qa, approved] = await Promise.all([B.readBook(root, "AI_TODO.md"), B.readBook(root, "USER_QA.md"), approvedIds(root)]);
  const { tasks } = B.parseTasks(todo);
  const { rows } = B.parseQa(qa);
  const answered = rows.filter((q) => q.answer.trim() && approved.has(q.id) && tasks.some((t) => t.depends.includes(q.id)));
  if (answered.length === 0) return false;
  const byId = new Map(answered.map((q) => [q.id, q]));
  const next = tasks.map((t) => {
    const add = t.depends.filter((d) => byId.has(d)).map((d) => `answer ${d}: ${byId.get(d)!.answer}`);
    return add.length ? { ...t, notes: appendNote(t.notes, add.join("; ")) } : t;
  });
  await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, next));
  await B.writeBook(root, "USER_QA.md", B.writeQa(qa, rows.filter((q) => !byId.has(q.id))));
  return true;
}

/** Is there intake work for the agent: an approved `REQ-…`, or an answered + approved intake `QA-…`? */
export async function hasIntakeWork(root: string): Promise<boolean> {
  const [userTodo, todo, qa, approved] = await Promise.all([
    B.readBook(root, "USER_TODO.md"),
    B.readBook(root, "AI_TODO.md"),
    B.readBook(root, "USER_QA.md"),
    approvedIds(root),
  ]);
  if ([...approved].some((id) => id.startsWith("REQ-") && userTodo.includes(id))) return true;
  const taskDeps = new Set(B.parseTasks(todo).tasks.flatMap((t) => t.depends));
  return B.parseQa(qa).rows.some((q) => !taskDeps.has(q.id) && q.answer.trim() && approved.has(q.id));
}

/**
 * Auto-split (ADR-0371 §6), applied by the worker holding the parent's claim: child tasks (same group, new
 * ids, chained `Depends`; the first inherits the parent's deps + continues from its WIP branch) go to
 * `AI_TODO` unapproved; the parent moves to `AI_DONE` as "split into …". Returns the child ids.
 */
export async function applySplit(
  root: string,
  mine: LocalClaim,
  children: { desc: string; priority?: string; notes?: string; size?: string }[],
  evRoot: string,
): Promise<string[] | null> {
  if (!(await dropClaim(root, mine))) return null;
  const [todo, done, prog] = await Promise.all([B.readBook(root, "AI_TODO.md"), B.readBook(root, "AI_DONE.md"), B.readBook(root, "AI_PROGRESS.md")]);
  const g = /^TSK-(\d+)/.exec(mine.id)?.[1] ?? "0000";
  const texts = [todo, done, prog, mine.id];
  const ids: string[] = [];
  const rows: B.TaskRow[] = children.map((c, i) => {
    const id = nextId("TSK", g, [...texts, ...ids]);
    ids.push(id);
    const deps = i === 0 ? mine.task.depends : [ids[i - 1]!];
    const notes = [c.size ? `size: ${c.size}` : "", c.notes ?? "", `split from ${mine.id}`, i === 0 ? `from: ${mine.branch}` : ""].filter(Boolean).join("; ");
    return { id, priority: c.priority || mine.task.priority || "Medium", tag: "", depends: deps, group: mine.task.group, desc: c.desc, notes };
  });
  const { tasks } = B.parseTasks(todo);
  await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, [...tasks, ...rows]));
  // The parent's attachments follow it to AI Done (ADR-0404); the books' links are rewritten in place.
  const moved = await moveTaskEvidence(root, mine.id, evRoot);
  await B.writeBook(root, "AI_DONE.md", B.appendDone(await B.readBook(root, "AI_DONE.md"), { id: mine.id, group: mine.task.group, depends: mine.task.depends, desc: rehomeTaskLinks(mine.task.desc, mine.id), files: "", evidence: evidenceCell(moved), notes: `split into ${ids.join(", ")} (after repeated attempts); WIP on ${mine.branch}` }));
  const attempts = await B.readAttempts(root);
  delete attempts[mine.id];
  await B.writeAttempts(root, attempts);
  return ids;
}

/** Was this task itself produced by a split (then it is never split again — ADR-0371 §6)? */
export function isSplitChild(task: B.TaskRow): boolean {
  return /split from TSK-/.test(task.notes);
}
