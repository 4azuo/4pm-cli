/**
 * Map a package payload to its install targets per kind and provider: the files to write, the folders
 * the package owns, VS Code tasks and hook groups to merge, and the paths whose prior existence blocks a
 * fresh install. Pure (no I/O) — `packages.ts` applies the plan.
 * @adr 0460 @adr 0461 @adr 0462
 */
import type { PackagePayloadFile } from "@4pm/ws";
import type { HookGroup, OwnedHookGroup, PackageKind, Provider } from "./package-manifest";
import type { TaskDef } from "./package-config-merge";

/** What installing one artifact writes. */
export interface InstallPlan {
  files: { path: string; content: Buffer }[];
  dirs: string[];
  tasks: TaskDef[];
  hookGroups: OwnedHookGroup[];
  warnings: string[];
  /** Paths that must not pre-exist for a fresh install (hand-authored artifacts are never clobbered). */
  conflictPaths: string[];
}

/** Guide files a guide package may target. */
const GUIDE_TARGETS = new Set(["CLAUDE.md", "AGENT.md"]);
/** Event names allowed in hook configs. */
const EVENT_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** Sanitize a name to a safe file/dir stem (defense-in-depth beyond the server checks). */
export function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

/** Reject traversal / absolute payload paths. */
function safeRel(path: string): boolean {
  return !!path && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

/** An empty plan. */
function emptyPlan(): InstallPlan {
  return { files: [], dirs: [], tasks: [], hookGroups: [], warnings: [], conflictPaths: [] };
}

/** Copy every payload file (except `skip`) under `dir`. */
function copyInto(plan: InstallPlan, dir: string, files: PackagePayloadFile[], skip: string[] = []): string | null {
  for (const f of files) {
    if (skip.includes(f.path)) continue;
    if (!safeRel(f.path)) return `unsafe payload path: ${f.path}`;
    plan.files.push({ path: `${dir}/${f.path}`, content: Buffer.from(f.contentBase64, "base64") });
  }
  return null;
}

/** Parse a packaged `hook.json` into event → groups, substituting `{{hookDir}}`. */
function hookGroupsOf(raw: string, hookDir: string): Record<string, HookGroup[]> | string {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return "invalid hook.json";
  }
  const hooks = (doc as { hooks?: unknown })?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return "invalid hook.json";
  const out: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!EVENT_RE.test(event) || !Array.isArray(groups)) return "invalid hook.json";
    out[event] = (groups as HookGroup[]).map((g) => {
      const cmds = Array.isArray(g?.hooks) ? g.hooks : [];
      return {
        ...(typeof g.matcher === "string" ? { matcher: g.matcher } : {}),
        hooks: cmds.map((h) => ({
          type: "command" as const,
          command: String(h.command ?? "").split("{{hookDir}}").join(hookDir),
          ...(typeof h.timeout === "number" ? { timeout: h.timeout } : {}),
        })),
      };
    });
    if (out[event]!.some((g) => g.hooks.length === 0 || g.hooks.some((h) => !h.command.trim()))) return "invalid hook.json";
  }
  return out;
}

/**
 * Plan one non-bundle artifact. `providers` applies to skill/subagent/hook (empty ⇒ claude);
 * `guideTarget` to a guide. Returns the plan or an error string (a cli error contract).
 */
export function planArtifact(
  kind: Exclude<PackageKind, "bundle">,
  slug: string,
  files: PackagePayloadFile[],
  providers: Provider[],
  opts: { guideTarget?: string } = {},
): InstallPlan | string {
  const plan = emptyPlan();
  const byPath = new Map(files.map((f) => [f.path, f]));
  const targets: Provider[] = providers.length ? providers : ["claude"];
  switch (kind) {
    case "skill": {
      if (!byPath.has("SKILL.md")) return "invalid package: missing SKILL.md";
      for (const p of targets) {
        const dir = p === "claude" ? `.claude/skills/${slug}` : `.agents/skills/${slug}`;
        const err = copyInto(plan, dir, files);
        if (err) return err;
        plan.dirs.push(dir);
        plan.conflictPaths.push(dir);
      }
      return plan;
    }
    case "subagent": {
      const agent = byPath.get("agent.md");
      if (!agent) return "invalid package: missing agent.md";
      for (const p of targets) {
        if (p === "claude") {
          const main = `.claude/agents/${slug}.md`;
          plan.files.push({ path: main, content: Buffer.from(agent.contentBase64, "base64") });
          plan.conflictPaths.push(main);
          for (const mem of ["short-memory", "long-memory"]) {
            const f = byPath.get(`${mem}.md`);
            if (f) plan.files.push({ path: `.claude/agents/${mem}/${slug}.md`, content: Buffer.from(f.contentBase64, "base64") });
          }
        } else {
          const toml = byPath.get("agent.codex.toml");
          if (!toml) return "invalid package: provider codex needs agent.codex.toml";
          const path = `.codex/agents/${slug}.toml`;
          plan.files.push({ path, content: Buffer.from(toml.contentBase64, "base64") });
          plan.conflictPaths.push(path);
        }
      }
      return plan;
    }
    case "script": {
      if (files.length === 0) return "invalid package: empty script";
      const dir = `.4pm/scripts/${slug}`;
      const err = copyInto(plan, dir, files);
      if (err) return err;
      plan.dirs.push(dir);
      plan.conflictPaths.push(dir);
      return plan;
    }
    case "command": {
      const cmd = byPath.get("command.md");
      if (!cmd) return "invalid package: missing command.md";
      const path = `.claude/commands/${slug}.md`;
      plan.files.push({ path, content: Buffer.from(cmd.contentBase64, "base64") });
      plan.conflictPaths.push(path);
      return plan;
    }
    case "vscode-task": {
      const f = byPath.get("tasks.json");
      if (!f) return "invalid package: missing tasks.json";
      let doc: { tasks?: unknown };
      try {
        doc = JSON.parse(Buffer.from(f.contentBase64, "base64").toString("utf8")) as { tasks?: unknown };
      } catch {
        return "invalid package: tasks.json";
      }
      if (!Array.isArray(doc.tasks) || doc.tasks.length === 0) return "invalid package: tasks.json";
      for (const t of doc.tasks as TaskDef[]) {
        if (typeof t?.label !== "string" || !t.label.trim()) return "invalid package: task without label";
        if ((t.runOptions as { runOn?: unknown } | undefined)?.runOn === "folderOpen") {
          return "invalid package: folderOpen task";
        }
        plan.tasks.push(t);
      }
      return plan;
    }
    case "hook": {
      const hookFile = byPath.get("hook.json");
      if (!hookFile) return "invalid package: missing hook.json";
      const raw = Buffer.from(hookFile.contentBase64, "base64").toString("utf8");
      const hasScripts = files.some((f) => f.path !== "hook.json");
      for (const p of targets) {
        const dir = p === "claude" ? `.claude/hooks/${slug}` : `.codex/hooks/${slug}`;
        const hookDir = p === "claude" ? `"$CLAUDE_PROJECT_DIR"/.claude/hooks/${slug}` : dir;
        const events = hookGroupsOf(raw, hookDir);
        if (typeof events === "string") return events;
        for (const [event, groups] of Object.entries(events)) {
          for (const group of groups) plan.hookGroups.push({ provider: p, event, group });
        }
        if (hasScripts) {
          const err = copyInto(plan, dir, files, ["hook.json"]);
          if (err) return err;
          plan.dirs.push(dir);
          plan.conflictPaths.push(dir);
        }
        if (p === "codex") plan.warnings.push("CODEX_HOOKS_EXPERIMENTAL");
      }
      return plan;
    }
    case "guide": {
      const guide = byPath.get("GUIDE.md");
      if (!guide) return "invalid package: missing GUIDE.md";
      const target = opts.guideTarget ?? "CLAUDE.md";
      if (!GUIDE_TARGETS.has(target)) return "invalid package: bad guide target";
      plan.files.push({ path: target, content: Buffer.from(guide.contentBase64, "base64") });
      plan.conflictPaths.push(target);
      return plan;
    }
  }
}

/** Merge several plans into one (bundle members). */
export function mergePlans(plans: InstallPlan[]): InstallPlan {
  const out = emptyPlan();
  for (const p of plans) {
    out.files.push(...p.files);
    out.dirs.push(...p.dirs);
    out.tasks.push(...p.tasks);
    out.hookGroups.push(...p.hookGroups);
    out.conflictPaths.push(...p.conflictPaths);
    for (const w of p.warnings) if (!out.warnings.includes(w)) out.warnings.push(w);
  }
  return out;
}
