/**
 * Marketplace package operations on the worker (packages.pack/install/list/remove). Packs a project
 * subagent/skill/command into a payload file set (the server zips it); installs a downloaded package
 * into its kind/provider targets — files, owned folders, VS Code tasks and hook groups, bundle members —
 * recording `.4pm/packages.json`; lists what is installed with drift, requiredBy and the worker's
 * enabled AI providers; removes a package (refused while required unless forced). Paths are clamped
 * under the physic root and symlink-safe; these never throw — errors map to a failing reply.
 * @adr 0185 @adr 0460 @adr 0461 @adr 0462
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readFileInRoot, resolveEntry, writeFileInRoot } from "../../utils/safe-path";
import { lstatSync } from "node:fs";
import type {
  InstalledPackageState,
  PackagePayloadFile,
  PackagesInstallReply,
  PackagesInstallRequest,
  PackagesListReply,
  PackagesPackReply,
  PackagesRemoveReply,
  PackagesRemoveRequest,
} from "@4pm/ws";
import {
  listDirFiles,
  readManifest,
  readRel,
  requiredBy,
  sha256,
  writeManifest,
  type Manifest,
  type ManifestEntry,
  type PackageKind,
  type Provider,
} from "./package-manifest";
import {
  addHookGroups,
  addTasks,
  currentTaskHashes,
  missingHookGroups,
  removeHookGroups,
  removeTasks,
  taskLabelConflicts,
} from "./package-config-merge";
import { mergePlans, planArtifact, safeName, type InstallPlan } from "./package-targets";

/** Kinds whose install is per provider. */
const TARGETED: PackageKind[] = ["skill", "subagent", "hook"];

/** Read a project file (symlink-safe); null when missing. */
async function readMaybe(root: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFileInRoot(root, join(root, rel));
  } catch {
    return null;
  }
}

/** True when a root-relative path exists (file, dir or link — never followed). */
function exists(root: string, rel: string): boolean {
  try {
    lstatSync(join(root, rel));
    return true;
  } catch {
    return false;
  }
}

/** packages.pack — read a project subagent/skill/command into a payload file set. */
export async function packPackage(root: string, kind: "subagent" | "skill" | "command", name: string): Promise<PackagesPackReply> {
  const slug = safeName(name);
  if (!slug) return { ok: false, files: [], error: "invalid name" };
  const files: PackagePayloadFile[] = [];
  const add = async (rel: string, as: string) => {
    const buf = await readMaybe(root, rel);
    if (buf) files.push({ path: as, contentBase64: buf.toString("base64") });
  };
  if (kind === "subagent") {
    await add(`.claude/agents/${slug}.md`, "agent.md");
    if (files.length === 0) return { ok: false, files: [], error: "artifact not found" };
    await add(`.claude/agents/short-memory/${slug}.md`, "short-memory.md");
    await add(`.claude/agents/long-memory/${slug}.md`, "long-memory.md");
    await add(`.codex/agents/${slug}.toml`, "agent.codex.toml");
  } else if (kind === "command") {
    await add(`.claude/commands/${slug}.md`, "command.md");
  } else {
    const dir = `.claude/skills/${slug}`;
    for (const rel of await listDirFiles(root, dir)) await add(rel, rel.slice(dir.length + 1));
  }
  if (files.length === 0) return { ok: false, files: [], error: "artifact not found" };
  return { ok: true, files };
}

/** Build the install plan for a request (a bundle merges its members' plans). */
function planFor(req: PackagesInstallRequest, slug: string): { plan: InstallPlan; members: string[] } | string {
  const chosen = (req.providers ?? []) as Provider[];
  if (req.kind !== "bundle") {
    const plan = planArtifact(req.kind, slug, req.files, TARGETED.includes(req.kind) ? chosen : [], {
      ...(req.guideTarget ? { guideTarget: req.guideTarget } : {}),
    });
    return typeof plan === "string" ? plan : { plan, members: [] };
  }
  if (!req.members?.length) return "invalid package: bundle without members";
  const plans: InstallPlan[] = [];
  const members: string[] = [];
  for (const m of req.members) {
    const mslug = safeName(m.slug);
    if (!mslug || mslug !== m.slug) return "invalid slug";
    const prefix = `items/${m.kind}/${m.slug}/`;
    const own = req.files
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => ({ path: f.path.slice(prefix.length), contentBase64: f.contentBase64 }));
    // A member targets the chosen providers it supports (its own list, else claude).
    const supports = (m.providers ?? ["claude"]) as Provider[];
    const mine = TARGETED.includes(m.kind) ? supports.filter((p) => chosen.length === 0 || chosen.includes(p)) : [];
    if (TARGETED.includes(m.kind) && mine.length === 0) continue;
    const plan = planArtifact(m.kind, mslug, own, mine);
    if (typeof plan === "string") return `${m.kind}:${m.slug}: ${plan}`;
    plans.push(plan);
    members.push(`${m.kind}:${m.slug}`);
  }
  return { plan: mergePlans(plans), members };
}

/** Aggregate sha256 over an entry's current on-disk state (files + owned tasks + hook groups). */
async function entryState(root: string, e: ManifestEntry): Promise<{ recorded: string; current: string }> {
  const recordedParts: string[] = [];
  const currentParts: string[] = [];
  for (const f of e.files) {
    recordedParts.push(`${f.path}\0${f.sha256}`);
    const buf = await readMaybe(root, f.path);
    currentParts.push(`${f.path}\0${buf ? sha256(buf) : ""}`);
  }
  const taskNow = await currentTaskHashes(root, e.tasks.map((t) => t.label));
  for (const t of e.tasks) {
    recordedParts.push(`task:${t.label}\0${t.sha256}`);
    currentParts.push(`task:${t.label}\0${taskNow.get(t.label) ?? ""}`);
  }
  const missing = await missingHookGroups(root, e.hookGroups);
  recordedParts.push(`hooks\0${e.hookGroups.length}`);
  currentParts.push(`hooks\0${e.hookGroups.length - missing.length}`);
  return { recorded: sha256(recordedParts.join("\n")), current: sha256(currentParts.join("\n")) };
}

/** Delete an entry's targets: owned folders + files, owned tasks, owned hook groups. A guide file stays. */
async function deleteTargets(root: string, e: ManifestEntry): Promise<void> {
  if (e.kind !== "guide") {
    for (const d of e.dirs) {
      const target = resolveEntry(root, join(root, d));
      if (target) await rm(target, { recursive: true, force: true });
    }
    for (const f of e.files) {
      const target = resolveEntry(root, join(root, f.path));
      if (target) await rm(target, { force: true });
    }
  }
  await removeTasks(root, e.tasks.map((t) => t.label));
  await removeHookGroups(root, e.hookGroups);
}

/** packages.install — write a package version into its targets, drift-guarded; records the manifest. */
export async function installPackage(
  root: string,
  req: PackagesInstallRequest,
): Promise<PackagesInstallReply> {
  const slug = safeName(req.slug);
  if (!slug || slug !== req.slug) return { ok: false, error: "invalid slug" };
  try {
    const manifest = await readManifest(root);
    const key = `${req.kind}:${slug}`;
    const existing = manifest[key];
    const planned = planFor(req, slug);
    if (typeof planned === "string") return { ok: false, error: planned };
    const { plan, members } = planned;

    if (existing) {
      // Update: refuse to clobber local edits, then clear the old targets.
      const state = await entryState(root, existing);
      if (existing.kind !== "guide" && state.current !== state.recorded) return { ok: false, error: "DRIFT" };
      await deleteTargets(root, existing);
    } else {
      // Fresh install: never overwrite a hand-authored artifact or another package's member.
      const memberOfBundle = Object.values(manifest).some((e) => e.members.includes(key) || members.some((m) => e.members.includes(m)));
      if (members.some((m) => manifest[m]) || memberOfBundle) return { ok: false, error: "ALREADY_INSTALLED" };
      const blocked = plan.conflictPaths.find((p) => exists(root, p));
      if (blocked) {
        if (req.kind === "guide" && !req.guideOverwrite) return { ok: false, error: "GUIDE_TARGET_EXISTS" };
        if (req.kind !== "guide") return { ok: false, error: "ALREADY_INSTALLED" };
      }
    }
    const conflicts = await taskLabelConflicts(root, plan.tasks.map((t) => t.label), []);
    if (conflicts.length) return { ok: false, error: "TASK_LABEL_CONFLICT" };

    for (const f of plan.files) await writeFileInRoot(root, join(root, f.path), f.content);
    const tasks = plan.tasks.length ? await addTasks(root, plan.tasks) : [];
    if (plan.hookGroups.length) await addHookGroups(root, plan.hookGroups);

    const entry: ManifestEntry = {
      kind: req.kind,
      slug,
      version: req.version,
      packageId: req.packageId,
      installedAt: new Date().toISOString(),
      providers: (req.providers ?? (TARGETED.includes(req.kind) ? ["claude"] : [])) as Provider[],
      requires: req.requires ?? [],
      files: plan.files.map((f) => ({ path: f.path, sha256: sha256(f.content) })),
      dirs: plan.dirs,
      tasks,
      hookGroups: plan.hookGroups,
      members,
      ...(req.kind === "guide" ? { guideTarget: req.guideTarget ?? "CLAUDE.md" } : {}),
    };
    manifest[key] = entry;
    await writeManifest(root, manifest);
    const state = await entryState(root, entry);
    return { ok: true, sha256: state.recorded, ...(plan.warnings.length ? { warnings: plan.warnings } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** packages.list — the installed manifest with drift, requiredBy and the worker's enabled providers. */
export async function listPackages(root: string, enabledProviders: string[]): Promise<PackagesListReply> {
  const manifest = await readManifest(root);
  const installed: InstalledPackageState[] = [];
  for (const [key, e] of Object.entries(manifest)) {
    const state = await entryState(root, e);
    installed.push({
      slug: e.slug,
      kind: e.kind,
      version: e.version,
      packageId: e.packageId,
      installedAt: e.installedAt,
      sha256: state.recorded,
      currentSha256: state.current,
      providers: e.providers,
      requires: e.requires,
      requiredBy: requiredBy(manifest, key),
      ...(e.guideTarget ? { guideTarget: e.guideTarget as "CLAUDE.md" | "AGENT.md" } : {}),
    });
  }
  installed.sort((a, b) => `${a.kind}:${a.slug}`.localeCompare(`${b.kind}:${b.slug}`));
  return { installed, enabledProviders };
}

/** Find the manifest key for a slug (+ optional kind); null when absent/ambiguous. */
function findKey(manifest: Manifest, slug: string, kind?: string): string | null | "ambiguous" {
  const keys = Object.keys(manifest).filter((k) => manifest[k]!.slug === slug && (!kind || manifest[k]!.kind === kind));
  if (keys.length === 0) return null;
  return keys.length > 1 ? "ambiguous" : keys[0]!;
}

/** packages.remove — delete a package's targets + its manifest entry. Never throws. */
export async function removePackage(root: string, req: PackagesRemoveRequest): Promise<PackagesRemoveReply> {
  const n = safeName(req.slug);
  if (!n) return { ok: false, error: "invalid slug" };
  try {
    const manifest = await readManifest(root);
    const key = findKey(manifest, n, req.kind);
    if (key === "ambiguous") return { ok: false, error: "invalid slug" };
    if (!key) return { ok: false, error: "not installed" };
    const needed = requiredBy(manifest, key);
    if (needed.length && !req.force) return { ok: false, error: "REQUIRED_BY", requiredBy: needed };
    await deleteTargets(root, manifest[key]!);
    delete manifest[key];
    await writeManifest(root, manifest);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Re-apply the hook groups recorded in `.4pm/packages.json` — used after `project.create` resets
 * `.claude/settings.json` so installed hooks survive a re-create. Never throws.
 * @adr 0461 @adr 0329
 */
export async function reapplyInstalledHooks(root: string): Promise<void> {
  try {
    if (!(await readRel(root, ".4pm/packages.json"))) return;
    const manifest = await readManifest(root);
    const groups = Object.values(manifest).flatMap((e) => e.hookGroups);
    if (groups.length) await addHookGroups(root, groups);
  } catch {
    // Best-effort: a broken settings file is left for the operator.
  }
}
