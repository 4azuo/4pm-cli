/**
 * Tests for the AI account lease client: the account key (email → api key → local dir), the server's pick
 * mapped back onto the remaining attempts, the pin / preference sent, fail-open on errors and timeouts,
 * release and exhaustion reports — and `runAiFailover` running the leased attempt first.
 * @adr 0518
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiAttempt } from "../../utils/ai-cli";

vi.mock("../exec/executor", () => ({
  /** Fake AI CLI: exit 0 for the dir named "ok", else a usage-limit failure. */
  runCommand: async (
    req: { env: Record<string, string> },
    onOut: (o: { chunk?: string; done?: boolean; exitCode?: number }) => void,
  ) => {
    const ok = (req.env.CLAUDE_CONFIG_DIR ?? "").endsWith("/ok");
    if (!ok) onOut({ chunk: "Claude AI usage limit reached\n" });
    onOut({ done: true, exitCode: ok ? 0 : 1 });
  },
}));
vi.mock("../worker/tool-health", () => ({ reportToolResult: () => undefined }));

const { accountKeyOf, createAccountLeaser } = await import("./ai-account-lease");
const { runAiFailover } = await import("./ai-runner");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "acct-lease-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A claude attempt on `<root>/<name>`, optionally signed in as `email`. */
function attempt(name: string, email?: string): AiAttempt {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (email) writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  return { cmd: "claude", label: name, dir, key: `claude::${dir}`, args: [], stdin: "hi", env: { CLAUDE_CONFIG_DIR: dir } };
}

/** A fake `ai.account` transport recording requests; `pick` answers acquire with that account key. */
function transport(pick: (candidates: string[]) => { accountKey: string; busy?: boolean } | Error) {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    request: async <T>(_channel: string, data: unknown): Promise<T> => {
      const req = data as Record<string, unknown>;
      sent.push(req);
      if (req.op !== "acquire") return { ok: true } as T;
      const r = pick(req.candidates as string[]);
      if (r instanceof Error) throw r;
      return { accountKey: r.accountKey, lease: "L1", leaseTtlSec: 120, busy: r.busy ?? false, order: [] } as T;
    },
  };
}

describe("accountKeyOf", () => {
  it("keys the same signed-in account alike across dirs, and different accounts apart", () => {
    const a = accountKeyOf(attempt("one", "Dev@Example.com"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(accountKeyOf(attempt("two", "dev@example.com"))).toBe(a);
    expect(accountKeyOf(attempt("three", "other@example.com"))).not.toBe(a);
  });

  it("falls back to the API key descriptor, then the local dir", () => {
    const withKey = { ...attempt("k1"), apiKey: { source: "ssm" as const, name: "/p/key" } };
    const sameKey = { ...attempt("k2"), apiKey: { source: "ssm" as const, name: "/p/key" } };
    expect(accountKeyOf(withKey)).toBe(accountKeyOf(sameKey));
    expect(accountKeyOf(attempt("d1"))).not.toBe(accountKeyOf(attempt("d2")));
  });
});

describe("createAccountLeaser", () => {
  it("maps the server's pick onto the remaining attempts and sends the head as preferred", async () => {
    const a = attempt("a", "a@x.io");
    const b = attempt("b", "b@x.io");
    const t = transport((c) => ({ accountKey: c[1]! }));
    const leaser = createAccountLeaser(t, { pinnedCredential: null, usage: () => null });
    expect(await leaser.next([a, b])).toBe(1);
    expect(t.sent[0]).toMatchObject({ op: "acquire", preferred: accountKeyOf(a) });
    leaser.done();
    expect(t.sent.at(-1)).toMatchObject({ op: "release", lease: "L1", accountKey: accountKeyOf(b) });
  });

  it("sends the pin instead of a preference while the pinned attempt remains", async () => {
    const a = attempt("a", "a@x.io");
    const b = attempt("b", "b@x.io");
    const t = transport((c) => ({ accountKey: c[1]!, busy: true }));
    const shared: string[] = [];
    const leaser = createAccountLeaser(t, { pinnedCredential: b.key, usage: () => null, onShared: (l) => shared.push(l) });
    expect(await leaser.next([a, b])).toBe(1);
    expect(t.sent[0]).toMatchObject({ pinned: accountKeyOf(b) });
    expect(t.sent[0]).not.toHaveProperty("preferred");
    expect(shared).toEqual(["b"]);
  });

  it("fails open on a transport error", async () => {
    const leaser = createAccountLeaser(transport(() => new Error("down")), { pinnedCredential: null, usage: () => null });
    expect(await leaser.next([attempt("a"), attempt("b")])).toBe(0);
  });

  it("reports an exhausted account until its 5 h reset when the usage snapshot is about it", async () => {
    const a = attempt("a", "a@x.io");
    const t = transport((c) => ({ accountKey: c[0]! }));
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    const usage = { plan: "max", profile: "a@x.io", session: { utilizationPct: 100, resetsAt: reset }, weekly: { utilizationPct: 1, resetsAt: null }, checkedAt: "" };
    createAccountLeaser(t, { pinnedCredential: null, usage: () => usage }).exhausted(a);
    expect(t.sent[0]).toMatchObject({ op: "exhausted", accountKey: accountKeyOf(a), until: Date.parse(reset) });
  });
});

describe("runAiFailover with a leaser", () => {
  it("runs the leased attempt first and marks a usage-limited account exhausted", async () => {
    const bad = attempt("bad", "bad@x.io");
    const ok = attempt("ok", "ok@x.io");
    // Server: first pick the busy-free "bad" account, then whatever remains.
    const t = transport((c) => ({ accountKey: c[0]! }));
    const leaser = createAccountLeaser(t, { pinnedCredential: null, usage: () => null });
    const handlers = { onChunk: () => undefined, onAttemptStart: () => undefined, onAttemptFail: () => undefined };
    const result = await runAiFailover({ cmd: "claude", attempts: [bad, ok] }, "c1", root, handlers, { leaser });
    expect(result.exitCode).toBe(0);
    expect(result.workedDir).toBe(ok.dir);
    expect(t.sent.map((r) => r.op)).toEqual(["acquire", "exhausted", "release", "acquire", "release"]);
  });

  it("moves the server's choice to the front", async () => {
    const bad = attempt("bad", "bad@x.io");
    const ok = attempt("ok", "ok@x.io");
    const t = transport((c) => ({ accountKey: c[c.length - 1]! }));
    const leaser = createAccountLeaser(t, { pinnedCredential: null, usage: () => null });
    const handlers = { onChunk: () => undefined, onAttemptStart: () => undefined, onAttemptFail: () => undefined };
    const result = await runAiFailover({ cmd: "claude", attempts: [bad, ok] }, "c2", root, handlers, { leaser });
    expect(result.workedDir).toBe(ok.dir);
    expect(t.sent.filter((r) => r.op === "acquire")).toHaveLength(1);
  });
});
