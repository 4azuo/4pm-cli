/**
 * Tests for the project ER on real temp git repos (a bare remote + a clone): web change requests are
 * published on the books branch, approve = apply (`er: v<N>` commits), a change on other attributes merges,
 * the same attribute conflicts, the author cannot approve, a past version reads from git, intake numbers the
 * agent's change requests and an open change request blocks its task group.
 * @adr 0453
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockedErGroups, prepareIntakeEr, readEr, writeEr } from "./autonomous-er";
import { syncBooks } from "./autonomous-git";
import { resetApprovalTrustForTest } from "./autonomous-approvals";

const BOOKS = "autonomous-books/main";

let tmp: string;
let remote: string;
let root: string;
let profile: string;

/** Run git in `cwd` (identity fixed). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** A module text holding one erDiagram. */
function moduleText(body: string): string {
  return `# billing\n\n\`\`\`mermaid\nerDiagram\n${body}\n\`\`\`\n`;
}

/** Save a web change request on module `billing`. */
function save(body: string, baseVersion: number, by = "u1", id?: string) {
  return writeEr(root, profile, { kind: "save", ...(id ? { id } : {}), title: "t", module: "billing", modules: [{ name: "billing", content: moduleText(body) }], baseVersion, by });
}

/** Approve a change request (legacy mode — no signing keys). */
function approve(id: string, by = "u2") {
  return writeEr(root, profile, { kind: "decide", id, decision: "approve", by });
}

beforeEach(() => {
  resetApprovalTrustForTest();
  tmp = mkdtempSync(join(tmpdir(), "4pm-er-"));
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
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("ER change requests", () => {
  it("proposes, applies, merges and conflicts on the books branch", async () => {
    const s1 = await save("  ORDER {\n    uuid id PK\n    int total\n  }", 0);
    expect(s1).toMatchObject({ ok: true, id: "ERC-1", state: "pending" });
    expect(await approve("ERC-1", "u1")).toMatchObject({ ok: false, code: "APPROVAL_SELF" });
    expect(await approve("ERC-1")).toMatchObject({ ok: true, state: "applied", version: 1 });
    expect(g(remote, "log", "-1", "--format=%s", BOOKS)).toBe("er: v1 (ERC-1)");
    expect(g(remote, "show", `${BOOKS}:.4pm/er/billing.md`)).toContain("int total");
    expect(g(remote, "show", `${BOOKS}:.4pm/er/index.md`)).toContain("billing.md");
    // `main` never carries the ER.
    expect(() => g(remote, "show", "main:.4pm/er/billing.md")).toThrow();

    // Three edits from v1: total "gross", total "net", a new attribute.
    const base = "  ORDER {\n    uuid id PK\n    int total\n  }";
    expect(await save(base.replace("int total", 'int total "gross"'), 1)).toMatchObject({ id: "ERC-2" });
    const s3 = await save(base.replace("int total", 'int total "net"'), 1);
    expect(s3).toMatchObject({ id: "ERC-3", overlaps: ["ERC-2"] });
    expect(await save(`${base.replace("  }", "    string note\n  }")}`, 1)).toMatchObject({ id: "ERC-4" });

    expect(await approve("ERC-2")).toMatchObject({ ok: true, version: 2 });
    expect(await approve("ERC-3")).toMatchObject({ ok: false, code: "ER_CHANGE_CONFLICT", state: "conflict", meta: { conflictsWith: ["ERC-2"], entities: ["ORDER"] } });
    expect(await approve("ERC-4")).toMatchObject({ ok: true, version: 3 });

    const read = await readEr(root, profile, {});
    expect(read.currentVersion).toBe(3);
    const billing = read.modules.find((m) => m.name === "billing")!.content;
    expect(billing).toContain('int total "gross"');
    expect(billing).toContain("string note");
    expect(read.changes.find((c) => c.id === "ERC-3")?.state).toBe("conflict");
    expect(read.history.map((h) => h.erc)).toEqual(["ERC-4", "ERC-2", "ERC-1"]);
    expect(read.history[0]?.commit).toMatch(/^[0-9a-f]{40}$/);

    const v1 = await readEr(root, profile, { version: 1 });
    expect(v1.modules.find((m) => m.name === "billing")!.content).not.toContain("note");
    expect((await readEr(root, profile, { version: 9 })).error).toBe("unknown ER version");
  });

  it("rejects, withdraws and refuses a stale decision", async () => {
    await save("  A {\n    uuid id PK\n  }", 0);
    expect(await writeEr(root, profile, { kind: "decide", id: "ERC-1", decision: "reject", reason: "no", by: "u2" })).toMatchObject({ ok: true, state: "rejected" });
    expect(await approve("ERC-1")).toMatchObject({ ok: false, code: "ER_CHANGE_STALE" });
    expect(await writeEr(root, profile, { kind: "withdraw", id: "ERC-1", by: "u3" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await writeEr(root, profile, { kind: "withdraw", id: "ERC-1", by: "u1" })).toMatchObject({ ok: true, state: "withdrawn" });
    expect(await save("  A {\n    uuid id PK\n  }", 0, "u1", "ERC-1")).toMatchObject({ ok: false, code: "ER_CHANGE_STALE" });
    expect(await save("  A {\n    uuid id PK\n  ", 0)).toMatchObject({ ok: false, code: "ER_CHANGE_INVALID" });
  });
});

describe("autonomous hooks", () => {
  it("numbers an intake change request, restores the approved files and blocks the group", async () => {
    await save("  ORDER {\n    uuid id PK\n  }", 0);
    await approve("ERC-1");
    await syncBooks(root, "main");
    // The agent edits an approved module (reverted) and writes a new change request.
    writeFileSync(join(root, ".4pm/er/billing.md"), "tampered\n");
    mkdirSync(join(root, ".4pm/er/changes"), { recursive: true });
    writeFileSync(
      join(root, ".4pm/er/changes/ERC-NEW-1.md"),
      '# Vouchers\n\n```json er-meta\n{"title":"Vouchers","source":"intake","group":"TSK-000007","module":"billing"}\n```\n\n```mermaid\nerDiagram\n  VOUCHER { uuid id PK }\n  ORDER ||--o{ VOUCHER : uses\n```\n\nWhy.\n',
    );
    const out = await prepareIntakeEr(root, `origin/${BOOKS}`, ".4pm/er");
    expect(out).toMatchObject({ created: ["ERC-2"], skipped: [], tampered: true });
    expect(readFileSync(join(root, ".4pm/er/billing.md"), "utf8")).toContain("ORDER");
    const erc = readFileSync(join(root, ".4pm/er/changes/ERC-2.md"), "utf8");
    expect(erc).toContain('"baseVersion": 1');
    expect(erc).toContain('"ORDER": 1');
    expect([...(await blockedErGroups(root, ".4pm/er"))]).toEqual(["TSK-000007"]);
  });
});
