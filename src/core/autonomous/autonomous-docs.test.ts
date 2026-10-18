/**
 * Tests of the DOC phase book transitions: a DOC row per new task group (root tasks depend on it), the lineage of
 * an intake, a finished round parked in review, the review (revise ⇒ runnable again, proceed ⇒ AI Done; a stale
 * round refused), the overlaps, the implement note and the numbering of new numbered docs on a real repo.
 * @adr 0536 @adr 0537
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocsSidecar, parseLineage, readSpecDocs, type DocsSidecar } from "@4pm/dto";
import * as B from "./autonomous-books";
import {
  addDocRows,
  applyDocReview,
  applyDocRoundDone,
  docManifest,
  docOverlaps,
  docRunnable,
  implementDocsNote,
  intakeSources,
  numberNewDocs,
  recordIntakeLineage,
} from "./autonomous-docs";

const TODO_HEAD = "| ID | Priority | Tag | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n";
const DONE = "## Done\n\n| Timestamp | ID | Group | Depends | Task description | Files | Evidence | Notes |\n|---|---|---|---|---|---|---|---|\n\n## Incidents\n\n| Timestamp | Note |\n|---|---|\n";
const SPEC = { types: ["adr", "api"], org: "" };

let root: string;

/** A file under the project root. */
function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "4pm-docs-"));
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, "AI_DONE.md"), DONE);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("DOC rows after an intake", () => {
  it("adds one DOC row per new group before its first task and links the root tasks", async () => {
    writeFileSync(
      join(root, "AI_TODO.md"),
      `${TODO_HEAD}| TSK-000001-001 | Medium | | | g | Old task | |\n| TSK-000007-001 | High | | | Login | Add API | size: S |\n| TSK-000007-002 | Medium | | TSK-000007-001 | Login | Add UI | size: M |\n`,
    );
    const added = await addDocRows(root, new Set(["TSK-000001-001"]), SPEC, () => ({ id: "REQ-000005-001", request: "Users can log in", team: "", tags: "", due: "" }));
    expect(added).toEqual(["DOC-000007-001"]);
    const { tasks } = B.parseTasks(read("AI_TODO.md"));
    expect(tasks.map((t) => t.id)).toEqual(["TSK-000001-001", "DOC-000007-001", "TSK-000007-001", "TSK-000007-002"]);
    const doc = tasks.find((t) => t.id === "DOC-000007-001")!;
    expect(doc).toMatchObject({ priority: "High", tag: "docs", desc: "Docs for REQ-000005-001: Users can log in", notes: "doc types: adr, api" });
    expect(tasks.find((t) => t.id === "TSK-000007-001")!.depends).toEqual(["DOC-000007-001"]);
    // A task that already depends on a task of the group waits through it.
    expect(tasks.find((t) => t.id === "TSK-000007-002")!.depends).toEqual(["TSK-000007-001"]);
    // Running it again adds nothing.
    expect(await addDocRows(root, new Set(["TSK-000001-001"]), SPEC, () => undefined)).toEqual([]);
  });

  it("records the lineage of the groups the intake used", async () => {
    const userTodo = "| ID | Team | Group | Depends | Request |\n|---|---|---|---|---|\n| REQ-000005-001 | FE | | | Users can log in |\n";
    const sources = intakeSources(["REQ-000005-001"], userTodo, "");
    await recordIntakeLineage(root, sources, [7, 8], new Set(["000007"]));
    const lin = parseLineage(read(".claude/.autonomous.lineage.json"));
    expect(Object.keys(lin)).toEqual(["000007"]);
    expect(lin["000007"]).toMatchObject({ source: "REQ-000005-001", request: "Users can log in", team: "FE" });
  });
});

describe("DOC rounds and reviews", () => {
  const doc: B.TaskRow = { id: "DOC-000007-001", priority: "High", tag: "docs", depends: [], group: "Login", desc: "Docs for REQ", notes: "", team: "" };
  const files = [{ path: "docs/adr/0012-login.md", type: "adr", action: "created" as const, number: 12 }];

  beforeEach(async () => {
    writeFileSync(join(root, "AI_TODO.md"), `${TODO_HEAD}| TSK-000007-001 | High | | DOC-000007-001 | Login | Add API | |\n`);
    await applyDocRoundDone(root, doc, { branch: "dev/main/GRP-000007/DOC-000007-001", head: "abc", files });
  });

  it("parks a finished round in review with its manifest", async () => {
    const docs = parseDocsSidecar(read(".claude/.autonomous.docs.json"));
    expect(docs["DOC-000007-001"]).toMatchObject({ round: 1, state: "review", head: "abc", files });
    expect(docRunnable(docs, "DOC-000007-001")).toBe(false);
    expect(B.parseTasks(read("AI_TODO.md")).tasks.map((t) => t.id)).toContain("DOC-000007-001");
  });

  it("revise makes the row runnable again", async () => {
    const r = await applyDocReview(root, { id: "DOC-000007-001", round: 1, decision: "revise", opinion: "Add the error cases" }, true, "u1", "a@x");
    expect(r).toEqual({ ok: true, decided: "revise" });
    const docs = parseDocsSidecar(read(".claude/.autonomous.docs.json"));
    expect(docs["DOC-000007-001"]!.state).toBe("pending");
    expect(docs["DOC-000007-001"]!.history).toEqual([expect.objectContaining({ round: 1, decision: "revise", opinion: "Add the error cases", by: "u1" })]);
  });

  it("proceed moves the DOC to AI Done with its branch", async () => {
    const r = await applyDocReview(root, { id: "DOC-000007-001", round: 1, decision: "proceed", opinion: "" }, true, "u1", "a@x");
    expect(r).toEqual({ ok: true, decided: "proceed" });
    expect(B.parseTasks(read("AI_TODO.md")).tasks.map((t) => t.id)).toEqual(["TSK-000007-001"]);
    expect(B.doneRows(read("AI_DONE.md")).get("DOC-000007-001")).toBe("docs accepted after 1 round(s); branch: dev/main/GRP-000007/DOC-000007-001");
  });

  it("refuses a review of another round", async () => {
    const r = await applyDocReview(root, { id: "DOC-000007-001", round: 2, decision: "proceed", opinion: "" }, true, "u1", "a@x");
    expect(r).toEqual({ ok: false, error: "DOC_ROUND_STALE" });
  });
});

describe("helpers", () => {
  it("finds the files shared with other open DOC rows", () => {
    const docs: DocsSidecar = {
      "DOC-000007-001": { round: 1, state: "review", branch: "b1", files: [{ path: "CHANGELOG.md", type: "changelog", action: "updated" }], history: [] },
      "DOC-000009-001": { round: 1, state: "accepted", branch: "b2", files: [{ path: "CHANGELOG.md", type: "changelog", action: "updated" }], history: [] },
    };
    expect(docOverlaps(docs, "DOC-000008-001", [{ path: "CHANGELOG.md", type: "changelog", action: "updated" }])).toEqual({ "CHANGELOG.md": ["DOC-000007-001"] });
  });

  it("lists the accepted docs of a task's group for the implement prompt", () => {
    const docs: DocsSidecar = {
      "DOC-000007-001": {
        round: 2,
        state: "accepted",
        branch: "b",
        files: [{ path: "docs/api/0003-login.md", type: "api", action: "created", number: 3 }],
        history: [{ round: 2, at: "", by: "u", decision: "proceed", opinion: "Use 401 for bad tokens", final: true }],
      },
    };
    const note = implementDocsNote(docs, "TSK-000007-002");
    expect(note).toContain("docs/api/0003-login.md");
    expect(note).toContain("Use 401 for bad tokens");
    expect(implementDocsNote(docs, "TSK-000008-001")).toBe("");
  });

  it("reads the spec's Docs section from fields or top-level keys", () => {
    expect(readSpecDocs({ fields: [{ id: "docs_types", value: ["adr", "bogus", "api"] }, { id: "docs_org", value: "One file per topic" }] })).toEqual({
      types: ["adr", "api"],
      org: "One file per topic",
    });
    expect(readSpecDocs({ docs_types: "page, adr" }).types).toEqual(["page", "adr"]);
    expect(readSpecDocs(null).types).toEqual([]);
  });
});

describe("numbering new numbered docs", () => {
  /** Run git in a dir (identity set, quiet). */
  function sh(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  }

  it("gives each NEW-<n> file a number above the repo and the open DOC branches, and rewrites links", async () => {
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    sh(root, "init", "-q", "--bare", "-b", "main", origin);
    sh(root, "clone", "-q", origin, work);
    mkdirSync(join(work, "docs/adr"), { recursive: true });
    writeFileSync(join(work, "docs/adr/0003-old.md"), "# old\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "base");
    sh(work, "push", "-q", "origin", "HEAD:main");
    // Another open DOC branch already holds 0007.
    sh(work, "checkout", "-q", "-b", "dev/main/GRP-000002/DOC-000002-001");
    writeFileSync(join(work, "docs/adr/0007-other.md"), "# other\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "other");
    sh(work, "push", "-q", "origin", "HEAD");
    sh(work, "checkout", "-q", "-b", "dev/main/GRP-000005/DOC-000005-001", "origin/main");
    writeFileSync(join(work, "docs/adr/NEW-1-login.md"), "# Login\nSee [api](../api/NEW-1-tokens.md).\n");
    mkdirSync(join(work, "docs/api"), { recursive: true });
    writeFileSync(join(work, "docs/api/NEW-1-tokens.md"), "# Tokens\nDecided in [ADR](../adr/NEW-1-login.md).\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "docs");
    sh(work, "fetch", "-q", "origin");
    const asked: { type: string; count: number; floor: number }[] = [];
    const renames = await numberNewDocs(
      work,
      "main",
      "DOC-000005-001",
      async (req) => {
        asked.push(...req);
        return new Map(req.map((r) => [r.type, r.type === "adr" ? [8] : [1]]));
      },
      async () => undefined,
    );
    expect(asked).toEqual(expect.arrayContaining([{ type: "adr", count: 1, floor: 7 }, { type: "api", count: 1, floor: 0 }]));
    expect(renames.map((r) => r.to).sort()).toEqual(["docs/adr/0008-login.md", "docs/api/0001-tokens.md"]);
    expect(readFileSync(join(work, "docs/adr/0008-login.md"), "utf8")).toContain("../api/0001-tokens.md");
    expect(readFileSync(join(work, "docs/api/0001-tokens.md"), "utf8")).toContain("../adr/0008-login.md");
    const manifest = await docManifest(work, "main", []);
    expect(manifest).toEqual([
      { path: "docs/adr/0008-login.md", type: "adr", action: "created", number: 8 },
      { path: "docs/api/0001-tokens.md", type: "api", action: "created", number: 1 },
    ]);
  });
});
