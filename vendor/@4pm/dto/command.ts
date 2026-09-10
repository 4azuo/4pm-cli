/**
 * DTO for the console command domain (command-0001/0002): dispatch a command to
 * a worker cli and read its status. Output streams over SSE (command.output), not
 * in these responses.
 */
import { z } from "zod";
import { baseRequestSchema } from "./base";

/**
 * Max `command` length for an executable command vs an AI prompt (ADR-0106).
 * The AI-prompt cap was raised 200k → 500k (ADR-0255): the whole-spec review/compose prompts
 * embed the full self-describing envelope (+ `_aiReview`/`_aiTree` meta for compose), and a
 * genuinely large spec pushes that past 200k chars — which the dispatch pipe rejected as a
 * confusing `VALIDATION_FAILED` before the AI ever ran. 500k (~125k tokens) leaves ample
 * headroom while staying well within the model context window.
 */
export const COMMAND_MAX_LEN = 8_000;
export const AI_PROMPT_MAX_LEN = 500_000;

/**
 * Console prompt image attachments (ADR-0257): allowed MIME types, per-image byte cap, and the
 * max number of images per prompt. Shared by the upload endpoint (server validation) and the web.
 */
export const COMMAND_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const COMMAND_IMAGE_MAX_COUNT = 10;
export const COMMAND_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type CommandImageMime = (typeof COMMAND_IMAGE_MIME_TYPES)[number];

/**
 * The exact shape of a stored command-image id (ADR-0257): `<uuidv4>.<ext>`, the only form the server
 * ever mints (`randomUUID()` + `commandImageExt`). A dispatch's `images[].id` and the preview/gRPC
 * fetch key are checked against this so a client-supplied id can never carry `/` or `..` path
 * separators into a storage key (path-traversal guard — the id becomes `command-images/{orgId}/{id}`).
 */
export const COMMAND_IMAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;

/** True when `id` is a well-formed command-image id (`<uuidv4>.<ext>`) — see COMMAND_IMAGE_ID_RE. */
export function isCommandImageId(id: string): boolean {
  return COMMAND_IMAGE_ID_RE.test(id);
}

/** The file extension for a stored command-image MIME (ADR-0257) — drives the storage key + on-disk name. */
export function commandImageExt(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

/** Response of POST /commands/images (command-0008) — the stored image's id + metadata. */
export interface CommandImageUploadResponse {
  /** Opaque image id (`<uuid>.<ext>`) — reference it from a dispatch `images[].id`. */
  id: string;
  mime: string;
  name: string;
  bytes: number;
}

/**
 * One image attachment on a Console dispatch (ADR-0257): a prompt placeholder `[Image#N]` bound to an
 * uploaded image id + its display name/MIME. The serving cli rewrites `placeholder` to the on-disk path.
 */
export const commandImageRefSchema = z.object({
  // Constrained to `<uuidv4>.<ext>` (the only id the upload mints) so a client-supplied id can never
  // inject `/` or `..` into the `command-images/{orgId}/{id}` storage key (path-traversal guard).
  id: z.string().regex(COMMAND_IMAGE_ID_RE),
  placeholder: z.string().min(1).max(40),
  name: z.string().max(255),
  mime: z.enum(COMMAND_IMAGE_MIME_TYPES),
});
export type CommandImageRef = z.infer<typeof commandImageRefSchema>;

/** Where a command was initiated: `web` (dispatch) vs `local` (cli TUI) — ADR-0107. */
export type CommandOrigin = "web" | "local";

/** Body POST /commands — dispatch a command to the project's cli. */
export const dispatchCommandRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    // Target cli. Required unless `pick` is set — with `pick:"idle"` the server chooses the
    // target from the project's pool, so the client omits it (ADR-0171).
    machineLinkId: z.string().uuid().optional(),
    /**
     * Server-side idle-cli pick (ADR-0171): `"idle"` ⇒ omit `machineLinkId` and let the server
     * select + atomically claim an idle cli from the project's pool (machine-users + org
     * orchestrator). Used by the wizard's AI ops so parallel suggests spread across the pool
     * without double-booking a busy cli; no idle cli ⇒ `ALL_CLIS_BUSY`.
     */
    pick: z.enum(["idle"]).optional(),
    // In AI mode `command` carries the raw prompt (can be long — the spec-assist prompts
    // embed the whole self-describing spec envelope, ADR-0106), else an executable name.
    command: z.string().min(1).max(AI_PROMPT_MAX_LEN),
    args: z.array(z.string().max(1000)).max(50).optional(),
    /**
     * AI prompt mode: run `command` as a prompt through the cli's AI CLI (profile
     * failover) instead of spawning it verbatim (mirrors a locally-typed prompt).
     */
    ai: z.boolean().optional(),
    /**
     * Short human label shown to OTHER tabs watching this cli's activity feed (ADR-0101):
     * e.g. "AI review" so the Console shows a friendly line instead of the raw prompt.
     */
    label: z.string().max(120).optional(),
    /**
     * Git tab (ADR-0151): when set, `command` is a `git`/`gh`/`glab` command run on the
     * worker for the Git tab. The server routes the permission to `project.git` (`read`) /
     * `project.git_write` (`write`) instead of `command.execute`, and validates `command`
     * against the git allowlist (`isGitCommandAllowed`). Absent ⇒ normal console dispatch.
     */
    gitOp: z.enum(["read", "write"]).optional(),
    /**
     * Console image attachments (ADR-0257): up to `COMMAND_IMAGE_MAX_COUNT` uploaded images the
     * prompt references by `[Image#N]` placeholders. Only meaningful with `ai:true` on a full agent
     * run (one-shot spec-assist disallows `Read`). Rejected with `IMAGE_UPLOAD_BLOCKED` when the
     * project has `outboundReview.blockImages`.
     */
    images: z.array(commandImageRefSchema).max(COMMAND_IMAGE_MAX_COUNT).optional(),
    /**
     * One-shot AI mode (ADR-0249): the prompt is a text-in → text-out task (spec review /
     * compose / suggest / generators) that must NOT trigger the AI CLI's agentic tool loop.
     * The cli caps such a run (`--max-turns 1` + disallowed agentic tools) so it can't wander
     * the repo / edit files / loop forever. Only meaningful with `ai:true`; absent ⇒ a full
     * agent run (the Console tab + Git merge, which legitimately use tools).
     */
    aiOneShot: z.boolean().optional(),
  })
  // A plain executable command stays tightly capped; only AI prompts may be large.
  .superRefine((v, ctx) => {
    // Exactly one target selector: an explicit `machineLinkId` (Console/Git) XOR `pick` (ADR-0171).
    if ((v.machineLinkId == null) === (v.pick == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["machineLinkId"],
        message: "Provide exactly one of machineLinkId or pick.",
      });
    }
    if (!v.ai && v.command.length > COMMAND_MAX_LEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: COMMAND_MAX_LEN,
        type: "string",
        inclusive: true,
        path: ["command"],
        message: `command too long (max ${COMMAND_MAX_LEN})`,
      });
    }
  });
export type DispatchCommandRequest = z.infer<typeof dispatchCommandRequestSchema>;

/** Executables allowed for a Git-tab dispatch (`gitOp` set) — ADR-0151. */
export const GIT_COMMAND_ALLOWLIST = ["git", "gh", "glab"] as const;

/**
 * Guard a Git-tab command (`gitOp` set): the first token must be `git`/`gh`/`glab` and the
 * string must not contain shell control operators that could chain/redirect another command
 * (`;` `|` `&` `$` backtick `>` `<` newline). Quotes are allowed so a commit message can carry
 * spaces. Returns true when the command is safe to dispatch as a Git op.
 */
export function isGitCommandAllowed(command: string): boolean {
  const trimmed = command.trim();
  const first = trimmed.split(/\s+/)[0] ?? "";
  if (!(GIT_COMMAND_ALLOWLIST as readonly string[]).includes(first)) return false;
  // Reject shell control/redirection/substitution operators + newlines.
  if (/[;|&$`><\n\r]/.test(trimmed)) return false;
  return true;
}

/**
 * One command-activity event on the per-cli feed (`GET /commands/activity/stream` —
 * ADR-0101): a command started/finished on `machineLinkId`, so any tab of the same org
 * can show it + stream its output. `status`: `running` | `done` | `failed`.
 */
export interface CommandActivityEvent {
  commandId: string;
  machineLinkId: string;
  projectId: string;
  /** Caller's org — used server-side to scope the feed (never cross-org). */
  orgId: string;
  /** Friendly label (dispatch `label`, or the command/prompt text when absent). */
  label: string;
  /**
   * The full command/prompt text (ADR-0108) — lets a watching Console tab render the real
   * prompt (spec-context collapsed) like the cli TUI, instead of only the short `label`.
   */
  command?: string;
  /** True when it was an AI prompt run (`ai:true`). */
  ai: boolean;
  /**
   * Where the command was initiated (ADR-0149): `local` = typed in the cli TUI, `web` =
   * dispatched from the browser/server. The Console maps it to the cli-style source tag
   * (`local` cyan / `server` magenta) so the two transcripts read the same.
   */
  origin?: "web" | "local";
  status: "running" | "done" | "failed";
  exitCode?: number | null;
  startedAt: string;
  /**
   * Display name of the user who dispatched this command (ADR-0249) — `web` dispatches carry
   * the authenticated caller so the Console header can show "last run by <name>"; absent for a
   * `local` (cli-typed) run or when the name is unknown.
   */
  initiatedByName?: string;
}

/**
 * Origin/kind of a transcript entry (ADR-0107/0108) — the cli's `SessionBus` entry shape,
 * shared so the web Console renders it verbatim (ADR-0150) instead of re-deriving it.
 */
export type TranscriptSource = "server" | "local" | "system";
export type TranscriptKind = "log" | "cmd" | "out" | "exit" | "aireq" | "aires" | "result";

/** One line/block of the cli transcript, streamed over `console.sync` / command-0007. */
export interface TranscriptEntry {
  /** Stable entry id (uuid) — the render key; a `console.sync` `update` targets it. */
  id: string;
  source: TranscriptSource;
  kind: TranscriptKind;
  /** The line/block text; for a `result` it is the FULL body (the fold opens it, no fetch). */
  text: string;
  level: "info" | "warn" | "error";
  /** For a `result` entry — whether the body is json or code (drives the marker + pretty-print). */
  resultKind?: "json" | "code";
  /**
   * Processing time in milliseconds (ADR-0249) — set on the terminal `exit` entry of a run
   * (wall-clock from its `cmd`/`aireq` echo to completion) so the Console can show how long each
   * command/AI prompt took. Absent on non-terminal entries and on entries the cli can't time.
   */
  durationMs?: number;
}

/**
 * One event on the per-cli console-sync feed (`GET /console/stream` — command-0007, ADR-0150):
 * the cli's authoritative transcript streamed so the web renders it 1:1. `rev` increases
 * monotonically; a client that sees a gap waits for the next `snapshot` rather than rendering
 * out of order. Discriminated by `kind`:
 * - `snapshot` — the full current transcript (cap 500), replayed on subscribe + re-sent by the
 *   cli on the first viewer + a low-frequency timer to self-heal any drift.
 * - `add` — one new entry was pushed.
 * - `update` — an entry's `text` grew in place (a streaming `result` block); replace by `id`.
 * - `clear` — the transcript was wiped (`/clear` or the idle auto-clear).
 */
export type ConsoleSyncEvent =
  | { kind: "snapshot"; rev: number; entries: TranscriptEntry[] }
  | { kind: "add"; rev: number; entry: TranscriptEntry }
  | { kind: "update"; rev: number; entry: TranscriptEntry }
  | { kind: "clear"; rev: number };

/**
 * Query GET /commands?projectId= — project-scoped command history (command-0005, ADR-0107):
 * `BaseRequest` (page/size) plus the required project filter.
 */
export const listCommandsQuerySchema = baseRequestSchema.extend({
  projectId: z.string().uuid(),
  // Optional search filters (command-0005): `search` (from BaseRequest) matches the command
  // text/status; `from`/`to` are an inclusive `YYYY-MM-DD` date range over `startedAt`;
  // `machineLinkId` (ADR-0249) filters to one machine-user's commands (absent ⇒ all).
  from: z.string().optional(),
  to: z.string().optional(),
  machineLinkId: z.string().uuid().optional(),
});
export type ListCommandsQuery = z.infer<typeof listCommandsQuerySchema>;

/** Data 202 of POST /commands. */
export interface CommandDispatchResponse {
  commandId: string;
  /** `queued` | `dispatched`. */
  status: string;
  /**
   * AI dispatch (`ai:true`) only — the client-side SSE re-attach/backstop timeout (ms) the web
   * should use for this command, derived from the effective AI-run timeout
   * (`max(evict×1.5, effective×profileCount×1.2)`, `0`/unlimited ⇒ 1500s — ADR-0256). Absent for a
   * non-AI dispatch; the web falls back to its default when unset.
   */
  reattachCapMs?: number;
}

/**
 * Derive the SSE reply windows for an AI dispatch from the **effective** AI-run timeout (ADR-0256):
 * the server's finished-buffer eviction and the client's re-attach/backstop cap. `effectiveSec` is
 * the project override else the machine-user value (`0`/absent = unlimited); `profileCount` is the
 * configured failover profile count (the cap-floor factor). Both returned in **ms**.
 *
 *   evict = effective × 1.5            (0/unlimited ⇒ 1000s)
 *   cap   = max(evict × 1.5, effective × profileCount × 1.2)   (0 ⇒ 1500s)
 */
export function deriveAiReplyWindows(
  effectiveSec: number,
  profileCount: number,
): { evictMs: number; reattachCapMs: number } {
  const eff = Number.isFinite(effectiveSec) && effectiveSec > 0 ? Math.floor(effectiveSec) : 0;
  const profiles = Number.isFinite(profileCount) && profileCount > 0 ? Math.floor(profileCount) : 1;
  const evictMs = eff > 0 ? eff * 1500 : 1_000_000;
  const reattachCapMs = Math.max(Math.round(evictMs * 1.5), eff * profiles * 1200);
  return { evictMs, reattachCapMs };
}

/** Data GET /commands/:id — command status/result (output via SSE). */
export interface CommandStatusResponse {
  id: string;
  /** `dispatched` | `running` | `done` | `failed`. */
  status: string;
  exitCode: number | null;
  createdAt: string;
  finishedAt: string | null;
}

/**
 * Why a command's output blob is absent (ADR-0176) — lets the web show an honest, actionable
 * message instead of always blaming retention. `store-disabled`: the org never enabled
 * command-output storage, so it was never captured (the common default); `pruned`: it was stored
 * then swept by retention; `null`: output is present (or the command is otherwise fine).
 */
export type CommandOutputUnavailableReason = "store-disabled" | "pruned" | null;

/**
 * REST response of `GET /commands/:id/output` (ADR-0115/0122/0176). Reads the stored transcript
 * blob; `output`/`input` are `null` when the org disabled command-history storage or the blob was
 * pruned/never captured. `input` is the command's stored prompt blob (ADR-0149) so the console
 * backfill can echo `❯ <prompt>` exactly like the cli TUI — same availability/gating as `output`.
 * `unavailableReason` disambiguates *why* `output` is `null` (ADR-0176).
 */
export interface CommandOutputResponse {
  output: string | null;
  input: string | null;
  unavailableReason: CommandOutputUnavailableReason;
}

/** Metadata for one 4pm-cli slash command (ADR-0249) — name · usage · description. */
export interface CliSlashCommandMeta {
  /** Command word without the leading `/` (e.g. "clear"). */
  name: string;
  /** Usage hint (e.g. "/history [N]"). */
  usage: string;
  /** One-line description. */
  description: string;
}

/**
 * The 4pm-cli slash commands (ADR-0249) — the **shared** source of truth for both the web Console
 * autocomplete and the Worker-config allow/deny group, kept here so the cli, web and config UI never
 * drift. The cli owns the actual handlers (`src/ui/slash-commands.ts`) and maps them by `name`; from
 * the web Console a `/name` line runs the matching command on the worker unless an operator blocked it
 * via `webBlockedCommands`. Keep this list in sync with the cli's command registry.
 */
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

/** The slash-command names, for building an allow/deny set (ADR-0249). */
export const CLI_SLASH_COMMAND_NAMES: string[] = CLI_SLASH_COMMANDS.map((c) => c.name);
