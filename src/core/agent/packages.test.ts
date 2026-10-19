/**
 * Tests for the multi-target package installer: per-provider skill targets, VS Code task merge that
 * keeps the user's JSONC comments, hook group merge/removal, bundles, requiredBy, drift, the legacy
 * manifest migration and the guide target rules.
 * @adr 0460 @adr 0461 @adr 0462
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackagesInstallRequest } from "@4pm/ws";
import { installPackage, listPackages, removePackage, reapplyInstalledHooks } from "./packages";

let root: string;

/** A base64 payload file. */
function f(path: string, content: string) {
  return { path, contentBase64: Buffer.from(content).toString("base64") };
}

/** A minimal install request. */
function req(over: Partial<PackagesInstallRequest>): PackagesInstallRequest {
  return { kind: "skill", slug: "s", version: "1.0.0", packageId: "p", files: [], ...over } as PackagesInstallRequest;
}

const HOOK = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node {{hookDir}}/guard.mjs" }] }] },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "4pm-pkg-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("installPackage", () => {
  it("installs a skill for claude and codex and records it", async () => {
    const r = await installPackage(root, req({ files: [f("SKILL.md", "# s")], providers: ["claude", "codex"] }));
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, ".claude/skills/s/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".agents/skills/s/SKILL.md"))).toBe(true);
    const list = await listPackages(root, ["claude"]);
    expect(list.enabledProviders).toEqual(["claude"]);
    expect(list.installed[0]).toMatchObject({ kind: "skill", slug: "s", providers: ["claude", "codex"] });
    expect(list.installed[0]!.sha256).toBe(list.installed[0]!.currentSha256);
  });

  it("refuses to clobber a hand-authored artifact and detects drift on update", async () => {
    await mkdir(join(root, ".claude/skills/s"), { recursive: true });
    expect((await installPackage(root, req({ files: [f("SKILL.md", "x")] }))).error).toBe("ALREADY_INSTALLED");
    await rm(join(root, ".claude/skills/s"), { recursive: true });
    await installPackage(root, req({ files: [f("SKILL.md", "x")] }));
    await writeFile(join(root, ".claude/skills/s/SKILL.md"), "edited");
    expect((await installPackage(root, req({ version: "1.1.0", files: [f("SKILL.md", "y")] }))).error).toBe("DRIFT");
  });

  it("merges VS Code tasks keeping comments, and removes only its own labels", async () => {
    await mkdir(join(root, ".vscode"));
    await writeFile(
      join(root, ".vscode/tasks.json"),
      '{\n  // my tasks\n  "version": "2.0.0",\n  "tasks": [{ "label": "mine", "type": "shell", "command": "echo" }]\n}\n',
    );
    const tasks = JSON.stringify({ tasks: [{ label: "4pm: a", type: "shell", command: "bash x" }] });
    expect((await installPackage(root, req({ kind: "vscode-task", slug: "t", files: [f("tasks.json", tasks)] }))).ok).toBe(true);
    let text = await readFile(join(root, ".vscode/tasks.json"), "utf8");
    expect(text).toContain("// my tasks");
    expect(text).toContain('"4pm: a"');
    expect((await removePackage(root, { slug: "t" })).ok).toBe(true);
    text = await readFile(join(root, ".vscode/tasks.json"), "utf8");
    expect(text).toContain('"mine"');
    expect(text).not.toContain("4pm: a");
  });

  it("rejects a task label owned by someone else and folderOpen tasks", async () => {
    await mkdir(join(root, ".vscode"));
    await writeFile(join(root, ".vscode/tasks.json"), '{"version":"2.0.0","tasks":[{"label":"x"}]}');
    const clash = JSON.stringify({ tasks: [{ label: "x" }] });
    expect((await installPackage(root, req({ kind: "vscode-task", slug: "t", files: [f("tasks.json", clash)] }))).error).toBe(
      "TASK_LABEL_CONFLICT",
    );
    const open = JSON.stringify({ tasks: [{ label: "y", runOptions: { runOn: "folderOpen" } }] });
    expect((await installPackage(root, req({ kind: "vscode-task", slug: "u", files: [f("tasks.json", open)] }))).ok).toBe(false);
  });

  it("appends hook groups per provider and removes exactly them", async () => {
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude/settings.json"), JSON.stringify({ permissions: { deny: ["Read(x)"] } }));
    const r = await installPackage(
      root,
      req({ kind: "hook", slug: "g", files: [f("hook.json", HOOK), f("guard.mjs", "x")], providers: ["claude", "codex"] }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain("CODEX_HOOKS_EXPERIMENTAL");
    const claude = JSON.parse(await readFile(join(root, ".claude/settings.json"), "utf8"));
    expect(claude.permissions.deny).toEqual(["Read(x)"]);
    expect(claude.hooks.PreToolUse[0].hooks[0].command).toBe('node "$CLAUDE_PROJECT_DIR"/.claude/hooks/g/guard.mjs');
    const codex = JSON.parse(await readFile(join(root, ".codex/hooks.json"), "utf8"));
    expect(codex.PreToolUse[0].hooks[0].command).toBe("node .codex/hooks/g/guard.mjs");
    // The create reset wipes settings.json; the recorded groups come back.
    await writeFile(join(root, ".claude/settings.json"), "{}");
    await reapplyInstalledHooks(root);
    expect(JSON.parse(await readFile(join(root, ".claude/settings.json"), "utf8")).hooks.PreToolUse).toHaveLength(1);
    expect((await removePackage(root, { slug: "g", kind: "hook" })).ok).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".claude/settings.json"), "utf8")).hooks).toBeUndefined();
    expect(existsSync(join(root, ".claude/hooks/g"))).toBe(false);
  });

  it("installs a bundle's members and blocks a standalone copy of a member", async () => {
    const r = await installPackage(
      root,
      req({
        kind: "bundle",
        slug: "b",
        members: [
          { kind: "script", slug: "s1" },
          { kind: "skill", slug: "k1" },
        ],
        files: [f("items/script/s1/run.sh", "echo"), f("items/skill/k1/SKILL.md", "# k")],
        providers: ["claude"],
      }),
    );
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, ".4pm/scripts/s1/run.sh"))).toBe(true);
    expect(existsSync(join(root, ".claude/skills/k1/SKILL.md"))).toBe(true);
    expect((await installPackage(root, req({ kind: "script", slug: "s1", files: [f("a", "b")] }))).error).toBe("ALREADY_INSTALLED");
    expect((await removePackage(root, { slug: "b" })).ok).toBe(true);
    expect(existsSync(join(root, ".4pm/scripts/s1"))).toBe(false);
  });

  it("refuses to remove a required package unless forced", async () => {
    await installPackage(root, req({ kind: "script", slug: "dep", files: [f("a.sh", "x")] }));
    await installPackage(
      root,
      req({ kind: "vscode-task", slug: "t", requires: ["script:dep"], files: [f("tasks.json", JSON.stringify({ tasks: [{ label: "z" }] }))] }),
    );
    const blocked = await removePackage(root, { slug: "dep", kind: "script" });
    expect(blocked).toMatchObject({ ok: false, error: "REQUIRED_BY", requiredBy: ["vscode-task:t"] });
    expect((await removePackage(root, { slug: "dep", kind: "script", force: true })).ok).toBe(true);
  });

  it("writes a guide only onto a missing file unless overwrite is set, and keeps it on remove", async () => {
    await writeFile(join(root, "CLAUDE.md"), "ours");
    const g = req({ kind: "guide", slug: "gd", files: [f("GUIDE.md", "adapted")], guideTarget: "CLAUDE.md" });
    expect((await installPackage(root, g)).error).toBe("GUIDE_TARGET_EXISTS");
    expect((await installPackage(root, { ...g, guideOverwrite: true })).ok).toBe(true);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("adapted");
    expect((await removePackage(root, { slug: "gd" })).ok).toBe(true);
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
  });
});
