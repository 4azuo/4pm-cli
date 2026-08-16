/**
 * tool-health (ADR-0223) — report the last-run result of each external tool the cli invokes
 * directly (claude/codex/gh/glab/git) to the server, so the admin pool lists can surface a
 * failing tool (e.g. `claude: Not logged in`) under the worker's label. A module-level sink is
 * wired by the ws-client while a session is up; before the socket is ready (or on a run with no
 * link) reports are simply dropped. Best-effort — reporting never disrupts a run.
 */
import type { ToolHealthReport } from "@4pm/ws";

/** Where a report is delivered (set to the live ws-client send while connected). */
type ToolHealthSink = (report: ToolHealthReport) => void;

let sink: ToolHealthSink | null = null;

/** Wire the reporter to the live ws send (called on session-established; null clears it on close). */
export function setToolHealthSink(fn: ToolHealthSink | null): void {
  sink = fn;
}

/**
 * Report one tool's last-run outcome (ADR-0223) — last-wins per tool. On failure the `message` is
 * trimmed to a short human reason (≤200 chars); on success it is null. Never throws.
 */
export function reportToolResult(tool: string, ok: boolean, message?: string | null): void {
  try {
    const reason = (message ?? "").trim().slice(0, 200);
    sink?.({
      tool,
      ok,
      message: ok ? null : reason || "failed",
      at: new Date().toISOString(),
    });
  } catch {
    // best-effort — never let health reporting disrupt a run
  }
}
