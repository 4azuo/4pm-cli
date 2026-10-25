/**
 * Tests of the RAG model catalog and the generated engine: options per machine, profiles embedded, valid ESM.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RAG_ENGINE_MJS } from "./rag-engine-script";
import { RAG_MODELS, profileOf, ragOptionsFor } from "./rag-models";

describe("rag model catalog", () => {
  it("offers only commercial-friendly licences", () => {
    for (const m of RAG_MODELS) expect(["MIT", "Apache-2.0"]).toContain(m.license);
  });

  it("recommends e5-small on a small machine and hides the big models", () => {
    const opts = ragOptionsFor({ ramGB: 4, cpus: 2, diskFreeGB: 10, gpu: false });
    expect(opts.find((o) => o.recommended)?.id).toBe("e5-small");
    expect(opts.map((o) => o.id)).not.toContain("m3");
    expect(opts.map((o) => o.id)).not.toContain("e5-base");
  });

  it("recommends e5-base from 8 GB and offers the large ones from 12 GB", () => {
    const mid = ragOptionsFor({ ramGB: 8, cpus: 4, diskFreeGB: 50, gpu: false });
    expect(mid.find((o) => o.recommended)?.id).toBe("e5-base");
    expect(mid.map((o) => o.id)).toContain("code");
    const big = ragOptionsFor({ ramGB: 16, cpus: 8, diskFreeGB: 50, gpu: false });
    expect(big.map((o) => o.id)).toEqual(expect.arrayContaining(["m3", "arctic-l"]));
  });

  it("knows each model's pooling and prefixes", () => {
    expect(profileOf("Xenova/bge-small-en-v1.5")?.pooling).toBe("cls");
    expect(profileOf("Xenova/multilingual-e5-small")?.docPrefix).toBe("passage: ");
    expect(profileOf("jinaai/jina-embeddings-v2-base-code")?.indexesCode).toBe(true);
    expect(profileOf("someone/else")).toBeNull();
  });
});

describe("generated engine", () => {
  it("embeds the profiles and parses as ESM", () => {
    expect(RAG_ENGINE_MJS).toContain("Xenova/multilingual-e5-small");
    expect(RAG_ENGINE_MJS).toContain("Xenova/bge-reranker-base");
    const dir = mkdtempSync(join(tmpdir(), "rag-engine-"));
    try {
      const file = join(dir, "engine.mjs");
      writeFileSync(file, RAG_ENGINE_MJS);
      execFileSync(process.execPath, ["--check", file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
