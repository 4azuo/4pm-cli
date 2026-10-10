/**
 * Host-mounted AI logins under the agent uid separation (ADR-0433). The ADR-0199 recipe bind-mounts a host
 * login (`-v ~/.claude:/home/node/ai-creds/claude`) and points a profile at it. The agent cannot read those
 * host-owned `0600` files, and changing their owner/mode would break the login on the host — so, while
 * separation is on, a profile under `~/ai-creds/` runs on an imported copy in the state volume
 * (`~/.4pm/ai/mounted/<same path>`). The cli copies the credential files from the mount (never writes to it)
 * whenever the host's file changed since the last import; the copy is the agent's and the provider keeps
 * refreshing it in place. Off ⇒ the profile uses the mount directly, as before.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { logger } from "../common/logger/logger";
import { agentHome, agentUser, asAgent, prepareAgentCredentialDir } from "./agent-user";

/** The provider credential files worth importing (claude: token + account; codex: token). */
const CREDENTIAL_FILES = [".credentials.json", ".claude.json", "auth.json"] as const;

/** Where host logins are mounted (ADR-0199): `~/ai-creds/<name>`. */
function mountRoot(): string {
  return resolve(homedir(), "ai-creds");
}

/** Where their imported copies live in the state volume. */
function importedRoot(): string {
  return resolve(homedir(), ".4pm", "ai", "mounted");
}

/** The import bookkeeping (dir → file → source mtime), in a folder the agent cannot write. */
function markerPath(): string {
  return join(homedir(), ".4pm", "ai", ".mounted-imports.json");
}

/**
 * The credential dir a provider actually runs on: a profile under `~/ai-creds/` maps to its imported copy
 * while separation is on; every other dir (and every dir when off) is unchanged.
 */
export function effectiveCredentialDir(dir: string): string {
  if (!agentUser()) return dir;
  const d = resolve(dir);
  const root = mountRoot();
  return d.startsWith(root + sep) ? join(importedRoot(), relative(root, d)) : dir;
}

/** The mounted source of an imported copy, or null when `dir` is not one. */
function mountedSourceOf(dir: string): string | null {
  const d = resolve(dir);
  const base = importedRoot();
  return d.startsWith(base + sep) ? join(mountRoot(), relative(base, d)) : null;
}

/** Read the import bookkeeping (empty when absent / unreadable). */
function readMarkers(): Record<string, Record<string, number>> {
  try {
    return JSON.parse(readFileSync(markerPath(), "utf8")) as Record<string, Record<string, number>>;
  } catch {
    return {};
  }
}

/** Write the import bookkeeping (best-effort). */
function writeMarkers(markers: Record<string, Record<string, number>>): void {
  try {
    mkdirSync(join(homedir(), ".4pm", "ai"), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify(markers), { mode: 0o600 });
  } catch (err) {
    logger.warn("agent.credMount.marker", { error: String(err) });
  }
}

/** Write `content` to `target` AS the agent (`0600`, replaced atomically), so the agent owns the copy. */
function writeAsAgent(target: string, content: Buffer): void {
  const w = asAgent("sh", ["-c", 'umask 077 && cat > "$1.4pm-tmp" && mv -f -- "$1.4pm-tmp" "$1"', "sh", target]);
  execFileSync(w.cmd, w.args, {
    input: content,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? "", HOME: agentHome() },
  });
}

/**
 * Copy the credential files of an imported dir from its mount when the host's file changed since the last
 * import (or the copy is missing). A refreshed/re-logged host login therefore reaches the container on its
 * next start or AI run; the container's own refreshes stay in the copy. Never writes to the mount.
 */
function importFromMount(dir: string): void {
  const source = mountedSourceOf(dir);
  if (!source || !existsSync(source)) return;
  const markers = readMarkers();
  const seen = markers[dir] ?? {};
  let changed = false;
  for (const name of CREDENTIAL_FILES) {
    const src = join(source, name);
    let mtimeMs: number;
    try {
      const st = statSync(src);
      if (!st.isFile()) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // this provider doesn't use the file
    }
    const target = join(dir, name);
    if (seen[name] === mtimeMs && existsSync(target)) continue;
    try {
      writeAsAgent(target, readFileSync(src));
      seen[name] = mtimeMs;
      changed = true;
      logger.info("agent.credMount.imported", { dir, file: name });
    } catch (err) {
      // Typically the host file is not readable by the container's uid — the same limit as a direct mount.
      logger.warn("agent.credMount.import", { dir, file: name, error: String(err) });
    }
  }
  if (changed) writeMarkers({ ...markers, [dir]: seen });
}

/**
 * Make a provider credential dir ready for an agent run (ADR-0430 phase 3 + ADR-0433): share it with the
 * agent and, for an imported host login, refresh the copy from the mount. No-op when separation is off.
 */
export function prepareCredentialDir(dir: string): void {
  if (!agentUser()) return;
  prepareAgentCredentialDir(dir);
  importFromMount(dir);
}
