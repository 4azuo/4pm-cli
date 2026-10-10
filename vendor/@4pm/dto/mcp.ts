/**
 * MCP server allowlist DTOs — the approved, hash-pinned MCP servers of a project
 * (`project.settings.mcp`), the definition schema mirroring a `.mcp.json` entry, the canonical form the
 * server and the cli hash (sha256, computed by each side with its own crypto), and the repo-scan shapes.
 * @adr 0427
 */
import { z } from "zod";

/** Allowed MCP server name (the `.mcp.json` key). */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Max approved MCP servers per project. */
export const MCP_SERVERS_MAX = 20;

/** A string→string map (env vars / HTTP headers); values may be `${VAR}` references. */
const strMapSchema = z.record(z.string().min(1).max(200), z.string().max(4000));

/** A stdio MCP server — a command the AI CLI starts. Unknown keys are stripped. */
export const mcpStdioDefinitionSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().trim().min(1).max(1000),
  args: z.array(z.string().max(4000)).max(100).optional(),
  env: strMapSchema.optional(),
});

/** A remote MCP server — an http / sse endpoint the AI CLI calls. Unknown keys are stripped. */
export const mcpRemoteDefinitionSchema = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().trim().min(1).max(2000),
  headers: strMapSchema.optional(),
});

/** One MCP server definition (a `.mcp.json` `mcpServers` entry). */
export const mcpServerDefinitionSchema = z.union([mcpRemoteDefinitionSchema, mcpStdioDefinitionSchema]);
export type McpServerDefinition = z.infer<typeof mcpServerDefinitionSchema>;

/** Where an approved entry came from. */
export const MCP_SERVER_SOURCES = ["repo", "manual"] as const;
export type McpServerSource = (typeof MCP_SERVER_SOURCES)[number];

/** One approved MCP server as stored in `project.settings.mcp.servers` and returned by project-0086. */
export interface McpApprovedServer {
  name: string;
  definition: McpServerDefinition;
  /** sha256 (hex) of {@link canonicalMcpDefinition}. */
  hash: string;
  source: McpServerSource;
  /** User id who approved this exact definition. */
  approvedBy: string;
  /** That user's display name at approval time. */
  approvedByName: string;
  /** ISO timestamp of the approval. */
  approvedAt: string;
}

/** Response of project-0086 / project-0087. */
export interface McpServersResponse {
  servers: McpApprovedServer[];
}

/** Body of project-0087 PUT /projects/:id/mcp-servers — the whole list (names unique). */
export const putMcpServersRequestSchema = z.object({
  servers: z
    .array(
      z.object({
        name: z.string().regex(MCP_SERVER_NAME_RE),
        definition: mcpServerDefinitionSchema,
        source: z.enum(MCP_SERVER_SOURCES),
      }),
    )
    .max(MCP_SERVERS_MAX)
    .refine((list) => new Set(list.map((s) => s.name)).size === list.length, {
      message: "MCP server names must be unique",
    }),
});
export type PutMcpServersRequest = z.infer<typeof putMcpServersRequestSchema>;

/** One server found in a scanned `.mcp.json`. @api machine-0075 */
export interface McpScanServer {
  name: string;
  definition: McpServerDefinition;
  hash: string;
}

/** One scanned `.mcp.json` file; `error` set when it could not be parsed. @api machine-0075 */
export interface McpScanFile {
  path: string;
  servers: McpScanServer[];
  error?: string;
}

/** Response of machine-0075 GET /machines/:id/mcp-scan. */
export interface McpScanResponse {
  files: McpScanFile[];
}

/** Copy a string map with its keys sorted; undefined when empty. */
function sortedMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!map) return undefined;
  const keys = Object.keys(map).sort();
  if (keys.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = map[k] as string;
  return out;
}

/**
 * Normalize a definition to the exact shape the cli writes into the generated `--mcp-config`: `type`
 * made explicit (`stdio` by default), empty `args`/`env`/`headers` dropped, map keys sorted.
 */
export function normalizeMcpDefinition(def: McpServerDefinition): McpServerDefinition {
  if ("url" in def) {
    const headers = sortedMap(def.headers);
    return { type: def.type, url: def.url, ...(headers ? { headers } : {}) };
  }
  const env = sortedMap(def.env);
  return {
    type: "stdio",
    command: def.command,
    ...(def.args && def.args.length > 0 ? { args: [...def.args] } : {}),
    ...(env ? { env } : {}),
  };
}

/**
 * The canonical JSON string of a definition (normalized, fixed key order) — the input of the sha256
 * `hash` both the server (approval) and the cli (scan) compute, so equal definitions hash equal.
 */
export function canonicalMcpDefinition(def: McpServerDefinition): string {
  const n = normalizeMcpDefinition(def) as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(n).sort()) ordered[k] = n[k];
  return JSON.stringify(ordered);
}

/**
 * Read the approved MCP servers from the loosely-typed `settings.mcp` value, dropping any entry that
 * no longer validates (never throws).
 */
export function readMcpServers(raw: unknown): McpApprovedServer[] {
  const list = (raw as { servers?: unknown } | null | undefined)?.servers;
  if (!Array.isArray(list)) return [];
  const out: McpApprovedServer[] = [];
  for (const item of list.slice(0, MCP_SERVERS_MAX)) {
    const e = item as Partial<McpApprovedServer> | null;
    if (!e || typeof e.name !== "string" || !MCP_SERVER_NAME_RE.test(e.name)) continue;
    const def = mcpServerDefinitionSchema.safeParse(e.definition);
    if (!def.success || typeof e.hash !== "string") continue;
    out.push({
      name: e.name,
      definition: normalizeMcpDefinition(def.data),
      hash: e.hash,
      source: e.source === "repo" ? "repo" : "manual",
      approvedBy: typeof e.approvedBy === "string" ? e.approvedBy : "",
      approvedByName: typeof e.approvedByName === "string" ? e.approvedByName : "",
      approvedAt: typeof e.approvedAt === "string" ? e.approvedAt : "",
    });
  }
  return out;
}
