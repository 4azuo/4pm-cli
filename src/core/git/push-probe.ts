/**
 * `repo.pushProbe` — may the project credential push the primary repo's `<base>`? Run by the server before it accepts
 * Delivery · Auto: a protected base (read through `gh` / `glab` when available) refuses at once, otherwise a
 * `git push --dry-run` of the remote base onto itself asks the host for write access without changing anything.
 * @adr 0608 @api project-0135
 */
import type { RepoPushProbeReply } from "@4pm/ws";
import { git, resolveBases } from "../autonomous/autonomous-git";
import { branchProtection } from "./git-host";

/** Probe push rights on the served project's primary base. Never throws. */
export async function probePush(root: string | null | undefined): Promise<RepoPushProbeReply> {
  if (!root) return { ok: false, reason: "this worker has no project folder" };
  try {
    const { root: base } = await resolveBases(root);
    if (!base.base) return { ok: false, reason: "the base branch could not be resolved" };
    if (base.url && (await branchProtection(base.url, base.base)) === true) {
      return { ok: false, reason: `${base.base} is a protected branch` };
    }
    await git(root, ["fetch", "--quiet", "origin", base.base], 60_000);
    await git(root, ["push", "--dry-run", "--porcelain", "origin", `refs/remotes/origin/${base.base}:refs/heads/${base.base}`], 60_000);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}
