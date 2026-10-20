/**
 * The template copy of a scaffold: a packaged cli ships the template's `.gitignore` as `gitignore` (npm / pnpm deploy
 * drop dot-gitignore files), and the copy writes it back as `.gitignore` without clobbering the clone's own.
 * @adr 0568
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTemplate, templateEntryName } from "./scaffold";

describe("copyTemplate", () => {
  let base: string;
  let sample: string;
  let dir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "4pm-tpl-"));
    sample = join(base, "sample");
    dir = join(base, "project");
    mkdirSync(join(sample, ".claude"), { recursive: true });
    mkdirSync(dir);
    writeFileSync(join(sample, "gitignore"), ".4pm/logs/\n");
    writeFileSync(join(sample, ".claude", "AUTONOMOUS.md"), "guide\n");
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("restores a packaged gitignore as .gitignore", async () => {
    await copyTemplate(sample, dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".4pm/logs/\n");
    expect(existsSync(join(dir, "gitignore"))).toBe(false);
    expect(existsSync(join(dir, ".claude", "AUTONOMOUS.md"))).toBe(true);
  });

  it("keeps the clone's own .gitignore", async () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    await copyTemplate(sample, dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });

  it("maps the packaged name to the project entry", () => {
    expect(templateEntryName("gitignore")).toBe(".gitignore");
    expect(templateEntryName("src")).toBe("src");
  });
});
