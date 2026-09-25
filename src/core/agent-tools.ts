/**
 * Agent tool-permission editor on the worker (ADR-0183, agentTools.read/write channels). Reads and
 * writes only the `permissions` block of the Claude settings file — `.claude/settings.json` (shared,
 * committed) or `.claude/settings.local.json` (per-cli local override). On write the cli preserves
 * every other field of the file and re-injects the ADR-0154 secrets `deny` on a shared write, so the
 * editor can never widen tool access to `project.secrets.json`. Never throws — errors map to a reply.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AgentToolsPermissions,
  AgentToolsReadReply,
  AgentToolsScope,
  AgentToolsWriteReply,
} from "@4pm/ws";

const SHARED_REL = ".claude/settings.json";
const LOCAL_REL = ".claude/settings.local.json";
/** The ADR-0154 guard kept in the shared `deny` list so the AI can never read secrets. */
const SECRETS_DENY = "Read(./project.secrets.json)";

/** Resolve the settings file path for a scope. */
function fileFor(root: string, scope: AgentToolsScope): string {
  return join(root, scope === "shared" ? SHARED_REL : LOCAL_REL);
}

/** Parse a settings file into an object (`{}` when missing/invalid). */
async function readSettingsObject(path: string): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Coerce an unknown value into a normalized permissions block. Headless-only (ADR-0328): the mode is
 * always `bypassPermissions` (there is no TTY/human to answer an interactive prompt) and the legacy
 * `ask` list is dropped — a hand-edited `ask`/non-bypass mode in the file is normalized away here.
 */
function normalizePermissions(raw: unknown): AgentToolsPermissions {
  const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return { defaultMode: "bypassPermissions", allow: list(p.allow), deny: list(p.deny) };
}

/** agentTools.read — the permissions block of the scope's settings file. */
export async function readAgentTools(root: string, scope: AgentToolsScope): Promise<AgentToolsReadReply> {
  const obj = await readSettingsObject(fileFor(root, scope));
  return { permissions: normalizePermissions(obj.permissions) };
}

/** agentTools.write — splice the permissions block back, preserving the rest. Never throws. */
export async function writeAgentTools(
  root: string,
  scope: AgentToolsScope,
  permissions: AgentToolsPermissions,
): Promise<AgentToolsWriteReply> {
  try {
    const path = fileFor(root, scope);
    const obj = await readSettingsObject(path);
    const next = normalizePermissions(permissions);
    // The shared policy must always keep the secrets guard (ADR-0154).
    if (scope === "shared" && !next.deny.includes(SECRETS_DENY)) next.deny = [...next.deny, SECRETS_DENY];
    obj.permissions = next;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
