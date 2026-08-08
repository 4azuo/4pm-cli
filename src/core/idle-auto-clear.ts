/**
 * Idle transcript auto-clear for the HEADLESS path (ADR-0057 / ADR-0150). The interactive Ink
 * TUI runs its own idle-clear inside `ui/app.tsx`; when the cli runs headless in a container
 * (`FOURPM_HEADLESS` — no Ink is mounted) that timer never starts, so the `autoClearIdleMinutes`
 * knob had no effect on the console-sync transcript the web Console observes. This driver restores
 * the same behavior for the headless path: every `autoClearIdleMinutes` with no transcript activity
 * (and not mid-response), it wipes the session transcript so an idle session's buffer stays bounded.
 */
import type { SessionBus } from "./session-bus";

/**
 * Start the headless idle auto-clear loop; returns a stop function. `idleMinutes <= 0` disables it.
 */
export function startIdleAutoClear(bus: SessionBus, idleMinutes: number): () => void {
  const idleMs = Math.max(0, idleMinutes) * 60_000;
  if (idleMs <= 0) return () => {};
  // Any pushed line (server output, AI req/res, lifecycle log) counts as activity — mirrors the
  // TUI driver, which resets on both operator input and a server-dispatched line.
  let lastActivity = Date.now();
  const off = bus.onTranscript(() => {
    lastActivity = Date.now();
  });
  const timer = setInterval(() => {
    // Never clear mid-response (a tool is still running) or when there is nothing to clear.
    if (bus.busy !== null || bus.snapshot().length === 0) return;
    if (Date.now() - lastActivity < idleMs) return;
    bus.clear();
    bus.log(`Transcript auto-cleared after ${Math.round(idleMs / 60_000)} min idle.`);
    lastActivity = Date.now();
  }, 60_000);
  // Don't hold the event loop open just for this timer.
  timer.unref?.();
  return () => {
    off();
    clearInterval(timer);
  };
}
