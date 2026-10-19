/**
 * `4pm start` command — check version/auto-update, then open a WS
 * connection to the server and keep the session alive (heartbeat, reconnect,
 * receive dispatch). Requires an existing pairing (`.cre` present in the profile). The process-scoped
 * services register with the daemon lifecycle; a restart / update / stop signal / quit drains running
 * work, stops every service, then execs the new binary in place (or exits).
 * @adr 0015 @adr 0473 @adr 0505
 */
import { join } from "node:path";
import { readCredential } from "../core/profile/credential";
import { collectFingerprint } from "../core/profile/fingerprint";
import { fetchWhoami } from "../services/api";
import { checkAndUpdate } from "../core/update";
import { reexecUpdated } from "../core/update-reexec";
import { WsClient } from "../core/ws-client";
import { initCommandHistory } from "../core/exec/command-history";
import { initCommandOutput } from "../core/exec/command-output-store";
import {
  acquireInstanceLock,
  lockHolder,
  releaseInstanceLock,
} from "../core/profile/instance-lock";
import {
  backfillProfileConfig,
  ensureProfileConfig,
  prepareWorkspaces,
  readProfileConfig,
  resolveIdleAutoClearMinutes,
  drainTimeoutMs,
} from "../config/profile";
import { logger, type LogLevel } from "../common/logger/logger";
import { initI18n, t } from "../i18n";
import { SessionBus } from "../core/session/session-bus";
import { startControlServer } from "../core/control/control-server";
import { revokeAll } from "../core/git/git-auth";
import { startIdleAutoClear } from "../core/session/idle-auto-clear";
import { activeProfileLabel, applyAiAccountMask } from "../core/ai/ai-account-mask";
import { attachConsoleSink } from "../ui/console-sink";
import { runTui } from "../ui/run-tui";
import type { SessionInfo } from "../ui/session-info";
import { CLI_VERSION } from "../version";
import { addToolDirToPath, ensureToolchainAtBoot, exposeInstalledTools, setToolchainReporter, usedAiTools } from "../core/worker/toolchain";
import { checkAgentAiClis } from "../core/worker/agent-ai-cli";
import { startGitTokenServer } from "../core/git/git-token-server";
import { installAgentHelper, verifyAgentHelper } from "../core/agent/agent-helper-install";
import { syncAgentSshKey } from "../core/git/git-ssh-key";
import { prepareCredentialDir } from "../utils/ai-cred-mount";
import { adoptMountedAiLogins, disableUnloggedDefaults } from "../core/ai/ai-mount-profiles";
import { allAiProfileDirs } from "../utils/ai-cli";
import { lifecycle } from "../core/session/lifecycle";
import { stopEgressProxy } from "../core/network/egress-proxy";
import { stopNetguardSync } from "../core/network/netguard-client";
import { stopEgressEventSink } from "../core/network/egress-events";
import { stopCommandHistoryUpload } from "../core/exec/command-history";

/** Drain bound for a stop signal / quit: short, so `docker stop`'s grace still covers the teardown. */
const SIGNAL_DRAIN_MS = 10_000;

/**
 * Resolve the log level: `--verbose` ⇒ debug (highest priority), else FOURPM_LOG_LEVEL,
 * else info.
 * @adr 0054
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
  const credential = readCredential(profileDir);
  if (!credential) {
    console.error(t("start.notLinked", { profile: profileName }));
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
  // Backfill any operator-default keys a pre-existing config.json lacks (ADR-0244 follow-up), so a
  // config written before a default existed (e.g. `aiRunTimeoutSec: 300`) still gets the safeguard
  // instead of resolving to "no limit"/"off".
  backfillProfileConfig(profileDir);

  // Uid separation (ADR-0430): share + register this profile's workspace before anything runs in it.
  prepareWorkspaces(profileDir);
  // …and the tools installed before — also by an older cli — stay runnable by the agent (ADR-0487, ADR-0502).
  exposeInstalledTools();
  // A host login mounted at ~/ai-creds/<provider> with no profile pointing at it becomes one (ADR-0433).
  adoptMountedAiLogins(profileDir);
  // …and the seeded .claude/.codex that hold no login are switched off once, so runs don't try them first (ADR-0479).
  disableUnloggedDefaults(profileDir);

  // Auto-update before connecting — keeps profile/.cre intact
  const config = readProfileConfig(profileDir);
  // Localize the cli's operator-facing messages per the worker config (ADR-0276);
  // absent `locale` falls back to FOURPM_LOCALE/LANG, then English.
  initI18n(config.locale);
  // Mask AI account labels from the last ws_token's flag (ADR-0395) before anything renders one.
  applyAiAccountMask(profileDir, config.maskAiAccounts === true);
  const autoUpdate =
    config.autoUpdate !== false && process.env.FOURPM_NO_UPDATE !== "1";
  const result = await checkAndUpdate(credential.serverUrl, autoUpdate);
  if (result.action === "blocked") {
    logger.error("update.blocked", { minSupported: result.minSupported });
    console.error(t("start.updateBlocked", { minSupported: result.minSupported }));
    process.exitCode = 1;
    return;
  }
  if (result.action === "updated") {
    // Re-exec the new binary with the same original args (keeps the profile). Nothing is claimed
    // yet (lock, sockets, WS), so the child starts like a fresh `4pm start`.
    logger.info("update.updated", { version: result.version });
    console.log(t("start.restarting"));
    await reexecUpdated();
  }

  // Single-instance lock per profile (ADR-0047): refuse a second `4pm start` for the
  // same profile so two clis can't thrash each other's ws_token. Acquired AFTER the
  // auto-update re-exec branch so the restarted child takes the lock, not the parent.
  if (!acquireInstanceLock(profileDir)) {
    console.error(
      t("start.alreadyRunning", { profile: profileName, pid: lockHolder(profileDir) ?? "" }),
    );
    process.exitCode = 1;
    return;
  }
  const release = (): void => releaseInstanceLock(profileDir);
  process.once("exit", release);
  // Ctrl+C / termination: drain briefly and stop every service, then exit (the "exit" handler releases
  // the lock). A second signal exits at once.
  let signalled = false;
  const exitOnSignal = (): void => {
    if (signalled) process.exit(0);
    signalled = true;
    void lifecycle
      .shutdown("signal", { drainMs: SIGNAL_DRAIN_MS, cancelGraceMs: 5_000 })
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", exitOnSignal);
  process.once("SIGTERM", exitOnSignal);
  // Set when the session asks to restart into an updated cli — re-exec after the teardown.
  let restarting = false;

  // Toolchain (ADR-0396): the self-installed release binaries (gh/glab) come first on PATH, for the cli
  // and every child it spawns — set before anything captures PATH (git-auth's base env, AI runs).
  addToolDirToPath();

  try {
    // Local command history (per cli) + periodic R2 upload (config-gated) + per-command
    // output capture (for /output — ADR-0057).
    initCommandHistory(profileDir, profileName, config.commandHistoryUploadMinutes ?? 10);
    lifecycle.register("command-history.upload", "process", stopCommandHistoryUpload);
    initCommandOutput(profileDir);

    // Presentation bridge (ADR-0057): TUI on a TTY, else the plain console sink.
    const bus = new SessionBus();
    const client = new WsClient({
      credential,
      machine: collectFingerprint(),
      profileDir,
      bus,
    });
    // Started by the WS client's constructor — process-scoped services (ADR-0505).
    lifecycle.register("egress.proxy", "process", () => stopEgressProxy());
    lifecycle.register("egress.events", "process", stopEgressEventSink);
    lifecycle.register("netguard.sync", "process", stopNetguardSync);
    // GitHub-App tokens are revoked as the last service step (no stale process keeps them).
    lifecycle.register("git.tokens", "process", () => revokeAll().catch(() => undefined));
    // A self-update (daily tick / web push) or an operator restart: drain, stop every service and close
    // the session; the TUI exits once stopped, and the exec runs only after the teardown below.
    bus.onRestart(() => {
      restarting = true;
      void lifecycle.shutdown(bus.restartReason, { drainMs: drainTimeoutMs(profileDir) });
    });
    // Start-up self-heal (ADR-0396): install a missing gh/glab and the enabled profiles' AI CLIs in the
    // background; each success re-reports the tools snapshot. Never blocks or fails the start.
    setToolchainReporter(() => client.reportToolsSnapshot());
    // Once those installs settled, the AI CLIs in use must be runnable by the agent — repaired once, else
    // reported here instead of at the first AI run (ADR-0502).
    void ensureToolchainAtBoot(profileDir, (line) => bus.log(line))
      .catch(() => undefined)
      .then(() => {
        for (const { cmd, reason } of checkAgentAiClis(usedAiTools(profileDir))) {
          bus.log(t("start.aiCliUnusable", { tool: cmd, reason }), "error");
        }
      })
      .catch(() => undefined);
    // Expose this daemon's session over a per-profile unix socket so a `4pm attach` TUI can
    // observe/drive it (essential when headless in a container — ADR-0192 §2). Best-effort.
    const stopControl = startControlServer(bus, profileDir, {
      version: CLI_VERSION,
      scope: credential.scope,
      profile: profileName,
      serverUrl: credential.serverUrl,
      physicPath: config.physicPath ?? null,
      aiCli: config.aiCli || "claude",
    });
    // Uid separation (ADR-0430 phase 2): a token-only socket for the agent's git helper / gh shims, and the
    // deploy key exposed read-only. No-ops when separation is off.
    const stopGitToken = startGitTokenServer(profileDir);
    lifecycle.register("control.socket", "process", stopControl);
    lifecycle.register("git-token.socket", "process", stopGitToken);
    syncAgentSshKey(profileDir);
    // The standalone helper agent processes run instead of the cli bundle (ADR-0499) — installed before the
    // first git-auth / egress env is built, then checked as the agent so a broken helper shows up here.
    installAgentHelper(profileDir);
    const helperError = verifyAgentHelper();
    if (helperError) bus.log(t("start.agentHelperUnusable", { reason: helperError }), "error");
    // Phase 3: the configured AI credential dirs are the agent's, host-mounted logins imported (ADR-0433);
    // dirs added later are prepared at spawn.
    for (const dir of allAiProfileDirs(config)) prepareCredentialDir(dir);
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
          bus.log(t("start.recovered", { message: e.message }), "error");
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
      bus.setActiveProfile(activeProfileLabel(profileDir, config));
      const tui = runTui(bus, info);
      bus.log(t("start.connecting", { server: credential.serverUrl, profile: profileName }));
      // The WS loop runs concurrently, feeding the bus; the TUI resolves on quit.
      void runResilient();
      await tui;
      // The TUI ended: by a restart (already stopped) or by /quit — drain briefly and stop everything.
      await lifecycle.shutdown("quit", { drainMs: SIGNAL_DRAIN_MS, cancelGraceMs: 5_000 });
    } else {
      attachConsoleSink(bus);
      // Headless has no Ink TUI, so drive the idle transcript auto-clear here (the TUI runs its
      // own in ui/app.tsx) — otherwise the config knob is a no-op in a container (ADR-0150). The
      // window is re-read each tick so the project override (ws_token — ADR-0244) applies live.
      const stopIdleClear = startIdleAutoClear(bus, () =>
        resolveIdleAutoClearMinutes(readProfileConfig(profileDir)),
      );
      lifecycle.register("idle.auto-clear", "process", stopIdleClear);
      bus.log(t("start.connecting", { server: credential.serverUrl, profile: profileName }));
      await runResilient();
      // run() returns only after the session closed for good — make sure every service is stopped.
      await lifecycle.shutdown(lifecycle.reason ?? "quit", { drainMs: SIGNAL_DRAIN_MS, cancelGraceMs: 5_000 });
    }
  } finally {
    // Every service (control / git-token sockets, idle clear, GitHub-App token revoke — ADR-0356 …) is a
    // lifecycle service; an error path that skipped the shutdown still stops them all (idempotent).
    if (lifecycle.state !== "stopped") {
      await lifecycle.shutdown(lifecycle.reason ?? "quit", { drainMs: 0, cancelGraceMs: 0 }).catch(() => undefined);
    }
    release();
  }
  if (restarting) {
    // The re-exec parent must outlive stop signals and forward them to the child instead.
    process.off("SIGINT", exitOnSignal);
    process.off("SIGTERM", exitOnSignal);
    process.off("exit", release);
    console.log(t("start.restarting"));
    await reexecUpdated();
  }
}
