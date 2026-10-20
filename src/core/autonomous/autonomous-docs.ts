/**
 * The DOC phase on the worker: after an intake the cli adds one `DOC-<group>-001` row per new task group (every
 * root task of the group depends on it) and records where each group came from (the lineage sidecar — the
 * request row itself is removed by intake). A DOC round runs the docs agent on `dev/<base>/GRP-<g>/DOC-…`; the cli
 * then numbers the agent's `NEW-<n>-<slug>.md` files from the server's per-type counter, records the round's file
 * manifest and the overlaps with other open DOC rows, and parks the row in `review` until a person reviews it from
 * AI Todo (`bookSave.docReview`): `revise` runs another round, `proceed` moves the DOC to AI Done and releases the
 * group's tasks, which branch from the DOC branch. A round may write in the root and in any submodule: paths stay
 * root-relative and each file is numbered, listed and read in the repo that owns it.
 * @adr 0536 @adr 0537 @adr 0579
 */
import { join, posix } from "node:path";
import {
  DOCS_SIDECAR_REL,
  DOC_NUMBERED_TYPES,
  DOC_TEMPLATES_DIR,
  docTypeDir,
  type DocTemplateMeta,
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
  submoduleOf,
  type DocEntry,
  type DocManifestFile,
  type DocReview,
  type DocRepoHead,
  type DocsSidecar,
  type LineageSidecar,
  type SpecDocs,
} from "@4pm/dto";
import * as B from "./autonomous-books";
import { git, gitQuiet, type RepoBase } from "./autonomous-git";
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

/**
 * The spec's Docs section as on `origin/<base>` (else the working tree); no types when there is no spec. The
 * `numbered` flag of each type follows its mirrored spec doc template (`.4pm/doc-templates/<type>/meta.json`) when
 * there is one, else the built-in default.
 * @adr 0536 @adr 0564
 */
export async function readSpecDocsAt(root: string, base: string): Promise<SpecDocs> {
  let text = "";
  if (base) text = await gitQuiet(root, ["show", `origin/${base}:project.spec.json`]).catch(() => "");
  if (!text.trim()) text = await readFileInRoot(root, join(root, "project.spec.json"), "utf8").catch(() => "");
  let spec: SpecDocs;
  try {
    spec = readSpecDocs(JSON.parse(text || "{}"));
  } catch {
    return { types: [], org: "", numbered: [] };
  }
  const numbered = new Set(spec.numbered ?? []);
  for (const t of spec.types) {
    const rel = `${DOC_TEMPLATES_DIR}/${t}/meta.json`;
    const raw = base ? await gitQuiet(root, ["show", `origin/${base}:${rel}`]) : await readFileInRoot(root, join(root, rel), "utf8").catch(() => "");
    try {
      const meta = JSON.parse(raw || "null") as Partial<DocTemplateMeta> | null;
      if (meta && typeof meta.numbered === "boolean") {
        if (meta.numbered) numbered.add(t);
        else numbered.delete(t);
      }
    } catch {
      /* no / invalid template — the default stays */
    }
  }
  return { ...spec, numbered: spec.types.filter((t) => numbered.has(t)) };
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

/**
 * One repo a DOC round writes to: the root (`dir` "") or a submodule (`dir` = its folder), its checkout and base.
 * Paths outside are root-relative; inside the repo they drop the `<dir>/` prefix.
 * @adr 0579
 */
export interface DocRepo {
  dir: string;
  cwd: string;
  base: string;
}

/** A root-relative path of a repo-relative one. */
function rootPath(repo: DocRepo, rel: string): string {
  return repo.dir ? `${repo.dir}/${rel}` : rel;
}

/** A repo-relative path of a root-relative one ("" for the repo's own folder). */
function repoPath(repo: DocRepo, path: string): string {
  if (!repo.dir) return path;
  return path === repo.dir ? "" : path.slice(repo.dir.length + 1);
}

/** The repo of `repos` that owns a root-relative path (the longest submodule prefix, else the root). */
function ownerRepo(repos: readonly DocRepo[], path: string): DocRepo | undefined {
  return submoduleOf(repos, path) ?? repos.find((r) => !r.dir);
}

/** The fork point of `HEAD` with `origin/<base>` ("" when unknown). */
async function forkPoint(cwd: string, base: string): Promise<string> {
  return (await gitQuiet(cwd, ["merge-base", "HEAD", `origin/${base}`])).trim();
}

/**
 * The doc files the branch changed against its fork point, in every repo: root-relative path + git status letter
 * (A / M / R / D). A submodule's gitlink line in the root is no doc file; the files changed inside it are listed.
 */
async function changedDocFiles(repos: readonly DocRepo[]): Promise<{ path: string; status: string; repo: DocRepo }[]> {
  const all: { path: string; status: string; repo: DocRepo }[] = [];
  const subDirs = new Set(repos.filter((r) => r.dir).map((r) => r.dir));
  for (const repo of repos) {
    const fork = await forkPoint(repo.cwd, repo.base);
    if (!fork) continue;
    const out = (await gitQuiet(repo.cwd, ["diff", "--name-status", "--no-renames", fork, "HEAD"])).split("\n").filter(Boolean);
    for (const l of out) {
      const [status = "", rel = ""] = l.split("\t");
      if (!rel) continue;
      const path = rootPath(repo, rel);
      if (subDirs.has(path) || ownerRepo(repos, path) !== repo || docTypeOfPath(path) === null) continue;
      all.push({ path, status: status.slice(0, 1), repo });
    }
  }
  return all;
}

/** The highest `NNNN` of a numbered folder (root-relative `dir`) in `refs` of `repo` (base, branch, open DOC branches). */
async function highestNumber(repo: DocRepo, dir: string, refs: readonly string[]): Promise<number> {
  let max = 0;
  const rel = repoPath(repo, dir);
  for (const ref of refs) {
    const names = (await gitQuiet(repo.cwd, ["ls-tree", "--name-only", rel ? `${ref}:${rel}` : ref])).split("\n").filter(Boolean);
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
  repos: readonly DocRepo[],
  docId: string,
  allocate: DocNumberAllocator,
  log: (line: string) => Promise<void>,
  numberedTypes: readonly string[] = DOC_NUMBERED_TYPES,
): Promise<{ from: string; to: string; type: string; number: number }[]> {
  const changed = await changedDocFiles(repos);
  const fresh = changed.filter((f) => f.status !== "D" && NEW_DOC_FILE_RE.test(posix.basename(f.path)));
  const byType = new Map<string, string[]>();
  for (const f of fresh) {
    const type = docTypeOfPath(f.path);
    if (!type || !numberedTypes.includes(type)) continue;
    byType.set(type, [...(byType.get(type) ?? []), f.path]);
  }
  if (byType.size === 0) return [];
  const req: { type: string; count: number; floor: number }[] = [];
  for (const [type, paths] of byType) {
    // The floor is taken in the repo that holds the type's folder (ADR-0579).
    let floor = 0;
    const holder = ownerRepo(repos, `${docTypeDir(type)}/`);
    if (holder) {
      const refs = ["HEAD", `origin/${holder.base}`, ...(await openDocBranches(holder.cwd, holder.base)).map((b) => `origin/${b}`)];
      floor = await highestNumber(holder, docTypeDir(type), refs);
    }
    req.push({ type, count: paths.length, floor });
  }
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
  const touched = new Set<DocRepo>();
  for (const r of renames) {
    const repo = ownerRepo(repos, r.from);
    if (!repo) continue;
    await git(repo.cwd, ["mv", "-f", repoPath(repo, r.from), repoPath(repo, r.to)]);
    touched.add(repo);
  }
  // Rewrite the links: every changed doc file (now at its final path, in any repo) that names an old file.
  const moved = new Map(renames.map((r) => [r.from, r.to]));
  const targets = (await changedDocFiles(repos)).filter((f) => f.status !== "D" && f.path.endsWith(".md")).map((f) => ({ ...f, path: moved.get(f.path) ?? f.path }));
  for (const f of targets) {
    const rel = repoPath(f.repo, f.path);
    let text = await readFileInRoot(f.repo.cwd, join(f.repo.cwd, rel), "utf8").catch(() => "");
    if (!text) continue;
    let next = text;
    for (const r of renames) next = next.split(posix.basename(r.from)).join(posix.basename(r.to));
    if (next !== text) {
      text = next;
      await writeFileInRoot(f.repo.cwd, join(f.repo.cwd, rel), text);
      await gitQuiet(f.repo.cwd, ["add", "--", rel]);
      touched.add(f.repo);
    }
  }
  // Submodules first, so the root's commit records their new heads.
  for (const repo of [...touched].sort((a, b) => (a.dir ? 0 : 1) - (b.dir ? 0 : 1))) {
    await git(repo.cwd, ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "commit", "-q", "-m", `docs(${docId}): number new docs (4PM)`]);
  }
  const root = repos.find((r) => !r.dir);
  if (root && repos.some((r) => r.dir && touched.has(r))) {
    for (const r of repos) if (r.dir) await gitQuiet(root.cwd, ["add", "--", r.dir]);
    if ((await gitQuiet(root.cwd, ["diff", "--cached", "--name-only"])).trim()) {
      await git(root.cwd, ["-c", "user.name=4PM", "-c", "user.email=noreply@4pm.app", "commit", "-q", "-m", `docs(${docId}): submodule pointers (4PM)`]);
    }
  }
  return renames;
}

/**
 * The DOC's file manifest after a round: every doc file the branch changed against its fork point (a file created in
 * an earlier round stays `created`), with the number of a numbered file.
 */
export async function docManifest(repos: readonly DocRepo[], prev: readonly DocManifestFile[], numberedTypes: readonly string[] = DOC_NUMBERED_TYPES): Promise<DocManifestFile[]> {
  const prevCreated = new Set(prev.filter((f) => f.action === "created").map((f) => f.path));
  return (await changedDocFiles(repos))
    .filter((f) => f.status !== "D")
    .map((f) => {
      const type = docTypeOfPath(f.path) ?? "";
      const m = numberedTypes.includes(type) ? NUMBERED_DOC_FILE_RE.exec(posix.basename(f.path)) : null;
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
  round: { branch: string; head: string; files: DocManifestFile[]; repos?: DocRepoHead[] },
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
    ...(round.repos?.length ? { repos: round.repos } : {}),
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

/** The doc types block of the docs prompt: `- adr → docs/adr/ (numbered)` per declared type. @adr 0564 */
export function docTypesBlock(spec: SpecDocs): string {
  const numbered = spec.numbered ?? DOC_NUMBERED_TYPES;
  return spec.types
    .map((t) => {
      const dir = docTypeDir(t);
      return `- ${t} → \`${dir}${dir.endsWith(".md") ? "" : "/"}\`${numbered.includes(t) ? " (numbered)" : ""}`;
    })
    .join("\n");
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
 * on `origin/<base>` (the version before the DOC); `evidence not found` when absent. A path inside a submodule is read
 * from that submodule: its DOC branch (`dev/<sub-base>/GRP-…/<DOC id>`) or `origin/<sub-base>`.
 * @adr 0579
 */
export async function readDocFile(root: string, base: string | null, path: string, ref?: string, subs: readonly RepoBase[] = []): Promise<AutonomousEvidenceReply> {
  if (ref && !DOC_BRANCH_RE.test(ref)) return { error: "invalid ref" };
  const sub = submoduleOf(subs, path);
  const cwd = sub ? join(root, sub.dir) : root;
  const rel = sub ? path.slice(sub.dir.length + 1) : path;
  // The same `GRP-…/DOC-…` tail on the submodule's base.
  const branch = ref && sub ? `dev/${sub.base}/${ref.split("/").slice(-2).join("/")}` : ref;
  const before = sub ? sub.base : base;
  const at = branch ? `origin/${branch}` : before ? `origin/${before}` : null;
  if (!at) return { error: "evidence not found" };
  await gitQuiet(cwd, ["fetch", "-q", "origin", ...(branch ? [branch] : before ? [before] : [])]);
  const listed = (await gitQuiet(cwd, ["ls-tree", "--name-only", at, "--", rel])).trim();
  if (!listed) return { error: "evidence not found" };
  const text = await git(cwd, ["show", `${at}:${rel}`]).catch(() => null);
  if (text === null) return { error: "evidence not found" };
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > DOC_FILE_MAX_BYTES) return { error: "evidence file too large" };
  return { contentBase64: bytes.toString("base64"), contentType: "text/markdown", name: posix.basename(path), size: bytes.length };
}
