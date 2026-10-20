/**
 * Tests for the `project.tokens` handler's served-project fields: a push for another project replaces the
 * AI memory and forgets native sessions, switches the approval-signature project, and applies outbound review +
 * repos; a push for the same project keeps the memory.
 * @adr 0569
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WsChannels, type RepoPush, type WsEnvelope } from "@4pm/ws";
import { handleProjectChannels } from "./project";
import type { WsHandlerCtx } from "../context";
import { resetApprovalTrustForTest, setApprovalTrust } from "../../autonomous/autonomous-approvals";

let dir: string;
beforeEach(() => {
  resetApprovalTrustForTest();
  dir = mkdtempSync(join(tmpdir(), "4pm-ptok-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A minimal handler context recording what the push applied. */
function makeCtx(projectId: string | null) {
  const state = { outbound: false, repos: [] as RepoPush[] };
  const ctx = {
    profileDir: dir,
    servedProjectId: projectId,
    aiMemory: "old project memory",
    sessionIdByKey: new Map([["k", "s1"]]),
    sessionMetaByKey: new Map([["k", { at: 1, contextTokens: 1 }]]),
    setRestrictToFolder: () => undefined,
    setOutboundReviewEnabled: (v: boolean) => void (state.outbound = v),
    setServingRepos: (r: RepoPush[]) => void (state.repos = r),
    request: async () => ({}),
  } as unknown as WsHandlerCtx;
  return { ctx, state };
}

/** Deliver one `project.tokens` push. */
function push(ctx: WsHandlerCtx, payload: Record<string, unknown>): void {
  const message = { channel: WsChannels.PROJECT_TOKENS } as WsEnvelope;
  handleProjectChannels(ctx, message, { aiRunTimeoutSec: 0, autoClearIdleMinutes: 0, sessionSwitchPct: 0, perPromptTokenLimit: 0, ...payload });
}

describe("project.tokens served-project fields", () => {
  it("a switch replaces memory, forgets sessions and applies outbound review + repos", () => {
    const pub = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    setApprovalTrust([{ kid: "k1", publicKey: pub }], "p1", dir);
    const { ctx, state } = makeCtx("p1");
    const repos = [{ primary: true, url: "https://x/r.git", branch: "b2" }];
    push(ctx, { projectId: "p2", memoryText: "new project memory", outboundReview: { enabled: true }, repos });
    expect(ctx.servedProjectId).toBe("p2");
    expect(ctx.aiMemory).toBe("new project memory");
    expect(ctx.sessionIdByKey.size).toBe(0);
    expect(ctx.sessionMetaByKey.size).toBe(0);
    expect(state).toEqual({ outbound: true, repos });
  });

  it("a push for the same project keeps memory and sessions", () => {
    const { ctx } = makeCtx("p1");
    push(ctx, { projectId: "p1" });
    expect(ctx.aiMemory).toBe("old project memory");
    expect(ctx.sessionIdByKey.size).toBe(1);
  });

  it("an older server (no projectId) changes nothing project-scoped", () => {
    const { ctx } = makeCtx("p1");
    push(ctx, {});
    expect(ctx.servedProjectId).toBe("p1");
    expect(ctx.aiMemory).toBe("old project memory");
  });

  it("going idle clears the memory", () => {
    const { ctx } = makeCtx("p1");
    push(ctx, { projectId: null, memoryText: "" });
    expect(ctx.servedProjectId).toBeNull();
    expect(ctx.aiMemory).toBe("");
  });
});
