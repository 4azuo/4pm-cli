/**
 * Marketplace package operations on the worker (ADR-0185, packages.pack/install/list/remove). Packs
 * a `.claude/agents/<name>.md` (+ memory) or `.claude/skills/<name>/` tree into a payload file set
 * (the server zips it), installs a downloaded payload into `.claude/agents|skills` recording
 * `.claude/.4pm-packages.json`, lists installed packages with an on-disk sha256 for the drift guard,
 * and removes an installed package. All paths are clamped under the physic root's `.claude/` tree;
 * these never throw — errors map to a failing reply.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type {
  InstalledPackageState,
  PackagePayloadFile,
  PackagesInstallReply,
  PackagesInstallRequest,
  PackagesListReply,
  PackagesPackReply,
  PackagesRemoveReply,
} from "@4pm/ws";

const AGENTS_REL = ".claude/agents";
const SKILLS_REL = ".claude/skills";
const MANIFEST_REL = ".claude/.4pm-packages.json";

type Kind = "subagent" | "skill";

interface ManifestEntry {
  kind: Kind;
  version: string;
  packageId: string;
  installedAt: string;
  sha256: string;
}
type Manifest = Record<string, ManifestEntry>;

/** Sanitize a name to a safe file/dir stem (defense-in-depth beyond the DTO regex). */
function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

/** Read a file as UTF-8; null when missing. */
async function readMaybe(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** List every file under a dir (recursive), returning paths relative to it. */
async function listFilesRel(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(relative(dir, full));
    }
  }
  await walk(dir);
  return out.sort();
}

/** Gather an artifact's on-disk payload files (canonical package layout). */
async function readArtifactFiles(root: string, kind: Kind, slug: string): Promise<PackagePayloadFile[]> {
  const files: PackagePayloadFile[] = [];
  if (kind === "subagent") {
    const agent = await readMaybe(join(root, AGENTS_REL, `${slug}.md`));
    if (agent) files.push({ path: "agent.md", contentBase64: agent.toString("base64") });
    const short = await readMaybe(join(root, AGENTS_REL, "short-memory", `${slug}.md`));
    if (short) files.push({ path: "short-memory.md", contentBase64: short.toString("base64") });
    const long = await readMaybe(join(root, AGENTS_REL, "long-memory", `${slug}.md`));
    if (long) files.push({ path: "long-memory.md", contentBase64: long.toString("base64") });
  } else {
    const base = join(root, SKILLS_REL, slug);
    for (const rel of await listFilesRel(base)) {
      const buf = await readMaybe(join(base, rel));
      if (buf) files.push({ path: rel.split("\\").join("/"), contentBase64: buf.toString("base64") });
    }
  }
  return files;
}

/** Deterministic sha256 over an artifact's on-disk files (sorted path + bytes). */
async function artifactSha256(root: string, kind: Kind, slug: string): Promise<string> {
  const files = await readArtifactFiles(root, kind, slug);
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path);
    h.update("\0");
    h.update(f.contentBase64);
    h.update("\0");
  }
  return h.digest("hex");
}

/** True when the artifact already exists on disk (a hand-authored file we must not clobber). */
async function artifactExists(root: string, kind: Kind, slug: string): Promise<boolean> {
  const target = kind === "subagent" ? join(root, AGENTS_REL, `${slug}.md`) : join(root, SKILLS_REL, slug);
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Read the install manifest (empty when absent/corrupt). */
async function readManifest(root: string): Promise<Manifest> {
  const buf = await readMaybe(join(root, MANIFEST_REL));
  if (!buf) return {};
  try {
    return JSON.parse(buf.toString("utf8")) as Manifest;
  } catch {
    return {};
  }
}

/** Write the install manifest. */
async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const path = join(root, MANIFEST_REL);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}

/** Write a downloaded payload file set into the artifact's on-disk location. */
async function writeArtifactFiles(
  root: string,
  kind: Kind,
  slug: string,
  files: PackagePayloadFile[],
): Promise<void> {
  const byPath = new Map(files.map((f) => [f.path, Buffer.from(f.contentBase64, "base64")]));
  if (kind === "subagent") {
    const agent = byPath.get("agent.md");
    if (agent) {
      await mkdir(join(root, AGENTS_REL), { recursive: true });
      await writeFile(join(root, AGENTS_REL, `${slug}.md`), agent);
    }
    const short = byPath.get("short-memory.md");
    if (short) {
      await mkdir(join(root, AGENTS_REL, "short-memory"), { recursive: true });
      await writeFile(join(root, AGENTS_REL, "short-memory", `${slug}.md`), short);
    }
    const long = byPath.get("long-memory.md");
    if (long) {
      await mkdir(join(root, AGENTS_REL, "long-memory"), { recursive: true });
      await writeFile(join(root, AGENTS_REL, "long-memory", `${slug}.md`), long);
    }
  } else {
    const base = join(root, SKILLS_REL, slug);
    for (const [rel, buf] of byPath) {
      if (rel.includes("..") || rel.startsWith("/")) continue;
      const dest = join(base, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
    }
  }
}

/** packages.pack — read a project subagent/skill into a payload file set (server zips it). */
export async function packPackage(root: string, kind: Kind, name: string): Promise<PackagesPackReply> {
  const slug = safeName(name);
  if (!slug) return { ok: false, files: [], error: "invalid name" };
  const files = await readArtifactFiles(root, kind, slug);
  if (files.length === 0) return { ok: false, files: [], error: "artifact not found" };
  return { ok: true, files };
}

/** packages.install — write a downloaded package version, drift-guarded; records the manifest. */
export async function installPackage(root: string, req: PackagesInstallRequest): Promise<PackagesInstallReply> {
  const slug = safeName(req.slug);
  if (!slug) return { ok: false, error: "invalid slug" };
  try {
    const manifest = await readManifest(root);
    const existing = manifest[slug];
    if (!existing && (await artifactExists(root, req.kind, slug))) {
      return { ok: false, error: "ALREADY_INSTALLED" };
    }
    if (existing) {
      const currentSha = await artifactSha256(root, req.kind, slug);
      if (currentSha !== existing.sha256) return { ok: false, error: "DRIFT" };
    }
    await writeArtifactFiles(root, req.kind, slug, req.files);
    const sha256 = await artifactSha256(root, req.kind, slug);
    manifest[slug] = {
      kind: req.kind,
      version: req.version,
      packageId: req.packageId,
      installedAt: new Date().toISOString(),
      sha256,
    };
    await writeManifest(root, manifest);
    return { ok: true, sha256 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** packages.list — the installed manifest with a recomputed on-disk sha256 (drift). */
export async function listPackages(root: string): Promise<PackagesListReply> {
  const manifest = await readManifest(root);
  const installed: InstalledPackageState[] = [];
  for (const [slug, entry] of Object.entries(manifest)) {
    installed.push({
      slug,
      kind: entry.kind,
      version: entry.version,
      packageId: entry.packageId,
      installedAt: entry.installedAt,
      sha256: entry.sha256,
      currentSha256: await artifactSha256(root, entry.kind, slug),
    });
  }
  installed.sort((a, b) => a.slug.localeCompare(b.slug));
  return { installed };
}

/** packages.remove — delete the artifact + its manifest entry. Never throws. */
export async function removePackage(root: string, slug: string): Promise<PackagesRemoveReply> {
  const n = safeName(slug);
  if (!n) return { ok: false, error: "invalid slug" };
  try {
    const manifest = await readManifest(root);
    const entry = manifest[n];
    if (!entry) return { ok: false, error: "not installed" };
    if (entry.kind === "subagent") {
      await rm(join(root, AGENTS_REL, `${n}.md`), { force: true });
      await rm(join(root, AGENTS_REL, "short-memory", `${n}.md`), { force: true });
      await rm(join(root, AGENTS_REL, "long-memory", `${n}.md`), { force: true });
    } else {
      await rm(join(root, SKILLS_REL, n), { recursive: true, force: true });
    }
    delete manifest[n];
    await writeManifest(root, manifest);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
