/**
 * `flowmap.staleCheck` — which sources of a flow map changed on `origin/<base>` after the commit each is checked from:
 * a fetch of the base (at most every 5 minutes per repo), then `git log` per path. With `diffs` it also returns the
 * unified diff `since..origin/<base>` of those paths (for Update with AI), capped in total. A source in a submodule is
 * checked in its own repo. Never throws.
 * @adr 0698 @arch 0076
 */
import type { FlowMapStaleCheckReply, FlowMapStaleCheckRequest } from "@4pm/ws";
import { git } from "../../autonomous/autonomous-git";
import { locateBase, type BaseLocation } from "../../git/base-edit";

/** Fetch the base of a repo at most this often. */
const FETCH_EVERY_MS = 5 * 60_000;
/** Total diff bytes returned. */
const MAX_DIFF_BYTES = 200_000;
/** Most sources checked. */
const MAX_SOURCES = 200;

const lastFetch = new Map<string, number>();

/** Run git, "" on failure. */
async function gq(cwd: string, args: string[]): Promise<string> {
  return git(cwd, args, 60_000).catch(() => "");
}

/** Run git, true when it exits 0. */
async function gok(cwd: string, args: string[]): Promise<boolean> {
  return git(cwd, args, 60_000).then(
    () => true,
    () => false,
  );
}

/** The fetched remote head of the repo's base. */
async function baseHead(loc: BaseLocation): Promise<string> {
  const key = `${loc.repoDir}\u0000${loc.base}`;
  if (Date.now() - (lastFetch.get(key) ?? 0) > FETCH_EVERY_MS) {
    await gq(loc.repoDir, ["fetch", "-q", "origin", `+refs/heads/${loc.base}:refs/remotes/origin/${loc.base}`]);
    lastFetch.set(key, Date.now());
  }
  return (await gq(loc.repoDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${loc.base}^{commit}`])).trim();
}

/** Check the sources of a map on the project at `root`. */
export async function flowMapStaleCheck(root: string, req: FlowMapStaleCheckRequest): Promise<FlowMapStaleCheckReply> {
  try {
    const rootLoc = await locateBase(root, ".");
    if (!rootLoc) return { ok: false, code: "FLOWMAP_NO_BASE", error: "The repository has no remote base branch." };
    const rootHead = await baseHead(rootLoc);
    const changed: NonNullable<FlowMapStaleCheckReply["changed"]> = [];
    const want = new Set(req.diffs ?? []);
    const diffs: NonNullable<FlowMapStaleCheckReply["diffs"]> = [];
    let diffBytes = 0;
    for (const src of (req.sources ?? []).slice(0, MAX_SOURCES)) {
      const loc = await locateBase(root, src.path);
      if (!loc || !loc.rel || !/^[0-9a-f]{7,64}$/.test(src.since)) continue;
      const head = loc.repoDir === rootLoc.repoDir ? rootHead : await baseHead(loc);
      if (!head) continue;
      // A pin the repo does not know (rewritten history) cannot be compared — skip rather than flag.
      if (!(await gok(loc.repoDir, ["cat-file", "-e", `${src.since}^{commit}`]))) continue;
      if (!(await gok(loc.repoDir, ["merge-base", "--is-ancestor", src.since, head]))) continue;
      const out = (await gq(loc.repoDir, ["log", "-1", "--format=%H%x1f%an%x1f%aI%x1f%s", `${src.since}..${head}`, "--", loc.rel])).trim();
      if (!out) continue;
      const [commit = "", author = "", at = "", subject = ""] = out.split("\x1f");
      changed.push({ path: src.path, commit, author, at, subject: subject.slice(0, 200) });
      if (want.has(src.path) && diffBytes < MAX_DIFF_BYTES) {
        const diff = await gq(loc.repoDir, ["diff", "--no-color", "-U3", src.since, head, "--", loc.rel]);
        const cut = diff.slice(0, MAX_DIFF_BYTES - diffBytes);
        diffBytes += cut.length;
        if (cut) diffs.push({ path: src.path, diff: cut });
      }
    }
    return { ok: true, base: rootLoc.base, baseHead: rootHead, changed, ...(want.size ? { diffs } : {}) };
  } catch (err) {
    return { ok: false, code: "FLOWMAP_STALE_FAILED", error: err instanceof Error ? err.message : String(err) };
  }
}

