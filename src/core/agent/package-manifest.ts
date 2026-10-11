/**
 * The per-project installed-packages manifest `.4pm/packages.json` (`<kind>:<slug>` → entry): read it
 * (migrating the pre-ADR-0460 `.claude/.4pm-packages.json` on first read), write it, and hash files for
 * the drift guard. Symlink-safe reads/writes under the physic root.
 * @adr 0185 @adr 0460
 */
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { readFileInRoot, resolveEntry, writeFileInRoot } from "../../utils/safe-path";

/** The manifest path (provider-neutral). */
export const MANIFEST_REL = ".4pm/packages.json";
/** The legacy manifest path, migrated on first read. */
export const LEGACY_MANIFEST_REL = ".claude/.4pm-packages.json";

/** Every package kind (mirrors `@4pm/dto` MARKET_PACKAGE_KINDS). */
export type PackageKind = "subagent" | "skill" | "script" | "vscode-task" | "command" | "hook" | "bundle" | "guide";
/** AI providers a package can target. */
export type Provider = "claude" | "codex";

/** One hook command / matcher group (Claude & Codex share the shape). */
export interface HookGroup {
  matcher?: string;
  hooks: { type: "command"; command: string; timeout?: number }[];
}

/** One written file and its sha256 at install. */
export interface FileTarget {
  path: string;
  sha256: string;
}

/** One recorded hook group appended to a provider's hook config. */
export interface OwnedHookGroup {
  provider: Provider;
  event: string;
  group: HookGroup;
}

/** One installed package (or bundle member) record. */
export interface ManifestEntry {
  kind: PackageKind;
  slug: string;
  version: string;
  packageId: string;
  installedAt: string;
  providers: Provider[];
  requires: string[];
  /** Files written (root-relative). */
  files: FileTarget[];
  /** Folders owned whole (skill/script/hook dirs) — removed recursively. */
  dirs: string[];
  /** VS Code task labels owned + a hash of each task. */
  tasks: { label: string; sha256: string }[];
  /** Hook groups appended to the provider configs. */
  hookGroups: OwnedHookGroup[];
  /** Bundle members (`<kind>:<slug>`). */
  members: string[];
  /** Guide target file. */
  guideTarget?: string;
}

/** The manifest: `<kind>:<slug>` → entry. */
export type Manifest = Record<string, ManifestEntry>;

/** sha256 (hex) of bytes or text. */
export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Read a root-relative file (symlink-safe); null when missing/unreadable. */
export async function readRel(root: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFileInRoot(root, join(root, rel));
  } catch {
    return null;
  }
}

/** Every regular file under a root-relative dir, as root-relative POSIX paths (sorted; [] when absent). */
export async function listDirFiles(root: string, dirRel: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(abs, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  await walk(join(root, dirRel));
  return out.sort();
}

/** Convert one legacy `.4pm-packages.json` entry (slug → {kind, version, …}). */
function fromLegacy(slug: string, raw: Record<string, unknown>): ManifestEntry | null {
  const kind = raw.kind === "subagent" || raw.kind === "skill" ? raw.kind : null;
  if (!kind || typeof raw.version !== "string" || typeof raw.packageId !== "string") return null;
  const files: FileTarget[] =
    kind === "subagent" ? [{ path: `.claude/agents/${slug}.md`, sha256: "" }] : [];
  return {
    kind,
    slug,
    version: raw.version,
    packageId: raw.packageId,
    installedAt: typeof raw.installedAt === "string" ? raw.installedAt : new Date(0).toISOString(),
    providers: ["claude"],
    requires: [],
    files,
    dirs: kind === "skill" ? [`.claude/skills/${slug}`] : [],
    tasks: [],
    hookGroups: [],
    members: [],
  };
}

/** Normalize a parsed entry (older/partial shapes get empty arrays). */
function normalize(e: Partial<ManifestEntry>): ManifestEntry {
  return {
    kind: e.kind as PackageKind,
    slug: e.slug ?? "",
    version: e.version ?? "",
    packageId: e.packageId ?? "",
    installedAt: e.installedAt ?? new Date(0).toISOString(),
    providers: Array.isArray(e.providers) ? e.providers : ["claude"],
    requires: Array.isArray(e.requires) ? e.requires : [],
    files: Array.isArray(e.files) ? e.files : [],
    dirs: Array.isArray(e.dirs) ? e.dirs : [],
    tasks: Array.isArray(e.tasks) ? e.tasks : [],
    hookGroups: Array.isArray(e.hookGroups) ? e.hookGroups : [],
    members: Array.isArray(e.members) ? e.members : [],
    ...(e.guideTarget ? { guideTarget: e.guideTarget } : {}),
  };
}

/**
 * Read the manifest; on first read after the upgrade, convert the legacy `.claude/.4pm-packages.json`
 * (its legacy file hashes are re-taken now, so an existing install starts drift-free) and delete it.
 */
export async function readManifest(root: string): Promise<Manifest> {
  const buf = await readRel(root, MANIFEST_REL);
  if (buf) {
    try {
      const raw = JSON.parse(buf.toString("utf8")) as Record<string, Partial<ManifestEntry>>;
      return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, normalize(v)]));
    } catch {
      return {};
    }
  }
  const legacy = await readRel(root, LEGACY_MANIFEST_REL);
  if (!legacy) return {};
  let raw: Record<string, Record<string, unknown>>;
  try {
    raw = JSON.parse(legacy.toString("utf8")) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
  const manifest: Manifest = {};
  for (const [slug, entry] of Object.entries(raw)) {
    const converted = fromLegacy(slug, entry);
    if (!converted) continue;
    for (const d of converted.dirs) {
      for (const path of await listDirFiles(root, d)) converted.files.push({ path, sha256: "" });
    }
    for (const f of converted.files) f.sha256 = sha256((await readRel(root, f.path)) ?? "");
    manifest[`${converted.kind}:${slug}`] = converted;
  }
  await writeManifest(root, manifest);
  const legacyPath = resolveEntry(root, join(root, LEGACY_MANIFEST_REL));
  if (legacyPath) await rm(legacyPath, { force: true });
  return manifest;
}

/** Write the manifest (pretty JSON, keys sorted for stable diffs). */
export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
  await writeFileInRoot(root, join(root, MANIFEST_REL), JSON.stringify(sorted, null, 2) + "\n");
}

/** The installed packages (`<kind>:<slug>`) whose `requires` name `key`. */
export function requiredBy(manifest: Manifest, key: string): string[] {
  return Object.entries(manifest)
    .filter(([k, e]) => k !== key && e.requires.includes(key))
    .map(([k]) => k)
    .sort();
}
