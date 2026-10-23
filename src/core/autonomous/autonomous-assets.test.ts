/**
 * Tests of the asset phase helpers (plan from notes, round selection, parameters, file paths).
 * @adr 0615
 */
import { describe, expect, it } from "vitest";
import { assetFilePaths, assetParams, assetsToGenerate, planFromNotes } from "./autonomous-assets";

const item = { key: "hero", capability: "character.directions" as const, description: "a knight", width: 64, height: 64, path: "chars/hero", files: [] };

describe("asset helpers", () => {
  it("reads a plan from a JSON fence in the notes", () => {
    const notes = 'plan:\n```json\n[{"key":"hero","capability":"image.pixel","description":"a knight","width":32,"height":32,"path":"hero.png"}]\n```';
    expect(planFromNotes(notes).map((a) => a.key)).toEqual(["hero"]);
    expect(planFromNotes("no plan")).toEqual([]);
  });

  it("generates everything first, then only what was marked, sources before animations", () => {
    const walk = { ...item, key: "walk", capability: "animation.frames" as const, from: "hero", path: "chars/walk" };
    expect(assetsToGenerate([walk, item], 1).map((a) => a.key)).toEqual(["hero", "walk"]);
    const done = [{ ...item, files: ["x.png"] }, { ...walk, files: ["y.png"], regenerate: "slower" }];
    expect(assetsToGenerate(done, 2).map((a) => a.key)).toEqual(["walk"]);
  });

  it("adds the instruction and style to the description", () => {
    const p = assetParams({ ...item, regenerate: "red cape" }, "16 colors");
    expect(p.description).toBe("a knight\nChange from the previous version: red cape\nProject style: 16 colors");
  });

  it("names one file or a folder of labelled files", () => {
    expect(assetFilePaths("assets/generated", { ...item, path: "logo" }, [{ label: "image", base64: "" }])).toEqual(["assets/generated/logo.png"]);
    expect(assetFilePaths("assets/generated", item, [{ label: "South", base64: "" }, { label: "north-east", base64: "" }])).toEqual([
      "assets/generated/chars/hero/south.png",
      "assets/generated/chars/hero/north-east.png",
    ]);
  });
});
