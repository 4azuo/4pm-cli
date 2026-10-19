/**
 * The run context manifest: it names the row, its request (an archived one at its archive file), the group's
 * questions and answers, the linked discussions, mockups / sequences / change requests, attachments and finished
 * dependency evidence; the books index renders the configured folders.
 * @adr 0565
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARCHIVE_INDEX_REL, LINEAGE_SIDECAR_REL } from "@4pm/dto";
import { buildContextManifest, renderBooksIndex } from "./autonomous-context";
import type { LocalClaim } from "./autonomous-tasks";

const DIRS = { evidenceDir: ".4pm/evidence", mockupDir: ".4pm/mockups", sequenceDir: ".4pm/sequences", erDir: ".4pm/er", diagramDir: ".4pm/diagrams" };

let dir = "";

/** Write a file (folders created). */
function put(rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A task claim of `TSK-000007-002` depending on `TSK-000007-001` and `QA-000007-001`. */
function claim(): LocalClaim {
  return {
    id: "TSK-000007-002",
    claim: "c",
    worker: "w",
    started: "",
    attempt: 1,
    branch: "dev/main/GRP-000007/TSK-000007-002",
    base: "main",
    task: { id: "TSK-000007-002", priority: "", tag: "", depends: ["TSK-000007-001", "QA-000007-001"], group: "", desc: "Login form validation", notes: "", title: "Login validation" },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "context-"));
  put("USER_TODO.md", "# User Todo\n\n| ID | Group | Depends | Request | State |\n|---|---|---|---|---|\n");
  put(
    "USER_QA.md",
    "# QA\n\n| ID | Group | Depends | Original request | Question / options | Answer |\n|---|---|---|---|---|---|\n| QA-000007-001 | | | TSK-000007-002: x | Email or phone? | Email only |\n",
  );
  put("AI_TODO.md", "# AI Todo\n\n| ID | Priority | Actions | Depends | Group | Task description | Notes |\n|---|---|---|---|---|---|---|\n");
  put("AI_PROGRESS.md", "# AI Progress\n");
  put("AI_DONE.md", "# AI Done\n\n| Timestamp | ID | Group | Depends | Task description | Files | Evidence | Delivery | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 2026-10-18 10:00:00 | TSK-000007-001 | | | api | | | merged | |\n");
  put(LINEAGE_SIDECAR_REL, JSON.stringify({ "000007": { source: "REQ-000007-001", request: "Users log in with email", at: "" } }));
  put(ARCHIVE_INDEX_REL, JSON.stringify({ "REQ-000007-001": "2026-09" }));
  put(".4pm/discussions/DSC-20261001-0001.md", '---\nid: "DSC-20261001-0001"\ntitle: "Password rules"\nteam: ""\nlinks: ["REQ-000007-001"]\nstatus: "resolved"\n---\n');
  put(".4pm/discussions/DSC-20261001-0002.md", '---\nid: "DSC-20261001-0002"\ntitle: "Other"\nteam: ""\nlinks: ["REQ-000009-001"]\nstatus: "open"\n---\n');
  put(".4pm/mockups/TSK-000007--login.html", "<html></html>");
  put(".4pm/mockups/TSK-000008--other.html", "<html></html>");
  put(".4pm/sequences/TSK-000007-002.md", "# seq");
  put(".4pm/er/index.md", "# ER");
  put(".4pm/er/changes/ERC-12.md", '```json er-meta\n{"group": "TSK-000007"}\n```');
  put(".4pm/evidence/AI_DONE/TSK-000007-001/ai-test.txt", "ok");
  put(".4pm/evidence/USER_TODO/REQ-000007-001/1-shot.png", "png");
  put("project.spec.json", "{}");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("buildContextManifest", () => {
  it("indexes the row's whole context by id and path", async () => {
    const md = await buildContextManifest(dir, claim(), DIRS);
    expect(md).toContain("# Run context — TSK-000007-002");
    expect(md).toContain("Depends on TSK-000007-001 — `AI_DONE.md`");
    expect(md).toContain("REQ-000007-001 — `.4pm/archive/2026-09/USER_TODO.md` (archived)");
    expect(md).toContain("Users log in with email");
    expect(md).toContain("QA-000007-001 — Q: Email or phone? · A: Email only");
    expect(md).toContain("`.4pm/discussions/DSC-20261001-0001.md` — Password rules [resolved]");
    expect(md).not.toContain("DSC-20261001-0002");
    expect(md).toContain("Mockup `.4pm/mockups/TSK-000007--login.html`");
    expect(md).not.toContain("TSK-000008--other");
    expect(md).toContain("Sequence `.4pm/sequences/TSK-000007-002.md`");
    expect(md).toContain("ER change request `.4pm/er/changes/ERC-12.md`");
    expect(md).toContain("`.4pm/evidence/AI_DONE/TSK-000007-001/` — files of TSK-000007-001 (finished dependency)");
    expect(md).toContain("`.4pm/evidence/USER_TODO/REQ-000007-001/`");
    expect(md).toContain("`project.spec.json`");
  });
});

describe("renderBooksIndex", () => {
  it("names the configured folders", () => {
    const md = renderBooksIndex({ ...DIRS, mockupDir: "design/mockups" });
    expect(md).toContain("`design/mockups/<GROUP>--<name>.html`");
    expect(md).toContain("`.4pm/archive/ids.json`");
  });
});
