/**
 * The project-template marker of the served root as it stands on `origin/<base>` — the version the
 * project's Update PR advances on merge. Read after the cycle's books sync (the base was just fetched) and on
 * a tick skipped for `templateUpdateRequired` (fetching the base first, under a try-lock), then reported in
 * `machine.status.templateMarker` so the server can pause / resume autonomous.
 * @adr 0550
 */
import { logger } from "../../common/logger/logger";
import { tryAcquireRepo } from "../git/repo-lock";
import { gitQuiet, resolveBases } from "./autonomous-git";
import { setTemplateMarker } from "./autonomous-policy";

/** The marker file, relative to the project root. */
const MARKER_PATH = ".4pm/.4pm.json";

/**
 * Read `templateVersion` of the marker on `origin/<base>` (no fetch) and record it. A missing marker or
 * version records null; an unreadable base (no remote ref) records nothing.
 */
export async function readBaseTemplateMarker(root: string, base: string): Promise<void> {
  if (!base) return;
  const ref = `origin/${base}`;
  if (!(await gitQuiet(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim()) return;
  const raw = await gitQuiet(root, ["show", `${ref}:${MARKER_PATH}`]);
  let v: unknown = null;
  try {
    v = (JSON.parse(raw) as { templateVersion?: unknown }).templateVersion;
  } catch {
    // no marker on the base (or unreadable) ⇒ null
  }
  setTemplateMarker(root, typeof v === "string" && v.trim() ? v.trim() : null);
}

/**
 * Fetch `<base>` and re-read the marker — run on a tick the policy skips for a required template update,
 * so a merged Update PR resumes autonomous without a cycle. The fetch only try-acquires the repo lock: a
 * busy working tree skips this round.
 */
export async function refreshBaseTemplateMarker(root: string): Promise<void> {
  try {
    const base = (await resolveBases(root)).root.base;
    if (!base) return;
    const lock = tryAcquireRepo(root, "git", "template-marker-fetch");
    if (!lock) return;
    try {
      await gitQuiet(root, ["fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    } finally {
      lock.release();
    }
    await readBaseTemplateMarker(root, base);
  } catch (err) {
    logger.warn("autonomous.templateMarker.refreshFailed", { error: String(err) });
  }
}
