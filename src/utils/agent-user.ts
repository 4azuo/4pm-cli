/**
 * Agent uid separation. When the image entrypoint has dropped the cli to `node` with
 * only `SETUID`/`SETGID` and exported `FOURPM_AGENT_USER` (+ `FOURPM_AGENT_GID`, `FOURPM_AGENT_HOME`), every
 * process that executes in or on a project — AI CLIs, raw Console commands, git/scaffold/build steps — is
 * started as that user through `setpriv` with every capability cleared and `no_new_privs`, so a hook, a
 * build script or a prompt-injected agent can never act with the cli's identity, config or sockets.
 *
 * Off (no `FOURPM_AGENT_USER`) ⇒ every helper is a no-op and processes run exactly as before — a host
 * worker, a Kubernetes "restricted" pod, or an image that has not enabled it.
 * @adr 0430 phase 1
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants as fsc,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { logger } from "../common/logger/logger";

/** The agent user name when separation is on, else null. */
export function agentUser(): string | null {
  const u = process.env.FOURPM_AGENT_USER?.trim();
  return u ? u : null;
}

/** The shared group id (`4pm-work`) both users belong to, or null when unknown. */
function sharedGid(): number | null {
  const n = Number(process.env.FOURPM_AGENT_GID);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The agent's own $HOME (provider configs, caches) — never the cli's. */
export function agentHome(): string {
  return process.env.FOURPM_AGENT_HOME?.trim() || "/home/agent";
}

/** Roots under which a spawn runs as the agent: the workspaces + shared temp dirs (absolute, normalized). */
const agentRoots = new Set<string>();

/** Register a folder whose processes must run as the agent (the workspaces root, a shared temp dir). */
export function registerAgentRoot(dir: string): void {
  agentRoots.add(resolve(dir));
}

/** Forget an agent root (a removed temp dir). */
export function unregisterAgentRoot(dir: string): void {
  agentRoots.delete(resolve(dir));
}

/** True when `cwd` is (inside) a registered agent root. */
export function isAgentCwd(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const p = resolve(cwd);
  for (const r of agentRoots) if (p === r || p.startsWith(r + sep)) return true;
  return false;
}

/**
 * `sh` argv that runs `cmd args` under `umask` — the command and its arguments are passed positionally
 * (`$0` / `$@`), never interpolated into the script, and `exec` keeps the pid.
 */
function underUmask(umask: string, cmd: string, args: string[]): string[] {
  return ["/bin/sh", "-c", `umask ${umask} && exec "$0" "$@"`, cmd, ...args];
}

/**
 * The argv that runs `cmd args` as the agent: `setpriv --reuid/--regid=<agent> --init-groups` with the
 * inheritable + ambient capability sets cleared and `no_new_privs` (the agent ends with no capability and
 * cannot switch back to the cli's uid), under an explicit `umask 007` so what it creates in a workspace stays
 * shared with the cli (the cli itself runs `077`). Unchanged when separation is off.
 * @adr 0487 §1
 */
export function asAgent(cmd: string, args: string[]): { cmd: string; args: string[] } {
  const user = agentUser();
  if (!user) return { cmd, args };
  return {
    cmd: "setpriv",
    args: [
      `--reuid=${user}`,
      `--regid=${user}`,
      "--init-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      "--",
      ...underUmask("007", cmd, args),
    ],
  };
}

/**
 * The argv for a tool install / update the cli runs itself (npm, pnpm): under `umask 022` while separation is
 * on, so the installed CLIs are executable by the agent (the cli's own `umask 077` would hide them). Unchanged
 * when off.
 * @adr 0487 §1
 */
export function asToolInstall(cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (!agentUser() || process.platform === "win32") return { cmd, args };
  const [sh, ...rest] = underUmask("022", cmd, args);
  return { cmd: sh!, args: rest };
}

/** `asAgent` only when `cwd` is inside an agent root (project / shared temp) — else unchanged. */
export function asAgentFor(cmd: string, args: string[], cwd: string | undefined): { cmd: string; args: string[] } {
  return isAgentCwd(cwd) ? asAgent(cmd, args) : { cmd, args };
}

/**
 * Env entries an agent process must see instead of the cli's: its own HOME/USER, its own gh / glab config dirs
 * (the cli's `GH_CONFIG_DIR` / `GLAB_CONFIG_DIR` point at its private login, which the agent cannot read — gh
 * then refuses to start; the agent authenticates through the token shims instead), and — for git only in
 * agent processes — `safe.directory=*`, because the project tree is owned by the cli user and shared via
 * the group (git would otherwise refuse it as "dubious ownership"). The cli's own git keeps the check.
 * Empty when off.
 * @adr 0487 §4
 */
export function agentEnvOverrides(): Record<string, string> {
  const user = agentUser();
  if (!user) return {};
  const home = agentHome();
  return {
    HOME: home,
    USER: user,
    LOGNAME: user,
    GH_CONFIG_DIR: join(home, ".config", "gh"),
    GLAB_CONFIG_DIR: join(home, ".config", "glab"),
    GIT_CONFIG_PARAMETERS: "'safe.directory'='*'",
  };
}

/**
 * Share a folder the cli created with the agent: group = the shared group, mode `2770` (setgid ⇒ new
 * files inherit the group). No-op when separation is off.
 */
export function shareWithAgent(dir: string): void {
  const gid = sharedGid();
  if (!agentUser() || gid === null) return;
  chownSync(dir, -1, gid);
  chmodSync(dir, 0o2770);
}

/**
 * Let the agent pass THROUGH a folder without listing it (`~/.4pm` on the way to `workspaces/`): group =
 * the shared group, mode `0710`. No-op when separation is off.
 */
export function traversableByAgent(dir: string): void {
  const gid = sharedGid();
  if (!agentUser() || gid === null) return;
  chownSync(dir, -1, gid);
  chmodSync(dir, 0o710);
}

/**
 * A fresh temp dir both users can work in (a pool run's working dir, a help-image dir, a throwaway clone):
 * shared with the agent and registered as an agent root, so processes started in it run as the agent.
 */
export function makeAgentTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (agentUser()) {
    shareWithAgent(dir);
    registerAgentRoot(dir);
  }
  return dir;
}

/**
 * Give the agent read (+ traverse / execute) but not write access to something the cli owns: group = the
 * shared group, `mode` as given (e.g. `0o2750` for a folder, `0o640` for a key). No-op when off.
 */
export function readOnlyForAgent(path: string, mode: number): void {
  const gid = sharedGid();
  if (!agentUser() || gid === null) return;
  chownSync(path, -1, gid);
  chmodSync(path, mode);
}

/**
 * The cli-owned folder whose contents the agent may use but never change:
 * `~/.4pm/run/<profile>/` — the git-token socket, the gh/glab shims, the deploy-key copy. Created
 * `2750` (group = shared) under a `0710` `~/.4pm/run`; returns its path, or null when separation is off.
 */
export function prepareAgentRunDir(profileDirPath: string): string | null {
  if (!agentUser()) return null;
  const dir = agentRunDirPath(profileDirPath);
  const base = dirname(dir);
  mkdirSync(dir, { recursive: true });
  traversableByAgent(base);
  readOnlyForAgent(dir, 0o2750);
  return dir;
}

/** Path of a profile's run dir `~/.4pm/run/<profile>/`, whether or not it exists. */
export function agentRunDirPath(profileDirPath: string): string {
  return join(homedir(), ".4pm", "run", basename(profileDirPath));
}

/**
 * Delete a folder the agent may have written into: first as the agent (its private files and folders the cli
 * cannot enter), then as the cli for whatever remains. Both act on a symlink itself, never on its target. Off ⇒
 * a plain delete. Throws when the cli's own pass fails.
 * @adr 0487
 */
export function removeSharedTree(dir: string): void {
  if (agentUser()) {
    const w = asAgent("rm", ["-rf", "--", dir]);
    try {
      execFileSync(w.cmd, w.args, { stdio: "ignore", timeout: 120_000, env: { PATH: process.env.PATH ?? "", HOME: agentHome() } });
    } catch (err) {
      // Entries only the cli may remove are left to the pass below.
      logger.debug("agent.removeTree", { dir, error: String(err) });
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

/** True when `p` is `base` or inside it (both absolute, normalized). */
function within(p: string, base: string): boolean {
  return p === base || p.startsWith(base + sep);
}

/**
 * Why `dir` must never become an agent-writable credential dir, or null when it may:
 * it would contain the cli's home / `~/.4pm` (the agent could rename the cli's identity), or it sits
 * inside the cli's own secrets (profiles, run dir, gh/glab config, ssh).
 */
function forbiddenCredentialDir(dir: string): string | null {
  const home = resolve(homedir());
  const fourpm = join(home, ".4pm");
  if (within(home, dir) || within(fourpm, dir)) return "contains the cli home";
  for (const secret of ["profiles", "run", "gh", "glab", "default"].map((s) => join(fourpm, s)).concat(join(home, ".ssh"))) {
    if (within(dir, secret)) return "inside the cli's own config";
  }
  return null;
}

/**
 * Change group + mode of a cli-owned path through a descriptor opened with `O_NOFOLLOW`, so an entry the
 * agent swapped for a symlink is never followed. Returns false (untouched) when it is a symlink, not owned
 * by the cli, or cannot be opened.
 */
function setGroupModeNoFollow(path: string, mode: (current: number) => number, dirOnly: boolean): boolean {
  const gid = sharedGid();
  if (gid === null) return false;
  return changeModeNoFollow(path, mode, dirOnly, gid);
}

/**
 * Change the mode (and the group, when `gid` is given) of a cli-owned path through an `O_NOFOLLOW`
 * descriptor. Returns false (untouched) when it is a symlink, not owned by the cli, or cannot be opened.
 */
function changeModeNoFollow(path: string, mode: (current: number) => number, dirOnly: boolean, gid: number | null): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | (dirOnly ? fsc.O_DIRECTORY : 0));
    const st = fstatSync(fd);
    if (st.uid !== process.getuid?.()) return false;
    if (gid !== null) fchownSync(fd, -1, gid);
    fchmodSync(fd, mode(st.mode & 0o7777));
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** True when the agent (via "other" or the shared group) may pass through a folder with these stats. */
function agentCanTraverse(mode: number, gid: number): boolean {
  return (mode & 0o001) !== 0 || (gid === sharedGid() && (mode & 0o010) !== 0);
}

/**
 * Make every ancestor of `dir` passable for the agent: a cli-owned folder that is not gets the shared group
 * with group `--x` (no listing); a folder owned by someone else that blocks the agent is only reported.
 */
function openAncestorsForAgent(dir: string): void {
  for (let p = dirname(dir); ; p = dirname(p)) {
    try {
      const st = statSync(p);
      if (!agentCanTraverse(st.mode, st.gid)) {
        const ok = setGroupModeNoFollow(p, (m) => (m & 0o7707) | 0o010, true);
        if (!ok) logger.warn("agent.credDir.blockedAncestor", { dir, ancestor: p });
      }
    } catch {
      /* missing / unreadable — the spawn reports it */
    }
    if (dirname(p) === p) break;
  }
}

/**
 * Walk `dir` without following symlinks, calling `onDir` / `onFile` for every entry the cli owns (agent-owned
 * entries are the agent's own business). A folder the cli cannot list is skipped.
 */
function walkOwned(
  dir: string,
  onDir: (path: string) => void,
  onFile: (path: string) => void,
  skip: (path: string) => boolean = () => false,
): void {
  const uid = process.getuid?.();
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return; // a folder private to the agent — nothing of the cli's inside
    }
    for (const name of entries) {
      const p = join(d, name);
      if (skip(p)) continue;
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (st.uid === uid) onDir(p);
        walk(p);
      } else if (st.isFile() && st.uid === uid) {
        onFile(p);
      }
    }
  };
  walk(dir);
}

/**
 * Give a cli-installed code tree the image's modes (`/app`): folders `0755`, files `0644` (`0755` when
 * executable) — readable by everyone, writable by the cli only. Used for a self-update staged in the runtime
 * dir; only cli-owned entries, symlinks never followed. No-op when separation is off.
 * @adr 0499
 */
export function readableInstallTree(dir: string): void {
  if (!agentUser()) return;
  const fileMode = (m: number): number => ((m & 0o111) !== 0 ? 0o755 : 0o644);
  changeModeNoFollow(dir, () => 0o755, true, null);
  walkOwned(
    dir,
    (d) => changeModeNoFollow(d, () => 0o755, true, null),
    (f) => changeModeNoFollow(f, fileMode, false, null),
  );
}

/** Shared mode of a project file: `0770` when any execute bit is (or must be) set, else `0660`. */
function sharedFileMode(current: number, exec: boolean): number {
  return exec || (current & 0o111) !== 0 ? 0o770 : 0o660;
}

/** True when `path` is inside an agent root while separation is on — where the cli's writes are shared. */
export function isSharedPath(path: string): boolean {
  return agentUser() !== null && sharedGid() !== null && isAgentCwd(path);
}

/**
 * Give an entry the cli just created inside an agent root its shared mode: folders `02770`, files `0660`
 * (`0770` when `exec`), group `4pm-work` — through an `O_NOFOLLOW` descriptor. No-op outside an agent root or
 * when separation is off.
 * @adr 0487 §1
 */
export function shareCreated(path: string, kind: "file" | "dir", exec = false): void {
  if (!isSharedPath(path)) return;
  if (kind === "dir") setGroupModeNoFollow(path, () => 0o2770, true);
  else setGroupModeNoFollow(path, (m) => sharedFileMode(m, exec), false);
}

/**
 * Share the folders a recursive `mkdir` just created — from `first` (its return value) down to `dir`.
 * @adr 0487 §1
 */
export function shareNewDirs(first: string | undefined, dir: string): void {
  if (!first) return;
  const top = resolve(first);
  const created: string[] = [];
  for (let p = resolve(dir); ; p = dirname(p)) {
    created.push(p);
    if (p === top || dirname(p) === p) break;
  }
  for (const p of created.reverse()) shareCreated(p, "dir");
}

/**
 * `mkdir -p` for a folder the cli derives itself (a project folder in the workspace), sharing every folder it
 * creates inside an agent root. Project-relative paths from the web go through `safe-path` instead.
 * @adr 0487 §1
 */
export function mkdirShared(dir: string): void {
  shareNewDirs(mkdirSync(dir, { recursive: true }), dir);
}

/**
 * Share an open file descriptor the cli created inside an agent root (the `safe-path` writers): mode as
 * {@link shareCreated}, only when the cli owns the file. No-op outside an agent root.
 * @adr 0487 §1
 */
export function shareCreatedFd(fd: number, path: string, exec = false): void {
  if (!isSharedPath(path)) return;
  const gid = sharedGid();
  try {
    const st = fstatSync(fd);
    if (gid === null || st.uid !== process.getuid?.()) return;
    fchownSync(fd, -1, gid);
    fchmodSync(fd, sharedFileMode(st.mode & 0o7777, exec));
  } catch {
    /* best-effort — the start-time repair catches what is left */
  }
}

/**
 * Bring a whole tree inside an agent root back to the shared modes (folders `02770`, files `0660` / `0770`,
 * group `4pm-work`) — only entries the cli owns, symlinks skipped, every change through `O_NOFOLLOW`. Used after
 * a template copy and by the start-time project repair. No-op when separation is off.
 * @adr 0487 §1 §2
 */
export function shareTree(dir: string): void {
  if (!agentUser() || sharedGid() === null) return;
  setGroupModeNoFollow(dir, () => 0o2770, true);
  walkOwned(
    dir,
    (p) => setGroupModeNoFollow(p, () => 0o2770, true),
    (p) => setGroupModeNoFollow(p, (m) => sharedFileMode(m, false), false),
  );
}

/**
 * Make a tree of cli-installed tools runnable by the agent: cli-owned folders `0755`, files `0755` when the
 * owner may execute them, else `0644` — never writable by the agent; symlinks skipped, `O_NOFOLLOW`. A tree
 * whose top folder already is `0755` is not walked (installs run under `umask 022`; this repairs trees from
 * before). Entries matched by `skip` (the staged cli update) stay private. No-op when separation is off.
 * @adr 0487 §1
 */
export function exposeToAgent(dir: string, skip: (path: string) => boolean = () => false): void {
  if (!agentUser()) return;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || (st.mode & 0o777) === 0o755) return;
  } catch {
    return; // not installed yet
  }
  const dirMode = (): number => 0o755;
  const fileMode = (m: number): number => ((m & 0o100) !== 0 ? 0o755 : 0o644);
  changeModeNoFollow(dir, dirMode, true, null);
  walkOwned(
    dir,
    (p) => changeModeNoFollow(p, dirMode, true, null),
    (p) => changeModeNoFollow(p, fileMode, false, null),
    skip,
  );
}

/**
 * Whether the agent resolves and may execute `cmd` on its `PATH` (the cli's `PATH`, as agent spawns get) —
 * checked after a tool install. True when separation is off.
 * @adr 0487 §1
 */
export function agentCanRun(cmd: string): boolean {
  if (!agentUser()) return true;
  const w = asAgent("sh", ["-c", 'command -v "$1" >/dev/null && test -x "$(command -v "$1")"', "sh", cmd]);
  try {
    execFileSync(w.cmd, w.args, { stdio: "ignore", timeout: 10_000, env: { PATH: process.env.PATH ?? "", HOME: agentHome() } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Bring every project folder directly under a workspace root back to the shared modes: a folder that is not
 * group `4pm-work` + setgid + group `rwx` (created while separation was off, e.g. by an old `4pm link`) is
 * repaired as a whole tree with {@link shareTree}; a correct folder is not walked. Returns the repaired
 * folders. No-op when separation is off.
 * @adr 0487 §2
 */
export function repairWorkspaceProjects(root: string): string[] {
  const gid = sharedGid();
  if (!agentUser() || gid === null) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const repaired: string[] = [];
  for (const name of names) {
    const p = join(root, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const shared = st.gid === gid && (st.mode & 0o2070) === 0o2070;
    if (shared) continue;
    shareTree(p);
    repaired.push(p);
  }
  if (repaired.length > 0) logger.info("agent.workspaceRepaired", { folders: repaired });
  return repaired;
}

/** Credential dirs whose pre-separation (cli-owned) content was already handed over in this process. */
const migratedCredentialDirs = new Set<string>();

/**
 * Share the cli-owned content of a credential dir with the agent (a login made before separation was on):
 * folders `2770`, files group read/write, all through `O_NOFOLLOW` descriptors. Returns true when at least
 * one cli-owned file was found (it still has to be re-owned by the agent — see `prepareAgentCredentialDir`).
 */
function shareExistingContent(dir: string): boolean {
  let foundFile = false;
  walkOwned(
    dir,
    (p) => setGroupModeNoFollow(p, () => 0o2770, true),
    (p) => {
      if (setGroupModeNoFollow(p, (m) => m | 0o060, false)) foundFile = true;
    },
  );
  return foundFile;
}

/**
 * Prepare an AI credential dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) for a provider CLI
 * running as the agent: create it, share it (`2770`, setgid ⇒ the agent's files keep the shared group),
 * make its ancestors passable and — once per process — hand any file the cli created there before
 * separation to the agent (the agent copies it over itself, so it owns it and the provider can rewrite /
 * `chmod` it). A dir that would expose the cli's own home or secrets is refused. No-op when off.
 */
export function prepareAgentCredentialDir(dirPath: string): void {
  if (!agentUser() || sharedGid() === null) return;
  const dir = resolve(dirPath);
  const why = forbiddenCredentialDir(dir);
  if (why) {
    logger.warn("agent.credDir.refused", { dir, reason: why });
    return;
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    logger.warn("agent.credDir.mkdir", { dir, error: String(err) });
    return;
  }
  setGroupModeNoFollow(dir, (m) => (m & 0o7000) | 0o2770, true);
  openAncestorsForAgent(dir);
  if (migratedCredentialDirs.has(dir)) return;
  migratedCredentialDirs.add(dir);
  if (!shareExistingContent(dir)) return;
  // Re-own the cli's files as the agent: copy (mode + times kept) and rename over the original.
  const uid = String(process.getuid?.() ?? "");
  const w = asAgent("find", [
    dir,
    "-xdev",
    "-user",
    uid,
    "-type",
    "f",
    "-exec",
    "sh",
    "-c",
    'for f; do cp --preserve=mode,timestamps -- "$f" "$f.4pm-own" && mv -f -- "$f.4pm-own" "$f"; done',
    "sh",
    "{}",
    "+",
  ]);
  try {
    execFileSync(w.cmd, w.args, { stdio: "ignore", timeout: 60_000, env: { PATH: process.env.PATH ?? "", HOME: agentHome() } });
    logger.info("agent.credDir.migrated", { dir });
  } catch (err) {
    logger.warn("agent.credDir.migrate", { dir, error: String(err) });
  }
}

/**
 * Read a file the agent owns (a provider's `0600` `.credentials.json` / `.claude.json`).
 * While separation is on it is read BY the agent (`cat` under `setpriv`), never opened by the cli itself,
 * so a symlink the agent planted there can only point the cli at what the agent could read anyway. Off ⇒ a
 * plain read. Throws when unreadable (like `readFileSync`).
 */
export function readAgentFile(path: string): string {
  if (!agentUser()) return readFileSync(path, "utf8");
  const w = asAgent("cat", ["--", path]);
  return execFileSync(w.cmd, w.args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH ?? "", HOME: agentHome() },
  });
}

