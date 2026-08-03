/**
 * App — the root Ink component of the `4pm start` TUI (ADR-0057). A full-window layout
 * redrawn in place (no <Static>, so no terminal scrollbar accumulates): the **header**
 * (top) carries the live connection status · AI CLI · active profile; the **body** is a
 * fixed-height transcript viewport (follows the tail; PageUp/PageDown to scroll back);
 * the command block is pinned to the bottom; the **footer** is only the hint. Subscribes
 * to the SessionBus and forwards the operator's input.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { SessionBus, SessionStatus, TranscriptEntry } from "../core/session-bus";
import { appendInputHistory, loadInputHistory } from "../core/input-history";
import { readProfileConfig } from "../config/profile";
import type { SessionInfo } from "./session-info";
import { Banner } from "./banner";
import { flattenEntries, TranscriptLine } from "./transcript";
import { CommandInput, Hint } from "./command-input";
import { Spinner } from "./spinner";
import { runSlashCommand } from "./slash-commands";

/** Rows the fixed chrome takes (header + 3 rules + processing + suggestion + input + hint). */
const CHROME_ROWS = 12;
/** Cap entries kept in memory. */
const ENTRY_CAP = 3000;
/**
 * Coalesce streaming `result`-block updates to ~15fps (ADR-0177). A chatty AI run emits many
 * chunks/sec; re-rendering per chunk — with a full-height Ink frame — repaints the whole screen
 * each time. Batching to one re-render per ~66ms removes the flicker at no readable cost.
 */
const UPDATE_FLUSH_MS = 66;

/** A full-width `───` rule. */
function Rule({ width }: { width: number }): React.ReactElement {
  return <Text dimColor>{"─".repeat(Math.max(10, width))}</Text>;
}

/** Track the terminal size, updating on resize. */
function useTerminalSize(): { rows: number; cols: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ rows: stdout.rows || 24, cols: stdout.columns || 80 });
  useEffect(() => {
    const onResize = (): void => setSize({ rows: stdout.rows || 24, cols: stdout.columns || 80 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

/** The TUI root. */
export function App({
  bus,
  info,
}: {
  bus: SessionBus;
  info: SessionInfo;
}): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { rows, cols } = useTerminalSize();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [status, setStatus] = useState<SessionStatus>(bus.status);
  const [busy, setBusy] = useState<string | null>(bus.busy);
  const [activeProfile, setActiveProfile] = useState<string | null>(bus.activeProfile);
  const [scope, setScope] = useState<string>(bus.scope ?? info.scope);
  const [worker, setWorker] = useState<string | null>(bus.worker);
  const [project, setProject] = useState<string | null>(bus.project);
  const [usage, setUsage] = useState(bus.usage);
  const [sessionTokens, setSessionTokens] = useState(bus.sessionTokens);
  const [scrollBack, setScrollBack] = useState(0);
  // Fold numbers currently expanded (ADR-0108). Reset whenever a new AI request/response
  // arrives so the viewport re-folds — set below in the transcript subscription.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [history, setHistory] = useState<string[]>(() => loadInputHistory(info.profileDir));
  const [startedAt] = useState(() => Date.now());
  // A pending y/N confirmation (ADR-0057 `/config init` replace): the next input line is
  // captured as the answer instead of being routed as a command/prompt.
  const [pendingConfirm, setPendingConfirm] = useState<{ prompt: string; onYes: () => void } | null>(null);

  // Idle transcript auto-clear (memo): after this many ms with no local (operator) input,
  // wipe the on-screen buffer to keep an idle session bounded. 0 = disabled (config-driven).
  const [autoClearIdleMs] = useState(() => {
    const min = readProfileConfig(info.profileDir).autoClearIdleMinutes ?? 10;
    return min > 0 ? min * 60_000 : 0;
  });
  // Timestamp of the last activity (local operator input OR a server-dispatched line);
  // drives the idle check. Only `system` lifecycle lines don't count. Seeded to session start.
  const lastActivityRef = useRef(startedAt);
  // Latest values mirrored for the idle timer's stable-closure callback.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const entriesLenRef = useRef(entries.length);
  entriesLenRef.current = entries.length;
  const pendingConfirmRef = useRef(pendingConfirm);
  pendingConfirmRef.current = pendingConfirm;
  // Coalesced streaming updates: latest text per entry id, flushed on a ~15fps timer (ADR-0177).
  const pendingUpdatesRef = useRef(new Map<string, string>());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Apply all buffered streaming updates in one re-render, then arm for the next batch. */
  const flushUpdates = useCallback((): void => {
    flushTimerRef.current = null;
    const pending = pendingUpdatesRef.current;
    if (pending.size === 0) return;
    const snapshot = new Map(pending);
    pending.clear();
    setEntries((prev) => prev.map((e) => (snapshot.has(e.id) ? { ...e, text: snapshot.get(e.id)! } : e)));
  }, []);

  /** Wipe the on-screen transcript + terminal scrollback (shared by /clear and idle auto-clear). */
  const clearTranscript = useCallback((): void => {
    setEntries([]);
    setScrollBack(0);
    stdout.write("\x1b[2J\x1b[3J\x1b[H");
    // Also wipe the SessionBus history + notify the console-sync emitter so the web Console
    // clears in step with the cli (ADR-0150); its next snapshot then reflects the empty buffer.
    bus.clear();
  }, [stdout, bus]);

  useEffect(() => {
    const offTranscript = bus.onTranscript((entry) => {
      setEntries((prev) =>
        prev.length >= ENTRY_CAP ? [...prev.slice(prev.length - ENTRY_CAP + 1), entry] : [...prev, entry],
      );
      // Any local or server line counts as activity ⇒ resets the idle auto-clear window;
      // only `system` lifecycle lines (incl. the auto-clear notice itself) don't count.
      if (entry.source !== "system") lastActivityRef.current = Date.now();
      // New AI request/response ⇒ collapse any expanded fold (keep the viewport gentle).
      if (entry.kind === "aireq" || entry.kind === "aires") setExpanded(new Set());
    });
    // A streaming `result` block grows in place — buffer the latest text per id and flush on a
    // ~15fps timer (ADR-0177) instead of re-rendering the full-height frame on every chunk.
    const offUpdate = bus.onTranscriptUpdate((updated) => {
      pendingUpdatesRef.current.set(updated.id, updated.text);
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(flushUpdates, UPDATE_FLUSH_MS);
      }
    });
    const offStatus = bus.onStatus(setStatus);
    const offBusy = bus.onBusy(setBusy);
    const offProfile = bus.onActiveProfile(setActiveProfile);
    const offScope = bus.onScope(setScope);
    const offWorker = bus.onWorker(setWorker);
    const offProject = bus.onProject(setProject);
    const offUsage = bus.onUsage(setUsage);
    const offTokens = bus.onTokens(setSessionTokens);
    return () => {
      offTranscript();
      offUpdate();
      offStatus();
      offBusy();
      offProfile();
      offScope();
      offWorker();
      offProject();
      offUsage();
      offTokens();
      // Flush any buffered streaming update so the final chunk isn't dropped on teardown.
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flushUpdates();
    };
  }, [bus, flushUpdates]);

  // Idle transcript auto-clear (memo): every minute, if there has been no activity (local
  // operator input OR a server-dispatched line) for `autoClearIdleMs`, wipe the transcript.
  // Never clears while a response is streaming (`busy`), during a y/N confirm, or when there
  // is nothing to clear.
  useEffect(() => {
    if (autoClearIdleMs <= 0) return;
    const timer = setInterval(() => {
      if (busyRef.current !== null || pendingConfirmRef.current || entriesLenRef.current === 0) return;
      if (Date.now() - lastActivityRef.current < autoClearIdleMs) return;
      clearTranscript();
      bus.push({
        source: "system",
        kind: "log",
        text: `Transcript auto-cleared after ${Math.round(autoClearIdleMs / 60_000)} min idle.`,
      });
      lastActivityRef.current = Date.now();
    }, 60_000);
    return () => clearInterval(timer);
  }, [autoClearIdleMs, bus, clearTranscript]);

  // Keep the whole frame strictly SHORTER than the terminal (reserve one row): when an Ink frame
  // fills the terminal height it repaints via a full clear each render (flicker); one row of
  // headroom keeps Ink on its in-place differential renderer (ADR-0177).
  const frameRows = Math.max(4, rows - 1);
  const bodyHeight = Math.max(3, frameRows - CHROME_ROWS);
  // Text column = viewport width minus the source-tag gutter (Box width 7 + marginRight 1).
  const textWidth = Math.max(10, cols - 1 - 8);
  const lines = useMemo(() => flattenEntries(entries, textWidth, expanded), [entries, textWidth, expanded]);
  // Highest fold number on screen — `/expand`/`/collapse` with no arg target it (ADR-0108).
  const maxBlock = useMemo(() => lines.reduce((m, l) => Math.max(m, l.blockIndex ?? 0), 0), [lines]);

  /** Toggle a fold's expansion (ADR-0108); `n` defaults to the newest fold. */
  const expandFold = (n?: number): void => {
    const target = n ?? maxBlock;
    if (target < 1 || target > maxBlock) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  };

  /** Collapse a fold (ADR-0108); `n` defaults to the newest fold. */
  const collapseFold = (n?: number): void => {
    const target = n ?? maxBlock;
    setExpanded((prev) => {
      if (!prev.has(target)) return prev;
      const next = new Set(prev);
      next.delete(target);
      return next;
    });
  };

  // A `/…` line is a local slash command (handled here); anything else is a prompt for
  // the AI CLI (routed through the bus). Every submit is saved to the input history.
  const handleSubmit = (input: string): void => {
    setScrollBack(0);
    // Any operator submit (command, prompt, or confirm answer) counts as activity —
    // it resets the idle auto-clear window.
    lastActivityRef.current = Date.now();
    const trimmed = input.trim();
    // A pending confirmation captures this line as its y/N answer (not saved to history,
    // not routed as a command/prompt).
    if (pendingConfirm) {
      const { onYes } = pendingConfirm;
      setPendingConfirm(null);
      bus.push({ source: "local", kind: "cmd", text: trimmed });
      if (/^y(es)?$/i.test(trimmed)) onYes();
      else bus.push({ source: "local", kind: "log", text: "cancelled." });
      return;
    }
    setHistory((prev) => appendInputHistory(info.profileDir, input, prev));
    if (trimmed.startsWith("/")) {
      bus.push({ source: "local", kind: "cmd", text: trimmed });
      runSlashCommand(trimmed, {
        info,
        print: (text, level) => bus.push({ source: "local", kind: "log", text, level }),
        clear: clearTranscript,
        quit: () => exit(),
        confirm: (prompt, onYes) => {
          bus.push({ source: "local", kind: "log", text: prompt });
          setPendingConfirm({ prompt, onYes });
        },
        submitAi: (aiInput) => bus.submitLocal(aiInput),
        reconnect: () => bus.requestReconnect(),
        expand: expandFold,
        collapse: collapseFold,
        maxBlock,
        live: { status, scope, worker, project, activeProfile, startedAt },
      });
      return;
    }
    bus.submitLocal(input);
  };

  const maxScroll = Math.max(0, lines.length - bodyHeight);
  const clampedBack = Math.min(scrollBack, maxScroll);
  const lineRows = clampedBack > 0 ? bodyHeight - 1 : bodyHeight;
  const start = Math.max(0, lines.length - lineRows - clampedBack);
  const visible = lines.slice(start, start + lineRows);
  const width = cols - 1;

  useInput((_input, key) => {
    if (key.pageUp) setScrollBack((b) => Math.min(maxScroll, b + bodyHeight));
    else if (key.pageDown) setScrollBack((b) => Math.max(0, b - bodyHeight));
  });

  return (
    <Box flexDirection="column" height={frameRows}>
      <Banner info={info} scope={scope} worker={worker} project={project} status={status} activeProfile={activeProfile} usage={usage} sessionTokens={sessionTokens} />
      <Rule width={width} />
      <Box flexDirection="column" height={bodyHeight} overflow="hidden">
        {visible.map((line) => (
          <TranscriptLine key={line.key} line={line} />
        ))}
        {clampedBack > 0 ? (
          <Text dimColor>{`   ↑ ${clampedBack} newer line(s) hidden · PageDown`}</Text>
        ) : null}
      </Box>
      <Box justifyContent="flex-end">
        {busy ? (
          <Text color="yellow">
            <Spinner /> processing · {busy}…
          </Text>
        ) : (
          <Text> </Text>
        )}
      </Box>
      <Rule width={width} />
      <CommandInput status={status} history={history} onSubmit={handleSubmit} />
      <Rule width={width} />
      <Hint />
    </Box>
  );
}
