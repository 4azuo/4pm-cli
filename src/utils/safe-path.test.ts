/**
 * Tests for the symlink-safe project path helpers on a real temp filesystem: lexical
 * escapes (`..`, absolute paths, sibling-prefix folders) and symlink escapes (a committed link to a
 * file or folder outside the root) are refused for read, write, mkdir and entry operations, while
 * ordinary in-root paths and in-root symlinks keep working.
 * @adr 0430
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PathEscapeError,
  lexicalInRoot,
  mkdirInRoot,
  readFileInRoot,
  resolveEntry,
  resolveForRead,
  resolveForWrite,
  writeFileInRoot,
  writeFileInRootSync,
} from "./safe-path";

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  // <tmp>/root is the project; <tmp>/outside holds a "secret" the project must never reach;
  // <tmp>/root-evil shares the root's string prefix (guards a naive startsWith check).
  base = realpathSync(mkdtempSync(join(tmpdir(), "safe-path-")));
  root = join(base, "root");
  outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside);
  mkdirSync(join(base, "root-evil"));
  writeFileSync(join(root, "src", "a.txt"), "inside");
  writeFileSync(join(outside, "secret.cre"), "SECRET");
  writeFileSync(join(base, "root-evil", "x.txt"), "evil");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("lexicalInRoot", () => {
  it("resolves in-root relative paths and the root itself", () => {
    expect(lexicalInRoot(root, "src/a.txt")).toBe(join(root, "src", "a.txt"));
    expect(lexicalInRoot(root, "")).toBe(root);
  });

  it("refuses .., absolute paths outside and a sibling folder sharing the root's prefix", () => {
    expect(lexicalInRoot(root, "../outside/secret.cre")).toBeNull();
    expect(lexicalInRoot(root, join(outside, "secret.cre"))).toBeNull();
    expect(lexicalInRoot(root, "../root-evil/x.txt")).toBeNull();
  });

  it("returns null without a root", () => {
    expect(lexicalInRoot(null, "a")).toBeNull();
  });
});

describe("resolveForRead", () => {
  it("allows a regular in-root file and a not-yet-existing in-root path", () => {
    expect(resolveForRead(root, "src/a.txt")).toBe(join(root, "src", "a.txt"));
    expect(resolveForRead(root, "src/new.txt")).toBe(join(root, "src", "new.txt"));
  });

  it("refuses a committed symlink to a file outside the root", () => {
    symlinkSync(join(outside, "secret.cre"), join(root, "leak"));
    expect(resolveForRead(root, "leak")).toBeNull();
  });

  it("refuses a path through a symlinked folder that points outside", () => {
    symlinkSync(outside, join(root, "linked-dir"));
    expect(resolveForRead(root, "linked-dir/secret.cre")).toBeNull();
    expect(resolveForRead(root, "linked-dir/missing.txt")).toBeNull();
  });

  it("allows a symlink that stays inside the root (returns its real path)", () => {
    symlinkSync(join(root, "src", "a.txt"), join(root, "alias"));
    expect(resolveForRead(root, "alias")).toBe(join(root, "src", "a.txt"));
  });
});

describe("readFileInRoot", () => {
  it("reads in-root files and throws PathEscapeError for escapes", async () => {
    expect(await readFileInRoot(root, "src/a.txt", "utf8")).toBe("inside");
    symlinkSync(join(outside, "secret.cre"), join(root, "leak"));
    await expect(readFileInRoot(root, "leak", "utf8")).rejects.toBeInstanceOf(PathEscapeError);
    await expect(readFileInRoot(root, "../outside/secret.cre", "utf8")).rejects.toBeInstanceOf(PathEscapeError);
  });
});

describe("resolveForWrite / writeFileInRoot", () => {
  it("refuses to write the root itself or through a symlink target", () => {
    expect(resolveForWrite(root, "")).toBeNull();
    symlinkSync(join(outside, "secret.cre"), join(root, "leak"));
    expect(resolveForWrite(root, "leak")).toBeNull();
  });

  it("writes a new file, creating missing in-root folders", async () => {
    await writeFileInRoot(root, "deep/nested/b.txt", "hello");
    expect(readFileSync(join(root, "deep", "nested", "b.txt"), "utf8")).toBe("hello");
    writeFileInRootSync(root, "deep/c.txt", "sync");
    expect(readFileSync(join(root, "deep", "c.txt"), "utf8")).toBe("sync");
  });

  it("never overwrites a file outside through a symlinked file or folder", async () => {
    symlinkSync(join(outside, "secret.cre"), join(root, "leak"));
    symlinkSync(outside, join(root, "linked-dir"));
    await expect(writeFileInRoot(root, "leak", "pwned")).rejects.toBeInstanceOf(PathEscapeError);
    await expect(writeFileInRoot(root, "linked-dir/secret.cre", "pwned")).rejects.toBeInstanceOf(PathEscapeError);
    expect(() => writeFileInRootSync(root, "leak", "pwned")).toThrow(PathEscapeError);
    expect(readFileSync(join(outside, "secret.cre"), "utf8")).toBe("SECRET");
  });

  it("refuses mkdir -p through a symlinked folder that leads outside", async () => {
    symlinkSync(outside, join(root, "linked-dir"));
    await expect(mkdirInRoot(root, join(root, "linked-dir", "made"))).rejects.toBeInstanceOf(PathEscapeError);
    expect(existsSync(join(outside, "made"))).toBe(false);
  });
});

describe("resolveEntry", () => {
  it("allows acting on an in-root symlink itself (delete/rename a link, not its target)", () => {
    symlinkSync(join(outside, "secret.cre"), join(root, "leak"));
    expect(resolveEntry(root, "leak")).toBe(join(root, "leak"));
  });

  it("refuses the root itself and entries whose parent folder is outside", () => {
    symlinkSync(outside, join(root, "linked-dir"));
    expect(resolveEntry(root, "")).toBeNull();
    expect(resolveEntry(root, "linked-dir/secret.cre")).toBeNull();
    expect(resolveEntry(root, "../outside/secret.cre")).toBeNull();
  });
});
