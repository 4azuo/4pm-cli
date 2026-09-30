/**
 * Git host helpers (ADR-0371) — the few host-side reads/writes the cli needs beyond plain git, through the
 * worker's authenticated `gh` (GitHub / GHE, incl. the GitHub-App shim — ADR-0356) or `glab` (GitLab):
 * branch protection, the pull/merge-request state of a branch, and opening a PR into an explicit base.
 * Every call is best-effort: an unknown host or a failing CLI yields `null` / an error string, never a throw.
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

/**
 * Open a PR/MR from `head` into `base` (always explicit — ADR-0371). An already-open PR for the branch is
 * reported (its URL parsed from the "already exists" error) instead of a failure.
 */
export async function openPullRequest(opts: {
  url: string;
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
}): Promise<{ url: string | null; error: string | null }> {
  const h = repoHost(opts.url);
  if (!h.provider) return { url: null, error: "Unknown git host — no pull request opened." };
  const args =
    h.provider === "gh"
      ? ["pr", "create", "-R", h.host && h.host !== "github.com" ? `${h.host}/${h.slug}` : h.slug, "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body", opts.body]
      : ["mr", "create", "-R", h.slug, "--target-branch", opts.base, "--source-branch", opts.head, "--title", opts.title, "--description", opts.body, "--yes"];
  try {
    const { stdout } = await run(h.provider, args, { cwd: opts.cwd, timeout: 120_000 });
    return { url: stdout.trim().split(/\s+/).find((x) => /^https?:\/\//.test(x)) ?? null, error: null };
  } catch (err) {
    const msg = errText(err);
    const existing = /already exists/i.test(msg) ? (msg.match(/https?:\/\/\S+/)?.[0] ?? null) : null;
    return existing ? { url: existing, error: null } : { url: null, error: msg };
  }
}
