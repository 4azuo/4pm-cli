/**
 * Tests of the request-scope line added to an intake prompt for a `docs-only` request.
 * @adr 0613
 */
import { describe, expect, it } from "vitest";
import { intakeScopeNote } from "./autonomous-cycle";

const src = (id: string, tags: string) => ({ id, request: "r", team: "", tags, due: "", assignees: "", title: "" });

describe("intakeScopeNote", () => {
  it("names docs-only requests and stays empty otherwise", () => {
    expect(intakeScopeNote([src("REQ-000001-001", "ui, docs-only")])).toContain("REQ-000001-001 is tagged `docs-only`");
    expect(intakeScopeNote([src("REQ-000001-001", "ui")])).toBe("");
  });
});
