/**
 * Control server on a headless `4pm start` daemon (ADR-0192 §2): a per-profile unix socket that
 * lets a `4pm attach` TUI client observe + drive this worker without its own WS session. On each
 * SessionBus event it broadcasts a frame to every attached client; a client's `submit`/`reconnect`
 * frames are fed back into the bus. Best-effort — a control-channel error never takes the cli down.
 */
import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionBus } from "./session-bus";
import {
  CONTROL_SOCKET_FILE,
  createFrameParser,
  encodeFrame,
  type ControlClientFrame,
  type ControlServerFrame,
  type ControlSessionInfo,
} from "./control-protocol";

/** Start the control socket; returns a stop() that closes it + removes the socket file. */
export function startControlServer(
  bus: SessionBus,
  profileDir: string,
  info: ControlSessionInfo,
): () => void {
  const socketPath = join(profileDir, CONTROL_SOCKET_FILE);
  // Remove a stale socket from a previous (crashed) run so listen() doesn't EADDRINUSE.
  try {
    rmSync(socketPath, { force: true });
  } catch {
    /* ignore */
  }

  const clients = new Set<Socket>();
  const send = (sock: Socket, frame: ControlServerFrame): void => {
    try {
      sock.write(encodeFrame(frame));
    } catch {
      /* a dead socket is cleaned up on its 'close' */
    }
  };
  const broadcast = (frame: ControlServerFrame): void => {
    for (const sock of clients) send(sock, frame);
  };

  // Subscribe to the bus ONCE and fan out to all attached clients.
  const unsubs = [
    bus.onTranscript((entry) => broadcast({ t: "transcript", entry })),
    bus.onTranscriptUpdate((entry) =>
      broadcast({ t: "update", id: entry.id, text: entry.text, level: entry.level }),
    ),
    bus.onClear(() => broadcast({ t: "clear" })),
    bus.onStatus((status) => broadcast({ t: "status", status })),
    bus.onBusy((label) => broadcast({ t: "busy", label })),
    bus.onActiveProfile((label) => broadcast({ t: "activeProfile", label })),
    bus.onScope((scope) => broadcast({ t: "scope", scope })),
    bus.onWorker((worker) => broadcast({ t: "worker", worker })),
    bus.onProject((project) => broadcast({ t: "project", project })),
    bus.onUsage((usage) => broadcast({ t: "usage", usage })),
    bus.onTokens((total) => broadcast({ t: "tokens", total })),
  ];

  const server: Server = createServer((sock) => {
    clients.add(sock);
    // Snapshot the current state so a late attacher renders immediately (ADR-0192 §2).
    send(sock, {
      t: "snapshot",
      info,
      status: bus.status,
      busy: bus.busy,
      activeProfile: bus.activeProfile,
      scope: bus.scope,
      worker: bus.worker,
      project: bus.project,
      usage: bus.usage,
      tokens: bus.sessionTokens,
      transcript: bus.snapshot(),
    });
    const parse = createFrameParser<ControlClientFrame>();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      for (const frame of parse(chunk)) {
        if (frame.t === "submit") bus.submitLocal(frame.input);
        else if (frame.t === "reconnect") bus.requestReconnect();
      }
    });
    const drop = (): void => {
      clients.delete(sock);
    };
    sock.on("close", drop);
    sock.on("error", drop);
  });

  server.on("error", () => {
    /* listen error (e.g. perms) — the daemon still runs without an attach channel */
  });
  server.listen(socketPath);

  return () => {
    for (const un of unsubs) un();
    for (const sock of clients) sock.destroy();
    clients.clear();
    server.close();
    try {
      rmSync(socketPath, { force: true });
    } catch {
      /* ignore */
    }
  };
}
