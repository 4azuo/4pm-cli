/**
 * Tests for the self-update re-exec parent: it forwards stop signals to the child (the real cli) and
 * exits with the child's code — `docker stop` must reach the child, not kill it with the container — and
 * the exec path replaces the process in place (same pid, the signal reaches the new cli directly).
 * @adr 0473 @adr 0505
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forwardedSignals } from "./update-reexec";

/** The fixture: as the parent it re-execs itself; as the child (FOURPM_NO_UPDATE=1) it waits for SIGTERM. */
function fixtureSource(): string {
  const mod = pathToFileURL(join(__dirname, "update-reexec.ts")).href;
  return `
if (process.env.FOURPM_NO_UPDATE === "1") {
  process.on("SIGTERM", () => { console.log("child:SIGTERM"); process.exit(7); });
  console.log("child:ready");
  setInterval(() => {}, 1000);
} else {
  const { reexecUpdated } = await import(${JSON.stringify(mod)});
  await reexecUpdated({ preferExec: process.env.FIXTURE_EXEC === "1" });
}
`;
}

describe("reexecUpdated", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "4pm-reexec-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("forwards SIGINT only off a TTY", () => {
    expect(forwardedSignals(true)).toEqual(["SIGTERM", "SIGHUP"]);
    expect(forwardedSignals(false)).toEqual(["SIGTERM", "SIGHUP", "SIGINT"]);
  });

  it.each([
    ["spawn fallback", "0"],
    ["exec in place", "1"],
  ])("%s: SIGTERM reaches the new cli and its exit code is kept", async (_name, exec) => {
    const script = join(dir, "fixture.mjs");
    writeFileSync(script, fixtureSource());
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import tsx`.trim() };
    delete env.FOURPM_NO_UPDATE;
    env.FIXTURE_EXEC = exec;
    const parent = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    parent.stdout.on("data", (b: Buffer) => {
      out += String(b);
      // The child is up ⇒ stop the PARENT, as docker-init would.
      if (out.includes("child:ready")) parent.kill("SIGTERM");
    });
    parent.stderr.on("data", (b: Buffer) => (err += String(b)));
    const code = await new Promise<number | null>((resolve) => parent.on("exit", (c) => resolve(c)));
    expect(err).toBe("");
    expect(out).toContain("child:SIGTERM");
    expect(code).toBe(7);
  }, 20_000);
});
