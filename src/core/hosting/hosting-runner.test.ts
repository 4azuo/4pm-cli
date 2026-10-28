/**
 * Tests of the release commands: `.4pm/host.yml` fills the fields the form left empty, and the form wins otherwise.
 * @adr 0664
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostComposeYml, readHostYml, resolveCompose, resolveProcess } from "./hosting-runner";

describe("host.yml", () => {
  it("reads the flat keys and ignores the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "4pm-hostyml-"));
    mkdirSync(join(dir, ".4pm"));
    writeFileSync(join(dir, ".4pm", "host.yml"), "install: npm ci\nstart: node server.js\nport: 8080\nhealthPath: /health\nextra: [1]\nbuild: 3\n");
    expect(readHostYml(dir)).toEqual({ install: "npm ci", start: "node server.js", port: 8080, healthPath: "/health" });
    expect(readHostYml(join(dir, "missing"))).toEqual({});
    writeFileSync(join(dir, ".4pm", "host.yml"), "runMode: process\nprocess:\n  build: npm run build\n  start: npm start\ncompose:\n  service: web\n");
    expect(readHostYml(dir)).toEqual({ build: "npm run build", start: "npm start" });
    writeFileSync(join(dir, ".4pm", "host.yml"), "compose:\n  file: deploy/compose.yml\n  service: web\n  port: 3000\n");
    const yml = readHostComposeYml(dir);
    expect(yml).toEqual({ file: "deploy/compose.yml", service: "web", port: 3000 });
    expect(resolveCompose({ file: "docker-compose.yml", service: "", healthPath: "/" }, yml)).toEqual({ file: "deploy/compose.yml", service: "web", port: 3000, healthPath: "/" });
    expect(resolveCompose({ file: "docker-compose.yml", service: "api", port: 8080, healthPath: "/" }, yml).service).toBe("api");
  });

  it("fills only the empty form fields", () => {
    const yml = { install: "npm ci", start: "node server.js", healthPath: "/health", healthTimeoutSec: 120 };
    expect(resolveProcess({ start: "", healthPath: "/", healthTimeoutSec: 60 }, yml)).toEqual({
      install: "npm ci",
      build: undefined,
      start: "node server.js",
      port: undefined,
      healthPath: "/health",
      healthTimeoutSec: 120,
    });
    expect(resolveProcess({ start: "npm start", healthPath: "/up", healthTimeoutSec: 30 }, yml).start).toBe("npm start");
    expect(resolveProcess({ start: "npm start", healthPath: "/up", healthTimeoutSec: 30 }, yml).healthPath).toBe("/up");
  });
});
