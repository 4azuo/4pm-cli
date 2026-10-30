/**
 * Tests of the AI-audit scope tree / size and the report path check.
 */
import { describe, expect, it } from "vitest";
import { scopeSize, scopeTree } from "./audit-scope";
import { validReportPath } from "./audit-report";

const files = [
  { path: "docs/api/a.md", size: 10 },
  { path: "docs/b.md", size: 5 },
  { path: "src/x.ts", size: 100 },
  { path: "src/x.snap", size: 50 },
  { path: "README.md", size: 1 },
];

describe("audit scope", () => {
  it("builds a cumulative tree", () => {
    const t = scopeTree(files);
    expect(t.files).toBe(5);
    const docs = t.children.find((c) => c.path === "docs")!;
    expect(docs.files).toBe(2);
    expect(docs.children[0]!.path).toBe("docs/api");
  });
  it("sizes the selection minus excludes", () => {
    expect(scopeSize(files, ["docs", "src"], ["*.snap"])).toEqual({ files: 3, bytes: 115 });
  });
  it("checks report paths", () => {
    expect(validReportPath(".4pm/audits/2026-10-30-weekly.md")).toBe(true);
    expect(validReportPath("docs/x.md")).toBe(false);
    expect(validReportPath(".4pm/audits/../x.md")).toBe(false);
  });
});
