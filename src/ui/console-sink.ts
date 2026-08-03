/**
 * Console sink — the headless/service consumer of the SessionBus (ADR-0057). When
 * there is no TTY the cli keeps its plain `console.*` behavior: it prints the
 * lifecycle log lines (the ones that were previously `console.log/warn/error`) and
 * leaves per-command output to the structured logger / server, exactly as before.
 */
import type { SessionBus } from "../core/session-bus";

/**
 * Attach a console sink to the bus. Only system lifecycle lines are printed (to
 * preserve the pre-TUI headless output); command I/O entries are ignored here.
 */
export function attachConsoleSink(bus: SessionBus): void {
  bus.onTranscript((entry) => {
    if (entry.source !== "system") return;
    if (entry.level === "error") console.error(entry.text);
    else if (entry.level === "warn") console.warn(entry.text);
    else console.log(entry.text);
  });
}
