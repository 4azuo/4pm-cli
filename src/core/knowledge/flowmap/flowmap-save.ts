/**
 * `flowmap.savePlan` / `flowmap.save` — publish a flow-map version to the repo as a pull request to the base: the
 * plan reads `origin/<base>` (its folder tree, each source's current text) and lists every file the PR would change
 * with its diff — the `.flow.md` doc, its `.svg`, and a back-ref in each source (Doc Header `refs.related` / code
 * `@flow`); a source without a header, missing on the base or in another repo (a submodule) is skipped. The save
 * recomputes the plan, refuses when it differs from the previewed one (`FLOWMAP_PLAN_CHANGED`), commits the files on
 * a new `4pm/flow/<slug>-v<n>-<stamp>` branch cut from `origin/<base>` (never `<base>`, never the working tree) and
 * opens the PR / MR. Never throws: a failure is a reply with `code` / `step`.
 * @adr 0698 @arch 0076
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { FlowMapPlanFileWire, FlowMapSavePlanReply, FlowMapSavePlanRequest, FlowMapSaveReply, FlowMapSaveRequest } from "@4pm/ws";
import { CODE_EXT, parseFrontmatter } from "../../docs/doc-model";
import { git } from "../../autonomous/autonomous-git";
import { commitToBranch, locateBase, readBaseFile, type BaseEdit, type BaseLocation } from "../../git/base-edit";
import { openPullRequest } from "../../git/git-host";
import { addCodeBackref, addDocBackref } from "./flowmap-backref";
import { unifiedDiff } from "./flowmap-diff";
import { flowMapMarkdown, svgNameOf } from "./flowmap-file";

/** Most base folders listed. */
const MAX_DIRS = 3000;
/** Most sources edited. */
const MAX_SOURCES = 200;

/** A computed plan: the reply + the edits a save commits. */
interface Plan {
  reply: FlowMapSavePlanReply;
  loc: BaseLocation | null;
  edits: BaseEdit[];
}

/** A refusal reply. */
function refuse(code: string, error: string): Plan {
  return { reply: { ok: false, code, error }, loc: null, edits: [] };
}

/** `yyyymmddhhmm` in UTC. */
function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

/** The PR number of a PR / MR URL, or null. */
function prNumberOf(url: string | null): number | null {
  const m = url ? /\/(?:pull|merge_requests)\/(\d+)/.exec(url) : null;
  return m ? Number(m[1]) : null;
}

/** A clean repo-relative folder ("" = the root), or null when it escapes / targets a reserved folder. */
export function cleanFolder(folder: string): string | null {
  const f = posix.normalize((folder || "").trim().replace(/\\/g, "/")).replace(/^\.\/?/, "").replace(/\/+$/, "");
  if (f === "" || f === ".") return "";
  if (f.startsWith("/") || f.split("/").some((s) => s === ".." || s === "")) return null;
  if (/^(?:\.git|\.4pm)(?:\/|$)/.test(f)) return null;
  return f;
}

/** Whether a path is a Markdown doc / a source file the graph reads headers of. */
function kindOf(path: string): "doc" | "code" | "other" {
  if (/\.mdx?$/i.test(path)) return "doc";
  const ext = posix.extname(path).toLowerCase();
  return CODE_EXT.includes(ext) ? "code" : "other";
}

/** sha256 hex of a string. */
function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Compute the plan of a request on the project at `root`. */
async function computePlan(root: string, req: FlowMapSavePlanRequest): Promise<Plan> {
  const folder = cleanFolder(req.folder);
  if (folder === null || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(req.fileName || "")) {
    return refuse("FLOWMAP_PATH_INVALID", "Choose a folder inside the repository and a .md file name.");
  }
  const docPath = folder ? `${folder}/${req.fileName}` : req.fileName;
  const svgPath = folder ? `${folder}/${svgNameOf(req.fileName)}` : svgNameOf(req.fileName);
  const loc = await locateBase(root, ".");
  if (!loc) return refuse("FLOWMAP_SAVE_FAILED", "The repository has no remote base branch.");
  const docLoc = await locateBase(root, docPath);
  if (!docLoc || docLoc.repoDir !== loc.repoDir) return refuse("FLOWMAP_PATH_INVALID", "The folder belongs to another repository (a submodule).");
  // readBaseFile fetches the base; the head read after it is the plan's base ref.
  const existingDoc = await readBaseFile(root, docPath);
  const head = (await git(loc.repoDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${loc.base}^{commit}`]).catch(() => "")).trim();
  if (!head) return refuse("FLOWMAP_SAVE_FAILED", "The base branch could not be read.");
  const dirs = (await git(loc.repoDir, ["ls-tree", "-r", "-d", "--name-only", head], 60_000).catch(() => ""))
    .split("\n")
    .filter((d) => d && !/^(?:\.git|\.4pm)(?:\/|$)/.test(d))
    .slice(0, MAX_DIRS);

  const files: FlowMapPlanFileWire[] = [];
  const edits: BaseEdit[] = [];
  const uses: string[] = [];
  const slug = req.slug;
  for (const src of (req.sources ?? []).slice(0, MAX_SOURCES)) {
    if (src.path === docPath || src.path === svgPath) continue;
    const srcLoc = await locateBase(root, src.path);
    if (!srcLoc || srcLoc.repoDir !== loc.repoDir) {
      files.push({ path: src.path, status: "skipped", reason: "other-repo" });
      continue;
    }
    const read = await readBaseFile(root, src.path);
    if (!read || !read.data) {
      files.push({ path: src.path, status: "skipped", reason: "missing" });
      continue;
    }
    const before = read.data.toString("utf8");
    const kind = kindOf(src.path);
    if (kind === "doc") {
      const id = parseFrontmatter(before).header?.id;
      if (id && !uses.includes(id)) uses.push(id);
    }
    const after = kind === "doc" ? addDocBackref(before, req.docMeta.id) : kind === "code" ? addCodeBackref(before, slug) : null;
    if (after === null) {
      files.push({ path: src.path, status: "skipped", reason: "no-header" });
    } else if (after === before) {
      files.push({ path: src.path, status: "unchanged" });
    } else {
      files.push({ path: src.path, status: "modified", diff: unifiedDiff(src.path, before, after) });
      edits.push({ op: "put", path: src.path, data: Buffer.from(after, "utf8") });
    }
  }

  const md = flowMapMarkdown({
    id: req.docMeta.id,
    title: req.docMeta.title,
    features: req.docMeta.features,
    uses,
    generatedBy: req.docMeta.generatedBy,
    sources: req.sources ?? [],
    svgName: svgNameOf(req.fileName),
    modelJson: req.modelJson,
  });
  const mdBefore = existingDoc?.data ? existingDoc.data.toString("utf8") : null;
  const svgRead = await readBaseFile(root, svgPath);
  const svgBefore = svgRead?.data ? svgRead.data.toString("utf8") : null;
  const head2: FlowMapPlanFileWire[] = [];
  if (mdBefore !== md) {
    head2.push({ path: docPath, status: mdBefore === null ? "new" : "modified", diff: unifiedDiff(docPath, mdBefore, md) });
    edits.unshift({ op: "put", path: docPath, data: Buffer.from(md, "utf8") });
  } else head2.push({ path: docPath, status: "unchanged" });
  if (svgBefore !== req.svg) {
    head2.push({ path: svgPath, status: svgBefore === null ? "new" : "modified", diff: `${svgBefore === null ? "new" : "changed"} image · ${Buffer.byteLength(req.svg)} bytes` });
    edits.push({ op: "put", path: svgPath, data: Buffer.from(req.svg, "utf8") });
  } else head2.push({ path: svgPath, status: "unchanged" });
  const all = [...head2, ...files];
  const planHash = sha(
    JSON.stringify([
      head,
      all.map((f) => [f.path, f.status]),
      edits.map((e) => (e.op === "put" ? [e.path, sha(e.data.toString("utf8"))] : [])),
    ]),
  );
  return { reply: { ok: true, base: loc.base, baseRef: head, dirs, files: all, planHash }, loc, edits };
}

/** `flowmap.savePlan`. */
export async function flowMapSavePlan(root: string, req: FlowMapSavePlanRequest): Promise<FlowMapSavePlanReply> {
  try {
    return (await computePlan(root, req)).reply;
  } catch (err) {
    return { ok: false, code: "FLOWMAP_SAVE_FAILED", error: err instanceof Error ? err.message : String(err) };
  }
}

/** `flowmap.save`. */
export async function flowMapSave(root: string, req: FlowMapSaveRequest, machineUsername?: string): Promise<FlowMapSaveReply> {
  try {
    const plan = await computePlan(root, req);
    if (!plan.reply.ok || !plan.loc) return { ok: false, code: plan.reply.code, step: "base", error: plan.reply.error };
    if (plan.reply.planHash !== req.planHash) {
      return { ok: false, code: "FLOWMAP_PLAN_CHANGED", error: "The base branch changed since the preview — preview again." };
    }
    const skipped = (plan.reply.files ?? []).filter((f) => f.status === "skipped").map((f) => ({ path: f.path, reason: f.reason ?? "skipped" }));
    if (plan.edits.length === 0) return { ok: false, code: "FLOWMAP_SAVE_FAILED", step: "push", error: "The files are already like this on the base branch." };
    const slug = (req.slug || "flow").replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "flow";
    const branch = `4pm/flow/${slug}-v${req.version}-${stamp()}`;
    const message = `${req.title}\n\n4PM-Requested-By: ${req.byLabel.replace(/\s+/g, " ").slice(0, 200)}`;
    let commit: string | undefined;
    try {
      commit = await commitToBranch(plan.loc, branch, plan.edits, { message, machineUsername });
    } catch (err) {
      return { ok: false, code: "FLOWMAP_SAVE_FAILED", step: "push", error: err instanceof Error ? err.message : String(err) };
    }
    if (!commit) return { ok: false, code: "FLOWMAP_SAVE_FAILED", step: "push", error: "The files are already like this on the base branch." };
    const url = (await git(root, ["remote", "get-url", "origin"]).catch(() => "")).trim();
    const pr = await openPullRequest({ url, cwd: root, base: plan.loc.base, head: branch, title: req.title, body: req.body });
    if (pr.error) return { ok: false, code: "FLOWMAP_SAVE_FAILED", step: "pr", branch, error: pr.error };
    return { ok: true, branch, prUrl: pr.url, number: prNumberOf(pr.url), skipped };
  } catch (err) {
    return { ok: false, code: "FLOWMAP_SAVE_FAILED", step: "push", error: err instanceof Error ? err.message : String(err) };
  }
}
