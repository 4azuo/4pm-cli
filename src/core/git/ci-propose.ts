/**
 * `ci.propose` — CI workflow files proposed as a PR / MR: re-check the paths (workflow files only), commit
 * them on a new `4pm/ci/<slug>-<yyyymmddhhmm>` branch cut from the root repo's `origin/<base>` (a temporary index —
 * the working tree and `<base>` are never touched), push under the server-chosen `ci-propose:<uuid>` git-token scope
 * (the only scope minted with `workflows: write`), open the PR / MR into `<base>`, and end the scope (its tokens are
 * revoked). The token sockets serve that scope only while this run lasts. Never throws: a failure is a reply with
 * `code` / `step`.
 * @adr 0606 @adr 0607 @adr 0672 @api machine-0101
 */
import { CI_PROPOSE_MAX_FILE_BYTES, CI_PROPOSE_MAX_FILES, CI_PROPOSE_PATH, type CiProposeReply, type CiProposeRequest } from "@4pm/ws";
import { commitToBranch, locateBase, type BaseEdit } from "./base-edit";
import { closePrivilegedScope, endGitScope, JOB_ID_ENV, openPrivilegedScope } from "./git-auth";
import { openPullRequest } from "./git-host";
import { git } from "../autonomous/autonomous-git";

/** `yyyymmddhhmm` in UTC. */
function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

/** The PR number of a PR / MR URL, or null. */
function prNumberOf(url: string | null): number | null {
  const m = url ? /\/(?:pull|merge_requests)\/(\d+)/.exec(url) : null;
  return m ? Number(m[1]) : null;
}

/** Validate a request; the reply to send when invalid, else null. */
export function checkProposal(req: CiProposeRequest): CiProposeReply | null {
  if (!Array.isArray(req.files) || req.files.length === 0 || req.files.length > CI_PROPOSE_MAX_FILES) {
    return { ok: false, code: "CI_PATH_NOT_ALLOWED", error: "1 to 20 files are required." };
  }
  for (const f of req.files) {
    if (!CI_PROPOSE_PATH.test(f.path)) return { ok: false, code: "CI_PATH_NOT_ALLOWED", error: `Not a workflow path: ${f.path}` };
    if (f.content !== null && Buffer.byteLength(f.content) > CI_PROPOSE_MAX_FILE_BYTES) {
      return { ok: false, code: "CI_PATH_NOT_ALLOWED", error: `${f.path} is larger than 256 KB.` };
    }
  }
  if (!/^ci-propose:[\w-]+$/.test(req.scope)) return { ok: false, code: "CI_PROPOSE_FAILED", step: "push", error: "Bad git-token scope." };
  return null;
}

/** Commit, push and open the PR / MR for a proposal on the project at `root`. */
export async function proposeCi(root: string, req: CiProposeRequest, machineUsername?: string): Promise<CiProposeReply> {
  const invalid = checkProposal(req);
  if (invalid) return invalid;
  const loc = await locateBase(root, ".");
  if (!loc) return { ok: false, code: "CI_PROPOSE_FAILED", step: "base", error: "The repository has no remote base branch." };
  const slug = (req.slug || "ci").replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "ci";
  const branch = `4pm/ci/${slug}-${stamp()}`;
  const edits: BaseEdit[] = req.files.map((f) =>
    f.content === null ? { op: "delete", path: f.path } : { op: "put", path: f.path, data: Buffer.from(f.content, "utf8") },
  );
  const message = `${req.title}\n\n4PM-Requested-By: ${req.byLabel.replace(/\s+/g, " ").slice(0, 200)}`;
  // The push's credential helper asks through the token socket: let it serve this one scope for this run only.
  openPrivilegedScope(req.scope);
  try {
    let commit: string | undefined;
    try {
      commit = await commitToBranch(loc, branch, edits, { message, machineUsername, env: { [JOB_ID_ENV]: req.scope } });
    } catch (err) {
      return { ok: false, code: "CI_PROPOSE_FAILED", step: "push", error: err instanceof Error ? err.message : String(err) };
    }
    if (!commit) return { ok: false, code: "CI_PROPOSE_FAILED", step: "push", error: "The files are already like this on the base branch." };
    const url = (await git(root, ["remote", "get-url", "origin"]).catch(() => "")).trim();
    const pr = await openPullRequest({ url, cwd: root, base: loc.base, head: branch, title: req.title, body: req.body });
    if (pr.error) return { ok: false, code: "CI_PROPOSE_FAILED", step: "pr", branch, error: pr.error };
    return { ok: true, branch, prUrl: pr.url, number: prNumberOf(pr.url) };
  } finally {
    closePrivilegedScope(req.scope);
    await endGitScope(req.scope);
  }
}
