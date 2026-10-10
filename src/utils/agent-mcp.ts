/**
 * agent-mcp (ADR-0427) — the MCP server allowlist on the worker. Holds the serving project's approved
 * MCP servers (from `ws_token.mcpServers` / `project.tokens`), writes them to a generated config file in
 * the profile directory (outside the project folder), and builds the claude args: **every** claude spawn
 * gets `--strict-mcp-config` (repo `.mcp.json`, user-scope `~/.claude.json` and
 * `enableAllProjectMcpServers` are ignored); only full-agent project runs add `--mcp-config <file>`.
 * Also parses + hashes `.mcp.json` files for the web's repo scan. Claude only — other AI CLIs get no args.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalMcpDefinition,
  mcpServerDefinitionSchema,
  normalizeMcpDefinition,
  type McpServerDefinition,
} from "@4pm/dto";

/** File name of the generated config inside the profile directory. */
const CONFIG_FILE = "mcp-servers.json";
/** Name of the repo-scoped MCP declaration file Claude Code reads. */
const MCP_JSON = ".mcp.json";

/** The approved servers (in memory — the source of truth) and where the generated config is written. */
let approved: Record<string, McpServerDefinition> = {};
let configFile: string | null = null;

/** sha256 (hex) of a definition's canonical JSON — the same pin the server stores on approval. */
export function mcpHash(def: McpServerDefinition): string {
  return createHash("sha256").update(canonicalMcpDefinition(def)).digest("hex");
}

/**
 * Apply the approved servers pushed by the server (validated; invalid entries dropped) and remember
 * where to write the generated config (`<profileDir>/mcp-servers.json`). Never throws.
 */
export function setMcpServers(list: { name: string; definition: unknown }[] | undefined, profileDir: string): void {
  const next: Record<string, McpServerDefinition> = {};
  for (const item of list ?? []) {
    const parsed = mcpServerDefinitionSchema.safeParse(item.definition);
    if (parsed.success && typeof item.name === "string" && item.name) {
      next[item.name] = normalizeMcpDefinition(parsed.data);
    }
  }
  approved = next;
  configFile = join(profileDir, CONFIG_FILE);
  if (Object.keys(next).length === 0) {
    try {
      rmSync(configFile, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * (Re)write the generated config from memory right before a run and return its path — never trusting
 * the file on disk, which an earlier agent run could have edited. Null when nothing is approved or the
 * file cannot be written (the run then gets no MCP server).
 */
function writeConfig(): string | null {
  if (!configFile || Object.keys(approved).length === 0) return null;
  try {
    writeFileSync(configFile, JSON.stringify({ mcpServers: approved }, null, 2), { mode: 0o600 });
    return configFile;
  } catch {
    return null;
  }
}

/** Args for a run that must use NO MCP server (one-shot, read-only, pool and background runs). */
export function strictMcpArgs(cmd: string): string[] {
  return cmd.includes("claude") ? ["--strict-mcp-config"] : [];
}

/**
 * Args for a full-agent project run: strict, plus the freshly written config when servers are
 * approved. `--mcp-config` is variadic — callers place a single-value flag (e.g. `--settings`) after it.
 */
export function projectMcpArgs(cmd: string): string[] {
  if (!cmd.includes("claude")) return [];
  const file = writeConfig();
  return file ? ["--strict-mcp-config", "--mcp-config", file] : ["--strict-mcp-config"];
}

/** One scanned `.mcp.json` file (mirrors `@4pm/ws` `McpScanReply.files[]`). */
export interface McpScanFileResult {
  path: string;
  servers: { name: string; definition: McpServerDefinition; hash: string }[];
  error?: string;
}

/** Parse one `.mcp.json` into hashed entries; an unreadable/invalid file yields `error`. */
function scanFile(abs: string, rel: string): McpScanFileResult {
  try {
    const json = JSON.parse(readFileSync(abs, "utf8")) as { mcpServers?: Record<string, unknown> };
    const servers: McpScanFileResult["servers"] = [];
    for (const [name, raw] of Object.entries(json.mcpServers ?? {})) {
      const parsed = mcpServerDefinitionSchema.safeParse(raw);
      if (!parsed.success) continue;
      const definition = normalizeMcpDefinition(parsed.data);
      servers.push({ name, definition, hash: mcpHash(definition) });
    }
    return { path: rel, servers };
  } catch (err) {
    return { path: rel, servers: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Scan `.mcp.json` at the served root and in each first-level folder (where declared repos are
 * cloned). Missing files are omitted. Never throws.
 */
export function scanMcpJson(root: string): McpScanFileResult[] {
  const out: McpScanFileResult[] = [];
  if (existsSync(join(root, MCP_JSON))) out.push(scanFile(join(root, MCP_JSON), MCP_JSON));
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return out;
  }
  for (const dir of entries) {
    const abs = join(root, dir, MCP_JSON);
    if (existsSync(abs)) out.push(scanFile(abs, `${dir}/${MCP_JSON}`));
  }
  return out;
}
