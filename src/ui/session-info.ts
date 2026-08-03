import type { WhoamiResponse } from "@4pm/dto";

/**
 * Static session info shown in the TUI banner (ADR-0057) — resolved locally from the
 * credential/profile/config (never a secret), plus a `whoami` fetcher for /whoami.
 */
export interface SessionInfo {
  /** Installed cli version (CLI_VERSION). */
  version: string;
  /** Link scope — "project" (MACHINE) or "orchestrator" (root/ADMIN) — ADR-0010. */
  scope: string;
  /** Active profile name (default profile = paired userId — ADR-0047). */
  profile: string;
  /** Profile directory (~/.4pm/profiles/<name>/) — slash commands read/write config here. */
  profileDir: string;
  /** Server base URL the cli connects to. */
  serverUrl: string;
  /** The physic project folder this cli serves (null = not attached). */
  physicPath: string | null;
  /** AI CLI the input box drives (default "claude") — shown in the status hint. */
  aiCli: string;
  /** Fetch this cli's account + teams/projects from the server (for /whoami). */
  whoami: () => Promise<WhoamiResponse | null>;
}
