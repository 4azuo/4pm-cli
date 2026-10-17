/**
 * Project ER + sequence diagrams on the books branch — the cli half. `er.read` (the approved modules now or
 * at a past version, the change requests with their states, entity versions, history), `er.write` (save /
 * withdraw a change request from the web; approve = verify the signed entry, then apply with the per-entity
 * version check, the field-level merge or a conflict; reject), the intake step (restore the approved files,
 * number the agent's `ERC-NEW-*.md`), the implement step (the task's sequence + the group's ER as context,
 * an `implement` change request carried to the books at finish), the eligibility gate (a group with an open
 * change request waits) and the Evidences listing of `autonomous.read`.
 * @adr 0453 @arch 0053
 */
import { join } from "node:path";
import {
  AUTO_APPROVER,
  designGroupKey,
  ERC_ID_RE,
  ERC_NEW_FILE_RE,
  EVIDENCE_ROOT,
  applyErPatch,
  erConflicts,
  erDeltaFromEdit,
  erFocus,
  erMasterOf,
  erPatchEntities,
  erPatchIsEmpty,
  ercBlocks,
  ercPatch,
  isEvidencePath,
  parseErDiagram,
  parseErcFile,
  serializeErDiagram,
  serializeErcFile,
  type ErModel,
  type ErcMeta,
} from "@4pm/dto";
import type { ApprovalEntry, ApprovalState, AutonomousReadReply, ErChangeFile, ErReadReply, ErReadRequest, ErWriteReply, ErWriteRequest } from "@4pm/ws";
import { readAutonomousConfig, repoDirsOf, type AutonomousConfig } from "./autonomous-config";
import { freshBooksRef, gitQuiet, mutateBooks, resolveBases, restoreDirToRef } from "./autonomous-git";
import { approvalTrustActive, ercApprovalStateOf, ercFileHash } from "./autonomous-approvals";
import {
  APPROVALS_REL,
  AUTHORS_REL,
  dirSource,
  entityVersionAt,
  loadEr,
  modelsOf,
  modulesAtVersion,
  nextErcId,
  numberNewErcs,
  readJsonMap,
  refSource,
  removeInRoot,
  versionCommits,
  writeErSidecar,
  writeJson,
  writeModules,
  type ErSnapshot,
  type NewErcFile,
} from "./autonomous-er-store";
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
function changeFiles(snap: ErSnapshot): ErChangeFile[] {
  return snap.changes.map((c) => {
    const rec = snap.sidecar.changes[c.id];
    return { id: c.id, path: c.path, content: c.content, ...rec, state: rec?.state ?? "pending" };
  });
}

/**
 * er.read — the ER as on the books branch (else the working tree): the modules now or at `version`, the
 * change requests with states, entity versions, history (newest first, commits resolved) and the ERC
 * approval states.
 * @api machine-0077
 */
export async function readEr(root: string, profileDir: string, req: ErReadRequest): Promise<ErReadReply> {
  const { erDir } = await readAutonomousConfig(profileDir);
  const ref = await readRef(root);
  const src = ref ? refSource(root, ref) : dirSource(root);
  const snap = await loadEr(src, erDir, req.changes !== false);
  const commits = ref ? await versionCommits(root, ref) : new Map<number, string>();
  let modules = snap.modules;
  let version = snap.sidecar.version;
  if (req.version !== undefined && req.version !== snap.sidecar.version) {
    const commit = req.version === 0 ? null : commits.get(req.version);
    if (req.version !== 0 && (!commit || !ref)) return emptyRead(erDir, snap, "unknown ER version");
    modules = commit ? (await loadEr(refSource(root, commit), erDir, false)).modules : [];
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
    erDir,
    version,
    currentVersion: snap.sidecar.version,
    index: snap.index,
    modules: modules.map((m) => ({ name: m.name, path: m.path, content: m.content })),
    changes: changeFiles(snap),
    entities: snap.sidecar.entities,
    history: [...snap.sidecar.history].reverse().map((h) => ({ ...h, ...(commits.get(h.version) ? { commit: commits.get(h.version)! } : {}) })),
    approvals: approvals ?? "{}",
    authors: authors ?? "{}",
    approvalStates,
  };
}

/** A read reply carrying only an error. */
function emptyRead(erDir: string, snap: ErSnapshot, error: string): ErReadReply {
  return { erDir, version: 0, currentVersion: snap.sidecar.version, index: "", modules: [], changes: [], entities: {}, history: [], approvals: "{}", authors: "{}", approvalStates: {}, error };
}

/** The outcome of one ER write applied to a books checkout. */
interface ErWriteOutcome {
  reply: ErWriteReply;
  /** Commit + push even when the reply is a refusal (a conflict records the ERC's new state). */
  publish: boolean;
  message: string;
}

/** A refusal that writes nothing. */
function refuse(code: string, error: string, meta?: Record<string, unknown>): ErWriteOutcome {
  return { reply: { ok: false, code, error, ...(meta ? { meta } : {}) }, publish: false, message: "" };
}

/** Other open change requests touching the same entities as `id` (against the current model). */
function overlapsOf(snap: ErSnapshot, id: string, touched: readonly string[]): string[] {
  const master = erMasterOf(modelsOf(snap), snap.order).model;
  const mine = new Set(touched);
  const out: string[] = [];
  for (const c of snap.changes) {
    if (c.id === id) continue;
    const st = snap.sidecar.changes[c.id]?.state ?? "pending";
    if (st !== "pending" && st !== "conflict") continue;
    const { doc } = parseErcFile(c.content);
    if (doc && erPatchEntities(ercPatch(master, doc)).some((n) => mine.has(n))) out.push(c.id);
  }
  return out;
}

/** The approver recorded for an auto-approved apply. @adr 0530 */
const AUTO_ERC_APPROVER: ErcApprover = { by: AUTO_APPROVER, byLabel: "auto-approve" };

/**
 * Auto-approve: apply the given pending ERCs one after the other in the books checkout `dir` (each on the model
 * the previous one left). Returns the applied ids and the ones left in conflict.
 * @adr 0530
 */
export async function autoApplyErcs(dir: string, erDir: string, ids: readonly string[]): Promise<{ applied: string[]; conflict: string[] }> {
  const applied: string[] = [];
  const conflict: string[] = [];
  for (const id of ids) {
    const snap = await loadEr(dirSource(dir), erDir);
    if ((snap.sidecar.changes[id]?.state ?? "pending") !== "pending") continue;
    const out = await applyErc(dir, erDir, snap, id, AUTO_ERC_APPROVER, await readJsonMap(dir, APPROVALS_REL));
    if (out.reply.state === "applied") applied.push(id);
    else if (out.reply.state === "conflict") conflict.push(id);
  }
  return { applied, conflict };
}

/** Apply one `er.write` to the books checkout `dir`; `autoApprove` applies a saved ERC at once. @adr 0530 */
async function applyErWrite(dir: string, erDir: string, req: ErWriteRequest, autoApprove = false): Promise<ErWriteOutcome> {
  const snap = await loadEr(dirSource(dir), erDir);
  const at = new Date().toISOString();
  const byLabel = req.byLabel ?? req.by;
  const approvals = await readJsonMap(dir, APPROVALS_REL);
  const authors = await readJsonMap(dir, AUTHORS_REL);
  const fileOf = (id: string) => snap.changes.find((c) => c.id === id);
  if (req.kind === "save") {
    const prev = req.id ? fileOf(req.id) : undefined;
    if (req.id && !prev) return refuse("NOT_FOUND", "change request not found");
    const prevState = req.id ? (snap.sidecar.changes[req.id]?.state ?? "pending") : null;
    if (prevState === "applied" || prevState === "withdrawn") return refuse("ER_CHANGE_STALE", `change request is ${prevState}`);
    if (req.baseVersion > snap.sidecar.version) return refuse("ER_CHANGE_STALE", "unknown base version");
    const edited: Record<string, ErModel> = {};
    for (const m of req.modules) {
      const { model, errors } = parseErDiagram(m.content);
      if (errors.length) return refuse("ER_CHANGE_INVALID", errors[0]!.message, { module: m.name, line: errors[0]!.line });
      edited[m.name] = model;
    }
    const baseModules = req.baseVersion === snap.sidecar.version ? modelsOf(snap) : await modulesAtVersion(dir, "HEAD", erDir, req.baseVersion);
    if (!baseModules) return refuse("ER_CHANGE_STALE", "unknown base version");
    const { delta, remove, duplicates } = erDeltaFromEdit(baseModules, edited);
    if (duplicates.length) return refuse("ER_CHANGE_INVALID", `entity declared in two modules: ${duplicates.join(", ")}`, { entities: duplicates });
    const prevMeta = prev ? parseErcFile(prev.content).doc?.meta : undefined;
    const meta: ErcMeta = {
      title: req.title,
      source: prevMeta?.source ?? "web",
      req: req.req ?? prevMeta?.req ?? [],
      group: req.group ?? prevMeta?.group ?? "",
      ...(prevMeta?.task ? { task: prevMeta.task } : {}),
      ...(prevMeta?.team ? { team: prevMeta.team } : {}),
      module: req.module,
      baseVersion: req.baseVersion,
      base: {},
      remove,
    };
    const baseMaster = erMasterOf(baseModules).model;
    const patch = ercPatch(baseMaster, { meta, delta });
    if (erPatchIsEmpty(patch)) return refuse("ER_CHANGE_INVALID", "the edit changes nothing");
    const existing = new Set(baseMaster.entities.map((e) => e.name));
    const touched = erPatchEntities(patch);
    meta.base = Object.fromEntries(touched.filter((n) => existing.has(n)).map((n) => [n, entityVersionAt(snap.sidecar, n, req.baseVersion)]));
    const id = req.id ?? nextErcId(snap);
    const content = serializeErcFile(id, { meta, delta, rationale: req.rationale ?? "" });
    await writeFileInRoot(dir, join(dir, `${erDir}/changes/${id}.md`), content);
    snap.sidecar.changes[id] = { state: "pending", at, by: req.by, byLabel };
    await writeErSidecar(dir, snap.sidecar);
    // A revision voids an earlier approval; the editor becomes the author (separation of duties).
    delete approvals[id];
    authors[id] = { by: req.by, byLabel, at };
    await writeJson(dir, APPROVALS_REL, approvals);
    await writeJson(dir, AUTHORS_REL, authors);
    const overlaps = overlapsOf({ ...snap, changes: [...snap.changes.filter((c) => c.id !== id), { id, path: "", content }] }, id, touched);
    const message = `er: ${req.id ? "revise" : "propose"} ${id} by ${byLabel}`;
    if (autoApprove) {
      const out = await applyErc(dir, erDir, await loadEr(dirSource(dir), erDir), id, AUTO_ERC_APPROVER, approvals);
      return { ...out, reply: { ...out.reply, overlaps }, message: out.reply.state === "applied" ? `${message}; ${out.message} (auto)` : message, publish: true };
    }
    return { reply: { ok: true, id, state: "pending", overlaps }, publish: true, message };
  }
  const file = fileOf(req.id);
  if (!ERC_ID_RE.test(req.id) || !file) return refuse("NOT_FOUND", "change request not found");
  const state = snap.sidecar.changes[req.id]?.state ?? "pending";
  if (req.kind === "withdraw") {
    if (state === "applied" || state === "withdrawn") return refuse("ER_CHANGE_STALE", `change request is ${state}`);
    if (authorOf(authors, req.id) !== req.by && !req.byIsAdmin) return refuse("FORBIDDEN", "only the author or an ADMIN can withdraw");
    snap.sidecar.changes[req.id] = { state: "withdrawn", at, by: req.by, byLabel };
    delete approvals[req.id];
    await writeErSidecar(dir, snap.sidecar);
    await writeJson(dir, APPROVALS_REL, approvals);
    return { reply: { ok: true, id: req.id, state: "withdrawn" }, publish: true, message: `er: withdraw ${req.id} by ${byLabel}` };
  }
  // decide
  if (state !== "pending") return refuse("ER_CHANGE_STALE", `change request is ${state}`);
  if (req.decision === "reject") {
    snap.sidecar.changes[req.id] = { state: "rejected", reason: (req.reason ?? "").slice(0, 1000), at, by: req.by, byLabel };
    delete approvals[req.id];
    await writeErSidecar(dir, snap.sidecar);
    await writeJson(dir, APPROVALS_REL, approvals);
    return { reply: { ok: true, id: req.id, state: "rejected" }, publish: true, message: `er: reject ${req.id} by ${byLabel}` };
  }
  if (authorOf(authors, req.id) === req.by && !req.byIsAdmin) return refuse("APPROVAL_SELF", "self-approval blocked", { id: req.id });
  // The signed entry must bind to the file as it is now (ADR-0438 scheme, h = the file hash).
  const h = ercFileHash(file.content);
  if (req.h && req.h !== h) return refuse("APPROVAL_STALE", "approval stale", { id: req.id });
  let entry: ApprovalEntry = { approved: true, by: req.by, byLabel, at };
  if (req.entry) {
    if (ercApprovalStateOf(req.id, req.entry, file.content) !== "approved") return refuse("APPROVAL_STALE", "approval stale", { id: req.id });
    entry = req.entry;
  } else if (approvalTrustActive()) return refuse("APPROVAL_STALE", "approval stale", { id: req.id });
  return applyErc(dir, erDir, snap, req.id, { by: req.by, byLabel, entry }, approvals);
}

/** Who applies an ERC: a person (with the signed entry) or the project's auto-approve (`by = "auto"`, no entry). */
interface ErcApprover {
  by: string;
  byLabel: string;
  entry?: ApprovalEntry;
}

/**
 * Apply one pending ERC to the books checkout `dir`: per-entity version check against the model at its
 * `baseVersion` → field-level merge or `conflict`; on success the modules, the sidecar (version, entity versions,
 * history, state) and the approvals are written. Shared by a person's approve and auto-approve.
 * @adr 0453 @adr 0530
 */
async function applyErc(dir: string, erDir: string, snap: ErSnapshot, id: string, who: ErcApprover, approvals: Record<string, unknown>): Promise<ErWriteOutcome> {
  const file = snap.changes.find((c) => c.id === id);
  if (!file) return refuse("NOT_FOUND", "change request not found");
  const at = new Date().toISOString();
  const { doc, errors } = parseErcFile(file.content);
  if (!doc) return refuse("ER_CHANGE_INVALID", errors[0]?.message ?? "invalid change request", { line: errors[0]?.line ?? 1 });
  const current = modelsOf(snap);
  const currentMaster = erMasterOf(current, snap.order).model;
  const baseVersion = doc.meta.baseVersion ?? snap.sidecar.version;
  const baseModules = baseVersion === snap.sidecar.version ? current : ((await modulesAtVersion(dir, "HEAD", erDir, baseVersion)) ?? current);
  const baseMaster = erMasterOf(baseModules).model;
  const patch = ercPatch(baseMaster, doc);
  const conflicts = baseModules === current ? [] : erConflicts(baseMaster, currentMaster, patch);
  if (conflicts.length) {
    const entities = [...new Set(conflicts.map((c) => c.entity))];
    const conflictsWith = [...new Set(snap.sidecar.history.filter((x) => x.version > baseVersion && x.entities.some((e) => entities.includes(e))).map((x) => x.erc))];
    const reason = conflicts.map((c) => (c.attribute ? `${c.entity}.${c.attribute}` : c.relation ? `${c.entity} (${c.relation})` : c.entity)).join(", ");
    snap.sidecar.changes[id] = { state: "conflict", reason, conflictsWith, at, by: who.by, byLabel: who.byLabel };
    delete approvals[id];
    await writeErSidecar(dir, snap.sidecar);
    await writeJson(dir, APPROVALS_REL, approvals);
    return {
      reply: { ok: false, id, state: "conflict", code: "ER_CHANGE_CONFLICT", error: "ER change conflict", meta: { conflictsWith, entities } },
      publish: true,
      message: `er: conflict ${id}`,
    };
  }
  const applied = applyErPatch(current, patch, doc.meta.module);
  const after = erMasterOf(applied.modules);
  if (after.duplicates.length) return refuse("ER_CHANGE_INVALID", `entity declared in two modules: ${after.duplicates.map((d) => d[0]).join(", ")}`);
  await writeModules(dir, erDir, snap, applied.modules, applied.changed);
  const version = snap.sidecar.version + 1;
  const touched = erPatchEntities(patch);
  for (const n of touched) {
    if (patch.removeEntities.includes(n)) delete snap.sidecar.entities[n];
    else if (after.owner[n]) snap.sidecar.entities[n] = { v: (snap.sidecar.entities[n]?.v ?? 0) + 1, module: after.owner[n]! };
  }
  snap.sidecar.version = version;
  snap.sidecar.history.push({ version, erc: id, appliedAt: at, approvedBy: who.by, approvedByLabel: who.byLabel, entities: touched });
  snap.sidecar.changes[id] = { state: "applied", appliedVersion: version, at, by: who.by, byLabel: who.byLabel };
  if (who.entry) approvals[id] = who.entry;
  else delete approvals[id];
  await writeErSidecar(dir, snap.sidecar);
  await writeJson(dir, APPROVALS_REL, approvals);
  return { reply: { ok: true, id, state: "applied", version }, publish: true, message: `er: v${version} (${id})` };
}

/**
 * er.write — published straight to the books branch through a side worktree (books-only commit, retry on
 * a lost race); with no remote base it is applied to the working tree.
 * @api machine-0078 @api machine-0079
 */
export async function writeEr(root: string, profileDir: string, req: ErWriteRequest): Promise<ErWriteReply> {
  try {
    const cfg = await readAutonomousConfig(profileDir);
    const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
    let out: ErWriteOutcome | undefined;
    const pub = base
      ? await mutateBooks(
          root,
          base,
          () => out?.message || "er: update",
          async (dir) => {
            out = await applyErWrite(dir, cfg.erDir, req, cfg.erAutoApprove);
            return out.publish;
          },
          repoDirsOf(cfg),
        )
      : "unchanged";
    if (out === undefined) out = await applyErWrite(root, cfg.erDir, req, cfg.erAutoApprove);
    else if (pub === "failed") return { ok: false, error: "could not push the change to the base branch (retry)" };
    return out.reply;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Autonomous cycle hooks ──────────────────────────────────────────────────────────────────────────

/** The agent's new change requests (`<erDir>/changes/ERC-NEW-*.md`) in the working tree of `root`. */
async function newErcFiles(root: string, erDir: string): Promise<NewErcFile[]> {
  const files = await dirSource(root).list(`${erDir}/changes`);
  const out: NewErcFile[] = [];
  for (const p of files) {
    const name = p.split("/").pop() ?? "";
    if (!ERC_NEW_FILE_RE.test(name)) continue;
    out.push({ name, content: (await readFileInRoot(root, join(root, p), "utf8").catch(() => "")) || "" });
  }
  return out;
}

/**
 * After an intake run (inside `publishIntake`, books branch checked out): keep the agent's new change
 * requests aside, put the whole ER folder back to `ref` (the approved files are never edited by an agent),
 * then number the new ones. Returns the ids created, the skipped files and whether the agent edited the ER.
 */
export async function prepareIntakeEr(
  root: string,
  ref: string,
  erDir: string,
  team?: string,
  autoApprove = false,
): Promise<{ created: string[]; skipped: { name: string; reason: string }[]; tampered: boolean }> {
  const fresh = await newErcFiles(root, erDir);
  for (const f of fresh) await removeInRoot(root, `${erDir}/changes/${f.name}`);
  const tampered = (await restoreDirToRef(root, ref, erDir)).length > 0;
  const { created, skipped } = fresh.length ? await numberNewErcs(root, erDir, fresh, { source: "intake", ...(team ? { team } : {}) }) : { created: [], skipped: [] };
  if (autoApprove && created.length) await autoApplyErcs(root, erDir, created);
  return { created, skipped, tampered };
}

/** The change requests an implement agent wrote on its task branch (working tree first, then HEAD). */
export async function captureAgentErcs(cwd: string, erDir: string): Promise<NewErcFile[]> {
  const byName = new Map<string, string>();
  const tracked = (await gitQuiet(cwd, ["ls-tree", "-r", "--name-only", "HEAD", "--", `${erDir}/changes/`])).split("\n").filter(Boolean);
  for (const p of tracked) {
    const name = p.split("/").pop() ?? "";
    if (ERC_NEW_FILE_RE.test(name)) byName.set(name, await gitQuiet(cwd, ["show", `HEAD:${p}`]));
  }
  for (const f of await newErcFiles(cwd, erDir)) byName.set(f.name, f.content);
  return [...byName.entries()].map(([name, content]) => ({ name, content })).filter((f) => f.content.trim());
}

/** Publish an implement agent's change requests into the books checkout `root` (inside `publishBooks`). */
export async function publishTaskErcs(root: string, erDir: string, files: readonly NewErcFile[], task: string, team?: string, autoApprove = false): Promise<string[]> {
  if (files.length === 0) return [];
  const { created } = await numberNewErcs(root, erDir, files, { source: "implement", task, ...(team ? { team } : {}) });
  if (autoApprove && created.length) await autoApplyErcs(root, erDir, created);
  return created;
}

/** The task-id group key of a task / docs / question id (`TSK-000007-002` → `TSK-000007`; ADR-0536 adds `DOC-`). */
export function erGroupOf(id: string): string {
  return designGroupKey(id);
}

/**
 * The task groups that must wait: a group with a change request that is pending / in conflict / rejected
 * (read from the books checkout `root`). An ERC without a sidecar record is pending.
 */
export async function blockedErGroups(root: string, erDir: string): Promise<Set<string>> {
  const snap = await loadEr(dirSource(root), erDir);
  const out = new Set<string>();
  for (const c of snap.changes) {
    if (!ercBlocks(snap.sidecar.changes[c.id]?.state ?? "pending")) continue;
    const group = parseErcFile(c.content).doc?.meta.group;
    if (group) out.add(group);
  }
  return out;
}

/** How many change requests still block their group (pending / conflict / …). @adr 0529 */
export async function blockingErcCount(root: string, erDir: string): Promise<number> {
  const snap = await loadEr(dirSource(root), erDir);
  return snap.changes.filter((c) => ercBlocks(snap.sidecar.changes[c.id]?.state ?? "pending")).length;
}

/** The open change requests, one line each — the intake agent's `erOpenNote`. */
export async function openErcNote(root: string, erDir: string): Promise<string> {
  const snap = await loadEr(dirSource(root), erDir);
  const open = snap.changes.filter((c) => {
    const st = snap.sidecar.changes[c.id]?.state ?? "pending";
    return st === "pending" || st === "conflict" || st === "rejected";
  });
  if (open.length === 0) return "Open change requests: none.";
  const master = erMasterOf(modelsOf(snap), snap.order).model;
  const lines = open.map((c) => {
    const doc = parseErcFile(c.content).doc;
    const ents = doc ? erPatchEntities(ercPatch(master, doc)).join(", ") : "?";
    return `- \`${c.path}\` (${snap.sidecar.changes[c.id]?.state ?? "pending"}) — ${doc?.meta.title ?? c.id}; touches: ${ents}`;
  });
  return `Open change requests (not applied yet — a request touching the same entities gets a USER_QA question or records the open one in \`depends\`, never a second conflicting change):\n${lines.join("\n")}`;
}

/** Strip a ``` fence around an agent-returned diagram. */
function unfence(text: string): string {
  return text.trim().replace(/^```+\s*mermaid\s*\n?/i, "").replace(/\n?```+\s*$/, "").trim();
}

/**
 * Write a sequence diagram an implement agent returned with its question (`<sequenceDir>/<QA-ID>.md`) into
 * the books checkout `root`; ignored when it is not a `sequenceDiagram`.
 */
export async function writeQuestionSequence(root: string, sequenceDir: string, qaId: string, sequence: string | undefined): Promise<boolean> {
  const body = unfence(sequence ?? "");
  if (!/^sequenceDiagram\b/.test(body) || body.length > 50_000) return false;
  await writeFileInRoot(root, join(root, `${sequenceDir}/${qaId}.md`), `# ${qaId}\n\n\`\`\`mermaid\n${body}\n\`\`\`\n`);
  return true;
}

/**
 * The implement agent's design context (read from the books branch — the task branch does not carry it): the
 * task's sequence diagram and the group's applied change requests with the current form of the entities
 * they touch.
 */
export async function implementErContext(root: string, base: string, cfg: Pick<AutonomousConfig, "erDir" | "sequenceDir">, taskId: string): Promise<{ sequenceNote: string; erNote: string }> {
  const ref = await freshBooksRef(root, base);
  const src = ref ? refSource(root, ref) : dirSource(root);
  const seq = await src.read(`${cfg.sequenceDir}/${taskId}.md`);
  const sequenceNote = seq?.trim()
    ? `\nSEQUENCE DIAGRAM of this task (the intended flow — follow it; do not edit it):\n${seq.trim().slice(0, 20_000)}\n`
    : "";
  const group = erGroupOf(taskId);
  const snap = await loadEr(src, cfg.erDir);
  const master = erMasterOf(modelsOf(snap), snap.order).model;
  const mine = snap.changes.filter((c) => parseErcFile(c.content).doc?.meta.group === group && snap.sidecar.changes[c.id]?.state === "applied");
  const names = [...new Set(mine.flatMap((c) => {
    const doc = parseErcFile(c.content).doc;
    return doc ? [...doc.delta.entities.map((e) => e.name), ...doc.delta.relations.flatMap((r) => [r.a, r.b])] : [];
  }))];
  const where = ref ? `\`git show ${ref}:${cfg.erDir}/<module>.md\`` : `\`${cfg.erDir}/<module>.md\``;
  const head = `\nDATA MODEL: the approved project ER (v${snap.sidecar.version}) is on the books branch — read a module with ${where}. Do NOT edit it; propose a change as described in the rules.\n`;
  if (names.length === 0) return { sequenceNote, erNote: snap.modules.length ? head : "" };
  const focus = erFocus(master, names).model;
  return {
    sequenceNote,
    erNote: `${head}Entities this task's group changed (${mine.map((c) => c.id).join(", ")}), as they are now:\n\`\`\`mermaid\n${serializeErDiagram(focus)}\n\`\`\`\n`,
  };
}

/**
 * The Evidences listing of `autonomous.read`: the sequence diagrams, the change requests (meta + state) and
 * every book attachment under any evidence root — from the books branch (else the working tree).
 */
export async function listDesignEvidence(
  root: string,
  ref: string | null,
  cfg: Pick<AutonomousConfig, "erDir" | "sequenceDir" | "evidenceDir">,
): Promise<Pick<AutonomousReadReply, "sequences" | "ercs" | "evidence" | "erDir" | "sequenceDir">> {
  const src = ref ? refSource(root, ref) : dirSource(root);
  const sequences = (await src.list(cfg.sequenceDir)).filter((p) => /\/(?:TSK|QA)-\d{6}-\d{3}\.md$/.test(p)).sort();
  const snap = await loadEr(src, cfg.erDir);
  const ercs = snap.changes.map((c) => {
    const meta = parseErcFile(c.content).doc?.meta;
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
  const evidence: string[] = [];
  for (const dir of new Set([EVIDENCE_ROOT, cfg.evidenceDir])) evidence.push(...(await src.list(dir)).filter(isEvidencePath));
  return { sequences, ercs, evidence: [...new Set(evidence)].sort(), erDir: cfg.erDir, sequenceDir: cfg.sequenceDir };
}

/** Is `path` a readable ER / sequence file? @api machine-0073 */
export function isDesignFilePath(path: string, cfg: Pick<AutonomousConfig, "erDir" | "sequenceDir">): boolean {
  return path.toLowerCase().endsWith(".md") && [cfg.erDir, cfg.sequenceDir].some((d) => path.startsWith(`${d}/`)) && !path.includes("..");
}
