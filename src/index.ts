#!/usr/bin/env node
/**
 * CLI entry point for `4pm` (runs on the worker machine).
 * Commands: link (pairing) · start (connect WS, receive dispatch) · unlink ·
 * version (show version) · update (manual self-update).
 * Common flag: --profile <name> — an independent instance with its own config +
 * .cre at ~/.4pm/profiles/<name>/ (ADR-0014).
 */
import { runLink } from "./commands/link";
import { runStart } from "./commands/start";
import { runAttach } from "./commands/attach";
import { runUnlink } from "./commands/unlink";
import { runUpdate } from "./commands/update";
import { runVersion } from "./commands/version";
import {
  defaultProfileName,
  listProfiles,
  profileDir,
  resolveProfileArg,
} from "./config/profile";
import { selectFromList } from "./ui/select-profile";
import { logger } from "./common/logger/logger";

// Process-wide safety net (ADR-0075): the WS lifecycle runs detached (`void run()` under
// the TUI), so a stray async error must NEVER kill the cli — it has to keep reconnecting
// across a server restart. Log the full stack to the profile's JSONL (no-op until
// configured; writes to file so it can't corrupt the TUI) and keep the process alive.
// Deliberately does NOT exit — an unattended worker cli staying up beats a clean crash.
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error("process.unhandledRejection", { message: err.message, stack: err.stack });
});
process.on("uncaughtException", (err) => {
  logger.error("process.uncaughtException", { message: err.message, stack: err.stack });
});

/**
 * Read a `--name value` flag value.
 */
function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Resolve which linked profile to act on (ADR-0063): explicit `--profile` wins; else
 * 0 linked ⇒ prompt to link; 1 ⇒ that one; 2+ ⇒ an interactive picker on a TTY (or ask
 * for `--profile` when headless). Returns null when the caller should stop.
 */
async function pickLinkedProfile(
  explicit: string | null,
  action: string,
): Promise<string | null> {
  if (explicit) return explicit;
  const linked = listProfiles().filter((p) => p.linked);
  if (linked.length === 0) {
    console.error("No linked profile — run `4pm link` first.");
    return null;
  }
  if (linked.length === 1) return linked[0]!.name;
  if (!process.stdout.isTTY) {
    console.error(
      `Multiple profiles — pass --profile <name> (or run \`4pm ${action}\` in a terminal to pick).`,
    );
    return null;
  }
  return selectFromList(
    linked.map((p) => ({ label: p.name, value: p.name })),
    `Select a profile to ${action}:`,
  );
}

/**
 * Parse args and dispatch to the matching command.
 */
async function main(): Promise<void> {
  const [explicitProfile, args] = resolveProfileArg(process.argv.slice(2));
  const [command, ...rest] = args;
  // `link` resolves its profile after pairing (default = userId); every other command
  // resolves it now (explicit, else the default pointer — ADR-0047).
  switch (command) {
    case "link": {
      // `||` not `??`: an empty `--server` / FOURPM_SERVER="" means "not given", and `??`
      // would keep the empty string and dial nowhere.
      const serverUrl =
        flagValue(rest, "server") || process.env.FOURPM_SERVER || "http://localhost:42001";
      // Headless pairing token (ADR-0192 §6): `--token` or FOURPM_PAIR_TOKEN skips the interactive
      // hashcode dance (container/pool boot). `||` so an empty value means "not given".
      const pairToken = flagValue(rest, "token") || process.env.FOURPM_PAIR_TOKEN || null;
      await runLink(serverUrl.replace(/\/$/, ""), explicitProfile, pairToken);
      break;
    }
    case "start": {
      // Container/pool boot (ADR-0192 §6): no linked profile yet + a provisioning token present ⇒
      // headlessly pair first, so `docker run -e FOURPM_SERVER -e FOURPM_PAIR_TOKEN 4pm-cli` (which
      // defaults to `start`) self-provisions with no interactive step.
      const bootToken = process.env.FOURPM_PAIR_TOKEN || null;
      if (bootToken && listProfiles().filter((p) => p.linked).length === 0) {
        const serverUrl =
          flagValue(rest, "server") || process.env.FOURPM_SERVER || "http://localhost:42001";
        await runLink(serverUrl.replace(/\/$/, ""), explicitProfile, bootToken);
      }
      const name = await pickLinkedProfile(explicitProfile, "start");
      if (!name) {
        process.exitCode = 1;
        break;
      }
      await runStart(profileDir(name), name);
      break;
    }
    case "attach": {
      const name = await pickLinkedProfile(explicitProfile, "attach");
      if (!name) {
        process.exitCode = 1;
        break;
      }
      await runAttach(profileDir(name), name);
      break;
    }
    case "unlink": {
      const name = await pickLinkedProfile(explicitProfile, "unlink");
      if (!name) {
        process.exitCode = 1;
        break;
      }
      await runUnlink(profileDir(name), name);
      break;
    }
    case "version":
    case "--version":
    case "-v": {
      const name = explicitProfile ?? defaultProfileName();
      await runVersion(profileDir(name), name, flagValue(rest, "server"));
      break;
    }
    case "update":
    case "upgrade": {
      const name = explicitProfile ?? defaultProfileName();
      await runUpdate(profileDir(name), name, flagValue(rest, "server"));
      break;
    }
    default:
      console.log(
        [
          "4pm — the 4PM worker-machine CLI",
          "",
          "Usage:",
          "  4pm link      Pair with the server (pairing → confirmation code)",
          "  4pm start     Connect WS, receive commands from the server",
          "  4pm attach    Open the TUI against a running headless daemon (ADR-0192)",
          "  4pm unlink    Delete a link (pick a profile if several)",
          "  4pm version   Show the installed version (+ latest from the server)",
          "  4pm update    Update to the latest version now",
          "",
          "Flags:",
          "  --server <url>    Target 4PM server for this command. Applies to:",
          "                    link, version, update. Overrides FOURPM_SERVER and the",
          "                    default. `link` saves it to the profile's .cre, so",
          "                    start/version/update afterwards reuse that server — no",
          "                    need to repeat --server. Use it to pair against other",
          "                    environments/domains, e.g.:",
          "                      4pm link --server https://cli.4pm.app",
          "                      4pm link --server https://staging.4pm.app",
          "  --profile <name>  (Optional, advanced) Act on a specific profile — an",
          "                    independent instance with its own config + .cre at",
          "                    ~/.4pm/profiles/<name>/. Normally not needed: `link`",
          "                    auto-names the profile after the paired machine user,",
          "                    and start/unlink show a picker when several exist. Use",
          "                    it to force a custom name, link one account twice, or",
          "                    pick a profile headlessly (no TTY, multiple profiles).",
          "",
          "Environment:",
          "  FOURPM_SERVER     Default server URL when --server is omitted (link/version/",
          "                    update). Fallback when unset: http://localhost:42001.",
          "",
          "Profiles: named after the paired account (e.g. mcacc1); when several exist,",
          "start/unlink show a picker (↑↓ + Enter) — no --profile needed.",
          "Server URL: --server > FOURPM_SERVER > default http://localhost:42001;",
          "once linked, the profile's saved serverUrl is reused.",
        ].join("\n"),
      );
  }
}

void main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
