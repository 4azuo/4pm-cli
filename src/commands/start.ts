/**
 * `4pm start` command — check version/auto-update (ADR-0015), then open a WS
 * connection to the server and keep the session alive (heartbeat, reconnect,
 * receive dispatch). Requires an existing pairing (`.cre` present in the profile).
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readCredential } from "../core/credential";
import { collectFingerprint } from "../core/fingerprint";
import { fetchWhoami } from "../services/api";
import { checkAndUpdate } from "../core/update";
import { WsClient } from "../core/ws-client";
import { initCommandHistory } from "../core/command-history";
import { initCommandOutput } from "../core/command-output-store";
import {
  acquireInstanceLock,
  lockHolder,
  releaseInstanceLock,
} from "../core/instance-lock";
import { ensureProfileConfig, readProfileConfig } from "../config/profile";
import { logger, type LogLevel } from "../common/logger/logger";
import { SessionBus } from "../core/session-bus";
import { startControlServer } from "../core/control-server";
import { getWorkingProfile } from "../core/ai-profile-state";
import { profileDisplayLabel, profileLabels } from "../utils/ai-cli";
import { attachConsoleSink } from "../ui/console-sink";
import { runTui } from "../ui/run-tui";
import type { SessionInfo } from "../ui/session-info";
import { CLI_VERSION } from "../version";

/**
 * Resolve the log level: `--verbose` ⇒ debug (highest priority), else FOURPM_LOG_LEVEL,
 * else info (ADR-0054).
 */
function resolveLogLevel(): LogLevel {
  if (process.argv.includes("--verbose")) return "debug";
  const env = process.env.FOURPM_LOG_LEVEL;
  if (env === "error" || env === "warn" || env === "info" || env === "debug") return env;
  return "info";
}

/**
 * Run the cli's main connection lifecycle in the context of a single profile.
 */
export async function runStart(
  profileDir: string,
  profileName: string,
): Promise<void> {
  const credential = readCredential(profileDir, profileName);
  if (!credential) {
    console.error(
      `Profile "${profileName}" is not linked — run \`4pm link --server <URL>\` first.`,
    );
    process.exitCode = 1;
    return;
  }

  // Structured logging to the profile's logs/ dir (ADR-0054) — configured before the
  // update check so update outcomes are captured. Never logs the credential secrets.
  logger.configure({
    dir: join(profileDir, "logs"),
    level: resolveLogLevel(),
    base: { version: CLI_VERSION, profile: profileName, scope: credential.scope },
  });
  logger.info("cli.start", { serverUrl: credential.serverUrl });

  // Heal profiles linked before config-scaffolding existed: write the canonical defaults
  // if config.json is still missing, so it never ends up as the partial file the first
  // ws_token would otherwise create (keeps the structure identical to `/config init`).
  ensureProfileConfig(profileDir);

  // Auto-update before connecting (ADR-0015) — keeps profile/.cre intact
  const config = readProfileConfig(profileDir);
  const autoUpdate =
    config.autoUpdate !== false && process.env.FOURPM_NO_UPDATE !== "1";
  const result = await checkAndUpdate(credential.serverUrl, autoUpdate);
  if (result.action === "blocked") {
    logger.error("update.blocked", { minSupported: result.minSupported });
    console.error(
      `CLI is older than minSupported (${result.minSupported}) and the update failed — cannot connect.`,
    );
    process.exitCode = 1;
    return;
  }
  if (result.action === "updated") {
    // Re-exec the new binary with the same original args (keeps the profile)
    logger.info("update.updated", { version: result.version });
    console.log("Restarting with the new version…");
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, FOURPM_NO_UPDATE: "1" },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  // Single-instance lock per profile (ADR-0047): refuse a second `4pm start` for the
  // same profile so two clis can't thrash each other's ws_token. Acquired AFTER the
  // auto-update re-exec branch so the restarted child takes the lock, not the parent.
  if (!acquireInstanceLock(profileDir)) {
    console.error(
      `Profile "${profileName}" is already running (pid ${lockHolder(profileDir)}). ` +
        "Only one `4pm start` per profile is allowed.",
    );
    process.exitCode = 1;
    return;
  }
  const release = (): void => releaseInstanceLock(profileDir);
  // Control channel (ADR-0192 §2) — declared here so the finally can stop it.
  let stopControl: (() => void) | null = null;
  process.once("exit", release);
  // Ensure the "exit" handler runs on Ctrl+C / termination so the lock is released.
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));

  try {
    // Local command history (per cli) + periodic R2 upload (config-gated) + per-command
    // output capture (for /output — ADR-0057).
    initCommandHistory(profileDir, profileName, config.commandHistoryUploadMinutes ?? 10);
    initCommandOutput(profileDir);

    // Presentation bridge (ADR-0057): TUI on a TTY, else the plain console sink.
    const bus = new SessionBus();
    const client = new WsClient({
      credential,
      machine: collectFingerprint(),
      profileDir,
      bus,
    });
    // Expose this daemon's session over a per-profile unix socket so a `4pm attach` TUI can
    // observe/drive it (essential when headless in a container — ADR-0192 §2). Best-effort.
    stopControl = startControlServer(bus, profileDir, {
      version: CLI_VERSION,
      scope: credential.scope,
      profile: profileName,
      serverUrl: credential.serverUrl,
      physicPath: config.physicPath ?? null,
      aiCli: config.aiCli || "claude",
    });
    // Run the WS lifecycle so a thrown error RESTARTS the loop instead of killing the
    // cli — the reconnect loop must survive a server restart (a stray async error used
    // to escape the detached run() and terminate the process). run() returns only on a
    // deliberate stop (logout / SESSION_REPLACED / version); anything else ⇒ recover.
    const runResilient = async (): Promise<void> => {
      for (;;) {
        try {
          await client.run();
          return;
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          logger.error("ws.run.crash", { message: e.message, stack: e.stack });
          if (client.isStopped) return;
          bus.log(`Recovered from an internal error — reconnecting: ${e.message}`, "error");
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    };
    const useTui = Boolean(process.stdout.isTTY) && process.env.FOURPM_HEADLESS !== "1";
    if (useTui) {
      const info: SessionInfo = {
        version: CLI_VERSION,
        scope: credential.scope,
        profile: profileName,
        profileDir,
        serverUrl: credential.serverUrl,
        physicPath: config.physicPath ?? null,
        aiCli: config.aiCli || "claude",
        whoami: () =>
          fetchWhoami(credential.serverUrl, credential.hashcode3).catch(() => null),
      };
      // Seed the header's active AI profile: the last working one, else the first
      // configured candidate (ADR-0057). Updated live when failover picks one.
      const aiCli = config.aiCli || "claude";
      const workingDir = getWorkingProfile(profileDir, aiCli);
      const labels = profileLabels(config);
      bus.setActiveProfile(workingDir ? profileDisplayLabel(workingDir) : (labels[0] ?? null));
      const tui = runTui(bus, info);
      bus.log(`Connecting to ${credential.serverUrl} (profile: ${profileName})…`);
      // The WS loop runs concurrently, feeding the bus; the TUI resolves on quit.
      void runResilient();
      await tui;
    } else {
      attachConsoleSink(bus);
      bus.log(`Connecting to ${credential.serverUrl} (profile: ${profileName})…`);
      await runResilient();
    }
  } finally {
    stopControl?.();
    release();
  }
}
