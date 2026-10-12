/**
 * Tests for the self-update re-exec parent: it forwards stop signals to the child (the real cli) and
 * exits with the child's code — `docker stop` must reach the child, not kill it with the container.
 * @adr 0473
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
  await reexecUpdated();
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

  it("forwards SIGTERM to the child and exits with the child's code", async () => {
    const script = join(dir, "fixture.mjs");
    writeFileSync(script, fixtureSource());
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import tsx`.trim() };
    delete env.FOURPM_NO_UPDATE;
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
