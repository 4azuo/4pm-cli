/**
 * Tests of the `ci.propose` request checks: workflow paths only, file count / size caps, the scope shape.
 * @adr 0606
 */
import { describe, expect, it } from "vitest";
import type { CiProposeRequest } from "@4pm/ws";
import { checkProposal } from "./ci-propose";

/** A valid request with `files`. */
const req = (files: CiProposeRequest["files"], scope = "ci-propose:abc-123"): CiProposeRequest => ({ files, title: "CI", body: "", slug: "ci", scope, by: "u", byLabel: "u@x" });

describe("checkProposal", () => {
  it("accepts GitHub workflows and GitLab CI files", () => {
    expect(checkProposal(req([{ path: ".github/workflows/ci.yml", content: "on: push" }, { path: ".gitlab-ci.yml", content: null }, { path: ".gitlab/ci/test/unit.yaml", content: "x" }]))).toBeNull();
  });
  it("refuses any other path", () => {
    expect(checkProposal(req([{ path: "src/index.ts", content: "x" }]))?.code).toBe("CI_PATH_NOT_ALLOWED");
    expect(checkProposal(req([{ path: ".github/workflows/../../evil.yml", content: "x" }]))?.code).toBe("CI_PATH_NOT_ALLOWED");
    expect(checkProposal(req([{ path: ".github/workflows/sub/x.yml", content: "x" }]))?.code).toBe("CI_PATH_NOT_ALLOWED");
  });
  it("enforces the caps and the scope", () => {
    expect(checkProposal(req([]))?.code).toBe("CI_PATH_NOT_ALLOWED");
    expect(checkProposal(req([{ path: ".gitlab-ci.yml", content: "x".repeat(256 * 1024 + 1) }]))?.code).toBe("CI_PATH_NOT_ALLOWED");
    expect(checkProposal(req([{ path: ".gitlab-ci.yml", content: "x" }], "link"))?.code).toBe("CI_PROPOSE_FAILED");
  });
});
