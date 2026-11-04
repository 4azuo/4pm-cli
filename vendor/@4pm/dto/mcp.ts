/**
 * Vendored from @4pm/dto (mcp.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MCP_SERVERS_MAX = 20;
const strMapSchema = z.record(z.string().min(1).max(200), z.string().max(4000));
export const mcpStdioDefinitionSchema = z.object({
    type: z.literal("stdio").optional(),
    command: z.string().trim().min(1).max(1000),
    args: z.array(z.string().max(4000)).max(100).optional(),
    env: strMapSchema.optional(),
});
export const mcpRemoteDefinitionSchema = z.object({
    type: z.enum(["http", "sse"]),
    url: z.string().trim().min(1).max(2000),
    headers: strMapSchema.optional(),
});
export const mcpServerDefinitionSchema = z.union([mcpRemoteDefinitionSchema, mcpStdioDefinitionSchema]);
export type McpServerDefinition = z.infer<typeof mcpServerDefinitionSchema>;
export const MCP_SERVER_SOURCES = ["repo", "manual"] as const;
export type McpServerSource = (typeof MCP_SERVER_SOURCES)[number];
export interface McpApprovedServer {
    name: string;
    definition: McpServerDefinition;
    hash: string;
    source: McpServerSource;
    approvedBy: string;
    approvedByName: string;
    approvedAt: string;
}
export interface McpServersResponse {
    servers: McpApprovedServer[];
}
export const putMcpServersRequestSchema = z.object({
    servers: z
        .array(z.object({
        name: z.string().regex(MCP_SERVER_NAME_RE),
        definition: mcpServerDefinitionSchema,
        source: z.enum(MCP_SERVER_SOURCES),
    }))
        .max(MCP_SERVERS_MAX)
        .refine((list) => new Set(list.map((s) => s.name)).size === list.length, {
        message: "MCP server names must be unique",
    }),
});
export type PutMcpServersRequest = z.infer<typeof putMcpServersRequestSchema>;
export interface McpScanServer {
    name: string;
    definition: McpServerDefinition;
    hash: string;
}
export interface McpScanFile {
    path: string;
    servers: McpScanServer[];
    error?: string;
}
export interface McpScanResponse {
    files: McpScanFile[];
}
function sortedMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!map)
        return undefined;
    const keys = Object.keys(map).sort();
    if (keys.length === 0)
        return undefined;
    const out: Record<string, string> = {};
    for (const k of keys)
        out[k] = map[k] as string;
    return out;
}
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
export function canonicalMcpDefinition(def: McpServerDefinition): string {
    const n = normalizeMcpDefinition(def) as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const k of Object.keys(n).sort())
        ordered[k] = n[k];
    return JSON.stringify(ordered);
}
export function readMcpServers(raw: unknown): McpApprovedServer[] {
    const list = (raw as {
        servers?: unknown;
    } | null | undefined)?.servers;
    if (!Array.isArray(list))
        return [];
    const out: McpApprovedServer[] = [];
    for (const item of list.slice(0, MCP_SERVERS_MAX)) {
        const e = item as Partial<McpApprovedServer> | null;
        if (!e || typeof e.name !== "string" || !MCP_SERVER_NAME_RE.test(e.name))
            continue;
        const def = mcpServerDefinitionSchema.safeParse(e.definition);
        if (!def.success || typeof e.hash !== "string")
            continue;
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
