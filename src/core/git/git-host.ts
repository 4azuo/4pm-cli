/**
 * Git host helpers — the few host-side reads/writes the cli needs beyond plain git, through the
 * worker's authenticated `gh` (GitHub / GHE, incl. the GitHub-App shim) or `glab` (GitLab):
 * branch protection, the pull/merge-request state of a branch, opening a PR into an explicit base, and the
 * open PRs that conflict with their target, and the follow-up of a root PR that waits for submodule PRs (merge commit,
 * draft → ready, merge / auto-merge).
 * Every call is best-effort: an unknown host or a failing CLI yields `null` / an error string, never a throw.
 * @adr 0371 @adr 0356 @adr 0539 @adr 0579
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseRepoUrl } from "@4pm/dto";

const run = promisify(execFile);

/** Which host CLI serves a repo, and how to address it. */
export interface RepoHost {
  provider: "gh" | "glab" | null;
  host: string;
  /** `owner/name` (GitLab: the full group path + name). */
  slug: string;
}

/** Resolve the host CLI + slug from a clone url (GitHub incl. GHE hosts, GitLab incl. self-managed). */
export function repoHost(url: string): RepoHost {
  const p = parseRepoUrl(url);
  if (!p) return { provider: null, host: "", slug: "" };
  const slug = `${p.owner}/${p.name}`;
  const provider = /gitlab/i.test(p.host) ? "glab" : /github|ghe\.com/i.test(p.host) ? "gh" : null;
  return { provider, host: p.host, slug };
}

/** `gh` args addressing a non-github.com host. */
function ghHostArgs(h: RepoHost): string[] {
  return h.host && h.host !== "github.com" ? ["--hostname", h.host] : [];
}

/** Last lines of a failed command's stderr/message, capped. */
function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr || e?.message || String(err)).trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 400);
}

/**
 * Is `branch` protected on the host? `true`/`false`, or `null` when unknown (no host CLI, unknown host, or
 * the branch does not exist yet).
 */
export async function branchProtection(url: string, branch: string): Promise<boolean | null> {
  const h = repoHost(url);
  if (!h.provider || !branch) return null;
  try {
    if (h.provider === "gh") {
      const { stdout } = await run("gh", ["api", ...ghHostArgs(h), `repos/${h.slug}/branches/${encodeURIComponent(branch)}`, "--jq", ".protected"], { timeout: 30_000 });
      return stdout.trim() === "true";
    }
    const project = encodeURIComponent(h.slug);
    try {
      await run("glab", ["api", `projects/${project}/protected_branches/${encodeURIComponent(branch)}`], { timeout: 30_000 });
      return true;
    } catch (err) {
      // 404 ⇒ not protected (the branch itself may still exist).
      return /404|not found/i.test(errText(err)) ? false : null;
    }
  } catch {
    return null;
  }
}

/** The state of the most recent PR/MR whose head is `branch`: open · merged · closed, or null (none / unknown). */
export async function prStateOf(url: string, branch: string): Promise<"open" | "merged" | "closed" | null> {
  const h = repoHost(url);
  if (!h.provider) return null;
  try {
    if (h.provider === "gh") {
      const { stdout } = await run(
        "gh",
        ["pr", "list", "-R", h.host && h.host !== "github.com" ? `${h.host}/${h.slug}` : h.slug, "--head", branch, "--state", "all", "--json", "state", "-L", "1"],
        { timeout: 30_000 },
      );
      const s = (JSON.parse(stdout) as { state?: string }[])[0]?.state?.toLowerCase();
      return s === "open" || s === "merged" || s === "closed" ? s : null;
    }
    const { stdout } = await run("glab", ["mr", "list", "-R", h.slug, "--source-branch", branch, "--all", "-F", "json", "-P", "1"], { timeout: 30_000 });
    const s = (JSON.parse(stdout) as { state?: string }[])[0]?.state?.toLowerCase();
    return s === "opened" ? "open" : s === "merged" ? "merged" : s === "closed" ? "closed" : null;
  } catch {
    return null;
  }
}

/** An open pull / merge request whose head conflicts with its target (same-repo heads only). @adr 0539 */
export interface ConflictingPr {
  number: number;
  title: string;
  head: string;
  base: string;
  /** The head commit, to remember which state was already tried. */
  headSha: string;
}

/**
 * The open PRs/MRs of the repo at `url` that conflict with their target: `gh pr list` `mergeable == CONFLICTING`
 * (GitHub may still be computing — `UNKNOWN` is skipped) / `glab mr list` `has_conflicts`. PRs from forks are left
 * out (the cli cannot push to them). Empty on any failure.
 */
export async function conflictingPullRequests(url: string): Promise<ConflictingPr[]> {
  const h = repoHost(url);
  if (!h.provider) return [];
  try {
    if (h.provider === "gh") {
      const repo = h.host && h.host !== "github.com" ? `${h.host}/${h.slug}` : h.slug;
      const { stdout } = await run(
        "gh",
        ["pr", "list", "-R", repo, "--state", "open", "-L", "50", "--json", "number,title,headRefName,baseRefName,headRefOid,mergeable,isCrossRepository"],
        { timeout: 60_000 },
      );
      return (JSON.parse(stdout) as Record<string, unknown>[])
        .filter((p) => p.mergeable === "CONFLICTING" && p.isCrossRepository !== true)
        .map((p) => ({ number: Number(p.number), title: String(p.title ?? ""), head: String(p.headRefName ?? ""), base: String(p.baseRefName ?? ""), headSha: String(p.headRefOid ?? "") }));
    }
    const { stdout } = await run("glab", ["mr", "list", "-R", h.slug, "-F", "json", "-P", "50"], { timeout: 60_000 });
    return (JSON.parse(stdout) as Record<string, unknown>[])
      .filter((m) => m.has_conflicts === true && m.source_project_id === m.target_project_id)
      .map((m) => ({ number: Number(m.iid), title: String(m.title ?? ""), head: String(m.source_branch ?? ""), base: String(m.target_branch ?? ""), headSha: String(m.sha ?? "") }));
  } catch {
    return [];
  }
}

/**
 * Open a PR/MR from `head` into `base` (always explicit). An already-open PR for the branch is
 * reported (its URL parsed from the "already exists" error) instead of a failure.
 */
export async function openPullRequest(opts: {
  url: string;
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
  /** Open as a draft; a host / repo without drafts gets a normal PR. */
  draft?: boolean;
}): Promise<{ url: string | null; error: string | null }> {
  const h = repoHost(opts.url);
  if (!h.provider) return { url: null, error: "Unknown git host — no pull request opened." };
  const create = async (draft: boolean): Promise<{ url: string | null; error: string | null }> => {
    const args =
      h.provider === "gh"
        ? ["pr", "create", "-R", ghRepo(h), "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body", opts.body, ...(draft ? ["--draft"] : [])]
        : ["mr", "create", "-R", h.slug, "--target-branch", opts.base, "--source-branch", opts.head, "--title", opts.title, "--description", opts.body, "--yes", ...(draft ? ["--draft"] : [])];
    try {
      const { stdout } = await run(h.provider!, args, { cwd: opts.cwd, timeout: 120_000 });
      return { url: stdout.trim().split(/\s+/).find((x) => /^https?:\/\//.test(x)) ?? null, error: null };
    } catch (err) {
      const msg = errText(err);
      const existing = /already exists/i.test(msg) ? (msg.match(/https?:\/\/\S+/)?.[0] ?? null) : null;
      return existing ? { url: existing, error: null } : { url: null, error: msg };
    }
  };
  const first = await create(opts.draft === true);
  // Drafts are not available everywhere (e.g. private repos on some GitHub plans): open a normal PR instead.
  return opts.draft && first.error && /draft/i.test(first.error) ? create(false) : first;
}

/** `gh -R` repo argument (host-qualified off github.com). */
function ghRepo(h: RepoHost): string {
  return h.host && h.host !== "github.com" ? `${h.host}/${h.slug}` : h.slug;
}

/** The number of a PR / MR link, or null. */
function prNumber(prUrl: string): string | null {
  return /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(prUrl)?.[1] ?? null;
}

/**
 * The commit a merged PR / MR of `branch` produced on its base — the merge commit, the squash commit or the last
 * rebased commit — or null (not merged / unknown).
 * @adr 0579
 */
export async function prMergeCommitOf(url: string, branch: string): Promise<string | null> {
  const h = repoHost(url);
  if (!h.provider) return null;
  try {
    if (h.provider === "gh") {
      const { stdout } = await run("gh", ["pr", "list", "-R", ghRepo(h), "--head", branch, "--state", "merged", "--json", "mergeCommit", "-L", "1"], { timeout: 30_000 });
      const sha = (JSON.parse(stdout) as { mergeCommit?: { oid?: string } }[])[0]?.mergeCommit?.oid ?? "";
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    }
    const { stdout } = await run("glab", ["mr", "list", "-R", h.slug, "--source-branch", branch, "--merged", "-F", "json", "-P", "1"], { timeout: 30_000 });
    const m = (JSON.parse(stdout) as { merge_commit_sha?: string | null; squash_commit_sha?: string | null; sha?: string }[])[0];
    const sha = m?.merge_commit_sha || m?.squash_commit_sha || "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Turn a draft PR / MR ready for review. True when it is ready now (already ready counts). @adr 0579 */
export async function markPrReady(url: string, prUrl: string): Promise<boolean> {
  const h = repoHost(url);
  const n = prNumber(prUrl);
  if (!h.provider || !n) return false;
  try {
    if (h.provider === "gh") await run("gh", ["pr", "ready", n, "-R", ghRepo(h)], { timeout: 30_000 });
    else await run("glab", ["mr", "update", n, "-R", h.slug, "--ready"], { timeout: 30_000 });
    return true;
  } catch (err) {
    return /not a draft|already.*ready|is not in draft/i.test(errText(err));
  }
}

/**
 * Merge a PR / MR now, trying the merge styles the repo may allow (merge, squash, rebase); when the base needs
 * approvals / checks, turn on auto-merge instead. `merged` / `auto`, or the last error.
 * @adr 0579
 */
export async function mergePullRequest(url: string, prUrl: string): Promise<{ result: "merged" | "auto" } | { error: string }> {
  const h = repoHost(url);
  const n = prNumber(prUrl);
  if (!h.provider || !n) return { error: "Unknown git host or PR link." };
  let last = "";
  const attempt = async (args: string[]): Promise<boolean> => {
    try {
      await run(h.provider!, args, { timeout: 120_000 });
      return true;
    } catch (err) {
      last = errText(err);
      return false;
    }
  };
  if (h.provider === "gh") {
    const styles = ["--merge", "--squash", "--rebase"];
    for (const st of styles) if (await attempt(["pr", "merge", n, "-R", ghRepo(h), st])) return { result: "merged" };
    for (const st of styles) if (await attempt(["pr", "merge", n, "-R", ghRepo(h), st, "--auto"])) return { result: "auto" };
    return { error: last };
  }
  if (await attempt(["mr", "merge", n, "-R", h.slug, "--yes"])) return { result: "merged" };
  for (const flag of ["--auto-merge", "--when-pipeline-succeeds"]) if (await attempt(["mr", "merge", n, "-R", h.slug, "--yes", flag])) return { result: "auto" };
  return { error: last };
}
