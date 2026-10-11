/**
 * Tests for the autonomous config coercion — the `runTimeoutMinutes` default and clamp.
 * @adr 0452
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autonomousConfigPath, readAutonomousConfig } from "./autonomous-config";

let dir = "";

/** Write a raw config into a fresh profile dir and read it back through the coercion. */
async function readWith(raw: Record<string, unknown>) {
  dir = await mkdtemp(join(tmpdir(), "4pm-auto-cfg-"));
  await writeFile(autonomousConfigPath(dir), JSON.stringify(raw));
  return readAutonomousConfig(dir);
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runTimeoutMinutes", () => {
  it("defaults to 60", async () => {
    expect((await readWith({})).runTimeoutMinutes).toBe(60);
  });

  it("is never below 5 minutes nor unlimited", async () => {
    expect((await readWith({ runTimeoutMinutes: 0 })).runTimeoutMinutes).toBe(5);
    expect((await readWith({ runTimeoutMinutes: 2 })).runTimeoutMinutes).toBe(5);
  });

  it("never outlives the claim", async () => {
    expect((await readWith({ runTimeoutMinutes: 600, claimTtlHours: 2 })).runTimeoutMinutes).toBe(120);
  });

  it("falls back to the default on an invalid value", async () => {
    expect((await readWith({ runTimeoutMinutes: "x" })).runTimeoutMinutes).toBe(60);
  });
});
