/**
 * Tests of the flow-map back-ref edits (Doc Header `refs.related`, code `@flow`).
 */
import { describe, expect, it } from "vitest";
import { addCodeBackref, addDocBackref } from "./flowmap-backref";
import { unifiedDiff } from "./flowmap-diff";
import { flowMapMarkdown, svgNameOf } from "./flowmap-file";

describe("addDocBackref", () => {
  it("adds refs.related when refs is absent", () => {
    const out = addDocBackref("---\nid: req.checkout\nkind: req\ntitle: Checkout\n---\n# Checkout\n", "flow.checkout");
    expect(out).toBe("---\nid: req.checkout\nkind: req\ntitle: Checkout\nrefs:\n  related:\n    - flow.checkout\n---\n# Checkout\n");
  });
  it("adds related under an existing refs block", () => {
    const out = addDocBackref("---\nid: a.b\nrefs:\n  uses: [x.y]\n---\nbody", "flow.f");
    expect(out).toBe("---\nid: a.b\nrefs:\n  uses: [x.y]\n  related:\n    - flow.f\n---\nbody");
  });
  it("appends to a block list", () => {
    const out = addDocBackref("---\nid: a.b\nrefs:\n  related:\n    - x.y\n  uses: [z.w]\n---\n", "flow.f");
    expect(out).toBe("---\nid: a.b\nrefs:\n  related:\n    - x.y\n    - flow.f\n  uses: [z.w]\n---\n");
  });
  it("appends to a flow list and is idempotent", () => {
    const once = addDocBackref("---\nrefs:\n  related: [x.y]\n---\n", "flow.f")!;
    expect(once).toBe("---\nrefs:\n  related: [x.y, flow.f]\n---\n");
    expect(addDocBackref(once, "flow.f")).toBe(once);
  });
  it("refuses a doc without a header", () => {
    expect(addDocBackref("# Title\n", "flow.f")).toBeNull();
  });
});

describe("addCodeBackref", () => {
  it("inserts before the closing of a block header", () => {
    const src = "/**\n * Order service.\n * @kind service\n */\nexport class A {}\n";
    expect(addCodeBackref(src, "checkout")).toBe("/**\n * Order service.\n * @kind service\n * @flow checkout\n */\nexport class A {}\n");
    expect(addCodeBackref(addCodeBackref(src, "checkout")!, "checkout")).toBe(addCodeBackref(src, "checkout"));
  });
  it("handles # comment headers", () => {
    expect(addCodeBackref("# Billing job.\n# @kind service\nimport os\n", "pay")).toBe("# Billing job.\n# @kind service\n# @flow pay\nimport os\n");
  });
  it("refuses a file without a header", () => {
    expect(addCodeBackref("export const a = 1;\n", "x")).toBeNull();
  });
});

describe("unifiedDiff / flowMapMarkdown", () => {
  it("diffs an insertion with context", () => {
    const d = unifiedDiff("a.md", "1\n2\n3\n4", "1\n2\n2b\n3\n4");
    expect(d).toContain("+2b");
    expect(d).toContain(" 2");
    expect(unifiedDiff("a.md", "x", "x")).toBe("");
  });
  it("writes the doc header", () => {
    const md = flowMapMarkdown({ id: "flow.c", title: "Checkout — flow", features: ["checkout"], uses: ["req.c"], generatedBy: "4pm-flow-map v1", sources: [{ path: "a.md", commit: "abcdef1234567890" }], svgName: "c.flow.svg", modelJson: "{}" });
    expect(md).toContain("id: flow.c\nkind: flow\n");
    expect(md).toContain("  - a.md@abcdef123456");
    expect(md).toContain("```json 4pm-flow\n{}\n```");
    expect(svgNameOf("c.flow.md")).toBe("c.flow.svg");
  });
});
