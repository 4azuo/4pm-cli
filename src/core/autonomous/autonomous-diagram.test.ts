/**
 * Tests for the project system diagram on real temp git repos (a bare remote + a clone): a web change request is
 * auto-applied under `diagramAutoApprove` (the default) and waits for a person when the policy turns it off,
 * approve = apply (`diagram: v<N>` commits), a move and a relabel of the same cell merge, the same field
 * conflicts, intake numbers + applies the agent's change request, an open one blocks its group, and the ER's
 * `erAutoApprove` applies a saved ERC at once.
 * @adr 0530
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_AUTONOMOUS_SETTINGS } from "@4pm/dto";
import { blockedDiagramGroups, publishIntakeSdcs, readDiagram, writeDiagram } from "./autonomous-diagram";
import { writeEr } from "./autonomous-er";
import { syncBooks } from "./autonomous-git";
import { resetApprovalTrustForTest } from "./autonomous-approvals";
import { resetAutonomousPolicyForTest, setAutonomousPolicy } from "./autonomous-policy";

const BOOKS = "autonomous-books/main";

let tmp: string;
let remote: string;
let root: string;
let profile: string;

/** Run git in `cwd` (identity fixed). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** Set the project policy with some auto-approve flags. */
function policy(over: { diagramAutoApprove?: boolean; erAutoApprove?: boolean }): void {
  setAutonomousPolicy({ projectEnabled: true, allowed: true, settings: { ...DEFAULT_PROJECT_AUTONOMOUS_SETTINGS, ...over } });
}

/** A billing module with the service at (x, 40) labelled `label`. */
function billing(label = "Billing", x = 40): string {
  return `<mxfile><diagram id="p1" name="Runtime"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />
<object id="svc-billing" label="${label}" kind="service"><mxCell vertex="1" parent="1" style="rounded=1;whiteSpace=wrap;html=1;"><mxGeometry x="${x}" y="40" width="160" height="60" as="geometry" /></mxCell></object>
</root></mxGraphModel></diagram></mxfile>`;
}

/** Save a web change request on module `billing`. */
function save(content: string, baseVersion: number, by = "u1") {
  return writeDiagram(root, profile, { kind: "save", title: "t", module: "billing", modules: [{ name: "billing", content }], baseVersion, by });
}

/** Approve a change request (legacy mode — no signing keys). */
function approve(id: string, by = "u2") {
  return writeDiagram(root, profile, { kind: "decide", id, decision: "approve", by });
}

beforeEach(() => {
  resetApprovalTrustForTest();
  resetAutonomousPolicyForTest();
  tmp = mkdtempSync(join(tmpdir(), "4pm-diagram-"));
  remote = join(tmp, "remote.git");
  root = join(tmp, "work");
  profile = join(tmp, "profile");
  mkdirSync(profile);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, root]);
  g(root, "checkout", "-q", "-b", "main");
  writeFileSync(join(root, "app.ts"), "v1\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "push", "-q", "origin", "main");
});
afterEach(() => {
  resetAutonomousPolicyForTest();
  rmSync(tmp, { recursive: true, force: true });
});

describe("system-diagram change requests", () => {
  it("auto-applies a web save by default", async () => {
    policy({});
    expect(await save(billing(), 0)).toMatchObject({ ok: true, id: "SDC-1", state: "applied", version: 1 });
    expect(g(remote, "log", "-1", "--format=%s", BOOKS)).toContain("diagram: v1 (SDC-1)");
    expect(g(remote, "show", `${BOOKS}:.4pm/diagrams/billing.drawio`)).toContain('id="svc-billing"');
    expect(() => g(remote, "show", "main:.4pm/diagrams/billing.drawio")).toThrow();
    const read = await readDiagram(root, profile, {});
    expect(read).toMatchObject({ currentVersion: 1, autoApprove: true });
    expect(read.history[0]).toMatchObject({ sdc: "SDC-1", approvedBy: "auto" });
  });

  it("waits for a person when auto-approve is off; merges a move with a relabel; conflicts on the same field", async () => {
    policy({ diagramAutoApprove: false });
    expect(await save(billing(), 0)).toMatchObject({ ok: true, id: "SDC-1", state: "pending" });
    expect(await approve("SDC-1", "u1")).toMatchObject({ ok: false, code: "APPROVAL_SELF" });
    expect(await approve("SDC-1")).toMatchObject({ ok: true, state: "applied", version: 1 });
    // From v1: a relabel, a move, another relabel of the same cell.
    expect(await save(billing("Billing API"), 1)).toMatchObject({ id: "SDC-2", state: "pending" });
    expect(await save(billing("Billing", 300), 1)).toMatchObject({ id: "SDC-3" });
    expect(await save(billing("Payments"), 1)).toMatchObject({ id: "SDC-4", overlaps: ["SDC-2", "SDC-3"] });
    expect(await approve("SDC-2")).toMatchObject({ ok: true, version: 2 });
    expect(await approve("SDC-3")).toMatchObject({ ok: true, version: 3 });
    expect(await approve("SDC-4")).toMatchObject({ ok: false, code: "DIAGRAM_CHANGE_CONFLICT", state: "conflict", meta: { conflictsWith: ["SDC-2", "SDC-3"], cells: ["svc-billing"] } });
    const file = (await readDiagram(root, profile, {})).modules[0]!.content;
    expect(file).toContain('label="Billing API"');
    expect(file).toContain('x="300"');
    expect((await readDiagram(root, profile, { version: 1 })).modules[0]!.content).toContain('x="40"');
    expect(await save("<mxfile><diagram name='P'>abc</diagram></mxfile>", 3)).toMatchObject({ ok: false, code: "DIAGRAM_INVALID" });
  });
});

describe("autonomous hooks", () => {
  it("numbers + auto-applies an intake change request, and blocks the group while one is open", async () => {
    policy({ diagramAutoApprove: false });
    await save(billing(), 0);
    await approve("SDC-1");
    const { dir } = await syncBooks(root, "main");
    const sdc =
      '# Queue\n\n```json sd-meta\n{"title":"Queue","source":"intake","group":"TSK-000007","module":"billing","page":"Runtime"}\n```\n\n```xml\n<mxGraphModel><root><object id="queue-invoices" label="invoices" kind="queue"><mxCell vertex="1" parent="1" /></object><object id="l-b-q" kind="event"><mxCell edge="1" parent="1" source="svc-billing" target="queue-invoices" /></object></root></mxGraphModel>\n```\n\nWhy.\n';
    const manual = await publishIntakeSdcs(dir, { diagramDir: ".4pm/diagrams", diagramAutoApprove: false }, [{ name: "SDC-NEW-1.md", content: sdc }]);
    expect(manual).toMatchObject({ created: ["SDC-2"], skipped: [] });
    expect(readFileSync(join(dir, ".4pm/diagrams/billing.drawio"), "utf8")).toContain("svc-billing");
    expect(readFileSync(join(dir, ".4pm/diagrams/changes/SDC-2.md"), "utf8")).toContain('"baseVersion": 1');
    expect([...(await blockedDiagramGroups(dir, ".4pm/diagrams"))]).toEqual(["TSK-000007"]);
    // Same intake under auto-approve: applied at once, nothing new blocks, the new cell is placed.
    const auto = sdc.replace("TSK-000007", "TSK-000008").replace(/queue-invoices/g, "queue-b").replace("l-b-q", "l-b-q2");
    await publishIntakeSdcs(dir, { diagramDir: ".4pm/diagrams", diagramAutoApprove: true }, [{ name: "SDC-NEW-1.md", content: auto }]);
    expect([...(await blockedDiagramGroups(dir, ".4pm/diagrams"))]).toEqual(["TSK-000007"]);
    const placed = readFileSync(join(dir, ".4pm/diagrams/billing.drawio"), "utf8");
    expect(placed).toMatch(/id="queue-b"[\s\S]*?<mxGeometry x="40" y="160"/);
  });

  it("applies a saved ERC at once under erAutoApprove", async () => {
    policy({ erAutoApprove: true });
    const content = "# billing\n\n```mermaid\nerDiagram\n  ORDER {\n    uuid id PK\n  }\n```\n";
    expect(await writeEr(root, profile, { kind: "save", title: "t", module: "billing", modules: [{ name: "billing", content }], baseVersion: 0, by: "u1" })).toMatchObject({
      ok: true,
      id: "ERC-1",
      state: "applied",
      version: 1,
    });
    expect(g(remote, "log", "-1", "--format=%s", BOOKS)).toContain("er: v1 (ERC-1)");
  });
});
