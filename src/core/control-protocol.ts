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

/**
 * The control-channel token file, under the profile dir (ADR-0320 hardening). The daemon writes a
 * fresh random secret here (mode 0600) at startup; a client must present it as its first frame
 * (`{ t: "auth" }`) before the daemon accepts any other frame. This is defense-in-depth on top of the
 * OS boundary (a same-OS-user client can still read this 0600 file — the real isolation is the OS user
 * + the container); it blocks other users and stray/non-4pm local connections.
 */
export const CONTROL_TOKEN_FILE = "control.token";

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
  | { t: "tokens"; total: number }
  // The autonomous cycle triggered over this socket (ADR-0319) settled — `ok` false carries a `note`.
  | { t: "autonomousDone"; ok: boolean; note?: string }
  // The client's `auth` frame was missing/wrong — the daemon rejects the connection (ADR-0320).
  | { t: "authError" };

/** client → daemon frames. */
export type ControlClientFrame =
  // MUST be the first frame on a connection (ADR-0320): the control-channel token; the daemon accepts
  // no other frame until it matches.
  | { t: "auth"; token: string }
  | { t: "submit"; input: string }
  | { t: "reconnect" }
  // `4pm auto-run` asks the daemon to run ONE autonomous cycle through its live session (ADR-0319).
  | { t: "autonomousRun" };

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
