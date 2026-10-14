/**
 * Private-by-default / shared-by-intent modes under the agent uid separation: with the cli on `umask 077`,
 * only writes into an agent root come out shared (files `0660` / `0770`, folders `02770`), the tree repair and
 * the tool exposure set the documented modes without following symlinks, and agent spawns get `umask 007`.
 * Separation is simulated with the test user's own group as the shared group.
 * @adr 0487
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentAccessBlocker, agentEnvOverrides, asAgent, exposeToAgent, mkdirShared, registerAgentRoot, repairWorkspaceProjects, shareTree, unregisterAgentRoot } from "./agent-user";
import { appendFileInRoot, writeFileInRoot } from "./safe-path";

/** Permission bits (incl. setgid) of a path, never following a symlink. */
function mode(p: string): number {
  return lstatSync(p).mode & 0o7777;
}

describe.skipIf(process.platform === "win32")("agent share modes (separation on)", () => {
  const saved = { user: process.env.FOURPM_AGENT_USER, gid: process.env.FOURPM_AGENT_GID, umask: process.umask() };
  let base = "";
  let ws = "";
  let priv = "";

  beforeAll(() => {
    process.env.FOURPM_AGENT_USER = "agent";
    process.env.FOURPM_AGENT_GID = String(process.getgid?.() ?? 0);
    process.umask(0o077);
    base = mkdtempSync(join(tmpdir(), "4pm-share-"));
    ws = join(base, "ws");
    priv = join(base, "private");
    mkdirSync(ws);
    mkdirSync(priv);
    registerAgentRoot(ws);
  });

  afterAll(() => {
    unregisterAgentRoot(ws);
    process.umask(saved.umask);
    if (saved.user === undefined) delete process.env.FOURPM_AGENT_USER;
    else process.env.FOURPM_AGENT_USER = saved.user;
    if (saved.gid === undefined) delete process.env.FOURPM_AGENT_GID;
    else process.env.FOURPM_AGENT_GID = saved.gid;
    rmSync(base, { recursive: true, force: true });
  });

  it("shares a file and the folders written into an agent root", async () => {
    await writeFileInRoot(ws, join(ws, "a", "b", "f.md"), "x");
    expect(mode(join(ws, "a"))).toBe(0o2770);
    expect(mode(join(ws, "a", "b"))).toBe(0o2770);
    expect(mode(join(ws, "a", "b", "f.md"))).toBe(0o660);
  });

  it("keeps an executable write executable", async () => {
    await writeFileInRoot(ws, join(ws, "run.sh"), "#!/bin/sh\n", 0o755);
    expect(mode(join(ws, "run.sh"))).toBe(0o770);
  });

  it("shares an appended log", async () => {
    await appendFileInRoot(ws, join(ws, ".claude", "logs", "t.log"), "line\n");
    await appendFileInRoot(ws, join(ws, ".claude", "logs", "t.log"), "line\n");
    expect(mode(join(ws, ".claude", "logs", "t.log"))).toBe(0o660);
  });

  it("refuses to append through a symlink", async () => {
    const outside = join(priv, "target.log");
    writeFileSync(outside, "");
    symlinkSync(outside, join(ws, "evil.log"));
    await expect(appendFileInRoot(ws, join(ws, "evil.log"), "x")).rejects.toThrow();
  });

  it("leaves a write outside every agent root private", async () => {
    await writeFileInRoot(priv, join(priv, "secret.json"), "{}");
    expect(mode(join(priv, "secret.json"))).toBe(0o600);
  });

  it("mkdirShared shares only the folders it creates", () => {
    mkdirShared(join(ws, "p", "q"));
    expect(mode(join(ws, "p"))).toBe(0o2770);
    expect(mode(join(ws, "p", "q"))).toBe(0o2770);
  });

  it("shareTree repairs a private tree and skips symlinks", () => {
    const t = join(ws, "proj");
    mkdirSync(join(t, ".git", "objects"), { recursive: true, mode: 0o700 });
    writeFileSync(join(t, ".git", "HEAD"), "ref", { mode: 0o600 });
    writeFileSync(join(t, "tool.sh"), "", { mode: 0o700 });
    const outside = join(priv, "keep");
    writeFileSync(outside, "", { mode: 0o600 });
    symlinkSync(outside, join(t, "link"));
    shareTree(t);
    expect(mode(t)).toBe(0o2770);
    expect(mode(join(t, ".git"))).toBe(0o2770);
    expect(mode(join(t, ".git", "objects"))).toBe(0o2770);
    expect(mode(join(t, ".git", "HEAD"))).toBe(0o660);
    expect(mode(join(t, "tool.sh"))).toBe(0o770);
    expect(mode(outside)).toBe(0o600);
  });

  it("exposeToAgent opens a whole tool tree read/execute-only, the staged cli update included", () => {
    const prefix = join(base, "npm-global");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(prefix, "lib", "node_modules", "x"), { recursive: true });
    mkdirSync(join(prefix, "4pm-cli"), { recursive: true });
    writeFileSync(join(prefix, "lib", "node_modules", "x", "cli.js"), "", { mode: 0o700 });
    writeFileSync(join(prefix, "lib", "node_modules", "x", "package.json"), "{}", { mode: 0o600 });
    chmodSync(prefix, 0o770);
    exposeToAgent(prefix);
    expect(mode(prefix)).toBe(0o755);
    expect(mode(join(prefix, "bin"))).toBe(0o755);
    expect(mode(join(prefix, "lib", "node_modules", "x", "cli.js"))).toBe(0o755);
    expect(mode(join(prefix, "lib", "node_modules", "x", "package.json"))).toBe(0o644);
    expect(mode(join(prefix, "4pm-cli"))).toBe(0o755);
  });

  it("exposeToAgent walks private folders under an already-open top (a tree an older cli wrote)", () => {
    // The stg `mcacc2` layout (ADR-0502): prefix 0755, but bin/ and the package folder 0700.
    const prefix = join(base, "npm-old");
    const pkg = join(prefix, "lib", "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(pkg, "bin", "claude.exe"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync("../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", join(prefix, "bin", "claude"));
    chmodSync(join(prefix, "bin"), 0o700);
    chmodSync(pkg, 0o700);
    chmodSync(prefix, 0o755);
    exposeToAgent(prefix);
    expect(mode(join(prefix, "bin"))).toBe(0o755);
    expect(mode(pkg)).toBe(0o755);
    expect(mode(join(pkg, "bin", "claude.exe"))).toBe(0o755);
    expect(lstatSync(join(prefix, "bin", "claude")).isSymbolicLink()).toBe(true);
  });

  it("agentAccessBlocker names the folder that stops the agent, and nothing inside an open tree", () => {
    const prefix = join(base, "npm-blocked");
    const pkg = join(prefix, "lib", "node_modules", "tool");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(pkg, "tool.js"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync("../lib/node_modules/tool/tool.js", join(prefix, "bin", "fourpm-test-tool"));
    chmodSync(pkg, 0o700);
    const savedPath = process.env.PATH;
    process.env.PATH = join(prefix, "bin");
    try {
      const reason = agentAccessBlocker("fourpm-test-tool");
      expect(reason).toContain(join(prefix, "bin", "fourpm-test-tool"));
      expect(reason).toContain("blocked at");
      exposeToAgent(prefix);
      // Whatever still blocks (a private temp ancestor of the test dir) is outside the exposed tree.
      const after = agentAccessBlocker("fourpm-test-tool");
      if (after !== null) expect(after).not.toContain(`blocked at ${prefix}`);
      expect(agentAccessBlocker("fourpm-no-such-tool")).toBeNull();
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("repairWorkspaceProjects repairs an unshared project folder and leaves a shared one alone", () => {
    const root = join(base, "workspace");
    mkdirSync(root);
    const broken = join(root, "Broken (link while off)");
    mkdirSync(join(broken, ".git"), { recursive: true, mode: 0o755 });
    chmodSync(broken, 0o755);
    writeFileSync(join(broken, ".git", "HEAD"), "ref", { mode: 0o600 });
    const ok = join(root, "ok");
    mkdirSync(ok);
    chmodSync(ok, 0o2770);
    writeFileSync(join(ok, "private-by-agent"), "", { mode: 0o600 });
    expect(repairWorkspaceProjects(root)).toEqual([broken]);
    expect(mode(broken)).toBe(0o2770);
    expect(mode(join(broken, ".git"))).toBe(0o2770);
    expect(mode(join(broken, ".git", "HEAD"))).toBe(0o660);
    expect(mode(join(ok, "private-by-agent"))).toBe(0o600); // a correct folder is not walked
  });

  it("points the agent's gh / glab at its own config dirs, never the cli's login", () => {
    const env = agentEnvOverrides();
    expect(env.GH_CONFIG_DIR).toBe(join("/home/agent", ".config", "gh"));
    expect(env.GLAB_CONFIG_DIR).toBe(join("/home/agent", ".config", "glab"));
  });

  it("runs agent commands under umask 007, passing the command positionally", () => {
    const w = asAgent("git", ["status", "$(touch /tmp/x)"]);
    expect(w.cmd).toBe("setpriv");
    const i = w.args.indexOf("--");
    expect(w.args.slice(i + 1)).toEqual(["/bin/sh", "-c", 'umask 007 && exec "$0" "$@"', "git", "status", "$(touch /tmp/x)"]);
  });
});
