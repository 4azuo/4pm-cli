/**
 * agent-helper-install tests — the helper is copied into the profile's bin dir and every invocation points
 * at it; without a built helper the cli's own invocation and `4pm net-connect` are the fallback.
 * @adr 0499
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentHelperInvocation,
  agentHelperPath,
  agentProxyCommand,
  cliInvocation,
  installAgentHelper,
  verifyAgentHelper,
} from "./agent-helper-install";

const dirs: string[] = [];

/** A fresh temp dir removed after the test. */
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "4pm-agent-helper-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  installAgentHelper(tempDir(), null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("installAgentHelper", () => {
  it("falls back to the cli invocation when there is no built helper", () => {
    expect(installAgentHelper(tempDir(), null)).toBeNull();
    expect(agentHelperPath()).toBeNull();
    expect(agentHelperInvocation()).toBe(cliInvocation());
    expect(agentProxyCommand()).toBe("4pm net-connect %h %p");
  });

  it("copies the helper into <profileDir>/bin and invokes it with node", () => {
    const profile = tempDir();
    const source = join(tempDir(), "agent-helper.js");
    writeFileSync(source, "// helper");
    const installed = installAgentHelper(profile, source);
    expect(installed).toBe(join(profile, "bin", "agent-helper.mjs"));
    expect(readFileSync(installed!, "utf8")).toBe("// helper");
    expect(existsSync(`${installed}.${process.pid}.tmp`)).toBe(false);
    expect(agentHelperInvocation()).toBe(`"${process.execPath}" "${installed}"`);
    expect(agentProxyCommand()).toBe(`${process.execPath} ${installed} net-connect %h %p`);
  });

  it("skips the agent self-check when separation is off", () => {
    const source = join(tempDir(), "agent-helper.js");
    writeFileSync(source, "// helper");
    installAgentHelper(tempDir(), source);
    expect(verifyAgentHelper()).toBeNull();
  });
});
