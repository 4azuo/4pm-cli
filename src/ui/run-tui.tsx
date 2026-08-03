/**
 * runTui — mount the Ink TUI for `4pm start` (ADR-0057): clear the screen (like the
 * Claude Code CLI on start), render the App, and resolve when the operator quits
 * (Ctrl+C ⇒ useApp().exit). The caller runs the WsClient concurrently, feeding the
 * shared SessionBus.
 */
import React from "react";
import { render } from "ink";
import type { SessionBus } from "../core/session-bus";
import type { SessionInfo } from "./session-info";
import { App } from "./app";

/**
 * Clear the terminal + scrollback then mount the App. Returns a promise that
 * resolves when the Ink app exits.
 */
export function runTui(bus: SessionBus, info: SessionInfo): Promise<void> {
  // ESC[2J clear screen · ESC[3J clear scrollback · ESC[H home cursor.
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  const instance = render(<App bus={bus} info={info} />);
  return instance.waitUntilExit();
}
