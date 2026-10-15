/**
 * Subagents & skills management on the worker (ADR-0153, agents.list/read/write channels). Lists,
 * reads and writes `.claude/agents/<name>.md` (subagents, + short/long memory) and
 * `.claude/skills/<name>/SKILL.md` (skills) under the serving physic project. Names are sanitized
 * to a safe file stem so a request can never escape the `.claude/` tree. Never throws — errors map
 * to a failing reply. With `target: "base"` the items are read from `origin/<base>` and a write / delete is a
 * commit pushed to `<base>` (no working tree); a project without a remote base falls back to the tree.
 * @adr 0153 @adr 0511
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { readFileInRoot, resolveEntry, resolveForRead, writeFileInRoot } from "../../utils/safe-path";
import { baseList, baseMutate, baseRead, baseWrite, type BaseActor } from "../fs/fs-base";
import type {
  AgentReadReply,
  AgentSummary,
  AgentWriteReply,
  AgentWriteRequest,
  AgentsListReply,
} from "@4pm/ws";

const AGENTS_REL = ".claude/agents";
const SKILLS_REL = ".claude/skills";
const MEMORY_DIRS = new Set(["short-memory", "long-memory"]);

/** Sanitize a name to a safe file/dir stem (defense-in-depth beyond the DTO regex). */
function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

/** Read a project file as UTF-8 — symlink-safe; fallback when missing or outside the root. @adr 0430 */
async function readText(root: string, path: string, fallback = ""): Promise<string> {
  try {
    return await readFileInRoot(root, path, "utf8");
  } catch {
    return fallback;
  }
}

/** List a project folder only when it really is inside the root; [] otherwise. @adr 0430 */
async function listInRoot(root: string, dir: string): Promise<import("node:fs").Dirent[]> {
  const real = resolveForRead(root, dir);
  return real ? readdir(real, { withFileTypes: true }) : [];
}

/** How a listing / read reaches the files: the working tree, or `origin/<base>`. */
interface AgentsIo {
  readText(path: string): Promise<string>;
  list(dir: string): Promise<{ name: string; type: "dir" | "file" }[]>;
}

/** The working-tree io. */
function treeIo(root: string): AgentsIo {
  return {
    readText: (path) => readText(root, path),
    list: async (dir) =>
      (await listInRoot(root, dir).catch(() => [])).map((e) => ({ name: e.name, type: e.isDirectory() ? ("dir" as const) : ("file" as const) })),
  };
}

/** The `origin/<base>` io; null when the project has no remote base. */
async function baseIo(root: string): Promise<AgentsIo | null> {
  if (!(await baseList(root, ""))) return null;
  return {
    readText: async (path) => (await baseRead(root, path))?.content ?? "",
    list: async (dir) => (await baseList(root, dir))?.entries ?? [],
  };
}

/** The io for a request target. */
async function ioFor(root: string, target: "base" | "worktree" | undefined): Promise<AgentsIo> {
  return (target === "base" ? await baseIo(root).catch(() => null) : null) ?? treeIo(root);
}

/** Extract `name`/`description` from a `---`-delimited frontmatter block. */
function frontmatter(text: string): { name: string; description: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = m?.[1] ?? "";
  const get = (key: string): string =>
    body.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return { name: get("name"), description: get("description") };
}

/** agents.list — parse every subagent + skill of the physic project. */
export async function listAgents(root: string, target?: "base" | "worktree"): Promise<AgentsListReply> {
  const io = await ioFor(root, target);
  const subagents: AgentSummary[] = [];
  const skills: AgentSummary[] = [];
  try {
    for (const e of await io.list(join(root, AGENTS_REL))) {
      if (e.type !== "file" || !e.name.endsWith(".md") || MEMORY_DIRS.has(e.name)) continue;
      const fm = frontmatter(await io.readText(join(root, AGENTS_REL, e.name)));
      subagents.push({ name: e.name.replace(/\.md$/, ""), description: fm.description });
    }
  } catch {
    // no agents dir ⇒ empty
  }
  try {
    for (const e of await io.list(join(root, SKILLS_REL))) {
      if (e.type !== "dir") continue;
      const fm = frontmatter(await io.readText(join(root, SKILLS_REL, e.name, "SKILL.md")));
      skills.push({ name: e.name, description: fm.description });
    }
  } catch {
    // no skills dir ⇒ empty
  }
  subagents.sort((a, b) => a.name.localeCompare(b.name));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { subagents, skills };
}

/** File path for a subagent/skill. */
function itemPath(root: string, kind: "subagent" | "skill", name: string): string {
  const n = safeName(name);
  return kind === "subagent"
    ? join(root, AGENTS_REL, `${n}.md`)
    : join(root, SKILLS_REL, n, "SKILL.md");
}

/** agents.read — one item's content (+ a subagent's short/long memory). */
export async function readAgent(
  root: string,
  kind: "subagent" | "skill",
  name: string,
  target?: "base" | "worktree",
): Promise<AgentReadReply> {
  const io = await ioFor(root, target);
  const content = await io.readText(itemPath(root, kind, name));
  if (kind !== "subagent") return { content };
  const n = safeName(name);
  // Memory is the agent's own runtime state in the working tree, not a shared edit.
  const [short, long] = await Promise.all([
    readText(root, join(root, AGENTS_REL, "short-memory", `${n}.md`)),
    readText(root, join(root, AGENTS_REL, "long-memory", `${n}.md`)),
  ]);
  return { content, memory: { short, long } };
}

/** agents.write — create/edit or delete a subagent/skill. Never throws. */
export async function writeAgent(root: string, req: AgentWriteRequest, actor: BaseActor = {}): Promise<AgentWriteReply> {
  const n = safeName(req.name);
  if (!n) return { ok: false, error: "invalid name" };
  try {
    if (req.target === "base") {
      const based =
        req.action === "delete"
          ? await baseMutate(root, { op: "delete", path: req.kind === "subagent" ? itemPath(root, "subagent", n) : join(root, SKILLS_REL, n) }, actor)
          : req.content === undefined
            ? { ok: false, error: "content is required" }
            : await baseWrite(root, { path: itemPath(root, req.kind, n), content: req.content }, actor);
      if (based) return { ok: based.ok, ...(based.error ? { error: based.error } : {}), target: "base" };
    }
    if (req.action === "delete") {
      // Symlink-safe (ADR-0430): removes the entry itself, never a link's target.
      const target = resolveEntry(root, req.kind === "subagent" ? itemPath(root, "subagent", n) : join(root, SKILLS_REL, n));
      if (!target) return { ok: false, error: "path escapes the project root" };
      await rm(target, { recursive: true, force: true });
      return { ok: true };
    }
    if (req.content === undefined) return { ok: false, error: "content is required" };
    const path = itemPath(root, req.kind, n);
    await writeFileInRoot(root, path, req.content);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
