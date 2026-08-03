/**
 * Local control-channel protocol between a headless `4pm start` daemon and a `4pm attach` TUI
 * client (ADR-0192 §2). JSONL frames over a per-profile unix socket: the daemon broadcasts its
 * SessionBus events (so the attach TUI renders the same transcript/header), and the client sends
 * back local command submissions + reconnect requests. Pure types — no I/O.
 */
import type { MachineUsagePayload } from "@4pm/ws";
import type { SessionStatus, TranscriptEntry } from "./session-bus";

/** The unix socket a daemon listens on, under its profile dir. */
export const CONTROL_SOCKET_FILE = "control.sock";

/** Serializable header info a daemon shares on attach (subset of the TUI's SessionInfo). */
export interface ControlSessionInfo {
  version: string;
  scope: string;
  profile: string;
  serverUrl: string;
  physicPath: string | null;
  aiCli: string;
}

/** daemon → client frames. */
export type ControlServerFrame =
  | {
      t: "snapshot";
      info: ControlSessionInfo;
      status: SessionStatus;
      busy: string | null;
      activeProfile: string | null;
      scope: string | null;
      worker: string | null;
      project: string | null;
      usage: MachineUsagePayload | null;
      tokens: number;
      transcript: TranscriptEntry[];
    }
  | { t: "transcript"; entry: TranscriptEntry }
  | { t: "update"; id: string; text: string; level?: "info" | "warn" | "error" }
  | { t: "clear" }
  | { t: "status"; status: SessionStatus }
  | { t: "busy"; label: string | null }
  | { t: "activeProfile"; label: string | null }
  | { t: "scope"; scope: string }
  | { t: "worker"; worker: string }
  | { t: "project"; project: string | null }
  | { t: "usage"; usage: MachineUsagePayload }
  | { t: "tokens"; total: number };

/** client → daemon frames. */
export type ControlClientFrame =
  | { t: "submit"; input: string }
  | { t: "reconnect" };

/** Encode one frame as a JSONL line. */
export function encodeFrame(frame: ControlServerFrame | ControlClientFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Stateful line splitter for a JSONL socket stream: feed chunks, get back the complete frames
 * parsed so far (partial trailing line kept for the next chunk).
 */
export function createFrameParser<T>(): (chunk: string) => T[] {
  let buffer = "";
  return (chunk: string): T[] => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    const out: T[] = [];
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s) as T);
      } catch {
        // Skip a corrupt line — the stream self-heals on the next complete frame.
      }
    }
    return out;
  };
}
