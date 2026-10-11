/**
 * What a customer (CLIENT viewer) may see of the served project tree: never `.git`, never a gitignored
 * path — a worker checkout can hold local secrets (`.env`, credentials) that only internal members may
 * read. Tracked files stay visible even when a pattern matches them (git's own rule: only untracked
 * files are "ignored").
 * @adr 0449
 */
import { relative, resolve, sep } from "node:path";
import { execInProject } from "../agent/agent-spawn";
import { lexicalInRoot } from "../../utils/safe-path";

/** True when a root-relative path is `.git` or inside it. */
function inGitDir(rel: string): boolean {
  const first = rel.split(/[\\/]/)[0];
  return first === ".git";
}

/** A root-relative path with forward slashes ("" for the root). */
function toRel(root: string, abs: string): string {
  const rel = relative(resolve(root), abs).split(sep).join("/");
  return rel === "." ? "" : rel;
}

/**
 * The ignored, untracked paths under `pathspec` (root-relative), as git prints them — an ignored folder
 * collapses to `dir/`. A failed listing (no git, not a repo) yields `null`.
 */
async function ignoredUnder(root: string, pathspec: string): Promise<string[] | null> {
  try {
    const { stdout } = await execInProject(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", pathspec || "."],
      { cwd: root, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/** True when the absolute `target` (inside `root`) is hidden from a customer. */
export async function hiddenFromClient(root: string, target: string): Promise<boolean> {
  const rel = toRel(root, target);
  if (!rel) return false;
  if (inGitDir(rel)) return true;
  const ignored = await ignoredUnder(root, rel);
  // Fail closed: without git we cannot tell an ignored secret from a normal file.
  return ignored === null || ignored.length > 0;
}

/** Drop `.git` and gitignored names from one directory listing (`dirRel` = the folder, root-relative). */
export async function filterListingForClient<T extends { name: string }>(
  root: string,
  dirRel: string,
  entries: readonly T[],
): Promise<T[]> {
  const dir = dirRel.split(sep).join("/").replace(/^\.\/?/, "").replace(/\/$/, "");
  const prefix = dir ? `${dir}/` : "";
  const candidates = entries.filter((e) => !inGitDir(`${prefix}${e.name}`));
  const ignored = await ignoredUnder(root, dir);
  if (ignored === null) return []; // fail closed (see hiddenFromClient)
  const hidden = new Set(ignored.map((p) => p.replace(/\/$/, "")));
  return candidates.filter((e) => !hidden.has(`${prefix}${e.name}`));
}

/** True when `path` (root-relative) must be withheld from this viewer — only a customer is filtered. */
export async function clientHidden(root: string | null, path: string, viewer: string | undefined): Promise<boolean> {
  if (viewer !== "client" || !root) return false;
  const target = lexicalInRoot(root, path);
  return target ? hiddenFromClient(root, target) : false;
}
