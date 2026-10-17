/**
 * Tests for the lost `revoked` report retry: a scope whose report fails is re-sent by `flushPendingRevoked`
 * on reconnect, and skipped when the scope holds tokens again.
 * @adr 0535
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitTokenReply, GitTokenRequest } from "@4pm/ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureGitAuth, endGitScope, flushPendingRevoked, issueGitToken } from "./git-auth";

let dir: string;
let online: boolean;
let sent: GitTokenRequest[];

/** Fake WS transport: issues a token without `apiBase` (no GitHub call), throws while offline. */
async function transport(req: GitTokenRequest): Promise<GitTokenReply> {
  if (!online) throw new Error("Server did not respond (timeout).");
  sent.push(req);
  return req.op === "issue" ? ({ token: "tok", hostKind: "github" } as GitTokenReply) : ({} as GitTokenReply);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "4pm-git-auth-"));
  online = true;
  sent = [];
  configureGitAuth("github-app", "github.com", dir, transport);
});

afterEach(() => {
  configureGitAuth(null, null, dir, transport);
  rmSync(dir, { recursive: true, force: true });
});

describe("revoked report retry", () => {
  it("re-sends a report lost while offline", async () => {
    expect(await issueGitToken("job-1", "github.com", "o/r")).toBe("tok");
    online = false;
    await endGitScope("job-1");
    online = true;
    sent = [];
    await flushPendingRevoked();
    expect(sent).toEqual([{ op: "revoked", scope: "job-1" }]);
    sent = [];
    await flushPendingRevoked();
    expect(sent).toEqual([]);
  });

  it("skips a pending scope that is active again", async () => {
    await issueGitToken("job-2", "github.com", "o/r");
    online = false;
    await endGitScope("job-2");
    online = true;
    await issueGitToken("job-2", "github.com", "o/r");
    sent = [];
    await flushPendingRevoked();
    expect(sent).toEqual([]);
    await endGitScope("job-2");
    expect(sent).toEqual([{ op: "revoked", scope: "job-2" }]);
  });
});
