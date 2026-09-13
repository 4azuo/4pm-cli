/**
 * Small stateless helpers shared by the WsClient and its console-sync path: mapping a SessionBus
 * transcript entry to the console-sync wire shape, and resolving the reconnect-backoff cap env
 * override. Kept out of the main file so it stays focused on the session lifecycle.
 */
import { CLI_SETTINGS_BOUNDS, type TranscriptEntry as DtoTranscriptEntry } from "@4pm/dto";
import type { TranscriptEntry as BusTranscriptEntry } from "../session-bus";

/** Map a SessionBus transcript entry to the console-sync wire shape (drops the cli-only `ts`). */
export function toDtoEntry(e: BusTranscriptEntry): DtoTranscriptEntry {
  return {
    id: e.id,
    source: e.source,
    kind: e.kind,
    text: e.text,
    level: e.level,
    resultKind: e.resultKind,
    // Processing time on a terminal `exit` entry (ADR-0249) — the web renders it inline.
    ...(e.durationMs != null ? { durationMs: e.durationMs } : {}),
    // AI-run metadata on an `aireq` marker — powers the web's clickable CLI name → details modal.
    ...(e.aiMeta ? { aiMeta: e.aiMeta } : {}),
  };
}

/**
 * Read the env override for the reconnect cap (`FOURPM_RECONNECT_MAX_BACKOFF_SEC`),
 * clamped to the 1-min ceiling; null when unset/invalid. The org value (delivered via
 * the ws_token) takes precedence over this — env only applies before the first connect.
 */
export function envReconnectMaxSec(): number | null {
  const raw = Number(process.env.FOURPM_RECONNECT_MAX_BACKOFF_SEC);
  if (!Number.isFinite(raw)) return null;
  const { min, max } = CLI_SETTINGS_BOUNDS.reconnectMaxBackoffSec;
  return Math.min(Math.max(Math.floor(raw), min), max);
}
