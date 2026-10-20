/**
 * Tests for the sequence-diagram check: a valid diagram parses, a `;` in message text is reported for its file,
 * a fixer's reply is written back only when it parses, and a reply that still fails is left alone and returned.
 * @adr 0580
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSequenceFiles, isSequenceFile, mermaidBlockOf, repairSequenceFiles, unfenceDiagram } from "./autonomous-mermaid";

const DIR = ".4pm/sequences";
const GOOD = "sequenceDiagram\n    participant A\n    participant B\n    A->>B: login (HttpOnly, Secure)\n    B-->>A: ok";
const BAD = "sequenceDiagram\n    participant A\n    participant B\n    A->>B: login (HttpOnly; Secure)\n    B-->>A: ok";

let root: string;

/** Write a sequence file `<DIR>/<id>.md` holding `diagram`; returns its repo-relative path. */
function seq(id: string, diagram: string): string {
  const rel = `${DIR}/${id}.md`;
  writeFileSync(join(root, rel), `# ${id} — title\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\nNotes.\n`);
  return rel;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "4pm-mermaid-"));
  mkdirSync(join(root, DIR), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sequence diagram check", () => {
  it("knows sequence file names and pulls the mermaid block", () => {
    expect(isSequenceFile(`${DIR}/TSK-000002-004.md`, DIR)).toBe(true);
    expect(isSequenceFile(`${DIR}/QA-000002-001.md`, DIR)).toBe(true);
    expect(isSequenceFile(`${DIR}/notes.md`, DIR)).toBe(false);
    expect(isSequenceFile(`docs/TSK-000002-004.md`, DIR)).toBe(false);
    expect(mermaidBlockOf("# x\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n")).toBe("sequenceDiagram\n  A->>B: hi");
    expect(unfenceDiagram("Here it is:\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```")).toBe("sequenceDiagram\n  A->>B: hi");
  });

  it("passes a valid diagram and reports a `;` in message text for its file", async () => {
    const good = seq("TSK-000002-003", GOOD);
    const bad = seq("TSK-000002-004", BAD);
    const failures = await checkSequenceFiles(root, [good, bad]);
    expect(failures.map((f) => f.rel)).toEqual([bad]);
    expect(failures[0]!.error).toMatch(/Parse error/);
  });

  it("writes a fix back only when it parses", async () => {
    const bad = seq("TSK-000002-004", BAD);
    const lines: string[] = [];
    const left = await repairSequenceFiles(root, [bad], async (_f, diagram) => "```mermaid\n" + diagram.replace(";", ",") + "\n```", async (l) => {
      lines.push(l);
    });
    expect(left).toEqual([]);
    const text = readFileSync(join(root, bad), "utf8");
    expect(text).toContain("A->>B: login (HttpOnly, Secure)");
    expect(text).toMatch(/^# TSK-000002-004 — title\n/);
    expect(text).toContain("Notes.");
    expect(lines.some((l) => l.startsWith("[fix]"))).toBe(true);
  });

  it("leaves a diagram whose fix still fails and returns it", async () => {
    const bad = seq("TSK-000002-004", BAD);
    const left = await repairSequenceFiles(root, [bad], async (_f, diagram) => diagram, async () => undefined);
    expect(left.map((f) => f.rel)).toEqual([bad]);
    expect(readFileSync(join(root, bad), "utf8")).toContain("(HttpOnly; Secure)");
  });
});
