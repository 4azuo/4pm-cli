/**
 * Command history on the worker (per cli / MACHINE user): each executed console
 * command is appended to a local JSON file in the profile dir (status running →
 * done/failed). Every N minutes (config) the file is uploaded to object storage
 * — **Cloudflare R2** or **AWS S3** depending on `HISTORY_STORAGE` env. When no
 * provider is configured the history stays **local only** (dev/test).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One command history record. */
export interface CommandHistoryEntry {
  commandId: string;
  projectId?: string;
  cmd: string;
  args: string[];
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  status: "running" | "done" | "failed";
  /** Real token usage of an AI run (ADR-0072) — absent for non-AI commands. */
  tokens?: number;
  /** Token breakdown (input/output/cache) when the AI CLI reports it. */
  tokensBreakdown?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  /** Provider-reported cost in USD (claude `total_cost_usd`), when available. */
  costUsd?: number;
}

/** Token usage attached to a finished AI command. */
export interface CommandUsage {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd?: number;
}

/** Resolved object-storage target (R2 or S3). */
interface StorageConfig {
  /** S3 endpoint (R2) or undefined for native AWS S3. */
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
}

const MAX_ENTRIES = 1000;

let filePath: string | null = null;
let entries: CommandHistoryEntry[] = [];
let uploadTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Resolve the storage config from env. `HISTORY_STORAGE=r2|s3`; null (local only)
 * when unset or the required creds are missing.
 * - r2: R2_ACCOUNT_ID · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY · R2_BUCKET
 * - s3: AWS_REGION · AWS_ACCESS_KEY_ID · AWS_SECRET_ACCESS_KEY · S3_BUCKET
 */
function storageConfig(profileName: string): StorageConfig | null {
  const key = `command-history/${profileName}.json`;
  const provider = (process.env.HISTORY_STORAGE ?? "").toLowerCase();
  if (provider === "r2") {
    const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
    return {
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      region: "auto",
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      bucket: R2_BUCKET,
      key,
    };
  }
  if (provider === "s3") {
    const { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET } = process.env;
    if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET) return null;
    return {
      region: AWS_REGION,
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      bucket: S3_BUCKET,
      key,
    };
  }
  return null;
}

/** Persist the in-memory list to the local JSON file (capped to MAX_ENTRIES). */
function persist(): void {
  if (!filePath) return;
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  try {
    writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf8");
  } catch {
    // Best-effort — history must never break command execution.
  }
}

/** Upload the current history to object storage (best-effort; aws-sdk lazy). */
async function uploadHistory(cfg: StorageConfig): Promise<void> {
  try {
    const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: cfg.key,
        Body: JSON.stringify(entries),
        ContentType: "application/json",
      }),
    );
  } catch (err) {
    console.warn(`Command history upload failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Load the history file + start the periodic R2 uploader (if configured). */
export function initCommandHistory(
  profileDir: string,
  profileName: string,
  uploadMinutes = 10,
): void {
  filePath = join(profileDir, "command-history.json");
  if (existsSync(filePath)) {
    try {
      entries = JSON.parse(readFileSync(filePath, "utf8")) as CommandHistoryEntry[];
    } catch {
      entries = [];
    }
  }
  const cfg = storageConfig(profileName);
  if (!cfg) {
    console.log("Command history: no storage provider (HISTORY_STORAGE) — stored locally only.");
    return;
  }
  const intervalMs = Math.max(1, uploadMinutes) * 60_000;
  uploadTimer = setInterval(() => void uploadHistory(cfg), intervalMs);
  uploadTimer.unref();
}

/** Record a newly dispatched command (status = running). */
export function recordCommand(
  entry: Pick<CommandHistoryEntry, "commandId" | "projectId" | "cmd" | "args">,
): void {
  entries.push({
    ...entry,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    status: "running",
  });
  persist();
}

/** Snapshot of the current command history (persistent + live) — oldest → newest. */
export function getCommandHistory(): CommandHistoryEntry[] {
  return entries;
}

/** Drop history entries older than `days` (ADR-0115); `days<=0` keeps the count-based cap. */
export function pruneCommandHistoryByAge(days: number): void {
  if (days <= 0) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const before = entries.length;
  entries = entries.filter((e) => new Date(e.startedAt).getTime() >= cutoff);
  if (entries.length !== before) persist();
}

/** Mark a command finished with its exit code. */
export function finishCommand(commandId: string, exitCode: number, usage?: CommandUsage): void {
  const entry = entries.find((e) => e.commandId === commandId && e.status === "running");
  if (!entry) return;
  entry.status = exitCode === 0 ? "done" : "failed";
  entry.exitCode = exitCode;
  entry.finishedAt = new Date().toISOString();
  if (usage && usage.tokens > 0) {
    entry.tokens = usage.tokens;
    entry.tokensBreakdown = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheCreation: usage.cacheCreation,
    };
    if (usage.costUsd !== undefined) entry.costUsd = usage.costUsd;
  }
  persist();
}
