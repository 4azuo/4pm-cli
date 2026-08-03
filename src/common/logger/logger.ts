/**
 * CliLogger — structured JSONL logging per profile (ADR-0054), mirroring the server's
 * FileLoggerService (ADR-0004): writes ~/.4pm/profiles/<name>/logs/cli-YYYY-MM-DD.jsonl,
 * level-filtered, daily-rolled with retention. Appends are serialized so lines don't
 * interleave; file errors are swallowed (warn to console) so logging never breaks the
 * cli. NEVER pass secrets (ws_token/hashcode/keys) as fields.
 */
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Supported log levels (same order as the server). */
export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 14;

/** Base context stamped on every line — identifies the emitting instance. */
export interface LoggerContext {
  version: string;
  profile: string;
  scope?: string;
}

/** Options passed to configure() once at startup. */
export interface LoggerOptions {
  dir: string;
  level: LogLevel;
  base: LoggerContext;
  retentionDays?: number;
}

/**
 * Process-wide structured logger. Before configure() every call is a no-op, so
 * modules can import and log freely; startup wires the profile dir + level + context.
 */
class CliLogger {
  private dir: string | null = null;
  private minLevel: LogLevel = "info";
  private base: LoggerContext | null = null;
  private retentionDays = DEFAULT_RETENTION_DAYS;
  private queue: Promise<void> = Promise.resolve();

  /** Wire the profile log dir + level + base context; runs a retention sweep. */
  configure(opts: LoggerOptions): void {
    this.dir = opts.dir;
    this.minLevel = opts.level;
    this.base = opts.base;
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    void this.cleanupOldLogs();
  }

  /** Update the retention window at runtime + prune now (ADR-0115). `days<=0` keeps current. */
  setRetentionDays(days: number): void {
    if (days > 0) {
      this.retentionDays = days;
      void this.cleanupOldLogs();
    }
  }

  /** Log an error-level event. */
  error(event: string, fields?: Record<string, unknown>): void {
    this.write("error", event, fields);
  }

  /** Log a warn-level event. */
  warn(event: string, fields?: Record<string, unknown>): void {
    this.write("warn", event, fields);
  }

  /** Log an info-level event. */
  info(event: string, fields?: Record<string, unknown>): void {
    this.write("info", event, fields);
  }

  /** Log a debug-level event. */
  debug(event: string, fields?: Record<string, unknown>): void {
    this.write("debug", event, fields);
  }

  /** Serialize one JSONL line into today's file (no-op until configured / below level). */
  private write(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    const dir = this.dir;
    if (!dir || !this.base) return;
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.minLevel]) return;
    const timestamp = new Date().toISOString();
    const entry = { timestamp, level, ...this.base, event, ...fields };
    const line = JSON.stringify(entry) + "\n";
    const path = join(dir, `cli-${timestamp.slice(0, 10)}.jsonl`);
    this.queue = this.queue
      .then(() => mkdir(dir, { recursive: true }))
      .then(() => appendFile(path, line, "utf8"))
      .catch((err) => {
        console.warn(`Failed to write cli log: ${err}`);
      });
  }

  /** Delete cli log files older than the retention window (best-effort). */
  private async cleanupOldLogs(): Promise<void> {
    const dir = this.dir;
    if (!dir) return;
    const files = await readdir(dir).catch(() => [] as string[]);
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    for (const file of files) {
      const match = /^cli-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
      if (!match) continue;
      if (new Date(`${match[1]}T00:00:00Z`).getTime() < cutoff) {
        await unlink(join(dir, file)).catch(() => undefined);
      }
    }
  }
}

/** Process-wide cli logger — call configure() once at startup (ADR-0054). */
export const logger = new CliLogger();

/**
 * Read the last `limit` JSONL lines from the newest cli-*.jsonl in a logs dir (for the
 * `/logs` command). Newest file, tail of lines. [] on any error.
 */
export function readRecentLogLines(dir: string, limit: number): string[] {
  try {
    const files = readdirSync(dir)
      .filter((f) => /^cli-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
    const latest = files[files.length - 1];
    if (!latest) return [];
    const lines = readFileSync(join(dir, latest), "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit);
  } catch {
    return [];
  }
}

/** A snapshot of the cli's logs for server upload (ADR-0122). */
export interface LogUpload {
  fileName: string;
  content: string;
  totalBytes: number;
}

/** Cap the uploaded content (tail) well under the server's 1 MiB WS frame limit (ADR-0122). */
const LOG_UPLOAD_CONTENT_MAX = 512 * 1024;

/**
 * Read the newest cli-*.jsonl file (tail, capped for the WS frame) plus the total byte size of
 * ALL cli log files under `dir` (ADR-0122) — for the periodic upload to the server that keeps the
 * machine user's `log` storage footprint. `totalBytes` is always the true full footprint even
 * when the stored `content` is truncated. Returns null when there is no log file / on any error.
 */
export function readLogUpload(dir: string): LogUpload | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => /^cli-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
    const latest = files[files.length - 1];
    if (!latest) return null;
    let totalBytes = 0;
    for (const f of files) totalBytes += statSync(join(dir, f)).size;
    let content = readFileSync(join(dir, latest), "utf8");
    if (content.length > LOG_UPLOAD_CONTENT_MAX) {
      content = `…[truncated]\n${content.slice(-LOG_UPLOAD_CONTENT_MAX)}`;
    }
    return { fileName: latest, content, totalBytes };
  } catch {
    return null;
  }
}
