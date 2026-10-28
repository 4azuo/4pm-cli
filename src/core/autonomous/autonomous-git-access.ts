/**
 * The git credential pre-check of an autonomous cycle: before claiming, prove the project's git credential (the
 * GitHub App / GitLab token served through the credential helper, or the worker's own gh / glab login) can still
 * read every repository (`ls-remote`) and push to it (`push --dry-run` of a throw-away ref). Only an auth /
 * permission refusal fails the check — a network blip does not. A passing result is reused for 10 minutes.
 * @adr 0661 @arch 0038
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, type RepoBase } from "./autonomous-git";

/** How long a passing check is reused per project root. */
const OK_TTL_MS = 10 * 60_000;
/** The ref a dry-run push targets — never written (dry run). */
const PROBE_REF = "refs/heads/4pm/access-check";

/** Roots whose last check passed, until when. */
const okUntil = new Map<string, number>();

/** The first repository the credential can't reach / push, with the git message. */
export interface GitAccessFailure {
  /** "root" or the submodule folder. */
  repo: string;
  /** "read" (clone / fetch) or "push". */
  step: "read" | "push";
  reason: string;
}

/** True when a git error is the remote refusing the credential (not a network or local problem). */
export function isGitAccessError(message: string): boolean {
  return /\b40[134]\b|permission .*denied|denied to|not allowed to push|authentication failed|could not read (username|password)|repository not found|write access .*not granted|refusing to allow .*(oauth|github) app to create or update workflow|invalid username or password|access denied/i.test(
    message,
  );
}

/**
 * Check the credential on the root and every submodule; null when every reachable repo can be read and pushed.
 * A repository not checked out yet is skipped (its clone reports its own error).
 */
export async function checkGitAccess(root: string, repos: RepoBase[]): Promise<GitAccessFailure | null> {
  if ((okUntil.get(root) ?? 0) > Date.now()) return null;
  for (const r of repos) {
    const dir = r.dir ? join(root, r.dir) : root;
    if (!existsSync(join(dir, ".git"))) continue;
    const repo = r.dir || "root";
    try {
      await git(dir, ["ls-remote", "--heads", "origin", r.base || "HEAD"], 60_000);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (isGitAccessError(reason)) return { repo, step: "read", reason };
      continue;
    }
    try {
      await git(dir, ["push", "--dry-run", "--porcelain", "origin", `HEAD:${PROBE_REF}`], 60_000);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (isGitAccessError(reason)) return { repo, step: "push", reason };
    }
  }
  okUntil.set(root, Date.now() + OK_TTL_MS);
  return null;
}

/** Forget a passing result (a push was rejected mid-run, or the credential changed). */
export function forgetGitAccess(root: string): void {
  okUntil.delete(root);
}
