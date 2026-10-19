/**
 * User discussions on the books branch — the cli half: write a server batch of rendered
 * `.4pm/discussions/<DSC-ID>.md` files in one books commit (trailers `4PM-Discussion-Batch` / `4PM-Ops`),
 * never overwriting a file edited in the repo since the server last saw it; list / read the files and find
 * a batch commit by its trailer (verification of a lost reply). Agents read the files themselves from their books
 * overlay.
 * @adr 0454 @adr 0563
 */
import { join } from "node:path";
import { DISCUSSIONS_DIR, DISCUSSION_CODE_RE } from "@4pm/dto";
import type { AutonomousWriteReply, DiscussionsReadReply, DiscussionsReadRequest } from "@4pm/ws";
import { writeFileInRoot } from "../../utils/safe-path";
import { booksReadRef, gitQuiet, mutateBooks, resolveBases } from "./autonomous-git";
import { booksBranch } from "./autonomous-tasks";

/** A file path of the batch must be `.4pm/discussions/DSC-YYYYMMDD-NNNN.md`. */
function validPath(path: string): boolean {
  const m = /^\.4pm\/discussions\/(DSC-\d{8}-\d{4})\.md$/.exec(path);
  return Boolean(m && DISCUSSION_CODE_RE.test(m[1]!));
}

/** The blob sha of `path` at `ref` ("" when absent). */
async function blobAt(cwd: string, ref: string, path: string): Promise<string> {
  return (await gitQuiet(cwd, ["rev-parse", "-q", "--verify", `${ref}:${path}`])).trim();
}

/** The books-branch commit whose message carries `4PM-Discussion-Batch: <batchId>`, or null. */
async function batchCommit(cwd: string, ref: string, batchId: string): Promise<string | null> {
  const sha = (await gitQuiet(cwd, ["log", ref, "-1", "--format=%H", "--fixed-strings", `--grep=4PM-Discussion-Batch: ${batchId}`])).trim();
  return sha || null;
}

/** Fetch the books branch and return its read ref (null when there is no remote base). */
async function freshRef(root: string): Promise<{ base: string; ref: string } | null> {
  const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
  if (!base) return null;
  await gitQuiet(root, ["fetch", "-q", "origin", base]);
  await gitQuiet(root, ["fetch", "-q", "origin", booksBranch(base)]);
  const ref = await booksReadRef(root, base);
  return ref ? { base, ref } : null;
}

/** discussions.read — list blobs, read files, find a batch commit. */
export async function readDiscussions(root: string, req: DiscussionsReadRequest): Promise<DiscussionsReadReply> {
  try {
    const fresh = await freshRef(root);
    if (!fresh) return { files: [], ...(req.batchId ? { batchCommit: null } : {}), error: "no remote base" };
    const files: DiscussionsReadReply["files"] = [];
    if (req.list) {
      const out = await gitQuiet(root, ["ls-tree", "-r", fresh.ref, "--", `${DISCUSSIONS_DIR}/`]);
      for (const line of out.split("\n")) {
        const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line.trim());
        if (m && validPath(m[2]!)) files.push({ path: m[2]!, blobSha: m[1]! });
      }
    }
    for (const path of req.paths ?? []) {
      if (!validPath(path)) continue;
      const blobSha = await blobAt(root, fresh.ref, path);
      if (!blobSha) continue;
      const content = await gitQuiet(root, ["show", `${fresh.ref}:${path}`]);
      const i = files.findIndex((f) => f.path === path);
      if (i >= 0) files[i] = { path, blobSha, content };
      else files.push({ path, blobSha, content });
    }
    return { files, ...(req.batchId ? { batchCommit: await batchCommit(root, fresh.ref, req.batchId) } : {}) };
  } catch (err) {
    return { files: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Apply a discussion batch on the books branch (side worktree, books-only publish with retry): write each
 * file whose current blob still matches `expectedSha` (`null` = must not exist, `"*"` = overwrite), skip
 * the others, commit once with the batch trailers, then report the commit + blobs from the pushed branch.
 */
export async function applyDiscussionBatch(
  root: string,
  req: { batchId: string; opCount: number; files: { path: string; content: string; expectedSha: string | null }[] },
): Promise<AutonomousWriteReply> {
  const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
  if (!base) return { ok: false, error: "no remote base" };
  // A retried batch may already be on the branch (lost reply): report it instead of committing twice.
  const already = await readDiscussions(root, { batchId: req.batchId, list: true });
  if (already.batchCommit) return { ok: true, commitSha: already.batchCommit, files: already.files.map((f) => ({ path: f.path, blobSha: f.blobSha })), skipped: [] };

  let skipped: NonNullable<AutonomousWriteReply["skipped"]> = [];
  const message = `chore(web): discussions\n\n4PM-Discussion-Batch: ${req.batchId}\n4PM-Ops: ${req.opCount}`;
  const pub = await mutateBooks(
    root,
    base,
    message,
    async (dir) => {
      skipped = [];
      let wrote = 0;
      for (const f of req.files) {
        if (!validPath(f.path)) {
          skipped.push({ path: f.path, reason: "invalid", currentSha: null });
          continue;
        }
        const current = (await gitQuiet(dir, ["rev-parse", "-q", "--verify", `HEAD:${f.path}`])).trim() || null;
        if (f.expectedSha !== "*" && current !== f.expectedSha) {
          skipped.push({ path: f.path, reason: "changed", currentSha: current });
          continue;
        }
        const abs = join(dir, f.path);
        await writeFileInRoot(dir, abs, f.content);
        wrote++;
      }
      return wrote > 0;
    },
    [DISCUSSIONS_DIR],
  );
  if (pub === "failed") return { ok: false, error: "could not push the change to the books branch (retry)" };
  const fresh = await freshRef(root);
  if (!fresh) return { ok: false, error: "no remote base" };
  const commitSha = pub === "pushed" ? ((await batchCommit(root, fresh.ref, req.batchId)) ?? undefined) : undefined;
  const written = req.files.filter((f) => !skipped.some((s) => s.path === f.path));
  const files = [];
  for (const f of written) {
    const blobSha = await blobAt(root, fresh.ref, f.path);
    if (blobSha) files.push({ path: f.path, blobSha });
  }
  return { ok: true, ...(commitSha ? { commitSha } : {}), files, skipped };
}

