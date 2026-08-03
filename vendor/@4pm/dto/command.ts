/**
 * DTO for the console command domain (command-0001/0002): dispatch a command to
 * a worker cli and read its status. Output streams over SSE (command.output), not
 * in these responses.
 */
import { z } from "zod";
import { baseRequestSchema } from "./base";

/** Max `command` length for an executable command vs an AI prompt (ADR-0106). */
export const COMMAND_MAX_LEN = 8_000;
export const AI_PROMPT_MAX_LEN = 200_000;

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
  // text/status; `from`/`to` are an inclusive `YYYY-MM-DD` date range over `startedAt`.
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ListCommandsQuery = z.infer<typeof listCommandsQuerySchema>;

/** Data 202 of POST /commands. */
export interface CommandDispatchResponse {
  commandId: string;
  /** `queued` | `dispatched`. */
  status: string;
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
