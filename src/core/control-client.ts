/**
 * Control client for `4pm attach` (ADR-0192 §2): connects to a daemon's per-profile unix socket,
 * mirrors its SessionBus frames into a LOCAL bus (so the existing Ink TUI renders unchanged), and
 * forwards the operator's local command submissions + reconnect requests back to the daemon.
 */
import { connect, type Socket } from "node:net";
import type { SessionBus } from "./session-bus";
import {
  createFrameParser,
  encodeFrame,
  type ControlServerFrame,
  type ControlSessionInfo,
} from "./control-protocol";

/** A live attach connection. */
export interface ControlConnection {
  /** The daemon's shared header info (from the first snapshot). */
  info: ControlSessionInfo;
  /** Close the socket + stop forwarding. */
  close: () => void;
}

/**
 * Connect and resolve once the daemon's snapshot arrives (so the caller has the header info to
 * mount the TUI). Rejects if the socket can't connect. After connect, every frame is applied to
 * `bus`; a daemon disconnect flips the bus to `stopped` and logs it.
 */
export function connectControl(socketPath: string, bus: SessionBus): Promise<ControlConnection> {
  return new Promise<ControlConnection>((resolve, reject) => {
    const socket: Socket = connect(socketPath);
    socket.setEncoding("utf8");
    let ready = false;

    const forwardSubmit = bus.onLocalSubmit((input) => {
      try {
        socket.write(encodeFrame({ t: "submit", input }));
      } catch {
        /* dropped on close */
      }
    });
    const forwardReconnect = bus.onReconnect(() => {
      try {
        socket.write(encodeFrame({ t: "reconnect" }));
      } catch {
        /* dropped on close */
      }
    });
    const close = (): void => {
      forwardSubmit();
      forwardReconnect();
      socket.destroy();
    };

    const parse = createFrameParser<ControlServerFrame>();
    socket.on("data", (chunk: string) => {
      for (const frame of parse(chunk)) apply(frame);
    });
    socket.on("error", (err) => {
      if (!ready) reject(err);
    });
    socket.on("close", () => {
      if (ready) {
        bus.setStatus("stopped");
        bus.log("Daemon disconnected — the worker process closed the control channel.", "warn");
      }
    });

    /** Apply one daemon frame to the local bus. */
    function apply(frame: ControlServerFrame): void {
      switch (frame.t) {
        case "snapshot":
          bus.setStatus(frame.status);
          bus.setBusy(frame.busy);
          bus.setActiveProfile(frame.activeProfile);
          if (frame.scope) bus.setScope(frame.scope);
          if (frame.worker) bus.setWorker(frame.worker);
          bus.setProject(frame.project);
          if (frame.usage) bus.setUsage(frame.usage);
          bus.setTokens(frame.tokens);
          for (const entry of frame.transcript) bus.pushEntry(entry);
          ready = true;
          resolve({ info: frame.info, close });
          break;
        case "transcript":
          bus.pushEntry(frame.entry);
          break;
        case "update":
          bus.updateEntry(frame.id, frame.text, frame.level);
          break;
        case "clear":
          bus.clear();
          break;
        case "status":
          bus.setStatus(frame.status);
          break;
        case "busy":
          bus.setBusy(frame.label);
          break;
        case "activeProfile":
          bus.setActiveProfile(frame.label);
          break;
        case "scope":
          bus.setScope(frame.scope);
          break;
        case "worker":
          bus.setWorker(frame.worker);
          break;
        case "project":
          bus.setProject(frame.project);
          break;
        case "usage":
          bus.setUsage(frame.usage);
          break;
        case "tokens":
          bus.setTokens(frame.total);
          break;
      }
    }
  });
}
