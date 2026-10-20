/**
 * Where RAG lives: `.4pm/rag/`, nothing written before the project's repo is cloned, and a pre-ADR-0573
 * `.claude/rag/` moved over on first use.
 * @adr 0573
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ragSettings } from "./rag";

describe("RAG folder", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "4pm-rag-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writes nothing while the repo is not cloned", async () => {
    const reply = await ragSettings(root, { minScore: 0.5, topK: 5 });
    expect(reply.ok).toBe(false);
    expect(existsSync(join(root, ".4pm"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  it("moves a legacy .claude/rag to .4pm/rag, then writes there", async () => {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".claude", "rag", "models"), { recursive: true });
    writeFileSync(join(root, ".claude", "rag", "models", "m.onnx"), "x");
    const reply = await ragSettings(root, { minScore: 0.5, topK: 5 });
    expect(reply.ok).toBe(true);
    expect(existsSync(join(root, ".claude", "rag"))).toBe(false);
    expect(existsSync(join(root, ".4pm", "rag", "models", "m.onnx"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, ".4pm", "rag", "settings.json"), "utf8"))).toEqual({ minScore: 0.5, topK: 5 });
  });

  it("drops the legacy copy when .4pm/rag already exists", async () => {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".claude", "rag"), { recursive: true });
    mkdirSync(join(root, ".4pm", "rag"), { recursive: true });
    await ragSettings(root, {});
    expect(existsSync(join(root, ".claude", "rag"))).toBe(false);
    expect(existsSync(join(root, ".4pm", "rag", "settings.json"))).toBe(true);
  });
});
