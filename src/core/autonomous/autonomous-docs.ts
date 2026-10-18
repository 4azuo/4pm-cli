/**
 * The DOC phase on the worker: after an intake the cli adds one `DOC-<group>-001` row per new task group (every
 * root task of the group depends on it) and records where each group came from (the lineage sidecar — the
 * request row itself is removed by intake). A DOC round runs the docs agent on `dev/<base>/GRP-<g>/DOC-…`; the cli
 * then numbers the agent's `NEW-<n>-<slug>.md` files from the server's per-type counter, records the round's file
 * manifest and the overlaps with other open DOC rows, and parks the row in `review` until a person reviews it from
 * AI Todo (`bookSave.docReview`): `revise` runs another round, `proceed` moves the DOC to AI Done and releases the
 * group's tasks, which branch from the DOC branch.
 * @adr 0536 @adr 0537
 */
import { join, posix } from "node:path";
import {
  DOCS_SIDECAR_REL,
  DOC_NUMBERED_TYPES,
  DOC_TYPE_DIRS,
  LINEAGE_REQUEST_MAX,
  LINEAGE_SIDECAR_REL,
  NEW_DOC_FILE_RE,
  NUMBERED_DOC_FILE_RE,
  bookGroupCode,
  bookGroupOf,
  docNumberCode,
  docTypeOfPath,
  parseDocsSidecar,
  parseLineage,
  readSpecDocs,
  roundDecision,
  type DocEntry,
  type DocManifestFile,
  type DocReview,
  type DocsSidecar,
  type LineageSidecar,
  type SpecDocs,
} from "@4pm/dto";
import * as B from "./autonomous-books";
import { git, gitQuiet } from "./autonomous-git";
import type { AutonomousEvidenceReply } from "@4pm/ws";
import { readFileInRoot, writeFileInRoot } from "../../utils/safe-path";
import { evidenceCell } from "./autonomous-evidence";

// ── Sidecars ─────────────────────────────────────────────────────────────────────────────────────

/** Read the docs sidecar of a books checkout (`{}` when absent). */
export async function readDocs(root: string): Promise<DocsSidecar> {
  return parseDocsSidecar(await B.readBook(root, DOCS_SIDECAR_REL));
}

/** Write the docs sidecar (sorted, pretty). */
export async function writeDocs(root: string, map: DocsSidecar): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  await writeFileInRoot(root, join(root, DOCS_SIDECAR_REL), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Read the lineage sidecar (`{}` when absent). */
export async function readLineage(root: string): Promise<LineageSidecar> {
  return parseLineage(await B.readBook(root, LINEAGE_SIDECAR_REL));
}

/** Write the lineage sidecar (sorted, pretty). */
export async function writeLineage(root: string, map: LineageSidecar): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  await writeFileInRoot(root, join(root, LINEAGE_SIDECAR_REL), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** True when a DOC row may run now: no entry yet, or its last round was sent back for revision. */
export function docRunnable(docs: DocsSidecar, id: string): boolean {
  const e = docs[id];
  return !e || e.state === "pending";
}

// ── The spec's Docs section ──────────────────────────────────────────────────────────────────────

/** The spec's Docs section as on `origin/<base>` (else the working tree); no types when there is no spec. */
export async function readSpecDocsAt(root: string, base: string): Promise<SpecDocs> {
  let text = "";
  if (base) text = await gitQuiet(root, ["show", `origin/${base}:project.spec.json`]).catch(() => "");
  if (!text.trim()) text = await readFileInRoot(root, join(root, "project.spec.json"), "utf8").catch(() => "");
  try {
    return readSpecDocs(JSON.parse(text || "{}"));
  } catch {
    return { types: [], org: "" };
  }
}

// ── Intake post-step: DOC rows + lineage ─────────────────────────────────────────────────────────

/** Where an intake id came from, read before the intake agent removes its row. */
export interface IntakeSource {
  id: string;
  request: string;
  team: string;
  /** The source row's `Tags` / `Due` cells — copied onto the rows made from it. */
  tags: string;
  due: string;
  /** The source row's `Title` ("" when it has none — ADR-0549). */
  title: string;
}

/** The request text + team of each intake id (`REQ-…` from USER_TODO, an intake `QA-…` from USER_QA). */
export function intakeSources(ids: readonly string[], userTodo: string, userQa: string): IntakeSource[] {
  const qa = new Map(B.parseQa(userQa).rows.map((q) => [q.id, q]));
  return ids.map((id) => {
    if (id.startsWith("REQ-")) {
      return {
        id,
        request: B.requestText(userTodo, id),
        team: cellOf(userTodo, id, "team"),
        tags: cellOf(userTodo, id, "tags"),
        due: cellOf(userTodo, id, "due"),
        title: cellOf(userTodo, id, "title"),
      };
    }
    const q = qa.get(id);
    return { id, request: q ? `${q.original}\nQ: ${q.question}\nA: ${q.answer}` : "", team: q?.team ?? "", tags: q?.tags ?? "", due: q?.due ?? "", title: q?.title ?? "" };
  });
}

/** One cell (`column` lower-cased) of a row, via the books parser; "" when none. */
function cellOf(md: string, id: string, column: string): string {
  for (const t of B.findTables(md)) {
    const idIdx = t.header.findIndex((h) => h.toLowerCase() === "id");
    const colIdx = t.header.findIndex((h) => h.toLowerCase() === column);
    if (idIdx < 0 || colIdx < 0) continue;
    const row = t.rows.find((r) => r[idIdx] === id);
    if (row) return row[colIdx] ?? "";
  }
  return "";
}

/**
 * Copy each intake source's `Tags` / `Due` onto the new AI_TODO / USER_QA rows of the group it was given (group `i`
 * for source `i`). A row the agent already tagged / dated keeps its own value.
 * @adr 0543
 */
export async function fillIntakeMeta(
  root: string,
  sources: readonly IntakeSource[],
  groups: readonly number[],
  before: { AI_TODO: ReadonlySet<string>; USER_QA: ReadonlySet<string> },
): Promise<void> {
  const byGroup = new Map<string, IntakeSource>();
  sources.forEach((src, i) => {
    const g = groups[i];
    if (g !== undefined && (src.tags || src.due)) byGroup.set(bookGroupCode(g), src);
  });
  if (!byGroup.size) return;
  const metaOf = (id: string): IntakeSource | undefined => byGroup.get(bookGroupOf(id) ?? "");
  const todo = await B.readBook(root, "AI_TODO.md");
  const { tasks } = B.parseTasks(todo);
  const fill = <T extends { id: string; tags?: string; due?: string }>(row: T, isNew: boolean): T => {
    const src = isNew ? metaOf(row.id) : undefined;
    if (!src) return row;
    return { ...row, tags: row.tags || src.tags, due: row.due || src.due };
  };
  const nextTasks = tasks.map((t) => fill(t, !before.AI_TODO.has(t.id)));
  if (nextTasks.some((t, i) => t !== tasks[i])) await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, nextTasks));
  const qa = await B.readBook(root, "USER_QA.md");
  const { rows } = B.parseQa(qa);
  const nextQa = rows.map((q) => fill(q, !before.USER_QA.has(q.id)));
  if (nextQa.some((q, i) => q !== rows[i])) await B.writeBook(root, "USER_QA.md", B.writeQa(qa, nextQa));
}

/**
 * Record the lineage of the groups an intake used: group `i` was given for source `i` (the prompt hands them out in
 * that order). An intake `QA-…` source also records the request its own group came from.
 */
export async function recordIntakeLineage(root: string, sources: readonly IntakeSource[], groups: readonly number[], used: ReadonlySet<string>): Promise<void> {
  const map = await readLineage(root);
  const at = new Date().toISOString();
  sources.forEach((src, i) => {
    const g = groups[i];
    if (g === undefined) return;
    const code = bookGroupCode(g);
    if (!used.has(code)) return;
    const parent = src.id.startsWith("QA-") ? map[bookGroupOf(src.id) ?? ""] : undefined;
    map[code] = {
      source: src.id,
      request: src.request.replace(/\s+/g, " ").trim().slice(0, LINEAGE_REQUEST_MAX),
      at,
      ...(src.team ? { team: src.team } : {}),
      ...(parent ? { root: parent.root ?? parent.source } : {}),
    };
  });
  await writeLineage(root, map);
}

/** Copy lineage entries to the new groups of rows restored from the trash under a new id (new → old). */
export async function copyLineage(root: string, from: Record<string, string>): Promise<void> {
  const map = await readLineage(root);
  let changed = false;
  for (const [to, old] of Object.entries(from)) {
    if (map[old] && !map[to]) {
      map[to] = { ...map[old] };
      changed = true;
    }
  }
  if (changed) await writeLineage(root, map);
}

/**
 * Give every task group created by this intake its `DOC-<g>-001` row (placed before the group's first task) and put
 * that id into the `Depends` of each task of the group that depends on no other task / docs row. Groups that already
 * have a DOC row are left alone. Returns the DOC ids added.
 */
export async function addDocRows(root: string, before: ReadonlySet<string>, spec: SpecDocs, sourceOf: (group: string) => IntakeSource | undefined): Promise<string[]> {
  const todo = await B.readBook(root, "AI_TODO.md");
  const { tasks } = B.parseTasks(todo);
  const groups = new Map<string, B.TaskRow[]>();
  for (const t of tasks) {
    if (before.has(t.id) || !t.id.startsWith("TSK-")) continue;
    const g = bookGroupOf(t.id);
    if (g) groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  const added: string[] = [];
  let next = [...tasks];
  for (const [g, rows] of groups) {
    const docId = `DOC-${g}-001`;
    if (tasks.some((t) => t.id === docId)) continue;
    const src = sourceOf(g);
    const what = src?.request ? src.request.replace(/\s+/g, " ").trim().slice(0, 300) : rows.map((r) => r.desc).join(" / ").slice(0, 300);
    const priority = rows.some((r) => /^high$/i.test(r.priority)) ? "High" : rows[0]?.priority || "Medium";
    const doc: B.TaskRow = {
      id: docId,
      priority,
      tag: "docs",
      depends: [],
      group: rows[0]?.group ?? "",
      desc: `Docs for ${src?.id ?? `group ${g}`}: ${what}`,
      // ADR-0549: named after the source row's title (else its id).
      title: `Docs: ${src?.title || src?.id || `group ${g}`}`,
      notes: `doc types: ${spec.types.join(", ")}`,
      team: rows[0]?.team ?? "",
      tags: rows[0]?.tags ?? "",
      due: rows[0]?.due ?? "",
    };
    next = next.map((t) => (rows.includes(t) && !t.depends.some((d) => /^(?:TSK|DOC)-/.test(d)) ? { ...t, depends: [docId, ...t.depends] } : t));
    const first = next.findIndex((t) => rows.some((r) => r.id === t.id));
    next.splice(first < 0 ? next.length : first, 0, doc);
    added.push(docId);
  }
  if (added.length) await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, next));
  return added;
}

// ── A docs round: numbering, manifest, overlaps ──────────────────────────────────────────────────

/** The fork point of `HEAD` with `origin/<base>` ("" when unknown). */
async function forkPoint(cwd: string, base: string): Promise<string> {
  return (await gitQuiet(cwd, ["merge-base", "HEAD", `origin/${base}`])).trim();
}

/** The doc files the branch changed against its fork point: path + git status letter (A / M / R / D). */
async function changedDocFiles(cwd: string, base: string): Promise<{ path: string; status: string }[]> {
  const fork = await forkPoint(cwd, base);
  if (!fork) return [];
  const out = (await gitQuiet(cwd, ["diff", "--name-status", "--no-renames", fork, "HEAD"])).split("\n").filter(Boolean);
  return out
    .map((l) => {
      const [status = "", path = ""] = l.split("\t");
      return { path, status: status.slice(0, 1) };
    })
    .filter((f) => f.path && docTypeOfPath(f.path) !== null);
}

/** The highest `NNNN` of a numbered folder in `refs` (the base, the branch, every open DOC branch). */
async function highestNumber(cwd: string, dir: string, refs: readonly string[]): Promise<number> {
  let max = 0;
  for (const ref of refs) {
    const names = (await gitQuiet(cwd, ["ls-tree", "--name-only", ref, "--", `${dir}/`])).split("\n").filter(Boolean);
    for (const p of names) {
      const m = NUMBERED_DOC_FILE_RE.exec(posix.basename(p));
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max;
}

/** The remote DOC branches of `<base>` (`dev/<base>/GRP-<g>/DOC-<g>-<n>`, without the `origin/` prefix). */
async function openDocBranches(cwd: string, base: string): Promise<string[]> {
  return (await gitQuiet(cwd, ["for-each-ref", "--format=%(refname:lstrip=3)", `refs/remotes/origin/dev/${base}/`]))
    .split("\n")
    .filter((r) => /\/DOC-\d{6}-\d{3}$/.test(r));
}

/** Ask for doc numbers: `{type, count, floor}[]` → numbers per type (null when the server cannot give them). */
export type DocNumberAllocator = (req: { type: string; count: number; floor: number }[]) => Promise<Map<string, number[]> | null>;

/**
 * Number the round's new numbered files (`NEW-<n>-<slug>.md` in a numbered type's folder): one server number per
 * file above the highest number in the repo and on every open DOC branch, `git mv` to `NNNN-<slug>.md`, rewrite the
 * links in the changed doc files, and commit. Without server numbers the next local numbers above that floor are used
 * (logged). Returns the renames.
 */
export async function numberNewDocs(
  cwd: string,
  base: string,
  docId: string,
  allocate: DocNumberAllocator,
  log: (line: string) => Promise<void>,
): Promise<{ from: string; to: string; type: string; number: number }[]> {
  const changed = await changedDocFiles(cwd, base);
  const fresh = changed.filter((f) => f.status !== "D" && NEW_DOC_FILE_RE.test(posix.basename(f.path)));
  const byType = new Map<string, string[]>();
  for (const f of fresh) {
    const type = docTypeOfPath(f.path);
    if (!type || !DOC_NUMBERED_TYPES.includes(type)) continue;
    byType.set(type, [...(byType.get(type) ?? []), f.path]);
  }
  if (byType.size === 0) return [];
  const refs = ["HEAD", `origin/${base}`, ...(await openDocBranches(cwd, base)).map((b) => `origin/${b}`)];
  const req: { type: string; count: number; floor: number }[] = [];
  for (const [type, paths] of byType) req.push({ type, count: paths.length, floor: await highestNumber(cwd, DOC_TYPE_DIRS[type]!, refs) });
  const given = await allocate(req).catch(() => null);
  if (!given) await log(`[docs] ${docId}: the server gave no doc numbers — numbering above the highest found in the repo`);
  const renames: { from: string; to: string; type: string; number: number }[] = [];
  for (const r of req) {
    const paths = [...(byType.get(r.type) ?? [])].sort((a, b) => Number(NEW_DOC_FILE_RE.exec(posix.basename(a))?.[1]) - Number(NEW_DOC_FILE_RE.exec(posix.basename(b))?.[1]));
    const nums = given?.get(r.type) ?? paths.map((_, i) => r.floor + 1 + i);
    paths.forEach((from, i) => {
      const n = nums[i];
      if (n === undefined) return;
      const slug = NEW_DOC_FILE_RE.exec(posix.basename(from))![2]!;
      renames.push({ from, to: posix.join(posix.dirname(from), `${docNumberCode(n)}-${slug}.md`), type: r.type, number: n });
    });
  }
  for (const r of renames) await git(cwd, ["mv", "-f", r.from, r.to]);
  // Rewrite the links: every changed doc file (now at its final path) that names an old file.
  const moved = new Map(renames.map((r) => [r.from, r.to]));
  const targets = (await changedDocFiles(cwd, base)).filter((f) => f.status !== "D" && f.path.endsWith(".md")).map((f) => moved.get(f.path) ?? f.path);
  for (const p of targets) {
    let text = await readFileInRoot(cwd, join(cwd, p), "utf8").catch(() => "");
    if (!text) continue;
    let next = text;
    for (const r of renames) next = next.split(posix.basename(r.from)).join(posix.basename(r.to));
    if (next !== text) {
      text = next;
      await writeFileInRoot(cwd, join(cwd, p), text);
      await gitQuiet(cwd, ["add", "--", p]);
    }
  }
  if (renames.length) {
    await git(cwd, ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "commit", "-q", "-m", `docs(${docId}): number new docs (4PM)`]);
  }
  return renames;
}

/**
 * The DOC's file manifest after a round: every doc file the branch changed against its fork point (a file created in
 * an earlier round stays `created`), with the number of a numbered file.
 */
export async function docManifest(cwd: string, base: string, prev: readonly DocManifestFile[]): Promise<DocManifestFile[]> {
  const prevCreated = new Set(prev.filter((f) => f.action === "created").map((f) => f.path));
  return (await changedDocFiles(cwd, base))
    .filter((f) => f.status !== "D")
    .map((f) => {
      const type = docTypeOfPath(f.path) ?? "";
      const m = DOC_NUMBERED_TYPES.includes(type) ? NUMBERED_DOC_FILE_RE.exec(posix.basename(f.path)) : null;
      return {
        path: f.path,
        type,
        action: f.status === "A" || prevCreated.has(f.path) ? ("created" as const) : ("updated" as const),
        ...(m ? { number: Number(m[1]) } : {}),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The files this DOC shares with other open DOC rows (path → their ids). */
export function docOverlaps(docs: DocsSidecar, id: string, files: readonly DocManifestFile[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of files) {
    const others = Object.entries(docs)
      .filter(([other, e]) => other !== id && e.state !== "accepted" && e.files.some((x) => x.path === f.path))
      .map(([other]) => other);
    if (others.length) out[f.path] = others;
  }
  return out;
}

// ── Book transitions (inside `publishBooks`) ─────────────────────────────────────────────────────

/**
 * End of a successful round: the DOC row goes back to `AI_TODO` unchanged (its claim dropped by the caller), the entry
 * records the round, the branch head, the manifest and the overlaps, and waits in `review`.
 */
export async function applyDocRoundDone(
  root: string,
  task: B.TaskRow,
  round: { branch: string; head: string; files: DocManifestFile[] },
): Promise<void> {
  const todo = await B.readBook(root, "AI_TODO.md");
  const { tasks } = B.parseTasks(todo);
  await B.writeBook(root, "AI_TODO.md", B.writeTasks(todo, [...tasks.filter((t) => t.id !== task.id), task]));
  const docs = await readDocs(root);
  const prev = docs[task.id];
  const entry: DocEntry = {
    round: (prev?.round ?? 0) + 1,
    state: "review",
    branch: round.branch,
    head: round.head,
    files: round.files,
    history: prev?.history ?? [],
  };
  const overlaps = docOverlaps(docs, task.id, round.files);
  if (Object.keys(overlaps).length) entry.overlaps = overlaps;
  docs[task.id] = entry;
  await writeDocs(root, docs);
  const attempts = await B.readAttempts(root);
  if (attempts[task.id]) {
    delete attempts[task.id];
    await B.writeAttempts(root, attempts);
  }
}

/** Result of applying a review inside a book save. */
export type DocReviewResult = { ok: true; decided: "proceed" | "revise" | null } | { ok: false; error: string };

/**
 * Apply a person's review of a DOC round in a book save (the AI_TODO content of the save is already written): append
 * it to the history; once the round's last required approval landed (`final`) decide — any `revise` wins. `revise`
 * makes the row runnable again; `proceed` moves it from AI_TODO to AI Done ("docs accepted after N rounds" + the
 * branch, the manifest as Files) — the group's tasks may then run.
 */
export async function applyDocReview(dir: string, review: DocReview, final: boolean, by: string, byLabel: string): Promise<DocReviewResult> {
  const docs = await readDocs(dir);
  const entry = docs[review.id];
  if (!entry || entry.state !== "review") return { ok: false, error: "DOC_NOT_IN_REVIEW" };
  if (entry.round !== review.round) return { ok: false, error: "DOC_ROUND_STALE" };
  entry.history = [
    ...entry.history,
    { round: review.round, at: new Date().toISOString(), by, byLabel, decision: review.decision, opinion: review.opinion.trim(), final },
  ];
  const decided = final ? roundDecision(entry, review.round) : null;
  if (decided === "revise") entry.state = "pending";
  if (decided === "proceed") {
    entry.state = "accepted";
    const todo = await B.readBook(dir, "AI_TODO.md");
    const { tasks } = B.parseTasks(todo);
    const row = tasks.find((t) => t.id === review.id);
    if (row) {
      await B.writeBook(dir, "AI_TODO.md", B.writeTasks(todo, tasks.filter((t) => t.id !== review.id)));
      const files = entry.files.map((f) => f.path);
      await B.writeBook(
        dir,
        "AI_DONE.md",
        B.appendDone(await B.readBook(dir, "AI_DONE.md"), {
          id: row.id,
          title: row.title ?? "",
          team: row.team ?? "",
          tags: row.tags ?? "",
          due: row.due ?? "",
          group: row.group,
          depends: row.depends,
          desc: row.desc,
          files: files.slice(0, 20).join(", ") + (files.length > 20 ? ` (+${files.length - 20})` : ""),
          evidence: evidenceCell([]),
          notes: `docs accepted after ${entry.round} round(s); branch: ${entry.branch}`,
        }),
      );
    }
  }
  docs[review.id] = entry;
  await writeDocs(dir, docs);
  return { ok: true, decided };
}

// ── Prompt context ───────────────────────────────────────────────────────────────────────────────

/** The doc types block of the docs prompt: `- adr → docs/adr/ (numbered)` per declared type. */
export function docTypesBlock(spec: SpecDocs): string {
  return spec.types.map((t) => `- ${t} → \`${DOC_TYPE_DIRS[t]}${DOC_TYPE_DIRS[t]!.endsWith(".md") ? "" : "/"}\`${DOC_NUMBERED_TYPES.includes(t) ? " (numbered)" : ""}`).join("\n");
}

/** The earlier rounds' reviews for the docs prompt ("" before the first review). */
export function reviewHistoryText(entry: DocEntry | undefined): string {
  if (!entry?.history.length) return "";
  return entry.history.map((h) => `Round ${h.round} — ${h.decision} (${h.byLabel ?? h.by}): ${h.opinion || "(no opinion)"}`).join("\n");
}

/** The files the DOC already produced, for the next round's prompt ("" on the first round). */
export function previousFilesText(entry: DocEntry | undefined): string {
  if (!entry?.files.length) return "";
  return entry.files.map((f) => `- \`${f.path}\` (${f.action}${f.number ? `, #${docNumberCode(f.number)}` : ""})`).join("\n");
}

/**
 * The accepted docs of a task's group for the implement prompt: the DOC's files (on the branch the task starts from)
 * and the reviewers' opinions of the accepted round; "" when the group has no accepted DOC.
 */
export function implementDocsNote(docs: DocsSidecar, taskId: string): string {
  const g = bookGroupOf(taskId);
  if (!g) return "";
  const hit = Object.entries(docs).find(([id, e]) => id.startsWith(`DOC-${g}-`) && e.state === "accepted");
  if (!hit) return "";
  const [id, e] = hit;
  const files = e.files.map((f) => `- \`${f.path}\``).join("\n");
  const last = e.history.filter((h) => h.round === e.round && h.opinion.trim());
  const opinions = last.length ? `\nReviewer notes on the accepted docs:\n${last.map((h) => `- ${h.opinion.replace(/\s+/g, " ").slice(0, 1000)}`).join("\n")}\n` : "";
  return `\nACCEPTED DOCS of this request (${id}, reviewed by people — read them first and follow them; keep them true if your work changes a detail):\n${files || "- (no files)"}\n${opinions}`;
}

// ── Reading a doc file for the review ────────────────────────────────────────────────────────────

/** A DOC branch name `dev/<base>/GRP-<g>/DOC-<g>-<n>`. */
const DOC_BRANCH_RE = /^dev\/[A-Za-z0-9._/-]{1,150}\/GRP-\d{6}\/DOC-\d{6}-\d{3}$/;

/** True for a Markdown file under one of the spec's doc folders (or `CHANGELOG.md`), safe as a repo path. */
export function isDocFilePath(path: string): boolean {
  return /^(?!\.git\/)(?!.*(?:^|\/)\.{1,2}\/)[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,15}$/.test(path) && path.endsWith(".md") && docTypeOfPath(path) !== null;
}

/** Longest doc file sent to the web. */
const DOC_FILE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Read one doc file for the review modal: from `origin/<ref>` when `ref` is a DOC branch (the round's version), else as
 * on `origin/<base>` (the version before the DOC); `evidence not found` when absent.
 */
export async function readDocFile(root: string, base: string | null, path: string, ref?: string): Promise<AutonomousEvidenceReply> {
  if (ref && !DOC_BRANCH_RE.test(ref)) return { error: "invalid ref" };
  const at = ref ? `origin/${ref}` : base ? `origin/${base}` : null;
  if (!at) return { error: "evidence not found" };
  if (ref) await gitQuiet(root, ["fetch", "-q", "origin", ref]);
  const listed = (await gitQuiet(root, ["ls-tree", "--name-only", at, "--", path])).trim();
  if (!listed) return { error: "evidence not found" };
  const text = await git(root, ["show", `${at}:${path}`]).catch(() => null);
  if (text === null) return { error: "evidence not found" };
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > DOC_FILE_MAX_BYTES) return { error: "evidence file too large" };
  return { contentBase64: bytes.toString("base64"), contentType: "text/markdown", name: posix.basename(path), size: bytes.length };
}
