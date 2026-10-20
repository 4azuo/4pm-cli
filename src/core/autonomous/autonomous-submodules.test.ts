/**
 * Tests of the submodule follow-up on real local repos: a squash-merged submodule PR moves the root branch's pointer to
 * the commit on the submodule's base (no working tree touched), a pointer-only root PR is recognized, a closed
 * submodule PR alerts once, and a merged root PR drops its entry.
 * @adr 0579
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeliveryState, PointersSidecar } from "@4pm/dto";
import { advancePointers, pointerOnly, type PrStateLookup } from "./autonomous-submodules";

let tmp: string;

/** Run git in a dir (identity set, quiet, local file submodules allowed). */
function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "4pm-subs-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A root repo with a `docs` submodule, and a row branch in both whose root commit only bumps the pointer. */
function setup(): { work: string; sub: string; subOrigin: string; branch: string } {
  const subOrigin = join(tmp, "docs.git");
  const rootOrigin = join(tmp, "root.git");
  const seed = join(tmp, "seed");
  sh(tmp, "init", "-q", "--bare", "-b", "main", subOrigin);
  sh(tmp, "init", "-q", "--bare", "-b", "main", rootOrigin);
  sh(tmp, "clone", "-q", subOrigin, seed);
  writeFileSync(join(seed, "README.md"), "docs\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "-m", "base");
  sh(seed, "push", "-q", "origin", "HEAD:main");
  const work = join(tmp, "work");
  sh(tmp, "clone", "-q", rootOrigin, work);
  sh(work, "submodule", "add", "-q", "-b", "main", subOrigin, "docs");
  sh(work, "commit", "-q", "-m", "root base");
  sh(work, "push", "-q", "origin", "HEAD:main");
  const branch = "dev/main/GRP-000004/TSK-000004-001";
  const sub = join(work, "docs");
  sh(sub, "checkout", "-q", "-b", branch);
  writeFileSync(join(sub, "a.md"), "# a\n");
  sh(sub, "add", "-A");
  sh(sub, "commit", "-q", "-m", "a");
  sh(sub, "push", "-q", "origin", branch);
  sh(work, "checkout", "-q", "-b", branch);
  sh(work, "add", "docs");
  sh(work, "commit", "-q", "-m", "pointer");
  sh(work, "push", "-q", "origin", branch);
  return { work, sub, subOrigin, branch };
}

describe("submodule pointer follow-up", () => {
  it("moves the pointer to the squash commit on the submodule's base and sees a pointer-only root PR", async () => {
    const { work, sub, subOrigin, branch } = setup();
    // The submodule PR is squash-merged: a new commit on main, the branch tip is not in main.
    sh(sub, "checkout", "-q", "main");
    sh(sub, "merge", "-q", "--squash", branch);
    sh(sub, "commit", "-q", "-m", "squash a");
    sh(sub, "push", "-q", "origin", "main");
    const squash = sh(sub, "rev-parse", "HEAD").trim();
    expect(await pointerOnly(work, "main", branch)).toBe(true);
    const sidecar: PointersSidecar = {
      [branch]: { id: "TSK-000004-001", base: "main", subs: [{ dir: "docs", url: subOrigin, branch, base: "main", state: "open" }] },
    };
    const states: Record<string, DeliveryState> = { [`${subOrigin} ${branch}`]: "merged" };
    const lookup: PrStateLookup = async (url, b) => states[`${url} ${b}`] ?? "open";
    const alerts: string[] = [];
    const adv = await advancePointers(work, { dir: "", url: join(tmp, "root.git"), base: "main" }, sidecar, lookup, (k) => alerts.push(k));
    const e = adv.updates.get(branch)!;
    expect(e.subs[0]).toMatchObject({ state: "merged", sha: squash, pointed: true });
    sh(work, "fetch", "-q", "origin", branch);
    expect(sh(work, "ls-tree", `origin/${branch}`, "docs").split(/\s+/)[2]).toBe(squash);
    // The worker's own checkout is untouched.
    expect(sh(work, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
    expect(alerts).toEqual([]);
    // Still pointer-only after the move.
    expect(await pointerOnly(work, "main", branch)).toBe(true);
  });

  it("alerts once for a closed submodule PR and drops the entry once the root PR is merged", async () => {
    const { work, subOrigin, branch } = setup();
    const rootUrl = join(tmp, "root.git");
    const sidecar: PointersSidecar = {
      [branch]: { id: "TSK-000004-001", base: "main", subs: [{ dir: "docs", url: subOrigin, branch, base: "main", state: "open" }] },
    };
    const states: Record<string, DeliveryState> = { [`${subOrigin} ${branch}`]: "closed" };
    const lookup: PrStateLookup = async (url, b) => states[`${url} ${b}`] ?? "open";
    const alerts: string[] = [];
    const adv = await advancePointers(work, { dir: "", url: rootUrl, base: "main" }, sidecar, lookup, (k) => alerts.push(k));
    const e = adv.updates.get(branch)!;
    expect(e.subs[0]!.state).toBe("closed");
    expect(e.alerted).toEqual(["submodule-pr-closed:docs"]);
    expect(alerts).toEqual(["submodule-pr-closed"]);
    // Again with the stored entry: no second alert.
    const again = await advancePointers(work, { dir: "", url: rootUrl, base: "main" }, { [branch]: e }, lookup, (k) => alerts.push(k));
    expect(again.updates.size).toBe(0);
    expect(alerts).toHaveLength(1);
    states[`${rootUrl} ${branch}`] = "merged";
    const done = await advancePointers(work, { dir: "", url: rootUrl, base: "main" }, { [branch]: e }, lookup, () => undefined);
    expect(done.updates.get(branch)).toBeNull();
  });
});
