/**
 * AI Done delivery records (`.4pm/.autonomous.delivery.json`, books set): captured at delivery for the root and every
 * delivered submodule (branch, base, shas, PR, full file list), kept fresh by the PR state refresh (submodule PRs,
 * mergeability, merge commits), seeded from the Notes of older open rows — and the two reads of the AI Done Files
 * modal, which resolve each repo's content to the task's own commits (merge commit → task branch → head sha → PR head
 * ref → deletion-log tip → base) so a row stays viewable after its branch is deleted.
 * @adr 0582 @api machine-0098 @api machine-0099
 */
import { join, posix } from "node:path";
import {
  BRANCH_DELETIONS_REL,
  DELIVERY_SIDECAR_REL,
  EVIDENCE_MAX_BYTES,
  bookRowsById,
  deliverySettled,
  isSafeRepoDir,
  parseDeliverySidecar,
  parseDoneNotes,
  serializeDeliverySidecar,
  type DeliveryRepo,
  type DeliverySidecar,
  type DeliveryState,
  type DoneDelivery,
  type DoneFile,
  type DoneFileStatus,
} from "@4pm/dto";
import type {
  AutonomousDoneFileReply,
  AutonomousDoneFileRequest,
  AutonomousDoneFilesReply,
  AutonomousDoneFilesRequest,
  DoneFileSource,
  DoneFilesRepo,
} from "@4pm/ws";
import { execInProject as run } from "../agent/agent-spawn";
import { prHeadRef, prStatusOf } from "../git/git-host";
import * as B from "./autonomous-books";
import { mimeOf } from "./autonomous-evidence";
import { freshBooksRef, git, gitQuiet, resolveBases, type RepoBase } from "./autonomous-git";

// ── Sidecar ──────────────────────────────────────────────────────────────────────────────────────

/** Read the delivery sidecar of a books checkout (`{}` when absent). */
export async function readDeliveries(bdir: string): Promise<DeliverySidecar> {
  return parseDeliverySidecar(await B.readBook(bdir, DELIVERY_SIDECAR_REL));
}

/** Write the delivery sidecar (sorted, pretty). */
export async function writeDeliveries(bdir: string, s: DeliverySidecar): Promise<void> {
  await B.writeBook(bdir, DELIVERY_SIDECAR_REL, serializeDeliverySidecar(s));
}

/** Add / replace delivery records inside a books publish. */
export async function recordDeliveries(bdir: string, add: ReadonlyMap<string, DoneDelivery>): Promise<void> {
  if (!add.size) return;
  const s = await readDeliveries(bdir);
  for (const [id, d] of add) s[id] = d;
  await writeDeliveries(bdir, s);
}

// ── Capture at delivery ──────────────────────────────────────────────────────────────────────────

/** What a delivered repo is, before its files / shas are read. */
export interface RepoDeliveryInput {
  /** `"."` = the root, else the submodule folder. */
  dir: string;
  url: string;
  branch: string;
  base: string;
  /** The ref holding the delivered work (the branch, or `origin/<branch>`). */
  ref: string;
  state: DeliveryState;
  pr?: string;
  mergeSha?: string;
  conflict?: boolean;
  /** Root-relative paths to leave out (the root's submodule links). */
  exclude?: ReadonlySet<string>;
}

/** The changed files of `ref` against `origin/<base>` (`--name-status`, renames as the new path), root-relative. */
async function changedFiles(cwd: string, base: string, ref: string, prefix: string): Promise<DoneFile[]> {
  const out = await gitQuiet(cwd, ["-c", "core.quotepath=off", "diff", "--name-status", "-M", `origin/${base}...${ref}`]);
  const files: DoneFile[] = [];
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    const code = parts[0]?.[0] ?? "";
    const path = parts[parts.length - 1] ?? "";
    if (!path || parts.length < 2) continue;
    const status: DoneFileStatus = code === "A" || code === "D" || code === "R" ? code : "M";
    files.push({ path: `${prefix}${path}`, status });
  }
  return files;
}

/** Capture one delivered repo: its merge-base and tip shas and its full changed-file list. */
export async function captureRepo(cwd: string, d: RepoDeliveryInput): Promise<DeliveryRepo> {
  const prefix = d.dir === "." ? "" : `${d.dir}/`;
  const files = (await changedFiles(cwd, d.base, d.ref, prefix)).filter((f) => !d.exclude?.has(f.path));
  const baseSha = (await gitQuiet(cwd, ["merge-base", `origin/${d.base}`, d.ref])).trim();
  const headSha = (await gitQuiet(cwd, ["rev-parse", `${d.ref}^{commit}`])).trim();
  return {
    dir: d.dir,
    url: d.url,
    branch: d.branch,
    base: d.base,
    state: d.state,
    files,
    ...(/^[0-9a-f]{40}$/.test(baseSha) ? { baseSha } : {}),
    ...(/^[0-9a-f]{40}$/.test(headSha) ? { headSha } : {}),
    ...(d.pr ? { pr: d.pr } : {}),
    ...(d.mergeSha ? { mergeSha: d.mergeSha } : {}),
    ...(d.conflict ? { conflict: true } : {}),
  };
}

// ── Refresh ──────────────────────────────────────────────────────────────────────────────────────

/** Git's answer for a PR state when the host CLI gives none (null = unknown). */
export type GitPrStateFn = (cwd: string, branch: string, base: string) => Promise<DeliveryState | null>;

/** The repos of one PR refresh: the project root (git fallback cwd) and its submodules (clone urls for seeding). */
export interface DeliveryRefreshCtx {
  root: string;
  rootBase: RepoBase;
  subs: readonly RepoBase[];
}

/** The outcome of refreshing the delivery records of one books checkout. */
export interface DeliveryRecordStates {
  /** Records that changed or were seeded (id → new record). */
  updates: Map<string, DoneDelivery>;
  /** id → its root entry's state (the AI Done `Delivery` cell follows it). */
  rootStates: Map<string, DeliveryState>;
  notes: string[];
}

/** A `Delivery` cell that is still open (`PR open …`). */
const openCell = (cell: string): boolean => cell.trim().toLowerCase().startsWith("pr open");

/**
 * Seed a record for an older AI Done row from its Notes (root branch + PR, submodule PR links, conflict) — no shas or
 * file lists; submodule branches follow the `dev/<sub-base>/<GROUP>/<ID>` naming.
 */
export function seedFromNotes(notes: string, delivery: string, rootBase: RepoBase, subs: readonly RepoBase[]): DoneDelivery | null {
  const n = parseDoneNotes(notes);
  if (!n.branch) return null;
  const rootState: DeliveryState = n.mergedSha ? "direct" : openCell(delivery) ? "open" : delivery.trim() === "merged" || delivery.trim() === "closed" ? (delivery.trim() as DeliveryState) : "open";
  const repos: DeliveryRepo[] = [
    {
      dir: ".",
      url: rootBase.url,
      branch: n.branch,
      base: rootBase.base,
      state: rootState,
      files: [],
      ...(n.pr ? { pr: n.pr } : {}),
      ...(n.mergedSha ? { mergeSha: n.mergedSha } : {}),
      ...(n.conflict?.repos.includes(".") ? { conflict: true } : {}),
    },
  ];
  const parts = n.branch.split("/");
  for (const s of n.submodules) {
    const sub = subs.find((x) => x.dir === s.dir);
    const branch = s.branch ?? (parts.length >= 4 && sub ? ["dev", sub.base, ...parts.slice(2)].join("/") : "");
    repos.push({
      dir: s.dir,
      url: sub?.url ?? "",
      branch,
      base: sub?.base ?? "",
      state: s.mergedSha ? "direct" : "open",
      files: [],
      ...(s.pr ? { pr: s.pr } : {}),
      ...(s.mergedSha ? { mergeSha: s.mergedSha } : {}),
      ...(n.conflict?.repos.includes(s.dir) ? { conflict: true } : {}),
    });
  }
  return { repos, seeded: true, ...(n.remarks.length ? { remarks: n.remarks } : {}) };
}

/**
 * Look up every open repo entry of the delivery records (host CLI by PR link / branch, else git), within the shared
 * lookup budget (`take()` false ⇒ stop), and seed records for open AI Done rows that have none. Final entries are
 * never looked up again.
 */
export async function deliveryRecordStates(
  bdir: string,
  ctx: DeliveryRefreshCtx,
  take: () => boolean,
  gitState: GitPrStateFn,
): Promise<DeliveryRecordStates> {
  const out: DeliveryRecordStates = { updates: new Map(), rootStates: new Map(), notes: [] };
  const records = await readDeliveries(bdir);
  // Older open rows without a record get one from their Notes.
  for (const r of B.openDeliveries(await B.readBook(bdir, "AI_DONE.md"))) {
    if (records[r.id]) continue;
    const seeded = seedFromNotes(r.notes, r.delivery, ctx.rootBase, ctx.subs);
    if (!seeded) continue;
    records[r.id] = seeded;
    out.updates.set(r.id, seeded);
    out.notes.push(`[pr] ${r.id}: delivery record seeded from its notes`);
  }
  for (const [id, rec] of Object.entries(records)) {
    if (deliverySettled(rec)) continue;
    let changed = false;
    const repos: DeliveryRepo[] = [];
    for (const r of rec.repos) {
      if (r.state !== "open" || !take()) {
        repos.push(r);
        continue;
      }
      const cwd = r.dir === "." ? ctx.root : join(ctx.root, r.dir);
      const url = r.url || (r.dir === "." ? ctx.rootBase.url : "");
      const host = url ? await prStatusOf(url, r.branch, r.pr).catch(() => null) : null;
      let state: DeliveryState | null = host?.state ?? null;
      if (!state && r.branch && r.base) state = await gitState(cwd, r.branch, r.base).catch(() => null);
      if (!state) {
        repos.push(r);
        continue;
      }
      let next: DeliveryRepo = { ...r, state };
      if (host?.conflict !== undefined && state === "open") next = { ...next, conflict: host.conflict };
      if (state !== "open") delete next.conflict;
      if (state === "merged" && !next.mergeSha) {
        const sha = host?.mergeSha ?? (await gitQuiet(cwd, ["rev-parse", `origin/${r.base}`])).trim();
        if (/^[0-9a-f]{40}$/.test(sha)) next.mergeSha = sha;
      }
      if (next.state !== r.state || next.conflict !== r.conflict || next.mergeSha !== r.mergeSha) {
        changed = true;
        out.notes.push(`[pr] ${id} ${r.dir === "." ? "root" : r.dir} → ${next.state}${next.conflict ? " (conflicts)" : ""}`);
      }
      repos.push(next);
    }
    const root = repos.find((r) => r.dir === ".");
    if (root) out.rootStates.set(id, root.state);
    if (changed) out.updates.set(id, { ...rec, repos });
  }
  return out;
}

// ── Files modal reads (machine-0098 / machine-0099) ─────────────────────────────────────────────

/** A repo's resolved content source. */
interface Resolved extends DoneFilesRepo {
  /** The repo's working directory on the worker. */
  cwd: string;
  entry: DeliveryRepo;
}

/** Resolutions per row + repo, reused for a minute so clicking through files does not refetch. */
const resolvedCache = new Map<string, { at: number; value: Resolved }>();
const RESOLVE_TTL_MS = 60_000;

/** Does the commit exist locally (optionally fetching it by sha)? */
async function haveCommit(cwd: string, sha: string | undefined, fetch: boolean): Promise<boolean> {
  if (!sha) return false;
  if (await catFile(cwd, sha)) return true;
  if (!fetch) return false;
  await gitQuiet(cwd, ["fetch", "-q", "origin", sha], 120_000);
  return catFile(cwd, sha);
}

/** `git cat-file -e` prints nothing on success, so test its exit status. */
async function catFile(cwd: string, sha: string): Promise<boolean> {
  try {
    await git(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The newest deletion-log tip of `branch` in a repo (`repo` "" = the root), or undefined. */
function deletedTip(log: unknown, repo: string, branch: string): string | undefined {
  const entries = (log as { entries?: { repo?: string; name?: string; sha?: string; at?: string }[] } | null)?.entries;
  if (!Array.isArray(entries)) return undefined;
  const hits = entries.filter((e) => (e.repo ?? "") === repo && e.name === branch && typeof e.sha === "string");
  hits.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return hits[0]?.sha;
}

/** Resolve where one repo's content is read from: the first source of the ADR-0582 chain that exists. */
async function resolveRepo(cwd: string, r: DeliveryRepo, deletions: unknown): Promise<Omit<Resolved, "cwd" | "entry">> {
  const done = (source: DoneFileSource, ref: string, sha: string): Omit<Resolved, "cwd" | "entry"> => ({
    dir: r.dir,
    source,
    ref,
    sha,
    ...(r.baseSha ? { baseSha: r.baseSha } : {}),
  });
  if ((r.state === "merged" || r.state === "direct") && (await haveCommit(cwd, r.mergeSha, true))) return done("merge", r.base, r.mergeSha!);
  if (r.branch) {
    await gitQuiet(cwd, ["fetch", "-q", "origin", `+refs/heads/${r.branch}:refs/remotes/origin/${r.branch}`]);
    const tip = (await gitQuiet(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${r.branch}`])).trim();
    if (tip) return done("branch", r.branch, tip);
  }
  if (await haveCommit(cwd, r.headSha, true)) return done("head", r.branch, r.headSha!);
  const prRef = prHeadRef(r.url, r.pr);
  if (prRef) {
    const local = `refs/4pm/pr-head/${prRef.replace(/^refs\//, "")}`;
    await gitQuiet(cwd, ["fetch", "-q", "origin", `+${prRef}:${local}`], 120_000);
    const sha = (await gitQuiet(cwd, ["rev-parse", "--verify", "--quiet", local])).trim();
    if (sha) return done("pr-ref", prRef, sha);
  }
  const tip = deletedTip(deletions, r.dir === "." ? "" : r.dir, r.branch);
  if (await haveCommit(cwd, tip, true)) return done("deleted-tip", r.branch, tip!);
  await gitQuiet(cwd, ["fetch", "-q", "origin", r.base]);
  const baseSha = (await gitQuiet(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${r.base}`])).trim();
  return { ...done("base", r.base, baseSha), warning: "base-fallback" };
}

/** One AI Done row as the reads need it: its record (or a legacy one from Notes) and its `Files` cell. */
interface DoneRow {
  record: DoneDelivery;
  legacy: boolean;
  filesCell: string;
}

/** Load an AI Done row + its record from the books branch (null when the row is not in AI Done). */
async function loadDoneRow(root: string, rowId: string): Promise<{ row: DoneRow; bases: { root: RepoBase; subs: RepoBase[] }; deletions: unknown } | null> {
  const bases = await resolveBases(root);
  const ref = bases.root.base ? await freshBooksRef(root, bases.root.base) : null;
  const show = async (rel: string): Promise<string> => (ref ? await gitQuiet(root, ["show", `${ref}:${rel}`]) : await B.readBook(root, rel));
  const row = bookRowsById(await show("AI_DONE.md")).get(rowId);
  if (!row) return null;
  const records = parseDeliverySidecar(await show(DELIVERY_SIDECAR_REL));
  let deletions: unknown;
  try {
    deletions = JSON.parse((await show(BRANCH_DELETIONS_REL)) || "null");
  } catch {
    deletions = null; // no / unreadable deletion log ⇒ no deleted-tip fallback
  }
  const filesCell = row.cells.files ?? "";
  const record = records[rowId];
  if (record && !record.seeded) return { row: { record, legacy: false, filesCell }, bases, deletions };
  const seeded = record ?? seedFromNotes(row.cells.notes ?? "", row.cells.delivery ?? "", bases.root, bases.subs);
  if (!seeded) return null;
  return { row: { record: seeded, legacy: true, filesCell }, bases, deletions };
}

/** Resolve every repo of a row (cached for a minute). */
async function resolveAll(root: string, rowId: string, row: DoneRow, deletions: unknown): Promise<Resolved[]> {
  const out: Resolved[] = [];
  for (const r of row.record.repos) {
    const key = `${root}\u0000${rowId}\u0000${r.dir}`;
    const hit = resolvedCache.get(key);
    if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) {
      out.push(hit.value);
      continue;
    }
    const cwd = r.dir === "." ? root : join(root, r.dir);
    const value: Resolved = { ...(await resolveRepo(cwd, r, deletions)), cwd, entry: r };
    resolvedCache.set(key, { at: Date.now(), value });
    out.push(value);
  }
  return out;
}

/** The repo (resolved) that owns a root-relative path: the longest submodule folder prefix, a gitlink path = that submodule. */
function ownerOf(repos: readonly Resolved[], path: string): { repo: Resolved; rel: string } | null {
  let best: Resolved | null = null;
  for (const r of repos) {
    if (r.dir === ".") continue;
    if ((path === r.dir || path.startsWith(`${r.dir}/`)) && (!best || r.dir.length > best.dir.length)) best = r;
  }
  if (best) return { repo: best, rel: path === best.dir ? "" : path.slice(best.dir.length + 1) };
  const rootRepo = repos.find((r) => r.dir === ".");
  return rootRepo ? { repo: rootRepo, rel: path } : null;
}

/**
 * Step into a submodule a path crosses inside `sha` (a gitlink the row's record does not list — older rows): the
 * submodule's checkout, the commit the link names (fetched when missing) and the rest of the path. Unchanged when no
 * gitlink is crossed.
 */
async function throughGitlink(cwd: string, sha: string, rel: string): Promise<{ cwd: string; sha: string; rel: string }> {
  if (!rel) return { cwd, sha, rel };
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const m = /^160000 commit ([0-9a-f]{40})\t/.exec(await gitQuiet(cwd, ["ls-tree", sha, "--", prefix]));
    if (!m) continue;
    const subCwd = join(cwd, prefix);
    await haveCommit(subCwd, m[1], true);
    return { cwd: subCwd, sha: m[1]!, rel: parts.slice(i).join("/") };
  }
  return { cwd, sha, rel };
}

/** The paths of a legacy `Files` cell (`a, b, … (+N)`). */
function legacyPaths(cell: string): string[] {
  return cell
    .split(/,\s*/)
    .map((p) => p.replace(/\s*\(\+\d+\)\s*$/, "").trim())
    .filter((p) => p && !/^\(\+\d+\)$/.test(p) && isSafeRepoDir(p));
}

/** A legacy `Files` entry: its owning repo and whether it is a folder / submodule at the resolved ref. */
async function legacyEntry(repos: readonly Resolved[], path: string): Promise<{ path: string; repo: string; status: "?"; dir?: true }> {
  const owner = ownerOf(repos, path);
  if (!owner) return { path, repo: ".", status: "?" };
  const at = await throughGitlink(owner.repo.cwd, owner.repo.sha, owner.rel);
  const type = at.rel ? (await gitQuiet(at.cwd, ["cat-file", "-t", `${at.sha}:${at.rel}`])).trim() : "tree";
  return { path, repo: owner.repo.dir, status: "?", ...(type === "tree" || type === "commit" ? { dir: true as const } : {}) };
}

/** Public view of a resolved repo (no worker paths). */
function repoView(r: Resolved): DoneFilesRepo {
  return {
    dir: r.dir,
    source: r.source,
    ref: r.ref,
    sha: r.sha,
    ...(r.baseSha ? { baseSha: r.baseSha } : {}),
    ...(r.warning ? { warning: r.warning } : {}),
  };
}

/** machine-0098: the files of one AI Done row per repo + where each repo's content is read from. */
export async function readDoneFiles(root: string, req: AutonomousDoneFilesRequest): Promise<AutonomousDoneFilesReply> {
  try {
    if (!/^(TSK|DOC)-\d{6}-\d{3}$/.test(req.rowId)) return { code: "not-found", error: "invalid row id" };
    const loaded = await loadDoneRow(root, req.rowId);
    if (!loaded) return { code: "not-found", error: "no such AI Done row" };
    const repos = await resolveAll(root, req.rowId, loaded.row, loaded.deletions);
    const files = loaded.row.legacy
      ? await Promise.all(legacyPaths(loaded.row.filesCell).map((path) => legacyEntry(repos, path)))
      : loaded.row.record.repos.flatMap((r) => r.files.map((f) => ({ path: f.path, repo: r.dir, status: f.status })));
    return { repos: repos.map(repoView), files, legacy: loaded.row.legacy };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Is `path` one the row lets a viewer read: a listed file, or under a listed folder / gitlink of a legacy row? */
function allowed(row: DoneRow, path: string): boolean {
  if (row.legacy) return legacyPaths(row.filesCell).some((p) => path === p || path.startsWith(`${p}/`));
  return row.record.repos.some((r) => r.files.some((f) => f.path === path || f.path.startsWith(`${path}/`)));
}

/** `git show <sha>:<rel>` as bytes (null when absent / unreadable). */
async function showBytes(cwd: string, sha: string, rel: string): Promise<Buffer | null> {
  try {
    const { stdout } = await run("git", ["show", `${sha}:${rel}`], { cwd, encoding: "buffer", maxBuffer: EVIDENCE_MAX_BYTES + 1024 });
    return stdout as unknown as Buffer;
  } catch {
    return null;
  }
}

/** machine-0099: one file of an AI Done row at its resolved ref (or its base sha), or a folder's children. */
export async function readDoneFile(root: string, req: AutonomousDoneFileRequest): Promise<AutonomousDoneFileReply> {
  try {
    if (!/^(TSK|DOC)-\d{6}-\d{3}$/.test(req.rowId)) return { code: "not-found", error: "invalid row id" };
    const path = req.path.replace(/\/+$/, "");
    if (!path || !isSafeRepoDir(path)) return { error: "invalid path" };
    const loaded = await loadDoneRow(root, req.rowId);
    if (!loaded) return { code: "not-found", error: "no such AI Done row" };
    if (!allowed(loaded.row, path)) return { error: "path not in this row" };
    const repos = await resolveAll(root, req.rowId, loaded.row, loaded.deletions);
    const owner = ownerOf(repos, path);
    if (!owner || !owner.repo.sha) return { error: "nothing to read" };
    const { repo } = owner;
    let sha = repo.sha;
    if (req.side === "before") {
      sha = repo.entry.baseSha && (await haveCommit(repo.cwd, repo.entry.baseSha, true))
        ? repo.entry.baseSha
        : (await gitQuiet(repo.cwd, ["merge-base", `origin/${repo.entry.base}`, repo.sha])).trim() || repo.sha;
    }
    // An older row may list a submodule the record does not know — read it at the commit its link names.
    const at = await throughGitlink(repo.cwd, sha, owner.rel);
    const rel = at.rel;
    const cwd = at.cwd;
    sha = at.sha;
    if (req.list) {
      const out = await gitQuiet(cwd, ["-c", "core.quotepath=off", "ls-tree", "-z", rel ? `${sha}:${rel}` : sha]);
      const entries = out
        .split("\0")
        .filter(Boolean)
        .flatMap((line) => {
          const m = /^\d+ (blob|tree|commit) [0-9a-f]+\t(.+)$/.exec(line);
          if (!m) return [];
          const child = posix.join(path, m[2]!);
          return [{ path: child, type: m[1] === "blob" ? ("file" as const) : ("dir" as const) }];
        });
      return { entries, source: repo.source, sha };
    }
    if (!rel) return { error: "a folder — list it instead" };
    const bytes = await showBytes(cwd, sha, rel);
    if (!bytes) return { missing: true, source: repo.source, sha, name: posix.basename(path) };
    if (bytes.length > EVIDENCE_MAX_BYTES) return { error: "file too large" };
    return {
      contentBase64: bytes.toString("base64"),
      contentType: mimeOf(path),
      name: posix.basename(path),
      size: bytes.length,
      source: repo.source,
      sha,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
