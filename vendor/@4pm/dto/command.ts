/**
 * Vendored from @4pm/dto (command.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
import { AI_JOBS, type AiJob } from "@4pm/shared-constants";
import { baseRequestSchema } from "./base";
import { timeZoneSchema } from "./time-zone";
import { ATTACHMENT_FILE_MIME_TYPES, ATTACHMENT_ID_EXT_PATTERN, ATTACHMENT_IMAGE_MIME_TYPES, ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, attachmentExt } from "./attachment";
export const COMMAND_MAX_LEN = 8000;
export const AI_PROMPT_MAX_LEN = 500000;
export const COMMAND_IMAGE_MAX_BYTES = ATTACHMENT_MAX_BYTES;
export const COMMAND_IMAGE_MAX_COUNT = ATTACHMENT_MAX_COUNT;
export const COMMAND_IMAGE_MIME_TYPES = [...ATTACHMENT_IMAGE_MIME_TYPES, ...ATTACHMENT_FILE_MIME_TYPES] as const;
export type CommandImageMime = (typeof COMMAND_IMAGE_MIME_TYPES)[number];
export const COMMAND_IMAGE_ID_RE = new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(${ATTACHMENT_ID_EXT_PATTERN})$`);
export function isCommandImageId(id: string): boolean {
    return COMMAND_IMAGE_ID_RE.test(id);
}
export function commandImageExt(mime: string): string {
    return attachmentExt(mime) ?? "bin";
}
export interface CommandImageUploadResponse {
    id: string;
    mime: string;
    name: string;
    bytes: number;
    category: "image" | "file";
}
export const commandImageRefSchema = z.object({
    id: z.string().regex(COMMAND_IMAGE_ID_RE),
    placeholder: z.string().min(1).max(40),
    name: z.string().max(255),
    mime: z.enum(COMMAND_IMAGE_MIME_TYPES),
    category: z.enum(["image", "file"]).optional(),
});
export type CommandImageRef = z.infer<typeof commandImageRefSchema>;
export type CommandOrigin = "web" | "local";
export const aiRunConfigSchema = z.object({
    model: z.string().trim().max(120).optional(),
    thinking: z.enum(["off", "low", "medium", "high"]).optional(),
    temperature: z.number().min(0).max(1).optional(),
});
export type AiRunConfig = z.infer<typeof aiRunConfigSchema>;
export const commandResultSinkSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("template-update"),
        fromVersion: z.string().max(64).nullable(),
        toVersion: z.string().min(1).max(64),
        instruction: z.string().nullable(),
    }),
    z.object({ kind: z.literal("doc-generation"), runId: z.string().guid() }),
    z.object({ kind: z.literal("automation-action"), runId: z.string().guid(), index: z.number().int().min(0).max(20) }),
    z.object({ kind: z.literal("checklist-ai"), runId: z.string().guid() }),
    z.object({ kind: z.literal("marketing-run"), runId: z.string().guid() }),
    z.object({ kind: z.literal("flow-map"), mapId: z.string().guid(), mode: z.enum(["generate", "update"]) }),
]);
export type CommandResultSink = z.infer<typeof commandResultSinkSchema>;
export const dispatchCommandRequestSchema = z
    .object({
    projectId: z.string().guid(),
    machineLinkId: z.string().guid().optional(),
    pick: z.enum(["idle"]).optional(),
    command: z.string().min(1).max(AI_PROMPT_MAX_LEN),
    args: z.array(z.string().max(1000)).max(50).optional(),
    ai: z.boolean().optional(),
    label: z.string().max(120).optional(),
    gitOp: z.enum(["read", "write"]).optional(),
    images: z.array(commandImageRefSchema).max(COMMAND_IMAGE_MAX_COUNT).optional(),
    aiOneShot: z.boolean().optional(),
    aiReadOnly: z.boolean().optional(),
    aiBypass: z.boolean().optional(),
    ciKind: z.enum(["ci", "security"]).optional(),
    aiConfig: aiRunConfigSchema.optional(),
    job: z.enum(AI_JOBS as [
        AiJob,
        ...AiJob[]
    ]).optional(),
    resultSink: commandResultSinkSchema.optional(),
})
    .superRefine((v, ctx) => {
    if ((v.machineLinkId == null) === (v.pick == null)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["machineLinkId"],
            message: "Provide exactly one of machineLinkId or pick.",
        });
    }
    if (v.aiOneShot && v.aiReadOnly) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["aiReadOnly"],
            message: "aiOneShot and aiReadOnly are mutually exclusive.",
        });
    }
    if (v.aiBypass && (v.aiOneShot || v.aiReadOnly)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["aiBypass"],
            message: "aiBypass is mutually exclusive with aiOneShot and aiReadOnly.",
        });
    }
    if (v.resultSink && !v.ai) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["resultSink"],
            message: "resultSink requires ai:true.",
        });
    }
    if (!v.ai && v.command.length > COMMAND_MAX_LEN) {
        ctx.addIssue({
            code: "too_big",
            maximum: COMMAND_MAX_LEN,
            origin: "string",
            inclusive: true,
            path: ["command"],
            message: `command too long (max ${COMMAND_MAX_LEN})`,
        });
    }
});
export type DispatchCommandRequest = z.infer<typeof dispatchCommandRequestSchema>;
export const GIT_COMMAND_ALLOWLIST = ["git", "gh", "glab"] as const;
export function isGitCommandAllowed(command: string): boolean {
    const trimmed = command.trim();
    const first = trimmed.split(/\s+/)[0] ?? "";
    if (!(GIT_COMMAND_ALLOWLIST as readonly string[]).includes(first))
        return false;
    if (/[;|&$`><\n\r]/.test(trimmed))
        return false;
    return true;
}
export type CommandActivityStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export interface CommandQueueInfo {
    position: number;
    limit: number;
    running: number;
    reason?: "slot" | "repo";
    holder?: "autonomous" | "command" | "git" | "project";
    task?: string;
}
export interface CommandActivityEvent {
    commandId: string;
    machineLinkId: string;
    projectId: string;
    orgId: string;
    label: string;
    command?: string;
    ai: boolean;
    origin?: "web" | "local";
    status: CommandActivityStatus;
    queue?: CommandQueueInfo;
    exitCode?: number | null;
    startedAt: string;
    initiatedByName?: string;
}
export type TranscriptSource = "server" | "local" | "system";
export type TranscriptKind = "log" | "cmd" | "out" | "exit" | "aireq" | "aires" | "result";
export interface AiRunMeta {
    cmd: string;
    args: string[];
    prompt: string;
    model?: string;
}
export interface TranscriptEntry {
    id: string;
    source: TranscriptSource;
    kind: TranscriptKind;
    text: string;
    level: "info" | "warn" | "error";
    resultKind?: "json" | "code";
    durationMs?: number;
    aiMeta?: AiRunMeta;
}
export type ConsoleSyncEvent = {
    kind: "snapshot";
    rev: number;
    entries: TranscriptEntry[];
} | {
    kind: "add";
    rev: number;
    entry: TranscriptEntry;
} | {
    kind: "update";
    rev: number;
    entry: TranscriptEntry;
} | {
    kind: "clear";
    rev: number;
};
export const listCommandsQuerySchema = baseRequestSchema.extend({
    projectId: z.string().guid(),
    from: z.string().optional(),
    to: z.string().optional(),
    tz: timeZoneSchema.optional(),
    machineLinkId: z.string().guid().optional(),
});
export type ListCommandsQuery = z.infer<typeof listCommandsQuerySchema>;
export interface CommandDispatchResponse {
    commandId: string;
    status: string;
    reattachCapMs?: number;
}
export function deriveAiReplyWindows(effectiveSec: number, profileCount: number): {
    evictMs: number;
    reattachCapMs: number;
} {
    const eff = Number.isFinite(effectiveSec) && effectiveSec > 0 ? Math.floor(effectiveSec) : 0;
    const profiles = Number.isFinite(profileCount) && profileCount > 0 ? Math.floor(profileCount) : 1;
    const evictMs = eff > 0 ? eff * 1500 : 1000000;
    const reattachCapMs = Math.max(Math.round(evictMs * 1.5), eff * profiles * 1200);
    return { evictMs, reattachCapMs };
}
export interface CancelCommandResponse {
    cancelled: true;
}
export interface CommandStatusResponse {
    id: string;
    status: string;
    exitCode: number | null;
    createdAt: string;
    finishedAt: string | null;
}
export type CommandOutputUnavailableReason = "store-disabled" | "pruned" | null;
export interface CommandOutputResponse {
    output: string | null;
    input: string | null;
    unavailableReason: CommandOutputUnavailableReason;
}
export interface CliSlashCommandMeta {
    name: string;
    usage: string;
    description: string;
}
export const CLI_SLASH_COMMANDS: CliSlashCommandMeta[] = [
    { name: "help", usage: "/help", description: "List slash commands" },
    { name: "version", usage: "/version", description: "Show the cli version" },
    { name: "status", usage: "/status", description: "Show connection + profile + session status" },
    { name: "history", usage: "/history [N]", description: "List the last N executed commands (+ time)" },
    { name: "output", usage: "/output <n>", description: "Replay a command's output (n from /history)" },
    { name: "logs", usage: "/logs [N]", description: "Tail the profile's structured log" },
    { name: "expand", usage: "/expand [N]", description: "Expand a collapsed ▸[N] block" },
    { name: "collapse", usage: "/collapse [N]", description: "Collapse an expanded ▸[N] block" },
    { name: "reconnect", usage: "/reconnect", description: "Reconnect to the server now (skip the backoff)" },
    { name: "whoami", usage: "/whoami", description: "Show this machine account + its teams & projects" },
    { name: "ai-profile", usage: "/ai-profile [list|use <n>|reset]", description: "List AI profiles / switch which one runs" },
    { name: "config", usage: "/config [show|init|set <k> <v>|delete <k>]", description: "View / init / update / delete profile config" },
    { name: "claude-cmd", usage: "/claude-cmd /context", description: "Run an AI-CLI slash command (e.g. /context, /usage)" },
    { name: "clear", usage: "/clear", description: "Clear the transcript" },
    { name: "quit", usage: "/quit", description: "Quit the cli (also /exit)" },
];
export const CLI_SLASH_COMMAND_NAMES: string[] = CLI_SLASH_COMMANDS.map((c) => c.name);
