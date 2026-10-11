/**
 * Customer (CLIENT) viewer filtering: `.git` and gitignored paths are hidden, tracked files stay visible.
 * @adr 0449
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientHidden, filterListingForClient } from "./client-visibility";

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "client-vis-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), ".env\nbuild/\n*.log\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  writeFileSync(join(root, "README.md"), "# hi\n");
  writeFileSync(join(root, "app.log"), "log\n");
  mkdirSync(join(root, "build"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.ts"), "export {};\n");
  writeFileSync(join(root, "src", "debug.log"), "x\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("client visibility", () => {
  it("drops .git and ignored entries from the root listing", async () => {
    const names = [".git", ".gitignore", ".env", "README.md", "app.log", "build", "src"].map((name) => ({ name }));
    const kept = (await filterListingForClient(root, "", names)).map((e) => e.name);
    expect(kept).toEqual([".gitignore", "README.md", "src"]);
  });

  it("filters a nested folder by its own path", async () => {
    const kept = (await filterListingForClient(root, "src", [{ name: "main.ts" }, { name: "debug.log" }])).map((e) => e.name);
    expect(kept).toEqual(["main.ts"]);
  });

  it("hides reads of ignored or .git paths only for a client viewer", async () => {
    expect(await clientHidden(root, ".env", "client")).toBe(true);
    expect(await clientHidden(root, ".git/config", "client")).toBe(true);
    expect(await clientHidden(root, "README.md", "client")).toBe(false);
    expect(await clientHidden(root, ".env", undefined)).toBe(false);
  });
});
