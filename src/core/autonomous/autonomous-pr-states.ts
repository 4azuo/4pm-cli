/**
 * PR states of the autonomous deliveries — the request PRs (lineage `delivery`), DOC PRs (docs `pr`) and AI Done
 * `Delivery` cells the merge gates read. Looked up by head branch (host CLI first, else git), written onto the books
 * branch by the cycle's housekeeping, and by a PR-only refresh on every tick the cycle itself does not reach (paused,
 * blocked, quiet hours, max ticks, offline, another cycle running) — in a temporary books worktree, no repo lock, no
 * tokens. The same refresh advances root PRs that wait for submodule PRs (pointer moves, draft → ready, pointer-only
 * merge). The AI Done delivery records (root + submodule PRs, mergeability, merge commits) are refreshed with them.
 * @adr 0575 @adr 0563 @adr 0579 @adr 0582
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WsChannels } from "@4pm/ws";
import { POINTERS_SIDECAR_REL, deliveryCell, parsePointers, type DeliveryState } from "@4pm/dto";
import type { WsHandlerCtx } from "../ws-client/context";
import { prStateOf } from "../git/git-host";
import { lifecycle } from "../session/lifecycle";
import { work } from "../session/work-tracker";
import * as B from "./autonomous-books";
import { readDocs, readLineage, writeDocs, writeLineage } from "./autonomous-docs";
import { git, gitQuiet, mutateBooks, readBooksFile, resolveBases, type RepoBase } from "./autonomous-git";
import { advancePointers, applyPointerAdvance, type PointerAdvance } from "./autonomous-submodules";
import { deliveryRecordStates, recordDeliveries, type DeliveryRefreshCtx } from "./autonomous-delivery";
import type { DoneDelivery } from "@4pm/dto";

/** A tick-log line writer. */
export type PrLog = (line: string) => Promise<void> | void;

/**
 * The state of `branch`'s PR into `base` by git alone, null when git cannot tell (remote unreachable): a branch gone
 * from the remote is merged; else `base` and the branch are fetched one by one and the branch is merged when its tip
 * is in `origin/<base>` or merging it changes nothing (squash / rebase merges — `merge-tree --write-tree`, git ≥ 2.38).
 */
export async function gitPrState(cwd: string, branch: string, base: string): Promise<DeliveryState | null> {
  let heads: string;
  try {
    heads = await git(cwd, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], 60_000);
  } catch {
    return null;
  }
  if (!heads.trim()) return "merged";
  await gitQuiet(cwd, ["fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  await gitQuiet(cwd, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const ancestor = await git(cwd, ["merge-base", "--is-ancestor", `origin/${branch}`, `origin/${base}`]).then(
    () => true,
    () => false,
  );
  if (ancestor) return "merged";
  const baseTree = (await gitQuiet(cwd, ["rev-parse", `origin/${base}^{tree}`])).trim();
  const merged = (await gitQuiet(cwd, ["merge-tree", "--write-tree", `origin/${base}`, `origin/${branch}`])).split("\n")[0]?.trim();
  return baseTree && merged === baseTree ? "merged" : "open";
}

/**
 * The newest state of a PR by its head branch: the host CLI first (gh / glab); when it cannot tell (unknown host, no
 * login, CLI error) git decides (`gitPrState`). `note` hears when the host CLI gave no answer.
 */
export async function prState(url: string, branch: string, cwd?: string, base?: string, note?: (line: string) => void): Promise<DeliveryState | null> {
  const s = await prStateOf(url, branch).catch(() => null);
  if (s === "merged" || s === "closed" || s === "open") return s;
  if (!cwd || !base) return null;
  const g = await gitPrState(cwd, branch, base);
  note?.(`host CLI gave no answer — git says ${g ?? "unknown"}`);
  return g;
}

/** PR states looked up for one books publish. */
export interface DeliveryStates {
  /** lineage group → state of its request PR. */
  lineage: Map<string, DeliveryState>;
  /** DOC id → state of its PR. */
  docs: Map<string, DeliveryState>;
  /** AI Done id → its new Delivery cell. */
  done: Map<string, string>;
  /** Rows whose PR was closed without merge (id → url). */
  closed: Map<string, string>;
  /** AI Done delivery records that changed or were seeded (id → record). @adr 0582 */
  records: Map<string, DoneDelivery>;
  /** Tick-log lines: each state change and each host CLI that gave no answer. */
  notes: string[];
}

/** One lookup cache shared by the attempts of one publish (a retried publish asks the host only once). */
export type PrStateCache = Map<string, DeliveryState | null>;

/** `PR #n` of a PR url, else the branch. */
function prLabel(url: string | undefined, branch: string): string {
  const n = /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(url ?? "")?.[1];
  return n ? `PR #${n}` : branch;
}

/**
 * Look up the PR states of every open delivery (request PRs, DOC PRs, AI Done rows) in `bdir`, at most 30 per call.
 * With `repos` (the project root + submodules) the AI Done delivery records are refreshed too, from the same budget;
 * a row with a record takes its `Delivery` from the record's root entry.
 */
export async function deliveryStates(bdir: string, rootBase: RepoBase, cache: PrStateCache = new Map(), repos?: DeliveryRefreshCtx): Promise<DeliveryStates> {
  const out: DeliveryStates = { lineage: new Map(), docs: new Map(), done: new Map(), closed: new Map(), records: new Map(), notes: [] };
  let budget = 30;
  const stateOf = async (id: string, branch: string): Promise<DeliveryState | null> => {
    if (cache.has(branch)) return cache.get(branch)!;
    if (budget-- <= 0) return null;
    const s = await prState(rootBase.url, branch, bdir, rootBase.base, (line) => out.notes.push(`[pr] ${id}: ${line}`));
    cache.set(branch, s);
    return s;
  };
  for (const [g, e] of Object.entries(await readLineage(bdir))) {
    if (e.delivery?.state !== "open") continue;
    const s = await stateOf(e.source, e.delivery.branch);
    if (s && s !== "open") {
      out.lineage.set(g, s);
      out.notes.push(`[pr] ${e.source} ${prLabel(e.delivery.url, e.delivery.branch)} → ${s}`);
      if (s === "closed") out.closed.set(e.source, e.delivery.url ?? "");
    }
  }
  for (const [id, e] of Object.entries(await readDocs(bdir))) {
    if (e.pr?.state !== "open") continue;
    const s = await stateOf(id, e.pr.branch);
    if (s && s !== "open") {
      out.docs.set(id, s);
      out.notes.push(`[pr] ${id} ${prLabel(e.pr.url, e.pr.branch)} → ${s}`);
      if (s === "closed") out.closed.set(id, e.pr.url ?? "");
    }
  }
  const rec = repos ? await deliveryRecordStates(bdir, repos, () => budget-- > 0, gitPrState) : null;
  if (rec) {
    out.records = rec.updates;
    out.notes.push(...rec.notes);
  }
  for (const r of B.openDeliveries(await B.readBook(bdir, "AI_DONE.md"))) {
    const recorded = rec?.rootStates.get(r.id);
    if (recorded) {
      if (recorded !== "open") out.done.set(r.id, deliveryCell(recorded));
      continue;
    }
    const branch = /branch:\s*([^\s;]+)/.exec(r.notes)?.[1];
    if (!branch) continue;
    const s = await stateOf(r.id, branch);
    if (s && s !== "open") {
      out.done.set(r.id, deliveryCell(s));
      out.notes.push(`[pr] ${r.id} ${branch} → ${s}`);
    }
  }
  return out;
}

/** Write the looked-up PR states into the books checkout `bdir` (inside a books publish). True when anything changed. */
export async function applyDeliveryStates(bdir: string, s: DeliveryStates): Promise<boolean> {
  let changed = false;
  if (s.lineage.size) {
    const lin = await readLineage(bdir);
    for (const [g, st] of s.lineage) {
      const e = lin[g];
      if (e?.delivery) lin[g] = { ...e, delivery: { ...e.delivery, state: st } };
    }
    await writeLineage(bdir, lin);
    changed = true;
  }
  if (s.docs.size) {
    const docs = await readDocs(bdir);
    for (const [id, st] of s.docs) {
      const e = docs[id];
      if (e?.pr) docs[id] = { ...e, pr: { ...e.pr, state: st } };
    }
    await writeDocs(bdir, docs);
    changed = true;
  }
  if (s.records.size) {
    await recordDeliveries(bdir, s.records);
    changed = true;
  }
  if (s.done.size) {
    const md = await B.readBook(bdir, "AI_DONE.md");
    const next = B.setDoneDelivery(md, s.done);
    if (next !== md) {
      await B.writeBook(bdir, "AI_DONE.md", next);
      changed = true;
    }
  }
  return changed;
}

/** Tell the managers once that a request / DOC PR was closed without merge (its group waits until Retry). */
export function alertClosedPrs(ctx: WsHandlerCtx, s: DeliveryStates): void {
  for (const [id] of s.closed) {
    try {
      ctx.send(WsChannels.AUTONOMOUS_ALERT, { kind: "pr-closed", task: id, message: `The PR of ${id} was closed without merge — its group waits until Retry.` });
    } catch {
      // best-effort
    }
  }
}

/**
 * Advance the root PRs that wait for submodule PRs from the pointers sidecar text: the host / git side effects run
 * now; `applyPointerAdvance` writes the result inside the books publish.
 */
export async function pointerAdvance(ctx: WsHandlerCtx, root: string, rootBase: RepoBase, sidecarText: string | null): Promise<PointerAdvance> {
  const sidecar = parsePointers(sidecarText);
  if (!Object.keys(sidecar).length) return { updates: new Map(), notes: [] };
  return advancePointers(root, rootBase, sidecar, prState, (kind, task, message) => {
    try {
      ctx.send(WsChannels.AUTONOMOUS_ALERT, { kind, task, message });
    } catch {
      // best-effort
    }
  });
}

/** One PR refresh at a time per cli. */
let refreshing = false;

/**
 * The PR-only refresh of a tick the cycle does not reach: look up the open deliveries on the books branch and write
 * their new states in a temporary books worktree (the main working tree is never touched). Skipped while the daemon
 * drains, without a served cloned project or a known `<base>`, and while another refresh runs. No tick is counted and
 * *Last check* is left alone.
 * @adr 0575
 */
export async function refreshPrStates(ctx: WsHandlerCtx, log: PrLog): Promise<void> {
  const root = ctx.physicRoot;
  if (refreshing || !root || lifecycle.stopping || !existsSync(join(root, ".git"))) return;
  refreshing = true;
  const lease = work.begin("gitOp", "autonomous-pr-refresh");
  try {
    const bases = await resolveBases(root);
    const rootBase = bases.root;
    if (!rootBase.base) return;
    const cache: PrStateCache = new Map();
    let states: DeliveryStates | null = null;
    const ptr = await pointerAdvance(ctx, root, rootBase, await readBooksFile(root, rootBase.base, POINTERS_SIDECAR_REL));
    for (const line of ptr.notes) await log(line);
    const res = await mutateBooks(root, rootBase.base, "chore(auto): PR states", async (dir) => {
      states = await deliveryStates(dir, rootBase, cache, { root, rootBase, subs: bases.subs });
      const a = await applyDeliveryStates(dir, states);
      const b = await applyPointerAdvance(dir, ptr);
      return a || b;
    });
    const done = states as DeliveryStates | null;
    if (!done) return;
    for (const line of done.notes) await log(line);
    if (res === "pushed") {
      await log("[books] PR states published (refresh outside the cycle)");
      alertClosedPrs(ctx, done);
    } else if (res === "failed") {
      await log("[warn] PR refresh: the books push failed");
    }
  } catch (err) {
    await log(`[warn] PR refresh: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    lease.end();
    refreshing = false;
  }
}
