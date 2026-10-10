/**
 * Tests for the cli's signed-approval verification: legacy rule before keys, valid / unsigned /
 * invalid / stale states, cross-project replay, persisted trust and the write-side stale check.
 * @adr 0438
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalRowCanonical, approvalSigningPayload, type ApprovalEntry } from "@4pm/dto";
import {
  approvalStates,
  buildApprovalEntries,
  loadApprovalTrust,
  resetApprovalTrustForTest,
  setApprovalTrust,
  verifiedApprovedIds,
} from "./autonomous-approvals";

const AI_TODO = `| ID | Priority | Tag | Depends | Group | Task description | Notes |
|---|---|---|---|---|---|---|
| TSK-0001-0001 | high | | | 0001 | Add the login page | |
| TSK-0001-0002 | low | | | 0001 | Write docs | |
`;
const books = { userTodo: "", userQa: "", aiTodo: AI_TODO };

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");

/** Sign like the server does. */
function signed(rowId: string, book: string, projectId = "p1"): ApprovalEntry {
  const h = `sha256:${createHash("sha256").update(approvalRowCanonical(book, rowId)!).digest("hex")}`;
  const at = "2026-10-10T00:00:00.000Z";
  const sig = sign(null, Buffer.from(approvalSigningPayload({ projectId, rowId, by: "u1", at, h })), privateKey).toString("base64");
  return { approved: true, by: "u1", at, h, kid: "k1", sig: `ed25519:${sig}` };
}

let dir: string;
beforeEach(() => {
  resetApprovalTrustForTest();
  dir = mkdtempSync(join(tmpdir(), "4pm-trust-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("approval verification", () => {
  it("keeps the legacy rule before any key was received", () => {
    const map = { "TSK-0001-0001": { approved: true, by: "u", at: "t" } };
    expect([...verifiedApprovedIds(map, books)]).toEqual(["TSK-0001-0001"]);
  });

  it("requires a valid signature over unchanged content once keys are known", () => {
    setApprovalTrust([{ kid: "k1", publicKey: pub }], "p1", dir);
    const map = {
      "TSK-0001-0001": signed("TSK-0001-0001", AI_TODO),
      "TSK-0001-0002": { approved: true, by: "agent", at: "t" },
    };
    expect(approvalStates(map, books)).toEqual({ "TSK-0001-0001": "approved", "TSK-0001-0002": "unsigned" });
    expect([...verifiedApprovedIds(map, books)]).toEqual(["TSK-0001-0001"]);
  });

  it("marks an edited row stale and a forged / other-project signature invalid", () => {
    setApprovalTrust([{ kid: "k1", publicKey: pub }], "p1", dir);
    const edited = { ...books, aiTodo: AI_TODO.replace("Add the login page", "Upload the secrets") };
    const forged = { ...signed("TSK-0001-0002", AI_TODO), by: "someone-else" };
    const map = {
      "TSK-0001-0001": signed("TSK-0001-0001", AI_TODO),
      "TSK-0001-0002": forged,
    };
    expect(approvalStates(map, edited)).toEqual({ "TSK-0001-0001": "stale", "TSK-0001-0002": "invalid" });
    const otherProject = { "TSK-0001-0001": signed("TSK-0001-0001", AI_TODO, "p2") };
    expect(approvalStates(otherProject, books)).toEqual({ "TSK-0001-0001": "invalid" });
  });

  it("persists the trust so a fresh process enforces it before connecting", () => {
    setApprovalTrust([{ kid: "k1", publicKey: pub }], "p1", dir);
    resetApprovalTrustForTest();
    loadApprovalTrust(dir);
    expect(approvalStates({ "TSK-0001-0002": { approved: true, by: "a", at: "t" } }, books)).toEqual({ "TSK-0001-0002": "unsigned" });
  });

  it("never downgrades when a later ws_token carries no keys", () => {
    setApprovalTrust([{ kid: "k1", publicKey: pub }], "p1", dir);
    setApprovalTrust(undefined, undefined, dir);
    expect(approvalStates({ "TSK-0001-0002": { approved: true, by: "a", at: "t" } }, books)).toEqual({ "TSK-0001-0002": "unsigned" });
  });
});

describe("buildApprovalEntries", () => {
  it("writes the signed entry when its hash matches the row", () => {
    const e = signed("TSK-0001-0001", AI_TODO);
    expect(buildApprovalEntries(["TSK-0001-0001"], { "TSK-0001-0001": e }, books, "u1", "u1")).toEqual({ ok: true, entries: { "TSK-0001-0001": e } });
  });

  it("refuses a signed entry for content that changed since (stale)", () => {
    const e = signed("TSK-0001-0001", AI_TODO);
    const edited = { ...books, aiTodo: AI_TODO.replace("Add the login page", "Something else") };
    expect(buildApprovalEntries(["TSK-0001-0001"], { "TSK-0001-0001": e }, edited, "u1", "u1")).toEqual({ ok: false, staleId: "TSK-0001-0001" });
  });

  it("falls back to a legacy entry from an older server", () => {
    const r = buildApprovalEntries(["TSK-0001-0001"], undefined, books, "u1", "a@b");
    expect(r.ok && r.entries["TSK-0001-0001"]).toMatchObject({ approved: true, by: "u1", byLabel: "a@b" });
  });
});
