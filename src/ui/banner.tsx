/**
 * Banner — the header block of the TUI (ADR-0057, cli-display 0001): logo + version,
 * link scope/profile, server, the physic project being served, and a **live status
 * line** (connection · AI CLI · active profile). Rendered in the live region (top) so
 * the status stays current. Local-only data; no secrets.
 */
import React from "react";
import { Box, Text } from "ink";
import type { MachineUsagePayload } from "@4pm/ws";
import type { SessionStatus } from "../core/session-bus";
import type { SessionInfo } from "./session-info";

/** Status dot color. */
function dotColor(status: SessionStatus): string {
  if (status === "connected") return "green";
  if (status === "stopped") return "red";
  return "yellow";
}

/** Human label for the link scope (role-based to avoid repeating "project"). */
function scopeLabel(scope: string): string {
  if (scope === "project") return "MACHINE";
  if (scope === "orchestrator") return "orchestrator (root)";
  return scope;
}

/** The header block. */
export function Banner({
  info,
  scope,
  worker,
  project,
  status,
  activeProfile,
  usage,
  sessionTokens,
}: {
  info: SessionInfo;
  /** Live scope (healed from the server at connect) — falls back to info.scope. */
  scope: string;
  /** Worker (physical machine) name learned from the server at connect, or null. */
  worker: string | null;
  /** Logical project name (project scope) learned from the server at connect, or null. */
  project: string | null;
  status: SessionStatus;
  activeProfile: string | null;
  /** Latest Claude subscription usage snapshot (5h/weekly — ADR-0072), or null. */
  usage: MachineUsagePayload | null;
  /** Tokens consumed this session. */
  sessionTokens: number;
}): React.ReactElement {
  return (
    <Box flexDirection="row" paddingX={1} paddingTop={1}>
      <Box marginRight={2} flexDirection="column">
        <Text color="cyan" bold>
          {"┌─┐"}
        </Text>
        <Text color="cyan" bold>
          {"│4│PM"}
        </Text>
        <Text color="cyan" bold>
          {"└─┘"}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>
          4PM CLI <Text color="cyan">v{info.version}</Text>
        </Text>
        <Text dimColor>
          scope: {scopeLabel(scope)} · profile: {info.profile}
          {worker ? ` · worker: ${worker}` : ""}
        </Text>
        {scope === "orchestrator" ? (
          <Text dimColor>server: {info.serverUrl} · mode: orchestrator (short-lived AI)</Text>
        ) : (
          <Text dimColor>
            server: {info.serverUrl} · serving: {project ?? info.physicPath ?? "(no project attached)"}
          </Text>
        )}
        {/* Status + active AI profile + subscription usage — one line (3-row header). */}
        <Text>
          <Text color={dotColor(status)}>●</Text> {status} · using{" "}
          <Text color="cyan">{info.aiCli}</Text>
          {activeProfile ? (
            <Text>
              {" "}
              <Text color="cyan">{activeProfile}</Text>
            </Text>
          ) : null}
          {usage ? (
            <Text dimColor>
              {" "}
              · 5h {usage.session.utilizationPct}% · weekly {usage.weekly.utilizationPct}%
            </Text>
          ) : null}
          {sessionTokens > 0 ? <Text dimColor> · session {sessionTokens.toLocaleString()} tok</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}
