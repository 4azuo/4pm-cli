/**
 * Git of the marketing branch `4pm/marketing/<base>` — an orphan branch holding only `.4pm/marketing/**`. Reads come
 * from the remote-tracking ref after a fetch; writes build the new tree in a temporary index (`GIT_INDEX_FILE`) from
 * that ref (or from nothing, the first time), commit it with `commit-tree` and push `<commit>:refs/heads/<branch>`.
 * A refused non-fast-forward push is a lost race: fetch and rebuild (3 attempts). The working tree is never touched,
 * so no repo lock is taken.
 * @adr 0640 @arch 0067
 */
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKETING_BASE_RE, MARKETING_ROOT, marketingBranch } from "@4pm/dto";
import { execInProject } from "../agent/agent-spawn";
import { resolveBases } from "../autonomous/autonomous-git";

/** A marketing git failure with an API code. */
export class MarketingGitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MarketingGitError";
  }
}

/** Run git as the project user; throws with the last stderr lines. */
export async function mg(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 120_000): Promise<string> {
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
export async function mgq(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    return await mg(cwd, args, env, 60_000);
  } catch {
    return "";
  }
}

/** The base of a request: the given one (validated), else the primary repo's base. */
export async function resolveMarketingBase(root: string, base?: string): Promise<string> {
  if (base) {
    if (!MARKETING_BASE_RE.test(base)) throw new MarketingGitError("MARKETING_WRITE_FAILED", `Bad base branch "${base}".`);
    return base;
  }
  const resolved = (await resolveBases(root)).root.base;
  if (!resolved) throw new MarketingGitError("MARKETING_WRITE_FAILED", "The repository has no remote base branch.");
  return resolved;
}

/** The remote branches that can be a base (no 4PM work / books / marketing branches). */
export async function listBases(root: string): Promise<string[]> {
  const out = await mgq(root, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
  return out
    .split("\n")
    .map((l) => l.trim().replace(/^origin\//, ""))
    .filter((b) => b && b !== "HEAD" && b !== "origin" && !/^(4pm\/|autonomous-books\/|dev\/)/.test(b) && MARKETING_BASE_RE.test(b))
    .sort();
}

/** Fetch the marketing branch of a base; the commit of its remote-tracking ref, or null when it doesn't exist. */
export async function marketingRef(root: string, base: string): Promise<string | null> {
  const branch = marketingBranch(base);
  await mgq(root, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const sha = (await mgq(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`])).trim();
  return sha || null;
}

/** A file at a commit (content + blob id), or null when absent. `rel` is relative to `.4pm/marketing/`. */
export async function readMarketingFile(root: string, commit: string | null, rel: string): Promise<{ content: string; sha: string } | null> {
  if (!commit) return null;
  const path = `${MARKETING_ROOT}/${rel}`;
  const sha = (await mgq(root, ["rev-parse", "--verify", "--quiet", `${commit}:${path}`])).trim();
  if (!sha) return null;
  const type = (await mgq(root, ["cat-file", "-t", sha])).trim();
  if (type !== "blob") return null;
  return { content: await mg(root, ["cat-file", "blob", sha]), sha };
}

/** The photo set folders at a commit. */
export async function listPhotoSets(root: string, commit: string | null): Promise<string[]> {
  if (!commit) return [];
  const out = await mgq(root, ["ls-tree", "-d", "--name-only", `${commit}:${MARKETING_ROOT}/photos`]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean).sort();
}

/** One change of a marketing commit: put a file, or delete a file / folder (`content: null`). Paths are relative to `.4pm/marketing/`. */
export interface MarketingEdit {
  path: string;
  content: string | null;
}

/** A push refused by a race (retry) vs. anything else. */
function isRace(msg: string): boolean {
  return /non-fast-forward|fetch first|rejected.*\(stale info\)|cannot lock ref|failed to update ref/i.test(msg);
}

/**
 * Commit edits on `4pm/marketing/<base>` and push. `build` is called with the current branch commit (null = the branch
 * doesn't exist yet) on every attempt and returns the edits — so checks against the current files run again after a
 * lost race; it may throw a `MarketingGitError` to refuse. Returns the new commit, or null when nothing changed.
 */
export async function commitMarketing(
  root: string,
  base: string,
  message: string,
  build: (commit: string | null) => Promise<MarketingEdit[]>,
): Promise<string | null> {
  const branch = marketingBranch(base);
  const gitDir = (await mg(root, ["rev-parse", "--absolute-git-dir"])).trim();
  const name = (await mgq(root, ["config", "user.name"])).trim() || "4PM";
  const email = (await mgq(root, ["config", "user.email"])).trim() || "4pm@users.noreply.4pm";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const parent = await marketingRef(root, base);
    const edits = await build(parent);
    const index = join(gitDir, `4pm-marketing-index-${process.pid}-${Date.now()}`);
    const scratch = await mkdtemp(join(tmpdir(), "4pm-marketing-"));
    await chmod(scratch, 0o755);
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    try {
      if (parent) await mg(root, ["read-tree", parent], env);
      else await mg(root, ["read-tree", "--empty"], env);
      let n = 0;
      for (const e of edits) {
        const path = `${MARKETING_ROOT}/${e.path}`;
        if (e.content === null) {
          const cur = (await mg(root, ["ls-files", "-z", "--", path], env)).split("\0").filter(Boolean);
          if (cur.length) await mg(root, ["update-index", "--force-remove", "--", ...cur], env);
          continue;
        }
        const file = join(scratch, `blob-${n++}`);
        await writeFile(file, e.content, { mode: 0o644 });
        const sha = (await mg(root, ["hash-object", "-w", `--path=${path}`, file], env)).trim();
        await mg(root, ["update-index", "--add", "--cacheinfo", `100644,${sha},${path}`], env);
      }
      // The branch always keeps its folder.
      if (!parent) {
        const keep = join(scratch, "keep");
        await writeFile(keep, "", { mode: 0o644 });
        const sha = (await mg(root, ["hash-object", "-w", keep], env)).trim();
        await mg(root, ["update-index", "--add", "--cacheinfo", `100644,${sha},${MARKETING_ROOT}/.keep`], env);
      }
      const tree = (await mg(root, ["write-tree"], env)).trim();
      if (parent && tree === (await mg(root, ["rev-parse", `${parent}^{tree}`])).trim()) return null;
      const commit = (await mg(root, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], env)).trim();
      try {
        await mg(root, ["push", "-q", "origin", `${commit}:refs/heads/${branch}`], undefined, 180_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRace(msg) && attempt < 3) continue;
        throw new MarketingGitError("MARKETING_WRITE_FAILED", `Push to ${branch} failed: ${msg}`);
      }
      await mgq(root, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      return commit;
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      await execInProject("rm", ["-f", index], { cwd: root, timeout: 10_000 }).catch(() => undefined);
    }
  }
  throw new MarketingGitError("MARKETING_WRITE_FAILED", `Push to ${branch} kept losing races.`);
}
