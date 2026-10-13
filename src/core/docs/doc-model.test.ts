/**
 * Tests for the shared Doc Header model: frontmatter subset parser, code headers, import resolution,
 * the parent tree + depth score, and the lint rules.
 * @adr 0488
 */
import { describe, expect, it } from "vitest";
import { buildDocModel, importSpecifiers, isIgnored, parseCodeHeader, parseFrontmatter, parseJsonc } from "./doc-model";

/** A doc with a header. */
function doc(path: string, header: string, body = ""): { path: string; text: string } {
  return { path, text: `---\n${header}\n---\n${body}` };
}

describe("parseFrontmatter", () => {
  it("reads scalars, flow + block lists and the refs map", () => {
    const r = parseFrontmatter(
      [
        "---",
        "id: api.project-0041   # the id",
        'kind: "api"',
        "title: Pause a project",
        "feature: [project-lifecycle, ops]",
        "parent: arch.0043",
        "refs:",
        "  implements: [adr.0092]",
        "  uses:",
        "    - api.project-0040",
        "status: approved",
        "---",
        "# Body",
      ].join("\r\n"),
    );
    expect(r.present).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.header).toMatchObject({
      id: "api.project-0041",
      kind: "api",
      title: "Pause a project",
      feature: ["project-lifecycle", "ops"],
      parent: "arch.0043",
      status: "approved",
      refs: [
        { type: "implements", to: "adr.0092" },
        { type: "uses", to: "api.project-0040" },
      ],
    });
  });

  it("refuses anchors / aliases / tags and reports an unclosed block", () => {
    expect(parseFrontmatter("---\nid: &a x\n---\n").errors[0]).toMatch(/YAML features/);
    expect(parseFrontmatter("---\nid: x\n").errors[0]).toMatch(/not closed/);
    expect(parseFrontmatter("# no header").present).toBe(false);
  });

  it("keeps an unknown refs key as related with an error", () => {
    const r = parseFrontmatter("---\nid: a.b\nkind: req\ntitle: T\nrefs:\n  blocks: [c.d]\n---\n");
    expect(r.header?.refs).toEqual([{ type: "related", to: "c.d" }]);
    expect(r.errors[0]).toMatch(/unknown refs key/);
  });
});

describe("code headers + imports", () => {
  it("reads @kind, @feature, doc tags and @er", () => {
    const h = parseCodeHeader('/**\n * Pause.\n * @kind service  @feature project-lifecycle\n * @api project-0041 @adr 0092 @er ORDER\n */\nexport {}');
    expect(h).toEqual({ kind: "service", feature: ["project-lifecycle"], refs: ["api.project-0041", "adr.0092", "er.ORDER"] });
    expect(parseCodeHeader("const x = 1;")).toBeNull();
  });

  it("lists JS, Python and Go import specifiers as strings", () => {
    expect(importSpecifiers("a.ts", 'import x from "./b";\nexport * from "../c.js";\nconst y = await import("./d");')).toEqual(["./b", "../c.js", "./d"]);
    expect(importSpecifiers("p/a.py", "from .b import c\nfrom . import d, e\nimport os.path")).toEqual([".b", ".d", ".e", "os.path"]);
    expect(importSpecifiers("a.go", 'import (\n  "fmt"\n  "ex.com/m/pkg"\n)')).toEqual(["fmt", "ex.com/m/pkg"]);
  });

  it("parses JSONC and matches ignore globs", () => {
    expect(parseJsonc('{ // c\n "a": [1,], /* b */ "s": "x//y" }')).toEqual({ a: [1], s: "x//y" });
    expect(isIgnored("AI_TODO.md", ["AI_*.md"])).toBe(true);
    expect(isIgnored("docs/x/AI_TODO.md", ["AI_*.md"])).toBe(true);
    expect(isIgnored(".claude/agents/a.md", [".claude/**"])).toBe(true);
    expect(isIgnored("docs/a.md", ["AI_*.md", ".claude/**"])).toBe(false);
  });
});

describe("buildDocModel", () => {
  it("builds the parent tree, typed edges, metrics and lint issues", () => {
    const model = buildDocModel({
      mode: "docs",
      docs: [
        doc("docs/req.md", "id: req.checkout\nkind: req\ntitle: Checkout"),
        doc("docs/flow.md", "id: flow.checkout\nkind: flow\ntitle: Checkout flow\nparent: req.checkout\nrefs:\n  uses: [api.missing]"),
        doc("docs/a1.md", "id: arch.a1\nkind: arch\ntitle: A1\nparent: flow.checkout"),
        doc("docs/a2.md", "id: arch.a2\nkind: arch\ntitle: A2\nparent: arch.a1"),
        doc("docs/a3.md", "id: arch.a3\nkind: arch\ntitle: A3\nparent: arch.a2"),
        doc("docs/a4.md", "id: arch.a4\nkind: arch\ntitle: A4\nparent: arch.a3", "[up](./req.md)"),
        { path: "notes/todo.md", text: "# todo" },
        { path: "AI_TODO.md", text: "# book" },
      ],
      code: [],
      configs: [],
    });
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    expect(byId.has("AI_TODO.md")).toBe(false);
    expect(byId.get("arch.a4")?.depth).toBe(5);
    expect(byId.get("notes/todo.md")?.kind).toBe("unclassified");
    expect(model.edges).toContainEqual({ from: "flow.checkout", to: "req.checkout", type: "parent" });
    expect(model.edges).toContainEqual({ from: "arch.a4", to: "req.checkout", type: "mentions" });
    expect(model.roots).toEqual(expect.arrayContaining(["req.checkout", "notes/todo.md"]));
    expect(model.orphans).toEqual(["notes/todo.md"]);
    // excess: a3 = 1, a4 = 2 over 8 nodes … avg 3/7, max 2 ⇒ 100 - 8.57 - 10 = 81
    expect(model.metrics.depthScore).toBe(81);
    expect(model.metrics.maxDepth).toBe(5);
    expect(model.metrics.unclassified).toBe(1);
    expect(model.metrics.brokenRefs).toBe(1);
    const rules = model.issues.map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(["ref-broken", "header-missing", "too-deep", "orphan"]));
    expect(model.metrics.perRoot[0]).toMatchObject({ id: "req.checkout", maxDepth: 5 });
  });

  it("detects duplicate ids, unknown kinds and parent cycles", () => {
    const model = buildDocModel({
      mode: "docs",
      docs: [
        doc("a.md", "id: req.a\nkind: req\ntitle: A\nparent: req.b"),
        doc("b.md", "id: req.b\nkind: req\ntitle: B\nparent: req.a"),
        doc("c.md", "id: req.a\nkind: wiki\ntitle: C"),
      ],
      code: [],
      configs: [],
    });
    const rules = model.issues.map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(["id-duplicate", "kind-unknown", "parent-cycle"]));
    expect(model.metrics.cycles).toBe(1);
    expect(model.nodes.find((n) => n.file === "c.md")?.id).toBe("c.md");
  });

  it("builds the code import tree with tsconfig paths, workspace packages and doc implements edges", () => {
    const model = buildDocModel({
      mode: "all",
      docs: [doc("docs/api.md", "id: api.orders\nkind: api\ntitle: Orders")],
      code: [
        { path: "app/src/main.ts", text: '/** Entry. @kind entry */\nimport { s } from "@/svc/orders";\nimport "@acme/lib";' },
        { path: "app/src/svc/orders.ts", text: '/**\n * Orders. @kind service\n * @api orders @er ORDER\n */\nimport { u } from "../util.js";' },
        { path: "app/src/util.ts", text: "export const u = 1;" },
        { path: "lib/src/index.ts", text: "/** Lib. @kind util */\nexport {};" },
      ],
      configs: [
        { path: "app/tsconfig.json", text: '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }' },
        { path: "lib/package.json", text: '{ "name": "@acme/lib" }' },
      ],
    });
    expect(model.edges).toEqual(
      expect.arrayContaining([
        { from: "app/src/main.ts", to: "app/src/svc/orders.ts", type: "imports" },
        { from: "app/src/main.ts", to: "lib/src/index.ts", type: "imports" },
        { from: "app/src/svc/orders.ts", to: "app/src/util.ts", type: "imports" },
        { from: "app/src/svc/orders.ts", to: "api.orders", type: "implements" },
        { from: "app/src/svc/orders.ts", to: "er.ORDER", type: "implements" },
      ]),
    );
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    expect(byId.get("app/src/util.ts")).toMatchObject({ depth: 2, parent: "app/src/svc/orders.ts" });
    expect(byId.get("er.ORDER")?.layer).toBe("er");
    expect(model.issues.filter((i) => i.rule === "code-header-missing").map((i) => i.file)).toEqual(["app/src/util.ts"]);
  });
});
