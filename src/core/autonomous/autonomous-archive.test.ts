/**
 * The archive: a request `Done` for longer than `archiveAfterDays` moves — with its AI Done rows and sidecar entries —
 * to `.4pm/archive/<YYYY-MM>/`, at most once a day; recent work stays live, and so does a request with an unmerged PR or
 * a trashed row; a request with no groups and a hand-made AI_DONE group archive on their own times.
 * @adr 0563
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPROVALS_SIDECAR_REL, AUTHORS_SIDECAR_REL, LINEAGE_SIDECAR_REL } from "@4pm/dto";
import * as B from "./autonomous-books";
import { archiveBooks } from "./autonomous-archive";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "archive-"));
  mkdirSync(join(dir, ".4pm"), { recursive: true });
  writeFileSync(
    join(dir, "USER_TODO.md"),
    "# User Todo\n\n| ID | Group | Depends | Request | State |\n|---|---|---|---|---|\n| REQ-000001-001 | | | Old | Done |\n| REQ-000002-001 | | | Recent | Done |\n",
  );
  writeFileSync(join(dir, "USER_QA.md"), "# QA\n\n| ID | Group | Depends | Original request | Question / options | Answer |\n|---|---|---|---|---|---|\n");
  writeFileSync(
    join(dir, "AI_DONE.md"),
    "# AI Done\n\n| Timestamp | ID | Group | Depends | Task description | Files | Evidence | Delivery | Notes |\n|---|---|---|---|---|---|---|---|---|\n" +
      "| 2026-01-10 10:00:00 | TSK-000011-001 | | | old task | | | merged | branch: b1 |\n" +
      "| 2026-10-18 10:00:00 | TSK-000012-001 | | | new task | | | PR open #3 | branch: b2 |\n\n## Incidents\n\n| Timestamp | Note |\n|---|---|\n| 2026-01-02 00:00:00 | old incident |\n",
  );
  writeFileSync(
    join(dir, LINEAGE_SIDECAR_REL),
    JSON.stringify({ "000011": { source: "REQ-000001-001", request: "Old", at: "" }, "000012": { source: "REQ-000002-001", request: "Recent", at: "" } }),
  );
  writeFileSync(join(dir, APPROVALS_SIDECAR_REL), JSON.stringify({ "REQ-000001-001": { approved: true }, "TSK-000011-001": { approved: true }, "TSK-000012-001": { approved: true } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("archiveBooks", () => {
  it("moves an old finished request with its rows and sidecar entries, once a day", async () => {
    const now = new Date("2026-10-19T00:00:00Z");
    expect(await archiveBooks(dir, 30, now)).toBe(true);
    expect(await B.readBook(dir, "USER_TODO.md")).not.toContain("REQ-000001-001");
    expect(await B.readBook(dir, "USER_TODO.md")).toContain("REQ-000002-001");
    const done = await B.readBook(dir, "AI_DONE.md");
    expect(done).not.toContain("TSK-000011-001");
    expect(done).toContain("TSK-000012-001");
    expect(done).not.toContain("old incident");
    expect(await B.readBook(dir, ".4pm/archive/2026-01/AI_DONE.md")).toContain("TSK-000011-001");
    expect(await B.readBook(dir, ".4pm/archive/2026-01/USER_TODO.md")).toContain("REQ-000001-001");
    expect(JSON.parse(await B.readBook(dir, ".4pm/archive/2026-01/.autonomous.approvals.json"))).toHaveProperty("TSK-000011-001");
    expect(JSON.parse(await B.readBook(dir, APPROVALS_SIDECAR_REL))).not.toHaveProperty("TSK-000011-001");
    expect(JSON.parse(await B.readBook(dir, LINEAGE_SIDECAR_REL))).not.toHaveProperty("000011");
    // The same day again: nothing.
    expect(await archiveBooks(dir, 30, now)).toBe(false);
  });

  it("keeps a finished request while a PR of its groups is open or a row of them is in the trash", async () => {
    const now = new Date("2026-10-19T00:00:00Z");
    const done = await B.readBook(dir, "AI_DONE.md");
    await B.writeBook(dir, "AI_DONE.md", done.replace("| 2026-01-10 10:00:00 | TSK-000011-001 | | | old task | | | merged |", "| 2026-01-10 10:00:00 | TSK-000011-001 | | | old task | | | PR open #2 |"));
    await archiveBooks(dir, 30, now);
    expect(await B.readBook(dir, "USER_TODO.md")).toContain("REQ-000001-001");

    await B.writeBook(dir, "AI_DONE.md", done);
    await B.writeBook(dir, ".4pm/archive/LAST", "");
    writeFileSync(
      join(dir, "AI_TODO.md"),
      `# AI Todo\n\n| ID | Priority | Actions | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n\n<!-- 4pm:todo-trash {"retentionHours":24,"items":[{"id":"TSK-000011-002","deletedAt":"2026-10-18T12:00:00Z"}]} -->\n`,
    );
    await archiveBooks(dir, 30, now);
    expect(await B.readBook(dir, "USER_TODO.md")).toContain("REQ-000001-001");
  });

  it("archives a done request with no groups by its author time, and a hand-made AI_DONE group on its own", async () => {
    const now = new Date("2026-10-19T00:00:00Z");
    const todo = await B.readBook(dir, "USER_TODO.md");
    await B.writeBook(dir, "USER_TODO.md", todo.replace("| REQ-000002-001 | | | Recent | Done |", "| REQ-000002-001 | | | Recent | Done |\n| REQ-000003-001 | | | Nothing to do | Done |"));
    writeFileSync(join(dir, AUTHORS_SIDECAR_REL), JSON.stringify({ "REQ-000003-001": { by: "u", byLabel: "u", at: "2026-02-01T08:00:00.000Z" } }));
    const done = await B.readBook(dir, "AI_DONE.md");
    await B.writeBook(dir, "AI_DONE.md", done.replace("| 2026-10-18 10:00:00 | TSK-000012-001 |", "| 2026-03-05 10:00:00 | TSK-000099-001 | | | by hand | | | direct | |\n| 2026-10-18 10:00:00 | TSK-000012-001 |"));
    await archiveBooks(dir, 30, now);
    expect(await B.readBook(dir, "USER_TODO.md")).not.toContain("REQ-000003-001");
    expect(await B.readBook(dir, ".4pm/archive/2026-02/USER_TODO.md")).toContain("REQ-000003-001");
    expect(await B.readBook(dir, "AI_DONE.md")).not.toContain("TSK-000099-001");
    expect(await B.readBook(dir, ".4pm/archive/2026-03/AI_DONE.md")).toContain("TSK-000099-001");
  });
});
