/**
 * SessionBus — the framework-agnostic bridge between the WS session (producer of
 * lifecycle logs + command I/O) and the presentation layer (ADR-0057): the Ink TUI
 * on a TTY, or the plain console sink when headless. It also carries the reverse
 * direction — a local command the operator submits in the TUI input box.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { MachineUsagePayload } from "@4pm/ws";

/** Connection status shown in the banner + used to gate the input box. */
export type SessionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped";

/** Origin/kind of a transcript entry (drives its label + styling). */
export type TranscriptSource = "server" | "local" | "system";
// `aireq`/`aires` mark an AI prompt sent to / response coming back from the AI CLI —
// rendered as "<cmd> ‹ …" / "<cmd> › …" with the CLI name colored (transcript.tsx).
// `result` is a whole AI-result block detected as json/code and auto-collapsed (ADR-0108).
export type TranscriptKind = "log" | "cmd" | "out" | "exit" | "aireq" | "aires" | "result";

/** One line/block in the scrollable transcript. */
export interface TranscriptEntry {
  id: string;
  source: TranscriptSource;
  kind: TranscriptKind;
  text: string;
  level: "info" | "warn" | "error";
  ts: number;
  /** For a `result` entry — whether the body is json or code (drives the marker + pretty-print). */
  resultKind?: "json" | "code";
}

/** Fields a producer supplies; id/ts/level default when omitted. */
export interface TranscriptInput {
  source: TranscriptSource;
  kind: TranscriptKind;
  text: string;
  level?: "info" | "warn" | "error";
  resultKind?: "json" | "code";
}

/**
 * A tiny typed pub/sub over node's EventEmitter. Every `on*` returns an
 * unsubscribe function (convenient for React effect cleanup).
 */
/** Max transcript entries replayed to a late subscriber (bounds memory). */
const REPLAY_CAP = 500;

export class SessionBus {
  private readonly emitter = new EventEmitter();
  private currentStatus: SessionStatus = "connecting";
  /** Recent entries replayed when a consumer subscribes after they were emitted. */
  private readonly history: TranscriptEntry[] = [];
  /** Labels of in-flight commands (tool names) — top = the one shown as "processing". */
  private readonly busyStack: string[] = [];
  /** The AI-CLI profile that last authenticated (shown in the header). */
  private currentActiveProfile: string | null = null;
  /** Link scope learned from the server at connect time (heals the header/.cre). */
  private currentScope: string | null = null;
  /** Worker (physical machine) name learned from the server at connect time. */
  private currentWorker: string | null = null;
  /** Logical project name (project scope) learned from the server at connect time. */
  private currentProject: string | null = null;
  /** Latest Claude subscription usage snapshot (5h/weekly — ADR-0072), for the header. */
  private currentUsage: MachineUsagePayload | null = null;
  /** Tokens consumed this session (sum of AI runs), for the header. */
  private currentSessionTokens = 0;

  constructor() {
    // Producers/consumers may attach many listeners (banner, transcript, sink…).
    this.emitter.setMaxListeners(50);
  }

  /** Latest known status (for a late subscriber to read immediately). */
  get status(): SessionStatus {
    return this.currentStatus;
  }

  /** Producer → consumers: push one transcript entry. Returns its id (for `updateEntry`). */
  push(input: TranscriptInput): string {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      level: "info",
      ...input,
      ts: Date.now(),
    };
    this.history.push(entry);
    if (this.history.length > REPLAY_CAP) this.history.shift();
    this.emitter.emit("transcript", entry);
    return entry.id;
  }

  /**
   * Wipe the transcript (`/clear` + idle auto-clear — ADR-0057): empty the replay history and
   * notify consumers so the TUI clears the screen and the console-sync emitter (ADR-0150) sends
   * a `clear` event. The current snapshot afterwards is empty (until new lines arrive).
   */
  clear(): void {
    this.history.length = 0;
    this.emitter.emit("clear");
  }

  /** Subscribe to transcript clears (TUI screen wipe + console.sync `clear` — ADR-0150). */
  onClear(fn: () => void): () => void {
    this.emitter.on("clear", fn);
    return () => this.emitter.off("clear", fn);
  }

  /** The current transcript entries (a copy) — the console-sync snapshot source (ADR-0150). */
  snapshot(): TranscriptEntry[] {
    return [...this.history];
  }

  /**
   * Producer → consumers: replace the text (and optionally the level) of an already-pushed entry
   * (ADR-0108) — used to grow a streaming `result` block in place, or to update a single reconnect
   * status line without pushing a new line per attempt. No-op if the entry has aged out.
   */
  updateEntry(id: string, text: string, level?: "info" | "warn" | "error"): void {
    const entry = this.history.find((e) => e.id === id);
    if (!entry) return;
    entry.text = text;
    if (level) entry.level = level;
    this.emitter.emit("transcript-update", entry);
  }

  /** Subscribe to in-place entry updates (a `result` block growing — ADR-0108). */
  onTranscriptUpdate(fn: (entry: TranscriptEntry) => void): () => void {
    this.emitter.on("transcript-update", fn);
    return () => this.emitter.off("transcript-update", fn);
  }

  /** Shortcut for a lifecycle log line (source = system). */
  log(text: string, level: "info" | "warn" | "error" = "info"): void {
    this.push({ source: "system", kind: "log", text, level });
  }

  /**
   * Insert a fully-formed transcript entry (preserving its id/ts) — used by the attach client
   * (ADR-0192 §2) to mirror a daemon's transcript over the control channel so `updateEntry` can
   * still target the same id. `push` is for producers minting a new entry; this is for replay.
   */
  pushEntry(entry: TranscriptEntry): void {
    this.history.push(entry);
    if (this.history.length > REPLAY_CAP) this.history.shift();
    this.emitter.emit("transcript", entry);
  }

  /** Producer → consumers: update the connection status. */
  setStatus(status: SessionStatus): void {
    this.currentStatus = status;
    this.emitter.emit("status", status);
  }

  /** UI → session: the operator submitted a local command line. */
  submitLocal(input: string): void {
    this.emitter.emit("local-submit", input);
  }

  /** Current processing label (tool name) or null when idle. */
  get busy(): string | null {
    return this.busyStack[this.busyStack.length - 1] ?? null;
  }

  /** Mark a tool as processing (shown above the input box). */
  startBusy(label: string): void {
    this.busyStack.push(label);
    this.emitter.emit("busy", this.busy);
  }

  /** Clear one in-flight tool (matching label, else the most recent). */
  endBusy(label: string): void {
    const idx = this.busyStack.lastIndexOf(label);
    if (idx >= 0) this.busyStack.splice(idx, 1);
    else this.busyStack.pop();
    this.emitter.emit("busy", this.busy);
  }

  /**
   * Mirror the current busy label directly (attach client — ADR-0192 §2): replaces the stack with
   * `[label]` (or empties it) and notifies. For a real session use `startBusy`/`endBusy` instead.
   */
  setBusy(label: string | null): void {
    this.busyStack.length = 0;
    if (label) this.busyStack.push(label);
    this.emitter.emit("busy", this.busy);
  }

  /** Subscribe to processing-state changes. */
  onBusy(fn: (label: string | null) => void): () => void {
    this.emitter.on("busy", fn);
    return () => this.emitter.off("busy", fn);
  }

  /** The AI-CLI profile currently in use (last authenticated), or null. */
  get activeProfile(): string | null {
    return this.currentActiveProfile;
  }

  /** Set the active AI-CLI profile (shown in the header). */
  setActiveProfile(label: string | null): void {
    this.currentActiveProfile = label;
    this.emitter.emit("active-profile", label);
  }

  /** Subscribe to active-profile changes. */
  onActiveProfile(fn: (label: string | null) => void): () => void {
    this.emitter.on("active-profile", fn);
    return () => this.emitter.off("active-profile", fn);
  }

  /** The link scope learned from the server, or null (fall back to the `.cre` value). */
  get scope(): string | null {
    return this.currentScope;
  }

  /** Set the link scope (learned at connect — heals the header). */
  setScope(scope: string): void {
    this.currentScope = scope;
    this.emitter.emit("scope", scope);
  }

  /** Subscribe to scope changes. */
  onScope(fn: (scope: string) => void): () => void {
    this.emitter.on("scope", fn);
    return () => this.emitter.off("scope", fn);
  }

  /** The worker (physical machine) name learned from the server at connect, or null. */
  get worker(): string | null {
    return this.currentWorker;
  }

  /** Set the worker name (learned from the hello_ack — heals the header). */
  setWorker(worker: string): void {
    this.currentWorker = worker;
    this.emitter.emit("worker", worker);
  }

  /** Subscribe to worker-name changes. */
  onWorker(fn: (worker: string) => void): () => void {
    this.emitter.on("worker", fn);
    return () => this.emitter.off("worker", fn);
  }

  /** The logical project name learned from the server at connect, or null. */
  get project(): string | null {
    return this.currentProject;
  }

  /**
   * Set the logical project name (learned from the hello_ack — heals the header),
   * or null to clear it when the cli goes idle (project detached/deleted — ADR-0068).
   */
  setProject(project: string | null): void {
    this.currentProject = project;
    this.emitter.emit("project", project);
  }

  /** Latest subscription usage snapshot, or null. */
  get usage(): MachineUsagePayload | null {
    return this.currentUsage;
  }

  /** Set the subscription usage snapshot (from the usage poll — ADR-0072). */
  setUsage(snapshot: MachineUsagePayload): void {
    this.currentUsage = snapshot;
    this.emitter.emit("usage", snapshot);
  }

  /** Subscribe to usage-snapshot changes. */
  onUsage(fn: (snapshot: MachineUsagePayload) => void): () => void {
    this.emitter.on("usage", fn);
    return () => this.emitter.off("usage", fn);
  }

  /** Tokens consumed this session. */
  get sessionTokens(): number {
    return this.currentSessionTokens;
  }

  /** Add to the session token counter (after an AI run — ADR-0072). */
  addTokens(n: number): void {
    this.currentSessionTokens += n;
    this.emitter.emit("tokens", this.currentSessionTokens);
  }

  /** Set the session token total directly (attach client mirror — ADR-0192 §2). */
  setTokens(total: number): void {
    this.currentSessionTokens = total;
    this.emitter.emit("tokens", this.currentSessionTokens);
  }

  /** Subscribe to session-token changes. */
  onTokens(fn: (total: number) => void): () => void {
    this.emitter.on("tokens", fn);
    return () => this.emitter.off("tokens", fn);
  }

  /** Subscribe to project-name changes. */
  onProject(fn: (project: string | null) => void): () => void {
    this.emitter.on("project", fn);
    return () => this.emitter.off("project", fn);
  }

  /**
   * Subscribe to transcript entries. Any entries emitted before this subscription
   * are replayed first (so a consumer that mounts a tick late — e.g. React effects —
   * does not miss the opening lifecycle lines).
   */
  onTranscript(fn: (entry: TranscriptEntry) => void): () => void {
    for (const entry of this.history) fn(entry);
    this.emitter.on("transcript", fn);
    return () => this.emitter.off("transcript", fn);
  }

  /** Subscribe to status changes. */
  onStatus(fn: (status: SessionStatus) => void): () => void {
    this.emitter.on("status", fn);
    return () => this.emitter.off("status", fn);
  }

  /** Subscribe to local command submissions. */
  onLocalSubmit(fn: (input: string) => void): () => void {
    this.emitter.on("local-submit", fn);
    return () => this.emitter.off("local-submit", fn);
  }

  /** UI → session: force an immediate reconnect (for /reconnect). */
  requestReconnect(): void {
    this.emitter.emit("reconnect");
  }

  /** Subscribe to reconnect requests. */
  onReconnect(fn: () => void): () => void {
    this.emitter.on("reconnect", fn);
    return () => this.emitter.off("reconnect", fn);
  }
}
