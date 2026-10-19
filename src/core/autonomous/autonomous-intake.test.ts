/**
 * Intake on its own branch: the agent's overlay edits become a patch (new rows, the request taken in), the patch is
 * applied to a books checkout (claim dropped, rows appended once, `Taken in`, lineage with the request PR as its
 * delivery), and a group waits for that PR (`mergeWait`) until it is merged.
 * @adr 0563
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINEAGE_SIDECAR_REL, parseLineage } from "@4pm/dto";
import * as B from "./autonomous-books";
import { applyIntakePatch, captureIntakePatch, prepareIntakeOverlay, type IntakePublished } from "./autonomous-intake";
import { mergeWait, type LocalClaim } from "./autonomous-tasks";

const USER_TODO = "# User Todo\n\n| ID | Title | Group | Depends | Request |\n|---|---|---|---|---|\n| REQ-000001-001 | Login | | | Add a login page |\n";
const USER_QA = "# QA\n\n| ID | Title | Group | Depends | Original request | Question / options | Answer |\n|---|---|---|---|---|---|---|\n";
const AI_TODO = "# AI Todo\n\n| ID | Title | Priority | Actions | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|---|\n";
const HEADER = "| Started | ID | Team | Worker | Claim | Attempt | Task description |\n|---|---|---|---|---|---|---|\n";
const CFG = { erDir: ".4pm/er", diagramDir: ".4pm/diagrams", erAutoApprove: false, diagramAutoApprove: false, docsPhase: false };

let overlay = "";
let books = "";
let profile = "";

/** Seed a books checkout. */
function seed(dir: string): void {
  writeFileSync(join(dir, "USER_TODO.md"), USER_TODO);
  writeFileSync(join(dir, "USER_QA.md"), USER_QA);
  writeFileSync(join(dir, "AI_TODO.md"), AI_TODO);
  writeFileSync(join(dir, "AI_DONE.md"), "# AI Done\n");
  writeFileSync(join(dir, "AI_PROGRESS.md"), `# AI Progress\n\n${HEADER}| ${B.stamp()} | REQ-000001-001 | | me | c1 | 1 | Intake — Add a login page |\n`);
}

beforeEach(() => {
  overlay = mkdtempSync(join(tmpdir(), "intake-overlay-"));
  books = mkdtempSync(join(tmpdir(), "intake-books-"));
  profile = mkdtempSync(join(tmpdir(), "intake-profile-"));
  seed(overlay);
  seed(books);
});
afterEach(() => {
  for (const d of [overlay, books, profile]) rmSync(d, { recursive: true, force: true });
});

const mine: LocalClaim = {
  id: "REQ-000001-001",
  claim: "c1",
  worker: "me",
  started: B.stamp(),
  attempt: 1,
  branch: "dev/main/GRP-000001/REQ-000001-001",
  base: "main",
  kind: "intake",
  groups: [7],
  task: { id: "REQ-000001-001", priority: "Medium", tag: "", depends: [], group: "", desc: "Add a login page", notes: "" },
};

describe("intake patch", () => {
  it("captures the agent's rows and applies them once to the books, with the request PR in the lineage", async () => {
    const before = await prepareIntakeOverlay(overlay, [mine.id]);
    // The agent: two tasks of the given group, the analysed request row removed.
    writeFileSync(
      join(overlay, "AI_TODO.md"),
      `${AI_TODO}| TSK-000007-001 | Form | High | | | GRP-000007 | Build the form | size: S |\n| TSK-000007-002 | API | High | | TSK-000007-001 | GRP-000007 | Build the API | size: M |\n`,
    );
    writeFileSync(join(overlay, "USER_TODO.md"), "# User Todo\n\n| ID | Title | Group | Depends | Request |\n|---|---|---|---|---|\n");
    const cap = await captureIntakePatch(overlay, profile, CFG, mine, before);
    expect("patch" in cap).toBe(true);
    const patch = "patch" in cap ? cap.patch : null;
    expect(patch!.tasks.map((t) => t.id)).toEqual(["TSK-000007-001", "TSK-000007-002"]);
    expect(patch!.taken).toEqual(["REQ-000001-001"]);

    mkdirSync(join(books, ".4pm"), { recursive: true });
    const out: IntakePublished = { ercs: [], sdcs: [], docIds: [], skipped: [] };
    const delivery = { branch: mine.branch, url: "https://github.com/o/r/pull/12", state: "open" as const };
    expect(await applyIntakePatch(books, patch!, mine, CFG, { types: [], org: "" }, delivery, out)).toBe(true);
    const todo = await B.readBook(books, "AI_TODO.md");
    expect(B.parseTasks(todo).tasks.map((t) => t.id)).toEqual(["TSK-000007-001", "TSK-000007-002"]);
    expect(await B.readBook(books, "USER_TODO.md")).toContain("Taken in");
    expect(B.parseClaims(await B.readBook(books, "AI_PROGRESS.md")).intake).toHaveLength(0);
    const lineage = parseLineage(await B.readBook(books, LINEAGE_SIDECAR_REL));
    expect(lineage["000007"]).toMatchObject({ source: "REQ-000001-001", delivery: { state: "open", url: delivery.url } });
    // The claim is gone: a second apply (a lost race re-run) does nothing.
    expect(await applyIntakePatch(books, patch!, mine, CFG, { types: [], org: "" }, delivery, out)).toBe(false);

    // The group's tasks wait for the request PR, then run once it is merged.
    const task = { id: "TSK-000007-001", depends: [] as string[] };
    expect(mergeWait(task, lineage, {})).toMatchObject({ id: "REQ-000001-001", state: "open" });
    expect(mergeWait(task, { "000007": { ...lineage["000007"]!, delivery: { ...delivery, state: "merged" } } }, {})).toBeNull();
  });

  it("discards a run that used a group it was not given", async () => {
    const before = await prepareIntakeOverlay(overlay, [mine.id]);
    writeFileSync(join(overlay, "AI_TODO.md"), `${AI_TODO}| TSK-000099-001 | X | High | | | GRP-000099 | x | |\n`);
    const cap = await captureIntakePatch(overlay, profile, CFG, mine, before);
    expect(cap).toEqual({ stray: ["TSK-000099-001"] });
  });
});

describe("mergeWait for DOC dependencies", () => {
  it("holds a task until its accepted DOC row's PR is merged", () => {
    const task = { id: "TSK-000007-001", depends: ["DOC-000007-001"] };
    const doc = { round: 1, state: "accepted" as const, branch: "b", files: [], history: [] };
    expect(mergeWait(task, {}, { "DOC-000007-001": doc })).toMatchObject({ id: "DOC-000007-001", state: "open" });
    expect(mergeWait(task, {}, { "DOC-000007-001": { ...doc, pr: { branch: "b", state: "closed" } } })).toMatchObject({ state: "closed" });
    expect(mergeWait(task, {}, { "DOC-000007-001": { ...doc, pr: { branch: "b", state: "direct" } } })).toBeNull();
  });
});
