/**
 * Merge marketplace packages into shared config files the user also owns, touching only what a
 * package added: VS Code tasks into `.vscode/tasks.json` (JSONC — edited in place so comments and
 * formatting survive, owned by `label`) and hook matcher groups into `.claude/settings.json` (`hooks`
 * key) / `.codex/hooks.json` (events at the root), owned by the exact group JSON recorded in the
 * manifest. Symlink-safe writes under the physic root.
 * @adr 0460 @adr 0461
 */
import { join } from "node:path";
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from "jsonc-parser";
import { writeFileInRoot } from "../../utils/safe-path";
import { readRel, sha256, type HookGroup, type OwnedHookGroup, type Provider } from "./package-manifest";

/** The VS Code tasks file. */
export const TASKS_REL = ".vscode/tasks.json";
/** Each provider's hook config file. */
export const HOOK_CONFIG_REL: Record<Provider, string> = {
  claude: ".claude/settings.json",
  codex: ".codex/hooks.json",
};

const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

/** Recursively sort object keys so JSON.stringify is canonical. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** sha256 of a value's canonical JSON. */
export function jsonSha(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)));
}

/** Deep equality through canonical JSON. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Parse JSONC text; throws on syntax errors (never silently rewrite a broken file). */
function parseJsonc(text: string, what: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`invalid ${what}`);
  return value;
}

/** A packaged VS Code task (any VS Code task object with a string label). */
export type TaskDef = Record<string, unknown> & { label: string };

/** Current `.vscode/tasks.json` text + its parsed tasks (empty template when the file is absent). */
async function readTasks(root: string): Promise<{ text: string; tasks: TaskDef[] }> {
  const buf = await readRel(root, TASKS_REL);
  const text = buf ? buf.toString("utf8") : '{\n  "version": "2.0.0",\n  "tasks": []\n}\n';
  const doc = parseJsonc(text, TASKS_REL) as { tasks?: unknown } | null;
  return { text, tasks: Array.isArray(doc?.tasks) ? (doc!.tasks as TaskDef[]) : [] };
}

/** Labels in `.vscode/tasks.json` not owned by `owned` that collide with `labels`. */
export async function taskLabelConflicts(root: string, labels: string[], owned: string[]): Promise<string[]> {
  const { tasks } = await readTasks(root);
  const present = new Set(tasks.map((t) => t?.label).filter((l): l is string => typeof l === "string"));
  return labels.filter((l) => present.has(l) && !owned.includes(l));
}

/** Remove the tasks with these labels (all occurrences), keeping the rest of the file intact. */
export async function removeTasks(root: string, labels: string[]): Promise<void> {
  if (labels.length === 0) return;
  const { text: original, tasks } = await readTasks(root);
  const drop = tasks.map((t, i) => (labels.includes(t?.label) ? i : -1)).filter((i) => i >= 0);
  if (drop.length === 0) return;
  let text = original;
  for (const i of drop.reverse()) {
    text = applyEdits(text, modify(text, ["tasks", i], undefined, { formattingOptions: FORMAT }));
  }
  await writeFileInRoot(root, join(root, TASKS_REL), text);
}

/** Append tasks (after removing any previous copies of their labels); returns each label's hash. */
export async function addTasks(root: string, defs: TaskDef[]): Promise<{ label: string; sha256: string }[]> {
  await removeTasks(root, defs.map((d) => d.label));
  let { text } = await readTasks(root);
  const doc = parseJsonc(text, TASKS_REL) as { tasks?: unknown } | null;
  if (!Array.isArray(doc?.tasks)) {
    text = applyEdits(text, modify(text, ["tasks"], [], { formattingOptions: FORMAT }));
  }
  for (const def of defs) {
    text = applyEdits(text, modify(text, ["tasks", -1], def, { formattingOptions: FORMAT, isArrayInsertion: true }));
  }
  await writeFileInRoot(root, join(root, TASKS_REL), text.endsWith("\n") ? text : text + "\n");
  return defs.map((d) => ({ label: d.label, sha256: jsonSha(d) }));
}

/** Current hash of each owned task label (missing ⇒ ""). */
export async function currentTaskHashes(root: string, labels: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const tasks: TaskDef[] = await readTasks(root).then(
    (r) => r.tasks,
    () => [],
  );
  for (const label of labels) {
    const t = tasks.find((x) => x?.label === label);
    out.set(label, t ? jsonSha(t) : "");
  }
  return out;
}

/** Read a provider's hook config: the event map (Claude: under `hooks`; Codex: the root) + the whole doc. */
async function readHookConfig(
  root: string,
  provider: Provider,
): Promise<{ doc: Record<string, unknown>; events: Record<string, HookGroup[]> }> {
  const buf = await readRel(root, HOOK_CONFIG_REL[provider]);
  const doc = buf ? (parseJsonc(buf.toString("utf8"), HOOK_CONFIG_REL[provider]) as Record<string, unknown> | null) ?? {} : {};
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Error(`invalid ${HOOK_CONFIG_REL[provider]}`);
  const raw = provider === "claude" ? doc.hooks : doc;
  const events: Record<string, HookGroup[]> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [event, groups] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(groups)) events[event] = groups as HookGroup[];
    }
  }
  return { doc, events };
}

/** Write a provider's hook config back (dropping now-empty events). */
async function writeHookConfig(
  root: string,
  provider: Provider,
  doc: Record<string, unknown>,
  events: Record<string, HookGroup[]>,
): Promise<void> {
  const clean = Object.fromEntries(Object.entries(events).filter(([, g]) => g.length > 0));
  let next: Record<string, unknown>;
  if (provider === "claude") {
    next = { ...doc };
    if (Object.keys(clean).length) next.hooks = clean;
    else delete next.hooks;
  } else {
    next = clean;
  }
  await writeFileInRoot(root, join(root, HOOK_CONFIG_REL[provider]), JSON.stringify(next, null, 2) + "\n");
}

/** Append hook groups to each provider's config (an identical group already present is not duplicated). */
export async function addHookGroups(root: string, groups: OwnedHookGroup[]): Promise<void> {
  for (const provider of ["claude", "codex"] as Provider[]) {
    const mine = groups.filter((g) => g.provider === provider);
    if (mine.length === 0) continue;
    const { doc, events } = await readHookConfig(root, provider);
    for (const g of mine) {
      const list = (events[g.event] ??= []);
      if (!list.some((x) => sameJson(x, g.group))) list.push(g.group);
    }
    await writeHookConfig(root, provider, doc, events);
  }
}

/** Remove exactly the recorded hook groups (deep-equal) from each provider's config. */
export async function removeHookGroups(root: string, groups: OwnedHookGroup[]): Promise<void> {
  for (const provider of ["claude", "codex"] as Provider[]) {
    const mine = groups.filter((g) => g.provider === provider);
    if (mine.length === 0) continue;
    let state;
    try {
      state = await readHookConfig(root, provider);
    } catch {
      continue; // a broken config is left for the user to fix
    }
    for (const g of mine) {
      const list = state.events[g.event];
      if (!list) continue;
      const idx = list.findIndex((x) => sameJson(x, g.group));
      if (idx >= 0) list.splice(idx, 1);
    }
    await writeHookConfig(root, provider, state.doc, state.events);
  }
}

/** Which recorded hook groups are missing from their provider config (edited/removed ⇒ drift). */
export async function missingHookGroups(root: string, groups: OwnedHookGroup[]): Promise<OwnedHookGroup[]> {
  const missing: OwnedHookGroup[] = [];
  for (const provider of ["claude", "codex"] as Provider[]) {
    const mine = groups.filter((g) => g.provider === provider);
    if (mine.length === 0) continue;
    const events: Record<string, HookGroup[]> = await readHookConfig(root, provider).then(
      (r) => r.events,
      () => ({}),
    );
    for (const g of mine) if (!(events[g.event] ?? []).some((x) => sameJson(x, g.group))) missing.push(g);
  }
  return missing;
}
