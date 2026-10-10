/**
 * Git commit author on the worker: before the AI (or a dispatched git command)
 * may commit, set the repo's local `user.name` to the machine-user's username so commits are
 * attributed to that machine-user. Push still uses whatever gh/glab account the worker is
 * already logged in with. Never throws — a failure just leaves git's existing config.
 * @adr 0097
 */
import { execInProject } from "../agent/agent-spawn";

// Project git runs as the agent user when uid separation is on (ADR-0430); unchanged otherwise.
const run = execInProject;

/**
 * Set the local git commit author name for `cwd` to `machineUsername` (best-effort).
 */
export async function setCommitAuthor(cwd: string, machineUsername: string): Promise<void> {
  if (!machineUsername) return;
  try {
    await run("git", ["config", "--local", "user.name", machineUsername], { cwd, timeout: 8000 });
  } catch {
    // Not a git repo yet / git missing — ignore; commits keep git's existing identity.
  }
}
