/**
 * Project system diagram (draw.io) on the books branch — the cli half. `diagram.read` (the approved modules now
 * or at a past version, the change requests with their states, cell versions, history, the auto-approve flag),
 * `diagram.write` (save / withdraw an SDC from the web — applied at once under `diagramAutoApprove`; approve =
 * verify the signed entry, then apply with the per-cell three-way merge or a conflict; reject), the intake step
 * (restore the approved files, number + auto-apply the agent's `SDC-NEW-*.md`), the implement step (the group's
 * applied changes as context, an `implement` SDC carried to the books at finish), the eligibility gate (a group
 * with an open SDC waits) and the Evidences listing.
 * @adr 0530 @arch 0057
 */
import { join } from "node:path";
import {
  AUTO_APPROVER,
  SDC_ID_RE,
  SDC_NEW_FILE_RE,
  applyDiagramPatch,
  diagramCellVersionAt,
  diagramCompactText,
  diagramConflicts,
  diagramDeltaFromEdit,
  diagramMasterOf,
  diagramPatchCells,
  diagramPatchIsEmpty,
  diagramSlice,
  ercBlocks,
  parseDiagramModules,
  parseSdcFile,
  sdcPatch,
  serializeSdcFile,
  type SdcMeta,
} from "@4pm/dto";
import type { ApprovalEntry, ApprovalState, AutonomousReadReply, DiagramChangeFile, DiagramReadReply, DiagramReadRequest, DiagramWriteReply, DiagramWriteRequest } from "@4pm/ws";
import { readAutonomousConfig, repoDirsOf, type AutonomousConfig } from "./autonomous-config";
import { freshBooksRef, gitQuiet, mutateBooks, resolveBases, restoreDirToRef } from "./autonomous-git";
import { approvalTrustActive, ercApprovalStateOf, ercFileHash } from "./autonomous-approvals";
import { APPROVALS_REL, AUTHORS_REL, dirSource, readJsonMap, refSource, removeInRoot, writeJson } from "./autonomous-er-store";
import {
  diagramModelsOf,
  diagramModulesAtVersion,
  diagramVersionCommits,
  loadDiagram,
  nextSdcId,
  numberNewSdcs,
  writeDiagramModules,
  writeDiagramSidecar,
  type DiagramSnapshot,
  type NewSdcFile,
} from "./autonomous-diagram-store";
import { readFileInRoot, writeFileInRoot } from "../../utils/safe-path";

/** The `by` recorded for an id in an authors map, or null. */
function authorOf(map: Record<string, unknown>, id: string): string | null {
  const e = map[id];
  return e && typeof e === "object" && typeof (e as { by?: unknown }).by === "string" ? (e as { by: string }).by : null;
}

/** The books read ref of the served project (fetched at most every 15 s), or null with no remote. */
async function readRef(root: string): Promise<string | null> {
  const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
  return base ? freshBooksRef(root, base) : null;
}

/** The change-request files of a snapshot as the wire shape (state from the sidecar; absent = pending). */
function changeFiles(snap: DiagramSnapshot): DiagramChangeFile[] {
  return snap.changes.map((c) => {
    const rec = snap.sidecar.changes[c.id];
    return { id: c.id, path: c.path, content: c.content, ...rec, state: rec?.state ?? "pending" };
  });
}

/**
 * diagram.read — the system diagram as on the books branch (else the working tree): the modules now or at
 * `version`, the change requests with states, cell versions, history (newest first, commits resolved), the SDC
 * approval states and the auto-approve flag.
 * @api machine-0087
 */
export async function readDiagram(root: string, profileDir: string, req: DiagramReadRequest): Promise<DiagramReadReply> {
  const cfg = await readAutonomousConfig(profileDir);
  const ref = await readRef(root);
  const src = ref ? refSource(root, ref) : dirSource(root);
  const snap = await loadDiagram(src, cfg.diagramDir, req.changes !== false);
  const commits = ref ? await diagramVersionCommits(root, ref) : new Map<number, string>();
  let modules = snap.modules;
  let version = snap.sidecar.version;
  const empty = (error: string): DiagramReadReply => ({
    diagramDir: cfg.diagramDir,
    version: 0,
    currentVersion: snap.sidecar.version,
    autoApprove: cfg.diagramAutoApprove,
    index: "",
    modules: [],
    changes: [],
    cells: {},
    history: [],
    approvals: "{}",
    authors: "{}",
    approvalStates: {},
    error,
  });
  if (req.version !== undefined && req.version !== snap.sidecar.version) {
    const commit = req.version === 0 ? null : commits.get(req.version);
    if (req.version !== 0 && (!commit || !ref)) return empty("unknown diagram version");
    modules = commit ? (await loadDiagram(refSource(root, commit), cfg.diagramDir, false)).modules : [];
    version = req.version;
  }
  const [approvals, authors] = await Promise.all([src.read(APPROVALS_REL), src.read(AUTHORS_REL)]);
  let approvalMap: Record<string, unknown> = {};
  try {
    approvalMap = JSON.parse(approvals ?? "{}") as Record<string, unknown>;
  } catch {
    // unreadable approvals ⇒ no states
  }
  const approvalStates: Record<string, ApprovalState> = {};
  for (const c of snap.changes) {
    const st = approvalMap[c.id] ? ercApprovalStateOf(c.id, approvalMap[c.id], c.content) : null;
    if (st) approvalStates[c.id] = st;
  }
  return {
    diagramDir: cfg.diagramDir,
    version,
    currentVersion: snap.sidecar.version,
    autoApprove: cfg.diagramAutoApprove,
    index: snap.index,
    modules: modules.map((m) => ({ name: m.name, path: m.path, content: m.content })),
    changes: changeFiles(snap),
    cells: snap.sidecar.cells,
    history: [...snap.sidecar.history].reverse().map((h) => ({ ...h, ...(commits.get(h.version) ? { commit: commits.get(h.version)! } : {}) })),
    approvals: approvals ?? "{}",
    authors: authors ?? "{}",
    approvalStates,
  };
}

/** The outcome of one diagram write applied to a books checkout. */
interface DiagramWriteOutcome {
  reply: DiagramWriteReply;
  publish: boolean;
  message: string;
}

/** A refusal that writes nothing. */
function refuse(code: string, error: string, meta?: Record<string, unknown>): DiagramWriteOutcome {
  return { reply: { ok: false, code, error, ...(meta ? { meta } : {}) }, publish: false, message: "" };
}

/** Other open change requests touching the same cells as `id` (against the current master). */
function overlapsOf(snap: DiagramSnapshot, id: string, touched: readonly string[]): string[] {
  const master = diagramMasterOf(diagramModelsOf(snap), snap.order);
  const mine = new Set(touched);
  const out: string[] = [];
  for (const c of snap.changes) {
    if (c.id === id) continue;
    const st = snap.sidecar.changes[c.id]?.state ?? "pending";
    if (st !== "pending" && st !== "conflict") continue;
    const { doc } = parseSdcFile(c.content);
    if (doc && diagramPatchCells(sdcPatch(master, doc)).some((n) => mine.has(n))) out.push(c.id);
  }
  return out;
}

/** Who applies an SDC: a person (with the signed entry) or auto-approve. */
interface SdcApprover {
  by: string;
  byLabel: string;
  entry?: ApprovalEntry;
}

/** The approver recorded for an auto-approved apply. */
const AUTO_SDC_APPROVER: SdcApprover = { by: AUTO_APPROVER, byLabel: "auto-approve" };

/** The `{module, page}` new cells of an SDC fall back to. */
function fallbackOf(meta: Pick<SdcMeta, "module" | "page">): { module: string; page: string } {
  return { module: meta.module, page: meta.page };
}

/**
 * Apply one pending SDC to the books checkout `dir`: per-cell three-way merge against the master at its
 * `baseVersion`, or `conflict`; on success the modules, the sidecar (version, cell versions, history, state)
 * and the approvals are written.
 */
async function applySdc(dir: string, diagramDir: string, snap: DiagramSnapshot, id: string, who: SdcApprover, approvals: Record<string, unknown>): Promise<DiagramWriteOutcome> {
  const file = snap.changes.find((c) => c.id === id);
  if (!file) return refuse("NOT_FOUND", "change request not found");
  const at = new Date().toISOString();
  const { doc, errors } = parseSdcFile(file.content);
  if (!doc) return refuse("DIAGRAM_INVALID", errors[0]?.message ?? "invalid change request");
  const current = diagramModelsOf(snap);
  const currentMaster = diagramMasterOf(current, snap.order);
  const baseVersion = doc.meta.baseVersion ?? snap.sidecar.version;
  const baseModules = baseVersion === snap.sidecar.version ? current : ((await diagramModulesAtVersion(dir, "HEAD", diagramDir, baseVersion)) ?? current);
  const baseMaster = diagramMasterOf(baseModules);
  const patch = sdcPatch(baseMaster, doc);
  const conflicts = diagramConflicts(baseMaster, currentMaster, patch);
  if (conflicts.length) {
    const cells = [...new Set(conflicts.map((c) => c.cell))];
    const conflictsWith = [...new Set(snap.sidecar.history.filter((x) => x.version > baseVersion && x.cells.some((c) => cells.includes(c))).map((x) => x.sdc))];
    const reason = conflicts.map((c) => `${c.cell} (${c.field})`).join(", ");
    snap.sidecar.changes[id] = { state: "conflict", reason, conflictsWith, at, by: who.by, byLabel: who.byLabel };
    delete approvals[id];
    await writeDiagramSidecar(dir, snap.sidecar);
    await writeJson(dir, APPROVALS_REL, approvals);
    return {
      reply: { ok: false, id, state: "conflict", code: "DIAGRAM_CHANGE_CONFLICT", error: "diagram change conflict", meta: { conflictsWith, cells } },
      publish: true,
      message: `diagram: conflict ${id}`,
    };
  }
  const applied = applyDiagramPatch(current, patch, fallbackOf(doc.meta));
  const after = diagramMasterOf(applied.modules);
  if (after.duplicates.length) return refuse("DIAGRAM_INVALID", `cell used in two modules: ${after.duplicates.map((d) => d[0]).join(", ")}`);
  await writeDiagramModules(dir, diagramDir, snap, applied.modules, applied.changed);
  const version = snap.sidecar.version + 1;
  const touched = [...new Set([...diagramPatchCells(patch), ...applied.removed])];
  for (const c of touched) {
    const o = after.owner[c];
    if (!o) delete snap.sidecar.cells[c];
    else snap.sidecar.cells[c] = { v: (snap.sidecar.cells[c]?.v ?? 0) + 1, module: o.module, page: o.page };
  }
  snap.sidecar.version = version;
  snap.sidecar.history.push({ version, sdc: id, appliedAt: at, approvedBy: who.by, approvedByLabel: who.byLabel, cells: touched });
  snap.sidecar.changes[id] = { state: "applied", appliedVersion: version, at, by: who.by, byLabel: who.byLabel };
  if (who.entry) approvals[id] = who.entry;
  else delete approvals[id];
  await writeDiagramSidecar(dir, snap.sidecar);
  await writeJson(dir, APPROVALS_REL, approvals);
  return { reply: { ok: true, id, state: "applied", version }, publish: true, message: `diagram: v${version} (${id})` };
}

/**
 * Auto-approve: apply the given pending SDCs one after the other in the books checkout `dir` (each on the
 * master the previous one left). Returns the applied ids and the ones left in conflict.
 */
export async function autoApplySdcs(dir: string, diagramDir: string, ids: readonly string[]): Promise<{ applied: string[]; conflict: string[] }> {
  const applied: string[] = [];
  const conflict: string[] = [];
  for (const id of ids) {
    const snap = await loadDiagram(dirSource(dir), diagramDir);
    if ((snap.sidecar.changes[id]?.state ?? "pending") !== "pending") continue;
    const out = await applySdc(dir, diagramDir, snap, id, AUTO_SDC_APPROVER, await readJsonMap(dir, APPROVALS_REL));
    if (out.reply.state === "applied") applied.push(id);
    else if (out.reply.state === "conflict") conflict.push(id);
  }
  return { applied, conflict };
}

/** Apply one `diagram.write` to the books checkout `dir`; `autoApprove` applies a saved SDC at once. */
async function applyDiagramWrite(dir: string, diagramDir: string, req: DiagramWriteRequest, autoApprove: boolean): Promise<DiagramWriteOutcome> {
  const snap = await loadDiagram(dirSource(dir), diagramDir);
  const at = new Date().toISOString();
  const byLabel = req.byLabel ?? req.by;
  const approvals = await readJsonMap(dir, APPROVALS_REL);
  const authors = await readJsonMap(dir, AUTHORS_REL);
  const fileOf = (id: string) => snap.changes.find((c) => c.id === id);
  if (req.kind === "save") {
    const prev = req.id ? fileOf(req.id) : undefined;
    if (req.id && !prev) return refuse("NOT_FOUND", "change request not found");
    const prevState = req.id ? (snap.sidecar.changes[req.id]?.state ?? "pending") : null;
    if (prevState === "applied" || prevState === "withdrawn") return refuse("DIAGRAM_CHANGE_STALE", `change request is ${prevState}`);
    if (req.baseVersion > snap.sidecar.version) return refuse("DIAGRAM_CHANGE_STALE", "unknown base version");
    const parsed = parseDiagramModules(Object.fromEntries(req.modules.map((m) => [m.name, m.content])));
    if (parsed.error) return refuse("DIAGRAM_INVALID", parsed.error.message, { module: parsed.error.module });
    const baseModules = req.baseVersion === snap.sidecar.version ? diagramModelsOf(snap) : await diagramModulesAtVersion(dir, "HEAD", diagramDir, req.baseVersion);
    if (!baseModules) return refuse("DIAGRAM_CHANGE_STALE", "unknown base version");
    const { cells, remove, duplicates } = diagramDeltaFromEdit(baseModules, parsed.modules);
    if (duplicates.length) return refuse("DIAGRAM_INVALID", `cell used in two modules: ${duplicates.join(", ")}`, { cells: duplicates });
    const prevMeta = prev ? parseSdcFile(prev.content).doc?.meta : undefined;
    const meta: SdcMeta = {
      title: req.title,
      source: prevMeta?.source ?? req.source ?? "web",
      req: req.req ?? prevMeta?.req ?? [],
      group: req.group ?? prevMeta?.group ?? "",
      ...(prevMeta?.task ? { task: prevMeta.task } : {}),
      ...(prevMeta?.team ? { team: prevMeta.team } : {}),
      module: req.module,
      page: req.page ?? "",
      baseVersion: req.baseVersion,
      base: {},
      remove: { cells: remove },
    };
    const baseMaster = diagramMasterOf(baseModules);
    const patch = sdcPatch(baseMaster, { meta, cells });
    if (diagramPatchIsEmpty(patch)) return refuse("DIAGRAM_INVALID", "the edit changes nothing");
    const touched = diagramPatchCells(patch);
    meta.base = Object.fromEntries(touched.filter((c) => baseMaster.byId.has(c)).map((c) => [c, diagramCellVersionAt(snap.sidecar, c, req.baseVersion)]));
    const id = req.id ?? nextSdcId(snap);
    const content = serializeSdcFile(id, { meta, cells, rationale: req.rationale ?? "" });
    await writeFileInRoot(dir, join(dir, `${diagramDir}/changes/${id}.md`), content);
    snap.sidecar.changes[id] = { state: "pending", at, by: req.by, byLabel };
    await writeDiagramSidecar(dir, snap.sidecar);
    // A revision voids an earlier approval; the editor becomes the author (separation of duties).
    delete approvals[id];
    authors[id] = { by: req.by, byLabel, at };
    await writeJson(dir, APPROVALS_REL, approvals);
    await writeJson(dir, AUTHORS_REL, authors);
    const overlaps = overlapsOf({ ...snap, changes: [...snap.changes.filter((c) => c.id !== id), { id, path: "", content }] }, id, touched);
    const message = `diagram: ${req.id ? "revise" : "propose"} ${id} by ${byLabel}`;
    if (autoApprove) {
      const out = await applySdc(dir, diagramDir, await loadDiagram(dirSource(dir), diagramDir), id, AUTO_SDC_APPROVER, approvals);
      return { reply: { ...out.reply, ok: true, id, overlaps }, publish: true, message: out.reply.state === "applied" ? `${message}; ${out.message} (auto)` : message };
    }
    return { reply: { ok: true, id, state: "pending", overlaps }, publish: true, message };
  }
  const file = fileOf(req.id);
  if (!SDC_ID_RE.test(req.id) || !file) return refuse("NOT_FOUND", "change request not found");
  const state = snap.sidecar.changes[req.id]?.state ?? "pending";
  if (req.kind === "withdraw") {
    if (state === "applied" || state === "withdrawn") return refuse("DIAGRAM_CHANGE_STALE", `change request is ${state}`);
    if (authorOf(authors, req.id) !== req.by && !req.byIsAdmin) return refuse("FORBIDDEN", "only the author or an ADMIN can withdraw");
    snap.sidecar.changes[req.id] = { state: "withdrawn", at, by: req.by, byLabel };
    delete approvals[req.id];
    await writeDiagramSidecar(dir, snap.sidecar);
    await writeJson(dir, APPROVALS_REL, approvals);
    return { reply: { ok: true, id: req.id, state: "withdrawn" }, publish: true, message: `diagram: withdraw ${req.id} by ${byLabel}` };
  }
  if (state !== "pending") return refuse("DIAGRAM_CHANGE_STALE", `change request is ${state}`);
  if (req.decision === "reject") {
    snap.sidecar.changes[req.id] = { state: "rejected", reason: (req.reason ?? "").slice(0, 1000), at, by: req.by, byLabel };
    delete approvals[req.id];
    await writeDiagramSidecar(dir, snap.sidecar);
    await writeJson(dir, APPROVALS_REL, approvals);
    return { reply: { ok: true, id: req.id, state: "rejected" }, publish: true, message: `diagram: reject ${req.id} by ${byLabel}` };
  }
  if (authorOf(authors, req.id) === req.by && !req.byIsAdmin) return refuse("APPROVAL_SELF", "self-approval blocked", { id: req.id });
  const h = ercFileHash(file.content);
  if (req.h && req.h !== h) return refuse("APPROVAL_STALE", "approval stale", { id: req.id });
  let entry: ApprovalEntry = { approved: true, by: req.by, byLabel, at };
  if (req.entry) {
    if (ercApprovalStateOf(req.id, req.entry, file.content) !== "approved") return refuse("APPROVAL_STALE", "approval stale", { id: req.id });
    entry = req.entry;
  } else if (approvalTrustActive()) return refuse("APPROVAL_STALE", "approval stale", { id: req.id });
  return applySdc(dir, diagramDir, snap, req.id, { by: req.by, byLabel, entry }, approvals);
}

/**
 * diagram.write — published straight to the books branch through a side worktree (books-only commit, retry on a
 * lost race); with no remote base it is applied to the working tree.
 * @api machine-0088 @api machine-0089
 */
export async function writeDiagram(root: string, profileDir: string, req: DiagramWriteRequest): Promise<DiagramWriteReply> {
  try {
    const cfg = await readAutonomousConfig(profileDir);
    const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
    let out: DiagramWriteOutcome | undefined;
    const pub = base
      ? await mutateBooks(
          root,
          base,
          () => out?.message || "diagram: update",
          async (dir) => {
            out = await applyDiagramWrite(dir, cfg.diagramDir, req, cfg.diagramAutoApprove);
            return out.publish;
          },
          repoDirsOf(cfg),
        )
      : "unchanged";
    if (out === undefined) out = await applyDiagramWrite(root, cfg.diagramDir, req, cfg.diagramAutoApprove);
    else if (pub === "failed") return { ok: false, error: "could not push the change to the base branch (retry)" };
    return out.reply;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Autonomous cycle hooks ──────────────────────────────────────────────────────────────────────────

/** The agent's new change requests (`<diagramDir>/changes/SDC-NEW-*.md`) in the working tree of `root`. */
async function newSdcFiles(root: string, diagramDir: string): Promise<NewSdcFile[]> {
  const files = await dirSource(root).list(`${diagramDir}/changes`);
  const out: NewSdcFile[] = [];
  for (const p of files) {
    const name = p.split("/").pop() ?? "";
    if (!SDC_NEW_FILE_RE.test(name)) continue;
    out.push({ name, content: (await readFileInRoot(root, join(root, p), "utf8").catch(() => "")) || "" });
  }
  return out;
}

/**
 * After an intake run (inside `publishIntake`, books branch checked out): keep the agent's new change requests
 * aside, put the whole diagram folder back to `ref`, number the new ones, and apply them under auto-approve.
 */
export async function prepareIntakeDiagram(
  root: string,
  ref: string,
  cfg: Pick<AutonomousConfig, "diagramDir" | "diagramAutoApprove">,
  team?: string,
): Promise<{ created: string[]; skipped: { name: string; reason: string }[]; tampered: boolean }> {
  const fresh = await newSdcFiles(root, cfg.diagramDir);
  for (const f of fresh) await removeInRoot(root, `${cfg.diagramDir}/changes/${f.name}`);
  const tampered = (await restoreDirToRef(root, ref, cfg.diagramDir)).length > 0;
  const { created, skipped } = fresh.length ? await numberNewSdcs(root, cfg.diagramDir, fresh, { source: "intake", ...(team ? { team } : {}) }) : { created: [], skipped: [] };
  if (cfg.diagramAutoApprove && created.length) await autoApplySdcs(root, cfg.diagramDir, created);
  return { created, skipped, tampered };
}

/** The change requests an implement agent wrote on its task branch (working tree first, then HEAD). */
export async function captureAgentSdcs(cwd: string, diagramDir: string): Promise<NewSdcFile[]> {
  const byName = new Map<string, string>();
  const tracked = (await gitQuiet(cwd, ["ls-tree", "-r", "--name-only", "HEAD", "--", `${diagramDir}/changes/`])).split("\n").filter(Boolean);
  for (const p of tracked) {
    const name = p.split("/").pop() ?? "";
    if (SDC_NEW_FILE_RE.test(name)) byName.set(name, await gitQuiet(cwd, ["show", `HEAD:${p}`]));
  }
  for (const f of await newSdcFiles(cwd, diagramDir)) byName.set(f.name, f.content);
  return [...byName.entries()].map(([name, content]) => ({ name, content })).filter((f) => f.content.trim());
}

/** Publish an implement agent's change requests into the books checkout `root` (inside `publishBooks`). */
export async function publishTaskSdcs(
  root: string,
  cfg: Pick<AutonomousConfig, "diagramDir" | "diagramAutoApprove">,
  files: readonly NewSdcFile[],
  task: string,
  team?: string,
): Promise<string[]> {
  if (files.length === 0) return [];
  const { created } = await numberNewSdcs(root, cfg.diagramDir, files, { source: "implement", task, ...(team ? { team } : {}) });
  if (cfg.diagramAutoApprove && created.length) await autoApplySdcs(root, cfg.diagramDir, created);
  return created;
}

/** The task groups that must wait for a system-diagram change (pending / conflict / rejected SDC). */
export async function blockedDiagramGroups(root: string, diagramDir: string): Promise<Set<string>> {
  const snap = await loadDiagram(dirSource(root), diagramDir);
  const out = new Set<string>();
  for (const c of snap.changes) {
    if (!ercBlocks(snap.sidecar.changes[c.id]?.state ?? "pending")) continue;
    const group = parseSdcFile(c.content).doc?.meta.group;
    if (group) out.add(group);
  }
  return out;
}

/** How many system-diagram change requests still block their group. */
export async function blockingSdcCount(root: string, diagramDir: string): Promise<number> {
  const snap = await loadDiagram(dirSource(root), diagramDir);
  return snap.changes.filter((c) => ercBlocks(snap.sidecar.changes[c.id]?.state ?? "pending")).length;
}

/** Cap of the compact master text given to an agent. */
const COMPACT_MAX = 20_000;

/** The intake agent's `diagramNote`: the approved master (compact text) and the open change requests. */
export async function intakeDiagramNote(root: string, diagramDir: string): Promise<string> {
  const snap = await loadDiagram(dirSource(root), diagramDir);
  const master = diagramMasterOf(diagramModelsOf(snap), snap.order);
  const text = master.cells.length ? diagramCompactText(master).slice(0, COMPACT_MAX) : "(empty — no system diagram yet; a request that introduces components may create the first module)";
  const open = snap.changes.filter((c) => ercBlocks(snap.sidecar.changes[c.id]?.state ?? "pending"));
  const lines = open.map((c) => {
    const doc = parseSdcFile(c.content).doc;
    const cells = doc ? diagramPatchCells(sdcPatch(master, doc)).join(", ") : "?";
    return `- \`${c.path}\` (${snap.sidecar.changes[c.id]?.state ?? "pending"}) — ${doc?.meta.title ?? c.id}; touches: ${cells}`;
  });
  const openNote = open.length
    ? `Open system-diagram change requests (a request touching the same cells gets a USER_QA question or records the open one in \`depends\`, never a second conflicting change):\n${lines.join("\n")}`
    : "Open system-diagram change requests: none.";
  return `Approved system diagram (v${snap.sidecar.version}; module / page, then cells):\n${text}\n${openNote}`;
}

/** The implement agent's `diagramNote`: the components and links its group's applied changes touched, as they are now. */
export async function implementDiagramContext(root: string, base: string, diagramDir: string, group: string): Promise<string> {
  const ref = await freshBooksRef(root, base);
  const src = ref ? refSource(root, ref) : dirSource(root);
  const snap = await loadDiagram(src, diagramDir);
  if (snap.modules.length === 0) return "";
  const master = diagramMasterOf(diagramModelsOf(snap), snap.order);
  const mine = snap.changes.filter((c) => parseSdcFile(c.content).doc?.meta.group === group && snap.sidecar.changes[c.id]?.state === "applied");
  const where = ref ? `\`git show ${ref}:${diagramDir}/<module>.drawio\`` : `\`${diagramDir}/<module>.drawio\``;
  const head = `\nSYSTEM DIAGRAM: the approved diagram (v${snap.sidecar.version}) is on the books branch — read a module with ${where}. Do NOT edit it; propose a change as described in the rules.\n`;
  const ids = [...new Set(mine.flatMap((c) => parseSdcFile(c.content).doc?.cells.map((x) => x.cell.id) ?? []))];
  if (ids.length === 0) return head;
  const slice = diagramSlice(master, ids);
  return `${head}Components and links this task's group changed (${mine.map((c) => c.id).join(", ")}), as they are now:\n${diagramCompactText(master, slice.cells).slice(0, COMPACT_MAX)}\n`;
}

/** The system-diagram part of the Evidences listing of `autonomous.read`. */
export async function listDiagramEvidence(root: string, ref: string | null, diagramDir: string): Promise<Pick<AutonomousReadReply, "sdcs" | "diagramDir">> {
  const src = ref ? refSource(root, ref) : dirSource(root);
  const snap = await loadDiagram(src, diagramDir);
  const sdcs = snap.changes.map((c) => {
    const meta = parseSdcFile(c.content).doc?.meta;
    return {
      id: c.id,
      path: c.path,
      state: snap.sidecar.changes[c.id]?.state ?? "pending",
      title: meta?.title ?? c.id,
      group: meta?.group ?? "",
      req: meta?.req ?? [],
      source: meta?.source ?? "web",
      ...(meta?.task ? { task: meta.task } : {}),
      ...(meta?.team ? { team: meta.team } : {}),
    };
  });
  return { sdcs, diagramDir };
}
