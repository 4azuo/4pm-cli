/**
 * Tests for the load check of a staged release: a bundle whose import is missing fails with the real
 * error line, one that resolves its import through the running install's node_modules passes.
 * @adr 0644
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReleaseLoads, loadFailureReason, ReleaseLoadError } from "./update-load-check";

/** Pack `files` (relative path → content) under `package/` into a .tgz, like a release tarball. */
async function packRelease(root: string, files: Record<string, string>): Promise<string> {
  const src = join(root, "src");
  for (const [path, content] of Object.entries(files)) {
    const full = join(src, "package", path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  const tgz = join(root, "cli.tgz");
  await create({ gzip: true, file: tgz, cwd: src }, ["package"]);
  return tgz;
}

describe("checkReleaseLoads", () => {
  let root: string;
  let running: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "4pm-load-check-test-"));
    running = join(root, "running");
    mkdirSync(join(running, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(running, "node_modules", "dep", "package.json"), '{"name":"dep","type":"module","main":"index.js"}');
    writeFileSync(join(running, "node_modules", "dep", "index.js"), "export const ok = 1;");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes a release whose imports resolve through the running node_modules", async () => {
    const tgz = await packRelease(root, {
      "package.json": '{"type":"module"}',
      "dist/index.js": 'import { ok } from "dep"; if (ok !== 1) process.exit(2); console.log("4pm-load-ok");',
    });
    await expect(checkReleaseLoads(tgz, running)).resolves.toBeUndefined();
  });

  it("fails a release with a missing package and names it", async () => {
    const tgz = await packRelease(root, {
      "package.json": '{"type":"module"}',
      "dist/index.js": 'import "yaml-missing-for-test"; console.log("never");',
    });
    const err = await checkReleaseLoads(tgz, running).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseLoadError);
    expect((err as ReleaseLoadError).reason).toMatch(/Cannot find package 'yaml-missing-for-test'/);
  });

  it("fails a release without an entry", async () => {
    const tgz = await packRelease(root, { "package.json": "{}" });
    await expect(checkReleaseLoads(tgz, running)).rejects.toBeInstanceOf(ReleaseLoadError);
  });
});

describe("loadFailureReason", () => {
  it("prefers the first error line, else the last line, else the fallback", () => {
    expect(loadFailureReason("a\nError [X]: boom\nb", "f")).toBe("Error [X]: boom");
    expect(loadFailureReason("a\nlast\n", "f")).toBe("last");
    expect(loadFailureReason("", "f")).toBe("f");
  });
});
