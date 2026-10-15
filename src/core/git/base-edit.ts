/**
 * Web file edits on the remote base branch — read a project file / folder from `origin/<base>` and commit an
 * edit (put / delete / move) straight onto `<base>` without the working tree: the new tree is built in a
 * temporary index (`GIT_INDEX_FILE`) from `origin/<base>`, committed with `commit-tree` and pushed
 * `<commit>:refs/heads/<base>`; a non-fast-forward push is a lost race ⇒ fetch and rebuild (3 attempts). A
 * write based on a blob the remote no longer holds fails with `FILE_CHANGED_UPSTREAM`; a refused push that is
 * not a race fails with `BASE_PUSH_REJECTED`. A path inside a submodule is read / committed in that submodule on
 * its own `<base>`. No `origin/<base>` ⇒ `null`, and the caller falls back to the working tree. Never takes the
 * repo lock; after a push it fast-forwards the root working tree when that is on `<base>`, clean and free.
 * @adr 0511
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { execInProject } from "../agent/agent-spawn";
import { resolveBases } from "../autonomous/autonomous-git";
import { lexicalInRoot } from "../../utils/safe-path";
import { tryAcquireRepo } from "./repo-lock";

/** The repo that owns a project path, and that path relative to it. */
export interface BaseLocation {
  /** Absolute repo folder (the root, or a submodule folder). */
  repoDir: string;
  /** Repo folder relative to the project root ("" = the root). */
  repoRel: string;
  /** The repo's base branch. */
  base: string;
  /** The path relative to the repo ("" = the repo root). */
  rel: string;
}

/** One edit of a base commit. Paths are relative to the repo. */
export type BaseEdit =
  | { op: "put"; path: string; data: Buffer; expectBlob?: string | null }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string }
  | { op: "mkdir"; path: string };

/** A failure the server maps to an error code (the message is the code). */
export class BaseEditError extends Error {}

/** Attempts of fetch → build → push before a lost race becomes an error. */
const MAX_ATTEMPTS = 3;
/** Reads reuse a fetch of `<base>` this recent. */
const READ_FETCH_MS = 15_000;
/** `resolveBases` per root is reused this long. */
const BASES_TTL_MS = 60_000;

const lastFetch = new Map<string, number>();
const basesCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof resolveBases>> }>();

/** Run git as the project user (agent uid when separated); throws with the last stderr lines. */
async function g(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 120_000): Promise<string> {
  try {
    const { stdout } = await execInProject("git", args, {
      cwd,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error((e.stderr || e.message || String(err)).trim().split("\n").slice(-4).join(" "), { cause: err });
  }
}

/** Run git; "" on failure. */
async function gq(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    return await g(cwd, args, env, 60_000);
  } catch {
    return "";
  }
}

/** The bases of a project (cached briefly). */
async function bases(root: string): Promise<Awaited<ReturnType<typeof resolveBases>>> {
  const hit = basesCache.get(root);
  if (hit && Date.now() - hit.at < BASES_TTL_MS) return hit.value;
  const value = await resolveBases(root);
  basesCache.set(root, { at: Date.now(), value });
  return value;
}

/** A project path (relative or absolute) → its root-relative posix form; null when it escapes the root. */
export function rootRel(root: string, path: string): string | null {
  const abs = lexicalInRoot(root, isAbsolute(path) ? path : path.replace(/^\/+/, ""));
  if (!abs) return null;
  const rel = relative(resolve(root), abs);
  return rel.split(sep).join("/");
}

/** Locate the repo that owns `path` and its base; null when the path escapes or the repo has no base. */
export async function locateBase(root: string, path: string): Promise<BaseLocation | null> {
  const rel = rootRel(root, path);
  if (rel === null) return null;
  const b = await bases(root);
  const sub = b.subs
    .filter((s) => s.dir && (rel === s.dir || rel.startsWith(s.dir + "/")))
    .sort((x, y) => y.dir.length - x.dir.length)[0];
  const repo = sub ?? b.root;
  if (!repo.base) return null;
  return {
    repoDir: repo.dir ? join(root, repo.dir) : root,
    repoRel: repo.dir,
    base: repo.base,
    rel: repo.dir ? (rel === repo.dir ? "" : rel.slice(repo.dir.length + 1)) : rel,
  };
}

/** The remote-tracking ref of `<base>` after a fetch (forced, or at most every 15 s); null when absent. */
async function baseRef(loc: BaseLocation, force: boolean): Promise<string | null> {
  const key = `${loc.repoDir}\u0000${loc.base}`;
  if (force || Date.now() - (lastFetch.get(key) ?? 0) > READ_FETCH_MS) {
    await gq(loc.repoDir, ["fetch", "-q", "origin", `+refs/heads/${loc.base}:refs/remotes/origin/${loc.base}`]);
    lastFetch.set(key, Date.now());
  }
  const sha = (await gq(loc.repoDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${loc.base}^{commit}`])).trim();
  return sha || null;
}

/** The blob id of `rel` at `commit`, or null when absent / not a file. */
async function blobAt(repoDir: string, commit: string, rel: string): Promise<string | null> {
  if (!rel) return null;
  const out = await gq(repoDir, ["ls-tree", "-z", commit, "--", rel]);
  const entry = out.split("\0").find(Boolean);
  if (!entry) return null;
  const [meta = ""] = entry.split("\t");
  const [, type, sha] = meta.split(" ");
  return type === "blob" && sha ? sha : null;
}

/** Read a file from `origin/<base>`; null ⇒ no base (fall back). `blob` null = the file is absent. */
export async function readBaseFile(root: string, path: string): Promise<{ loc: BaseLocation; data: Buffer | null; blob: string | null } | null> {
  const loc = await locateBase(root, path);
  if (!loc) return null;
  const ref = await baseRef(loc, false);
  if (!ref) return null;
  const blob = await blobAt(loc.repoDir, ref, loc.rel);
  if (!blob) return { loc, data: null, blob: null };
  const { stdout } = (await execInProject("git", ["cat-file", "blob", blob], {
    cwd: loc.repoDir,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  })) as unknown as { stdout: Buffer };
  return { loc, data: stdout, blob };
}

/** What `path` is on `origin/<base>`: a file, a folder (a submodule counts), absent; null ⇒ no base. */
export async function baseKind(root: string, path: string): Promise<"file" | "dir" | "none" | null> {
  const loc = await locateBase(root, path);
  if (!loc) return null;
  const ref = await baseRef(loc, false);
  if (!ref) return null;
  if (!loc.rel) return "dir";
  const type = (await gq(loc.repoDir, ["cat-file", "-t", `${ref}:${loc.rel}`])).trim();
  return type === "blob" ? "file" : type === "tree" || type === "commit" ? "dir" : "none";
}

/**
 * List a folder of `origin/<base>` (a submodule entry is a folder) + the ref / commit listed; null ⇒ no base
 * (fall back).
 */
export async function listBaseDir(
  root: string,
  path: string,
): Promise<{ entries: { name: string; type: "dir" | "file" }[]; ref: string; commit: string } | null> {
  const loc = await locateBase(root, path);
  if (!loc) return null;
  const ref = await baseRef(loc, false);
  if (!ref) return null;
  const out = await gq(loc.repoDir, ["ls-tree", "-z", loc.rel ? `${ref}:${loc.rel}` : ref]);
  const entries = out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta = "", name = ""] = line.split("\t");
      const type = meta.split(" ")[1];
      return { name, type: type === "blob" ? ("file" as const) : ("dir" as const) };
    })
    .filter((e) => e.name);
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { entries, ref: `origin/${loc.base}`, commit: ref };
}

/** Index entries (`mode sha path`) at or under `rel` in the temporary index. */
async function indexEntries(repoDir: string, env: NodeJS.ProcessEnv, rel: string): Promise<{ mode: string; sha: string; path: string }[]> {
  const out = await g(repoDir, ["ls-files", "-s", "-z", "--", rel], env);
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta = "", path = ""] = line.split("\t");
      const [mode = "100644", sha = ""] = meta.split(" ");
      return { mode, sha, path };
    })
    .filter((e) => e.path === rel || e.path.startsWith(rel + "/"));
}

/** Apply the edits to the temporary index (blobs are written into the object store). */
async function applyEdits(repoDir: string, env: NodeJS.ProcessEnv, edits: BaseEdit[], scratch: string): Promise<void> {
  let n = 0;
  for (const e of edits) {
    if (e.op === "put" || e.op === "mkdir") {
      const path = e.op === "put" ? e.path : posix.join(e.path, ".gitkeep");
      const data = e.op === "put" ? e.data : Buffer.alloc(0);
      const file = join(scratch, `blob-${n++}`);
      await writeFile(file, data, { mode: 0o644 });
      const sha = (await g(repoDir, ["hash-object", "-w", `--path=${path}`, file], env)).trim();
      const cur = await indexEntries(repoDir, env, path);
      const mode = cur.find((c) => c.path === path)?.mode ?? "100644";
      await g(repoDir, ["update-index", "--add", "--cacheinfo", `${mode},${sha},${path}`], env);
    } else if (e.op === "delete") {
      const cur = await indexEntries(repoDir, env, e.path);
      if (cur.length) await g(repoDir, ["update-index", "--force-remove", "--", ...cur.map((c) => c.path)], env);
    } else {
      const cur = await indexEntries(repoDir, env, e.from);
      if (!cur.length) throw new BaseEditError("source does not exist");
      if ((await indexEntries(repoDir, env, e.to)).length) throw new BaseEditError("destination already exists");
      for (const c of cur) {
        const dest = e.to + c.path.slice(e.from.length);
        await g(repoDir, ["update-index", "--add", "--cacheinfo", `${c.mode},${c.sha},${dest}`], env);
      }
      await g(repoDir, ["update-index", "--force-remove", "--", ...cur.map((c) => c.path)], env);
    }
  }
}

/** A push refused by a race (retry) vs. by policy / permission (give up). */
function pushFailure(msg: string): "race" | "rejected" | "other" {
  if (/non-fast-forward|fetch first|stale info|cannot lock ref|failed to update ref/i.test(msg)) return "race";
  if (/protected branch|GH006|pre-receive hook declined|permission|denied|forbidden|403|not allowed/i.test(msg)) return "rejected";
  return "other";
}

/**
 * Commit `edits` (all in the repo of `loc`) onto `origin/<base>` and push. Returns the pushed commit, or
 * `undefined` when the tree did not change. Throws `BaseEditError` (`FILE_CHANGED_UPSTREAM`,
 * `BASE_PUSH_REJECTED`, …) or an `Error` with git's message.
 */
export async function commitToBase(
  root: string,
  loc: BaseLocation,
  edits: BaseEdit[],
  opts: { message: string; by?: string; machineUsername?: string },
): Promise<string | undefined> {
  const gitDir = (await g(loc.repoDir, ["rev-parse", "--absolute-git-dir"])).trim();
  const scratch = await mkdtemp(join(tmpdir(), "4pm-web-edit-"));
  await chmod(scratch, 0o755);
  const index = join(gitDir, `4pm-web-index-${process.pid}-${Date.now()}`);
  const name = opts.machineUsername || (await gq(loc.repoDir, ["config", "user.name"])).trim() || "4PM";
  const email = (await gq(loc.repoDir, ["config", "user.email"])).trim() || `${name.replace(/[^a-zA-Z0-9._-]/g, "") || "4pm"}@users.noreply.4pm`;
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
  const message = opts.by ? `${opts.message}\n\n4PM-Edited-By: ${opts.by.replace(/\s+/g, " ").slice(0, 200)}` : opts.message;
  try {
    for (let attempt = 1; ; attempt++) {
      const parent = await baseRef(loc, true);
      if (!parent) throw new BaseEditError("no remote base");
      for (const e of edits) {
        if (e.op !== "put" || e.expectBlob === undefined) continue;
        if ((await blobAt(loc.repoDir, parent, e.path)) !== e.expectBlob) throw new BaseEditError("FILE_CHANGED_UPSTREAM");
      }
      // `read-tree` (no -m) replaces the whole temporary index with the parent tree.
      await g(loc.repoDir, ["read-tree", parent], env);
      await applyEdits(loc.repoDir, env, edits, scratch);
      const tree = (await g(loc.repoDir, ["write-tree"], env)).trim();
      const parentTree = (await g(loc.repoDir, ["rev-parse", `${parent}^{tree}`])).trim();
      if (tree === parentTree) return undefined;
      const commit = (await g(loc.repoDir, ["commit-tree", tree, "-p", parent, "-m", message], env)).trim();
      try {
        await g(loc.repoDir, ["push", "-q", "origin", `${commit}:refs/heads/${loc.base}`], undefined, 180_000);
      } catch (err) {
        const kind = pushFailure(err instanceof Error ? err.message : String(err));
        if (kind === "race" && attempt < MAX_ATTEMPTS) continue;
        if (kind === "rejected") throw new BaseEditError("BASE_PUSH_REJECTED");
        throw err;
      }
      await gq(loc.repoDir, ["update-ref", `refs/remotes/origin/${loc.base}`, commit]);
      lastFetch.set(`${loc.repoDir}\u0000${loc.base}`, Date.now());
      if (!loc.repoRel) await fastForwardRoot(root, loc.base);
      return commit;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    await execInProject("rm", ["-f", index], { cwd: loc.repoDir, timeout: 10_000 }).catch(() => undefined);
  }
}

/** Fast-forward the root working tree to `origin/<base>` when it is on `<base>`, clean and not held. */
async function fastForwardRoot(root: string, base: string): Promise<void> {
  const handle = tryAcquireRepo(root, "git", "web edit fast-forward");
  if (!handle) return;
  try {
    const branch = (await gq(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch !== base) return;
    if ((await gq(root, ["status", "--porcelain", "--untracked-files=no"])).trim()) return;
    await gq(root, ["merge", "-q", "--ff-only", `refs/remotes/origin/${base}`]);
  } finally {
    handle.release();
  }
}

/** Forget cached fetch times / bases (tests). */
export function resetBaseEditForTest(): void {
  lastFetch.clear();
  basesCache.clear();
}
