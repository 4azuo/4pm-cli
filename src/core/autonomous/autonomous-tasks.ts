/**
 * Autonomous task rules — the book transitions the cli performs in code: eligibility
 * (approval, attempts, `TSK-…` dependencies — one done / two-or-more merged — and `QA-…` answers),
 * claim / take-over of an expired claim, finish, release (failure / overrun), task question (`QA-…` into
 * `Depends`), auto-split, and the fold of task-question answers. Every mutator edits the book files in
 * the working tree and is meant to run inside `publishBooks` (which pushes them as the lock). The
 * worker's own live claim is mirrored in `<profileDir>/autonomous-claim.json` for resume / reconnect.
 * @adr 0371
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as B from "./autonomous-books";
import { isMerged, type RepoBase } from "./autonomous-git";
import { evidenceCell, moveTaskEvidence, rehomeTaskLinks } from "./autonomous-evidence";
import { readFileInRoot } from "../../utils/safe-path";
import { BOOK_STATE, approvalEntrySchema, bookRowStates, bookRowTeam, buildDependsWaiting, type WaitingItem } from "@4pm/dto";
import { verifiedApprovedIds } from "./autonomous-approvals";
import { servesTeam } from "./autonomous-teams";
import { docRunnable, readDocs, readLineage } from "./autonomous-docs";

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
  /** The task row as it was at the previous claim — the text the branch's earlier work was written for. @adr 0538 */
  prevTask?: B.TaskRow;
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

/**
 * Group id of a task or docs row: `TSK-GGGGGG-NNN` / `DOC-GGGGGG-NNN` ⇒ `GRP-GGGGGG` (deterministic — dependency
 * branches derive from it).
 * @adr 0536
 */
export function groupOf(taskId: string): string {
  const m = /^(?:TSK|DOC)-(\d+)-\d+/.exec(taskId);
  return m ? `GRP-${m[1]}` : "GRP-000000";
}

/** The task branch `dev/<base>/<GROUP>/<TSK>` (ADR-0371 §1, named per ADR-0372 — `<base>/…` can't coexist with `<base>`). */
export function taskBranch(base: string, taskId: string): string {
  return `dev/${base}/${groupOf(taskId)}/${taskId}`;
}

/**
 * The books branch `autonomous-books/<base>`: the books + sidecars live here (not on `<base>`), so
 * `<base>` can be protected. 4PM prefix first, like the task / template branches. @adr 0448 @adr 0372
 */
export function booksBranch(base: string): string {
  return `autonomous-books/${base}`;
}

/** A `from: <branch>` hint in Notes (split children continue the parent's WIP), or null. */
export function fromHint(notes: string): string | null {
  return /(?:^|;\s*)from:\s*(\S+)/.exec(notes)?.[1] ?? null;
}

/** The branch recorded in an `AI_DONE` Notes cell (`branch: …`), or null. */
function doneBranch(notes: string): string | null {
  return /branch:\s*([^\s;]+)/.exec(notes)?.[1] ?? null;
}

/**
 * Approved ids from the approvals sidecar — only entries whose server signature verifies and whose row
 * content is unchanged count (the legacy `approved: true` rule before this cli ever received keys).
 * @adr 0438
 */
export async function approvedIds(root: string): Promise<Set<string>> {
  try {
    const map = JSON.parse(await readFileInRoot(root, join(root, APPROVALS_REL), "utf8")) as Record<string, unknown>;
    const [userTodo, userQa, aiTodo] = await Promise.all([
      B.readBook(root, "USER_TODO.md"),
      B.readBook(root, "USER_QA.md"),
      B.readBook(root, "AI_TODO.md"),
    ]);
    return verifiedApprovedIds(map, { userTodo, userQa, aiTodo });
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
 * Pick the next eligible task: expired claims first (take-over), then `AI_TODO` in order
 * (smallest group, High → Medium → Low, line order). A task needs approval, attempts below the limit (and
 * not split-pending), its `QA-…` deps answered + approved (or folded), and its `TSK-…` deps satisfied:
 * one ⇒ done (its PR opened), two or more ⇒ all merged into `<base>`. A task of a group in `blockedGroups`
 * (`TSK-<GGGGGG>` — its ER change request is not applied yet, ADR-0453) waits. A `DOC-…` row runs
 * while its docs entry is pending (never in `review`) and is not held back by its group's change requests; a
 * `DOC-…` dependency is satisfied once accepted (in AI Done) and never counts toward the merged rule — a task whose
 * only dependency is its DOC branches from the DOC branch.
 * @adr 0536
 */
export async function pickTask(
  root: string,
  rootBase: RepoBase,
  opts: { worker: string; ttlHours: number; maxAttempts: number; skip?: Set<string>; profileDir?: string; blockedGroups?: ReadonlySet<string> },
): Promise<Candidate | null> {
  // A team-restricted worker only takes its teams' tasks (ADR-0450).
  const served = (team: string | undefined): boolean => (opts.profileDir ? servesTeam(opts.profileDir, team) : true);
  const [todo, prog, done, qa, attempts, approved, docs] = await Promise.all([
    B.readBook(root, "AI_TODO.md"),
    B.readBook(root, "AI_PROGRESS.md"),
    B.readBook(root, "AI_DONE.md"),
    B.readBook(root, "USER_QA.md"),
    B.readAttempts(root),
    approvedIds(root),
    readDocs(root),
  ]);
  const claims = B.parseClaims(prog).claims;
  const skip = opts.skip ?? new Set<string>();
  // 1. Expired claims (a dead / overrun worker) — take over, resuming its WIP branch.
  for (const c of claims) {
    if (skip.has(c.id) || c.worker === opts.worker || claimAgeHours(c) < opts.ttlHours) continue;
    const snap = attempts[c.id]?.task;
    const task = snap ?? { id: c.id, priority: "Medium", tag: "", depends: [], group: groupOf(c.id), desc: c.desc, notes: "", team: c.team ?? "" };
    if (!served(task.team)) continue;
    return { task, takeover: c, from: null };
  }
  // 2. Fresh tasks.
  const doneMap = B.doneRows(done);
  const qaRows = new Map(B.parseQa(qa).rows.map((q) => [q.id, q]));
  const claimed = new Set(claims.map((c) => c.id));
  const rank = (p: string): number => ({ high: 0, medium: 1, low: 2 })[p.trim().toLowerCase()] ?? 1;
  const groupNum = (id: string): number => Number(/^(?:TSK|DOC)-(\d+)/.exec(id)?.[1] ?? 9999);
  const tasks = B.parseTasks(todo)
    .tasks.map((t, i) => ({ t, i }))
    .sort((a, b) => groupNum(a.t.id) - groupNum(b.t.id) || rank(a.t.priority) - rank(b.t.priority) || a.i - b.i);
  for (const { t } of tasks) {
    if (skip.has(t.id) || claimed.has(t.id) || !approved.has(t.id) || !served(t.team)) continue;
    const isDoc = t.id.startsWith("DOC-");
    if (isDoc && !docRunnable(docs, t.id)) continue;
    if (!isDoc && opts.blockedGroups?.has(/^(TSK-\d{6})-/.exec(t.id)?.[1] ?? "")) continue;
    const a = attempts[t.id];
    if (a && (a.splitPending || a.blocked || a.count >= opts.maxAttempts)) continue;
    // QA deps: answered + approved, or already folded (a `State` — ADR-0562 — or absent: QA ids are never reused).
    const qaOk = t.depends
      .filter((d) => d.startsWith("QA-"))
      .every((d) => {
        const q = qaRows.get(d);
        return !q || !B.qaOpen(q) || (q.answer.trim().length > 0 && approved.has(d));
      });
    if (!qaOk) continue;
    const docDeps = t.depends.filter((d) => d.startsWith("DOC-"));
    if (docDeps.some((d) => !doneMap.has(d))) continue;
    const deps = t.depends.filter((d) => d.startsWith("TSK-"));
    if (deps.some((d) => !doneMap.has(d))) continue;
    let from: string | null = null;
    if (deps.length === 0 && docDeps.length === 1) {
      // The accepted docs of the request: continue from the DOC branch until a task PR carries them into <base>.
      const dep = docDeps[0]!;
      const branch = doneBranch(doneMap.get(dep) ?? "") ?? taskBranch(rootBase.base, dep);
      if (!(await isMerged(root, rootBase.url, branch, rootBase.base))) from = branch;
    } else if (deps.length === 1) {
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
  const row: B.ClaimRow = { started: mine.started, id: cand.task.id, team: cand.task.team ?? "", worker: mine.worker, claim: mine.claim, attempt: mine.attempt, desc: cand.task.desc };
  await B.writeBook(root, "AI_PROGRESS.md", B.writeClaims(prog, [...claims.filter((c) => c.id !== cand.task.id), row]));
  if (cand.takeover) attempts[cand.task.id] = { ...attempts[cand.task.id]!, task: attempts[cand.task.id]?.task ?? cand.task };
  await B.writeAttempts(root, attempts);
  if (incident) await B.writeBook(root, "AI_DONE.md", B.appendIncident(done, incident));
  return true;
}

/** Remove this worker's claim row; false when it is no longer ours (lost). */
export async function dropClaim(root: string, mine: LocalClaim): Promise<boolean> {
  const prog = await B.readBook(root, "AI_PROGRESS.md");
  const claims = B.parseClaims(prog).claims;
  const row = claims.find((c) => c.id === mine.id);
  if (!row || row.claim !== mine.claim) return false;
  await B.writeBook(root, "AI_PROGRESS.md", B.writeClaims(prog, claims.filter((c) => c.id !== mine.id)));
  return true;
}

/**
 * Release a task whose approval was withdrawn while it ran: drop the claim and put the row back in `AI_TODO`
 * unchanged (the person edits / re-approves it). No attempt is counted — the stop was a person's choice.
 * @adr 0538
 */
export async function applyUnapprovedRelease(root: string, mine: LocalClaim): Promise<boolean> {
  if (!(await dropClaim(root, mine))) return false;
  const todo = await B.readBook(root, "AI_TODO.md");
  const { tasks } = B.parseTasks(todo);
  await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, [...tasks.filter((t) => t.id !== mine.id), mine.task]));
  await B.writeBook(
    root,
    "AI_DONE.md",
    B.appendIncident(await B.readBook(root, "AI_DONE.md"), `${mine.id} was unapproved while ${mine.worker} ran it — stopped, returned to AI_TODO (WIP pushed on ${mine.branch}).`),
  );
  return true;
}

/**
 * Release a task whose branch conflicts with `<base>` (the agent could not resolve it): drop the claim, put the
 * row back in `AI_TODO` with a note, and mark it blocked in the attempts sidecar — no attempt is counted (a split
 * cannot fix a conflict). A person resolves on the branch and presses Retry.
 * @adr 0539 §2
 */
export async function applyBlockedRelease(root: string, mine: LocalClaim, at: { base: string; head: string }): Promise<boolean> {
  if (!(await dropClaim(root, mine))) return false;
  const attempts = await B.readAttempts(root);
  attempts[mine.id] = {
    ...(attempts[mine.id] ?? { count: 0, last: "", at: "" }),
    blocked: { reason: "merge-conflict", at: new Date().toISOString(), base: at.base, head: at.head },
  };
  await B.writeAttempts(root, attempts);
  const todo = await B.readBook(root, "AI_TODO.md");
  const { tasks } = B.parseTasks(todo);
  const back: B.TaskRow = { ...mine.task, notes: appendNote(mine.task.notes, `blocked: conflicts with ${mine.base}; WIP on ${mine.branch}`) };
  await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, [...tasks.filter((t) => t.id !== mine.id), back]));
  await B.writeBook(
    root,
    "AI_DONE.md",
    B.appendIncident(await B.readBook(root, "AI_DONE.md"), `${mine.id}: merging ${mine.base} into ${mine.branch} conflicts and the AI could not resolve it — blocked until a person resolves it and presses Retry.`),
  );
  return true;
}

/** Clear the `blocked` mark of `ids` (Retry, or the branch merges cleanly again). Returns whether any was set. @adr 0539 */
export async function applyUnblock(root: string, ids: readonly string[]): Promise<boolean> {
  const attempts = await B.readAttempts(root);
  let changed = false;
  for (const id of ids) {
    const a = attempts[id];
    if (!a?.blocked) continue;
    delete a.blocked;
    changed = true;
  }
  if (changed) await B.writeAttempts(root, attempts);
  return changed;
}

/** Is `id` still finally approved in an approvals sidecar text? Null when the text is unreadable. @adr 0538 */
export function stillApproved(approvalsText: string, id: string): boolean | null {
  if (!approvalsText.trim()) return null;
  try {
    const map = JSON.parse(approvalsText) as Record<string, unknown>;
    return approvalEntrySchema.safeParse(map[id]).success;
  } catch {
    return null;
  }
}

/** A Notes cell without the cli's own `attempt N ended: …` / `blocked: …` remarks (`…; WIP on <branch>`). */
function userNotes(notes: string): string {
  return notes
    .replace(/(?:^|;\s*)(?:attempt \d+ ended: .*?|blocked: conflicts with \S+); WIP on \S+/g, "")
    .replace(/^;\s*/, "")
    .trim();
}

/**
 * The previous task text when it differs from the claimed one (description or person-written notes), for the
 * implement prompt of a resumed task; "" when unchanged or unknown. @adr 0538
 */
export function previousTaskText(mine: LocalClaim): string {
  const prev = mine.prevTask;
  if (!prev) return "";
  const same = prev.desc.trim() === mine.task.desc.trim() && userNotes(prev.notes) === userNotes(mine.task.notes);
  return same ? "" : `Task description: ${prev.desc}\nNotes: ${userNotes(prev.notes) || "(none)"}`;
}

/**
 * Finish: claim → `AI_DONE` with branch + PR links; attempts cleared. The task's
 * attachments move from `AI_TODO/<TSK>/` to `AI_DONE/<TSK>/` and, with the agent's own files on the task
 * branch, fill the `Evidence` column.
 * @adr 0404
 */
export async function applyFinish(
  root: string,
  mine: LocalClaim,
  done: { files: string; notes: string; evidence: string[] },
  evRoot: string,
): Promise<boolean> {
  if (!(await dropClaim(root, mine))) return false;
  const moved = await moveTaskEvidence(root, mine.id, evRoot);
  await B.writeBook(root, "AI_DONE.md", B.appendDone(await B.readBook(root, "AI_DONE.md"), { id: mine.id, title: mine.task.title ?? "", team: mine.task.team ?? "", tags: mine.task.tags ?? "", due: mine.task.due ?? "", group: mine.task.group, depends: mine.task.depends, desc: rehomeTaskLinks(mine.task.desc, mine.id), files: done.files, evidence: evidenceCell([...moved, ...done.evidence]), notes: done.notes }));
  const attempts = await B.readAttempts(root);
  delete attempts[mine.id];
  await B.writeAttempts(root, attempts);
  return true;
}

/**
 * Release (failure / overrun): the task goes back to `AI_TODO` (a note appended), attempts+1,
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
  return `${prefix}-${group}-${String(max + 1).padStart(3, "0")}`;
}

/** Append to a Notes cell. */
function appendNote(notes: string, add: string): string {
  return notes.trim() ? `${notes.trim()}; ${add}` : add;
}

/**
 * Task question: a `USER_QA` row for the decision, its id added to the task's `Depends`, the
 * task back in `AI_TODO` (no attempt counted). Returns the QA id, or null when the claim is no longer ours.
 */
export async function applyQuestion(root: string, mine: LocalClaim, question: string, resetAttempts = false): Promise<string | null> {
  if (!(await dropClaim(root, mine))) return null;
  if (resetAttempts) {
    // A split child that hit the limit becomes a human decision: once answered it may run again.
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
  const g = /^(?:TSK|DOC)-(\d+)/.exec(mine.id)?.[1] ?? "000000";
  const qaId = nextId("QA", g, [qa, todo, done, attemptsText]);
  const { rows } = B.parseQa(qa);
  const qaDeps = mine.task.depends.filter((d) => d.startsWith("QA-")).join(", ");
  await B.writeBook(root, "USER_QA.md", B.writeQa(qa, [...rows, { id: qaId, title: mine.task.title ? `Question: ${mine.task.title}` : "", team: mine.task.team ?? "", tags: mine.task.tags ?? "", due: mine.task.due ?? "", group: mine.task.group, depends: qaDeps, original: `${mine.id}: ${mine.task.desc}`, question, answer: "" }]));
  const { tasks } = B.parseTasks(todo);
  const back: B.TaskRow = { ...mine.task, depends: [...mine.task.depends.filter((d) => d !== qaId), qaId], notes: appendNote(mine.task.notes, `waiting for ${qaId}; WIP on ${mine.branch}`) };
  await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, [...tasks.filter((t) => t.id !== mine.id), back]));
  return qaId;
}

/**
 * Fold task-question answers: each answered + approved open `QA-…` that some task depends on is
 * appended to those tasks' Notes and kept in `USER_QA` with `State` = `Done` (a folded / absent QA counts as
 * resolved). Returns true when the books changed. Intake questions (no dependent task) are left for the intake agent.
 * @adr 0562
 */
export async function foldTaskAnswers(root: string): Promise<boolean> {
  const [todo, qa, approved] = await Promise.all([B.readBook(root, "AI_TODO.md"), B.readBook(root, "USER_QA.md"), approvedIds(root)]);
  const { tasks } = B.parseTasks(todo);
  const { rows } = B.parseQa(qa);
  const answered = rows.filter((q) => B.qaOpen(q) && q.answer.trim() && approved.has(q.id) && tasks.some((t) => t.depends.includes(q.id)));
  if (answered.length === 0) return false;
  const byId = new Map(answered.map((q) => [q.id, q]));
  const next = tasks.map((t) => {
    const add = t.depends.filter((d) => byId.has(d)).map((d) => `answer ${d}: ${byId.get(d)!.answer}`);
    return add.length ? { ...t, notes: appendNote(t.notes, add.join("; ")) } : t;
  });
  await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, next));
  await B.writeBook(root, "USER_QA.md", B.writeQa(qa, rows.map((q) => (byId.has(q.id) ? { ...q, state: BOOK_STATE.done } : q))));
  return true;
}

/**
 * `waitingOf(requestId)` — what a USER_TODO request's `Depends` still wait on (`buildDependsWaiting` over the working
 * tree books + lineage): a request whose dependency is not finished is not taken in yet.
 * @adr 0561
 */
export async function requestWaiting(root: string): Promise<(id: string) => WaitingItem[]> {
  const [userTodo, todo, qa, done, prog, lineage] = await Promise.all([
    B.readBook(root, "USER_TODO.md"),
    B.readBook(root, "AI_TODO.md"),
    B.readBook(root, "USER_QA.md"),
    B.readBook(root, "AI_DONE.md"),
    B.readBook(root, "AI_PROGRESS.md"),
    readLineage(root),
  ]);
  const waitingOf = buildDependsWaiting({
    pendingRequests: new Set(B.openRowIds(userTodo, "REQ-")),
    openIds: [
      ...B.parseTasks(todo).tasks.map((t) => t.id),
      ...B.parseClaims(prog).claims.map((c) => c.id),
      ...B.parseQa(qa).rows.filter(B.qaOpen).map((q) => q.id),
    ],
    doneIds: new Set(B.doneRows(done).keys()),
    lineage,
  });
  const deps = B.requestDepends(userTodo);
  return (id) => waitingOf(deps.get(id) ?? []);
}

/**
 * Mark finished history: a `Taken in` request / question becomes `Done` once no row of the groups made from it
 * (lineage) is open any more — every task / doc in AI_DONE, no claim, no open question. True when a book changed
 * (run inside `publishBooks`).
 * @adr 0562
 */
export async function markDoneRows(root: string): Promise<boolean> {
  const [userTodo, todo, qa, done, prog, lineage] = await Promise.all([
    B.readBook(root, "USER_TODO.md"),
    B.readBook(root, "AI_TODO.md"),
    B.readBook(root, "USER_QA.md"),
    B.readBook(root, "AI_DONE.md"),
    B.readBook(root, "AI_PROGRESS.md"),
    readLineage(root),
  ]);
  const waitingOf = buildDependsWaiting({
    pendingRequests: new Set(),
    openIds: [
      ...B.parseTasks(todo).tasks.map((t) => t.id),
      ...B.parseClaims(prog).claims.map((c) => c.id),
      ...B.parseQa(qa).rows.filter(B.qaOpen).map((q) => q.id),
    ],
    doneIds: new Set(B.doneRows(done).keys()),
    lineage,
  });
  let changed = false;
  for (const [rel, md] of [
    ["USER_TODO.md", userTodo],
    ["USER_QA.md", qa],
  ] as const) {
    const finished = new Map<string, string>();
    for (const [id, state] of bookRowStates(md)) {
      if (state === BOOK_STATE.takenIn && waitingOf([id]).length === 0) finished.set(id, BOOK_STATE.done);
    }
    const next = B.setRowStates(md, finished);
    if (next !== md) {
      await B.writeBook(root, rel, next);
      changed = true;
    }
  }
  return changed;
}

/**
 * The intake work this worker may take: approved `REQ-…` whose `Depends` are finished and answered +
 * approved intake `QA-…` ids — of the teams it serves. Empty = nothing to do.
 * @adr 0450 @adr 0561
 */
export async function intakeIds(root: string, profileDir?: string): Promise<string[]> {
  const [userTodo, todo, qa, approved, waiting] = await Promise.all([
    B.readBook(root, "USER_TODO.md"),
    B.readBook(root, "AI_TODO.md"),
    B.readBook(root, "USER_QA.md"),
    approvedIds(root),
    requestWaiting(root),
  ]);
  const served = (md: string, id: string): boolean => (profileDir ? servesTeam(profileDir, bookRowTeam(md, id)) : true);
  const open = new Set(B.openRowIds(userTodo, "REQ-"));
  const reqs = [...approved].filter((id) => open.has(id) && served(userTodo, id) && waiting(id).length === 0);
  const taskDeps = new Set(B.parseTasks(todo).tasks.flatMap((t) => t.depends));
  const qas = B.parseQa(qa)
    .rows.filter((q) => B.qaOpen(q) && !taskDeps.has(q.id) && q.answer.trim() && approved.has(q.id) && served(qa, q.id))
    .map((q) => q.id);
  return [...reqs, ...qas].sort();
}

/**
 * The ids one intake run takes in: the first `size` of `free` (book order), plus any free answered question whose
 * `Depends` names a picked request — an answer never waits apart from its request.
 * @adr 0554
 */
export function intakeBatch(free: string[], size: number, qaMd: string): string[] {
  const picked = free.slice(0, Math.max(1, size));
  const pickedSet = new Set(picked);
  const deps = new Map(B.parseQa(qaMd).rows.map((q) => [q.id, q.depends]));
  for (const id of free) {
    if (pickedSet.has(id) || !id.startsWith("QA-")) continue;
    const on = (deps.get(id) ?? "").split(/[,\s]+/).filter(Boolean);
    if (on.some((d) => pickedSet.has(d))) {
      picked.push(id);
      pickedSet.add(id);
    }
  }
  return picked;
}

/** What a worker waits for: rows people must act on before a cycle can take them. @adr 0529 */
export interface WaitingCounts {
  /** Requests, tasks and answered questions not approved yet. */
  approval: number;
  /** ER change requests that still block their group (counted by the caller). */
  changeRequests: number;
  /** Tasks waiting on an unanswered question. */
  answers: number;
  /** Approved tasks waiting on unfinished tasks, and approved requests waiting on unfinished dependencies. @adr 0561 */
  dependencies: number;
  /** Approved tasks blocked by a merge conflict with their base. @adr 0539 */
  blocked: number;
}

/**
 * Count the served rows waiting on people — the same rules as `intakeIds` / `pickTask`: unapproved
 * `REQ-…` / `TSK-…` / `DOC-…` / answered `QA-…` and DOC rounds waiting for their review, tasks whose `QA-…`
 * dependency is unanswered (or unapproved), approved tasks whose `TSK-…` / `DOC-…` dependency is not done, and approved
 * requests whose `Depends` are not finished (`requestWaiting`).
 * `changeRequests` is the blocking ER change requests, counted by the caller.
 * @adr 0529 @adr 0453 @adr 0536 @adr 0561
 */
export async function waitingCounts(root: string, profileDir: string | undefined, changeRequests: number): Promise<WaitingCounts> {
  const [userTodo, todo, qa, done, approved, attempts, docs, waiting] = await Promise.all([
    B.readBook(root, "USER_TODO.md"),
    B.readBook(root, "AI_TODO.md"),
    B.readBook(root, "USER_QA.md"),
    B.readBook(root, "AI_DONE.md"),
    approvedIds(root),
    B.readAttempts(root),
    readDocs(root),
    requestWaiting(root),
  ]);
  const served = (team: string | undefined): boolean => (profileDir ? servesTeam(profileDir, team) : true);
  const reqIds = B.openRowIds(userTodo, "REQ-").filter((id) => served(bookRowTeam(userTodo, id)));
  const tasks = B.parseTasks(todo).tasks.filter((t) => served(t.team));
  const qaRows = B.parseQa(qa).rows.filter((q) => B.qaOpen(q) && served(q.team));
  const qaById = new Map(qaRows.map((q) => [q.id, q]));
  const doneMap = B.doneRows(done);
  let approval = reqIds.filter((id) => !approved.has(id)).length;
  // A DOC round waiting for its review is waiting on a person's approval too (ADR-0536).
  approval += tasks.filter((t) => !approved.has(t.id) || docs[t.id]?.state === "review").length;
  approval += qaRows.filter((q) => q.answer.trim() && !approved.has(q.id)).length;
  let answers = 0;
  let dependencies = 0;
  let blocked = 0;
  // Approved requests held back from intake by an unfinished dependency (ADR-0561).
  dependencies += reqIds.filter((id) => approved.has(id) && waiting(id).length > 0).length;
  for (const t of tasks) {
    if (!approved.has(t.id) || docs[t.id]?.state === "review") continue;
    if (attempts[t.id]?.blocked) {
      blocked++;
      continue;
    }
    const qaWait = t.depends.some((d) => {
      const q = d.startsWith("QA-") ? qaById.get(d) : undefined;
      return !!q && !(q.answer.trim() && approved.has(d));
    });
    if (qaWait) answers++;
    else if (t.depends.some((d) => /^(?:TSK|DOC)-/.test(d) && !doneMap.has(d))) dependencies++;
  }
  return { approval, changeRequests, answers, dependencies, blocked };
}

/** Is anything waiting on people? */
export function anyWaiting(w: WaitingCounts): boolean {
  return w.approval + w.changeRequests + w.answers + w.dependencies + w.blocked > 0;
}

/** Is there intake work for this worker (an approved request / answered question of its teams)? */
export async function hasIntakeWork(root: string, profileDir?: string): Promise<boolean> {
  return (await intakeIds(root, profileDir)).length > 0;
}

/**
 * Auto-split, applied by the worker holding the parent's claim: child tasks (same group, new
 * ids, chained `Depends`; the first inherits the parent's deps + continues from its WIP branch) go to
 * `AI_TODO` unapproved; the parent moves to `AI_DONE` as "split into …". Returns the child ids.
 */
export async function applySplit(
  root: string,
  mine: LocalClaim,
  children: { desc: string; title?: string; priority?: string; notes?: string; size?: string }[],
  evRoot: string,
): Promise<string[] | null> {
  if (!(await dropClaim(root, mine))) return null;
  const [todo, done, prog] = await Promise.all([B.readBook(root, "AI_TODO.md"), B.readBook(root, "AI_DONE.md"), B.readBook(root, "AI_PROGRESS.md")]);
  const g = /^(?:TSK|DOC)-(\d+)/.exec(mine.id)?.[1] ?? "000000";
  const texts = [todo, done, prog, mine.id];
  const ids: string[] = [];
  const rows: B.TaskRow[] = children.map((c, i) => {
    const id = nextId("TSK", g, [...texts, ...ids]);
    ids.push(id);
    const deps = i === 0 ? mine.task.depends : [ids[i - 1]!];
    const notes = [c.size ? `size: ${c.size}` : "", c.notes ?? "", `split from ${mine.id}`, i === 0 ? `from: ${mine.branch}` : ""].filter(Boolean).join("; ");
    // A split child keeps its parent's team, tags and due date (ADR-0450 / ADR-0543).
    return { id, title: c.title ?? "", priority: c.priority || mine.task.priority || "Medium", tag: "", depends: deps, group: mine.task.group, desc: c.desc, notes, team: mine.task.team ?? "", tags: mine.task.tags ?? "", due: mine.task.due ?? "" };
  });
  const { tasks } = B.parseTasks(todo);
  await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, [...tasks, ...rows]));
  // The parent's attachments follow it to AI Done (ADR-0404); the books' links are rewritten in place.
  const moved = await moveTaskEvidence(root, mine.id, evRoot);
  await B.writeBook(root, "AI_DONE.md", B.appendDone(await B.readBook(root, "AI_DONE.md"), { id: mine.id, title: mine.task.title ?? "", team: mine.task.team ?? "", tags: mine.task.tags ?? "", due: mine.task.due ?? "", group: mine.task.group, depends: mine.task.depends, desc: rehomeTaskLinks(mine.task.desc, mine.id), files: "", evidence: evidenceCell(moved), notes: `split into ${ids.join(", ")} (after repeated attempts); WIP on ${mine.branch}` }));
  const attempts = await B.readAttempts(root);
  delete attempts[mine.id];
  await B.writeAttempts(root, attempts);
  return ids;
}

/** Was this task itself produced by a split (then it is never split again)? */
export function isSplitChild(task: B.TaskRow): boolean {
  return /split from TSK-/.test(task.notes);
}
