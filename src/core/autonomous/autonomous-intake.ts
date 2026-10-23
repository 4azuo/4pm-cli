/**
 * Intake on its own branch — a request (or an answered intake question) is taken in like a task: the agent works on
 * `dev/<base>/<GROUP>/<ID>` with the books as a read-only overlay, writes its new tasks / questions into the overlay
 * books, mockups and sequences as files and ER / system-diagram change requests as `*-NEW-<k>` files. The cli then
 * turns the overlay edits into an **intake patch** (new rows, the requests it took in, the change requests, the
 * lineage sources) and applies it to the books branch inside the publish — re-applied on every push retry, so
 * parallel intakes never race. The mockups / sequences stay on the branch and reach `<base>` with its PR. A patch not
 * published yet rides the WIP branch as `.4pm/wip/<ID>.books.json`, re-applied by whichever worker resumes.
 * @adr 0563 @adr 0455 @adr 0562
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BOOK_STATE,
  WIP_DIR,
  bookGroupCode,
  bookGroupOf,
  bookRowTeam,
  type DeliveryRecord,
  type SpecDocs,
  parseAssetItems,
  type AssetItem,
} from "@4pm/dto";
import * as B from "./autonomous-books";
import { cappedBookIds } from "./autonomous";
import type { AutonomousConfig } from "./autonomous-config";
import { addAssetRow, addDocRows, addScopeDocRow, fillIntakeMeta, intakeSources, readLineage, recordIntakeLineage, writeLineage, type IntakeSource } from "./autonomous-docs";
import { captureAgentErcs, publishIntakeErcs } from "./autonomous-er";
import { captureAgentSdcs, publishIntakeSdcs } from "./autonomous-diagram";
import { AUTHORS_REL, readJsonMap, type NewErcFile } from "./autonomous-er-store";
import type { NewSdcFile } from "./autonomous-diagram-store";
import { dropClaim, type LocalClaim } from "./autonomous-tasks";
import { servedTeams } from "./autonomous-teams";
import { readFileInRoot, writeFileInRoot } from "../../utils/safe-path";
import { requestScopeTags } from "@4pm/constants";

/** The books state of an overlay before the intake agent ran. */
export interface IntakeBefore {
  /** Row ids per book before the run. */
  ids: Awaited<ReturnType<typeof cappedBookIds>>;
  /** USER_TODO / USER_QA as they were (history rows included — the agent sees them stripped). */
  userTodo: string;
  userQa: string;
  sources: IntakeSource[];
}

/** What one intake run produced, applied to the books branch by the publish. */
export interface IntakePatch {
  /** The request / intake question taken in. */
  id: string;
  groups: number[];
  tasks: B.TaskRow[];
  questions: B.QaRow[];
  /** The intake ids the agent took in (they get `State = Taken in`). */
  taken: string[];
  sources: IntakeSource[];
  ercs: NewErcFile[];
  sdcs: NewSdcFile[];
  /** The asset plan the agent wrote (`.4pm/assets-plan.json`) — becomes the group's `AST-…` row. @adr 0615 */
  assets?: { items: AssetItem[]; usedBy: string[] };
}

/** Where the intake agent writes its asset plan (read, then removed, before anything is committed). @adr 0615 */
export const ASSET_PLAN_REL = ".4pm/assets-plan.json";

/** Read and remove the agent's asset plan. */
async function captureAssetPlan(root: string): Promise<IntakePatch["assets"]> {
  const text = await readFileInRoot(root, join(root, ASSET_PLAN_REL), "utf8").catch(() => "");
  if (!text) return undefined;
  await rm(join(root, ASSET_PLAN_REL), { force: true }).catch(() => undefined);
  try {
    const o = JSON.parse(text) as { items?: unknown; usedBy?: unknown };
    const items = parseAssetItems(o.items);
    const usedBy = Array.isArray(o.usedBy) ? o.usedBy.filter((x): x is string => typeof x === "string") : [];
    return items.length ? { items, usedBy } : undefined;
  } catch {
    return undefined;
  }
}

/** The WIP file of an intake patch on its branch. */
export function intakeWipRel(id: string): string {
  return `${WIP_DIR}/${id}.books.json`;
}

/**
 * Prepare the overlay books for the intake agent: add the `Title` columns it fills, hide the history rows (a `State`
 * — ADR-0562), and remember what was there.
 * @adr 0549 @adr 0562
 */
export async function prepareIntakeOverlay(root: string, ids: readonly string[]): Promise<IntakeBefore> {
  await B.addTitleColumns(root);
  const [userTodo, userQa] = await Promise.all([B.readBook(root, "USER_TODO.md"), B.readBook(root, "USER_QA.md")]);
  const strippedTodo = B.stripStateRows(userTodo);
  const strippedQa = B.stripStateRows(userQa);
  if (strippedTodo !== userTodo) await B.writeBook(root, "USER_TODO.md", strippedTodo);
  if (strippedQa !== userQa) await B.writeBook(root, "USER_QA.md", strippedQa);
  const authors = (await readJsonMap(root, AUTHORS_REL)) as Record<string, { by?: string }>;
  return { ids: await cappedBookIds(root), userTodo, userQa, sources: intakeSources(ids, userTodo, userQa, authors) };
}

/** The new AI_TODO / USER_QA ids whose group is not one of `groups`. @adr 0455 */
async function strayIds(root: string, before: IntakeBefore["ids"], groups: readonly number[]): Promise<string[]> {
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

/**
 * Give the new rows a `Team` when the agent left it empty and the team is unambiguous: the worker serves exactly one
 * team, or every source shares one.
 * @adr 0450
 */
async function fillIntakeTeams(root: string, profileDir: string, sources: readonly IntakeSource[], before: IntakeBefore["ids"]): Promise<void> {
  const served = servedTeams(profileDir);
  const sourceTeams = new Set(sources.map((s) => s.team).filter(Boolean));
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

/**
 * Read the intake agent's result from the overlay into a patch: its new task / question rows (teams, tags / due and
 * titles filled in like before), the intake ids it took in (their rows removed by the agent), its new change requests.
 * Null when it used a group it was not given (the whole run is discarded and re-done).
 * @adr 0563 @adr 0455
 */
export async function captureIntakePatch(
  root: string,
  profileDir: string,
  cfg: Pick<AutonomousConfig, "erDir" | "diagramDir">,
  mine: LocalClaim,
  before: IntakeBefore,
): Promise<{ patch: IntakePatch } | { stray: string[] } | { outOfScope: string[] }> {
  const groups = mine.groups ?? [];
  const stray = await strayIds(root, before.ids, groups);
  if (stray.length) return { stray };
  await fillIntakeTeams(root, profileDir, before.sources, before.ids);
  await fillIntakeMeta(root, before.sources, groups, before.ids);
  await B.clampBookTitles(root);
  const [todo, qa, userTodoNow, userQaNow] = await Promise.all([
    B.readBook(root, "AI_TODO.md"),
    B.readBook(root, "USER_QA.md"),
    B.readBook(root, "USER_TODO.md"),
    B.readBook(root, "USER_QA.md"),
  ]);
  const tasks = B.parseTasks(todo).tasks.filter((t) => !before.ids.AI_TODO.has(t.id) && t.id.startsWith("TSK-"));
  const questions = B.parseQa(qa).rows.filter((q) => !before.ids.USER_QA.has(q.id));
  const assets = await captureAssetPlan(root);
  // A `docs-only` / `asset-only` request (ADR-0613, ADR-0615) gets no tasks: a run that wrote some is discarded and re-done.
  const scoped = before.sources.some((s) => requestScopeTags(s.tags).length > 0);
  if (tasks.length && scoped) return { outOfScope: tasks.map((t) => t.id) };
  // An `asset-only` request that produced no asset plan did nothing it was asked for.
  if (!assets && before.sources.some((s) => requestScopeTags(s.tags).includes("asset-only"))) return { outOfScope: ["(no asset plan)"] };
  // The agent removes each row it analysed (ADR-0562 keeps them, with a State, on the books branch).
  const still = new Set([...B.openRowIds(userTodoNow, "REQ-"), ...B.openRowIds(userQaNow, "QA-")]);
  const taken = [mine.id].filter((id) => !still.has(id));
  return {
    patch: {
      id: mine.id,
      groups,
      tasks,
      questions,
      taken,
      sources: before.sources,
      ercs: await captureAgentErcs(root, cfg.erDir),
      sdcs: await captureAgentSdcs(root, cfg.diagramDir),
      ...(assets ? { assets } : {}),
    },
  };
}

/** Append the patch's rows to a books checkout (ids already there are left alone). */
async function appendPatchRows(dir: string, patch: Pick<IntakePatch, "tasks" | "questions">): Promise<void> {
  if (patch.tasks.length) {
    const todo = await B.readBook(dir, "AI_TODO.md");
    const md = B.withTitleColumns(todo);
    const { tasks } = B.parseTasks(md);
    const have = new Set(tasks.map((t) => t.id));
    const add = patch.tasks.filter((t) => !have.has(t.id));
    if (add.length) await B.writeBook(dir, "AI_TODO.md", B.writeTasks(md, [...tasks, ...add]));
  }
  if (patch.questions.length) {
    const qa = await B.readBook(dir, "USER_QA.md");
    const md = B.withTitleColumns(qa);
    const { rows } = B.parseQa(md);
    const have = new Set(rows.map((q) => q.id));
    const add = patch.questions.filter((q) => !have.has(q.id));
    if (add.length) await B.writeBook(dir, "USER_QA.md", B.writeQa(md, [...rows, ...add]));
  }
}

/** Put a WIP patch back into a fresh overlay (a resumed intake sees the rows it wrote before). */
export async function restoreIntakeWip(root: string, cfg: Pick<AutonomousConfig, "erDir" | "diagramDir">, patch: IntakePatch): Promise<void> {
  await appendPatchRows(root, patch);
  for (const f of patch.ercs) await writeFileInRoot(root, join(root, `${cfg.erDir}/changes/${f.name}`), f.content);
  for (const f of patch.sdcs) await writeFileInRoot(root, join(root, `${cfg.diagramDir}/changes/${f.name}`), f.content);
}

/** Read the WIP patch committed on the checked-out intake branch (null when none / unreadable). */
export async function readIntakeWip(root: string, id: string): Promise<IntakePatch | null> {
  try {
    const p = JSON.parse(await readFileInRoot(root, join(root, intakeWipRel(id)), "utf8")) as IntakePatch;
    return p && p.id === id && Array.isArray(p.tasks) ? p : null;
  } catch {
    return null;
  }
}

/** Write the WIP patch into the working tree (committed with the WIP). */
export async function writeIntakeWip(root: string, patch: IntakePatch): Promise<void> {
  await writeFileInRoot(root, join(root, intakeWipRel(patch.id)), `${JSON.stringify(patch, null, 2)}\n`);
}

/** What the intake publish wrote. */
export interface IntakePublished {
  ercs: string[];
  sdcs: string[];
  docIds: string[];
  skipped: { name: string; reason: string }[];
}

/**
 * Apply an intake patch to the books checkout `dir` (inside `publishBooks`, on every attempt): drop this worker's
 * claim (false when lost), append the new rows, mark the taken-in rows `Taken in`, number + publish the change
 * requests, record the lineage (with the request PR as its `delivery`), add one DOC row per new task group, and clear
 * the attempts entry. `out` collects what was written.
 * @adr 0563 @adr 0536 @adr 0537
 */
export async function applyIntakePatch(
  dir: string,
  patch: IntakePatch,
  mine: LocalClaim,
  cfg: Pick<AutonomousConfig, "erDir" | "diagramDir" | "erAutoApprove" | "diagramAutoApprove" | "docsPhase">,
  spec: SpecDocs,
  delivery: DeliveryRecord | undefined,
  out: IntakePublished,
): Promise<boolean> {
  if (!(await dropClaim(dir, mine))) return false;
  const beforeTodo = new Set(B.parseTasks(await B.readBook(dir, "AI_TODO.md")).tasks.map((t) => t.id));
  await appendPatchRows(dir, patch);
  if (patch.taken.length) {
    const states = new Map(patch.taken.map((id) => [id, BOOK_STATE.takenIn] as const));
    for (const rel of ["USER_TODO.md", "USER_QA.md"] as const) {
      const md = await B.readBook(dir, rel);
      const next = B.setRowStates(md, states);
      if (next !== md) await B.writeBook(dir, rel, next);
    }
  }
  const team = patch.sources[0]?.team || undefined;
  const er = await publishIntakeErcs(dir, cfg.erDir, patch.ercs, team, cfg.erAutoApprove);
  const sd = await publishIntakeSdcs(dir, cfg, patch.sdcs, team);
  out.ercs = er.created;
  out.sdcs = sd.created;
  out.skipped = [...er.skipped, ...sd.skipped];
  const used = new Set([...patch.tasks.map((t) => bookGroupOf(t.id) ?? ""), ...patch.questions.map((q) => bookGroupOf(q.id) ?? "")].filter(Boolean));
  await recordIntakeLineage(dir, patch.sources, patch.groups, used);
  if (delivery) {
    const lin = await readLineage(dir);
    for (const g of used) if (lin[g]) lin[g] = { ...lin[g]!, delivery };
    await writeLineage(dir, lin);
  }
  out.docIds = [];
  if (cfg.docsPhase && spec.types.length) {
    out.docIds = await addDocRows(dir, beforeTodo, spec, (g) => patch.sources[patch.groups.findIndex((x) => bookGroupCode(x) === g)]);
  }
  // The asset plan (ADR-0615): the group's AST row, waited for by the tasks that use the assets.
  if (patch.assets?.items.length) {
    const taskGroup = patch.tasks.map((t) => bookGroupOf(t.id) ?? "").find(Boolean);
    const group = taskGroup || (patch.groups[0] !== undefined ? bookGroupCode(patch.groups[0]) : "");
    const src = patch.sources[0];
    if (group && src) {
      const astId = await addAssetRow(dir, group, src, patch.assets.items, patch.assets.usedBy, new Set(patch.tasks.map((t) => t.id)));
      if (astId) {
        out.docIds.push(astId);
        await recordIntakeLineage(dir, patch.sources, patch.groups, new Set([group]));
      }
    }
  }
  // A `docs-only` request (ADR-0613): its DOC row in the first given group, whatever the DOC-phase switch says.
  const docsOnly = patch.sources.find((s) => requestScopeTags(s.tags).includes("docs-only"));
  const docGroup = patch.groups[0] !== undefined ? bookGroupCode(patch.groups[0]) : "";
  if (docsOnly && docGroup) {
    const docId = await addScopeDocRow(dir, docGroup, docsOnly, spec);
    if (docId) {
      out.docIds.push(docId);
      await recordIntakeLineage(dir, patch.sources, patch.groups, new Set([docGroup]));
    }
  }
  const attempts = await B.readAttempts(dir);
  if (attempts[mine.id]) {
    delete attempts[mine.id];
    await B.writeAttempts(dir, attempts);
  }
  return true;
}

/** The team of an intake id in its book. */
export function intakeTeamOf(userTodo: string, userQa: string, id: string): string {
  return bookRowTeam(id.startsWith("REQ-") ? userTodo : userQa, id);
}
