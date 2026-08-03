/**
 * Subagents & skills management on the worker (ADR-0153, agents.list/read/write channels). Lists,
 * reads and writes `.claude/agents/<name>.md` (subagents, + short/long memory) and
 * `.claude/skills/<name>/SKILL.md` (skills) under the serving physic project. Names are sanitized
 * to a safe file stem so a request can never escape the `.claude/` tree. Never throws — errors map
 * to a failing reply.
 */
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
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

/** Read a file as UTF-8; fallback when missing. */
async function readText(path: string, fallback = ""): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
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
export async function listAgents(root: string): Promise<AgentsListReply> {
  const subagents: AgentSummary[] = [];
  const skills: AgentSummary[] = [];
  try {
    for (const e of await readdir(join(root, AGENTS_REL), { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".md") || MEMORY_DIRS.has(e.name)) continue;
      const fm = frontmatter(await readText(join(root, AGENTS_REL, e.name)));
      subagents.push({ name: e.name.replace(/\.md$/, ""), description: fm.description });
    }
  } catch {
    // no agents dir ⇒ empty
  }
  try {
    for (const e of await readdir(join(root, SKILLS_REL), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const fm = frontmatter(await readText(join(root, SKILLS_REL, e.name, "SKILL.md")));
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
): Promise<AgentReadReply> {
  const content = await readText(itemPath(root, kind, name));
  if (kind !== "subagent") return { content };
  const n = safeName(name);
  const [short, long] = await Promise.all([
    readText(join(root, AGENTS_REL, "short-memory", `${n}.md`)),
    readText(join(root, AGENTS_REL, "long-memory", `${n}.md`)),
  ]);
  return { content, memory: { short, long } };
}

/** agents.write — create/edit or delete a subagent/skill. Never throws. */
export async function writeAgent(root: string, req: AgentWriteRequest): Promise<AgentWriteReply> {
  const n = safeName(req.name);
  if (!n) return { ok: false, error: "invalid name" };
  try {
    if (req.action === "delete") {
      if (req.kind === "subagent") await rm(itemPath(root, "subagent", n), { force: true });
      else await rm(join(root, SKILLS_REL, n), { recursive: true, force: true });
      return { ok: true };
    }
    if (req.content === undefined) return { ok: false, error: "content is required" };
    const path = itemPath(root, req.kind, n);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, req.content, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
