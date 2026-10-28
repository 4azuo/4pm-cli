/**
 * Tests of the hosting helpers: the tunnel log reading, a log tail, the edge target file and the edge proxy forwarding.
 * @adr 0664
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tunnelLogState } from "./cloudflared";
import { freePort, isAlive, readText, setEdgeTarget, startEdge, stopGroup, tailFile, waitHealthy } from "./hosting-process";

const dir = mkdtempSync(join(tmpdir(), "4pm-hosting-test-"));

describe("hosting helpers", () => {
  it("reads the quick URL and the connection from the cloudflared log", () => {
    const log = join(dir, "tunnel.log");
    writeFileSync(log, "INF Requesting new quick Tunnel\nINF |  https://brave-fox-12.trycloudflare.com  |\nINF Registered tunnel connection connIndex=0\n");
    expect(tunnelLogState(log)).toEqual({ url: "https://brave-fox-12.trycloudflare.com", connected: true });
    expect(tunnelLogState(join(dir, "none.log"))).toEqual({ url: null, connected: false });
  });

  it("tails a log and writes the edge target", () => {
    const log = join(dir, "app.log");
    writeFileSync(log, Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\n");
    expect(tailFile(log, 2).text.trim().split("\n")).toEqual(["line 8", "line 9"]);
    setEdgeTarget(join(dir, "edge.target"), "127.0.0.1", 1234);
    expect(readText(join(dir, "edge.target"))).toBe("127.0.0.1:1234\n");
  });

  it("forwards the edge port to the live instance", async () => {
    const app = createServer((_req, res) => res.end("ok"));
    const appPort = await freePort();
    await new Promise<void>((r) => app.listen(appPort, "127.0.0.1", () => r()));
    const edgePort = await freePort();
    const target = join(dir, "edge2.target");
    setEdgeTarget(target, "127.0.0.1", appPort);
    const pid = startEdge(edgePort, target, join(dir, "edge.log"));
    try {
      expect(await waitHealthy(`http://127.0.0.1:${edgePort}/`, 10, () => isAlive(pid))).toBe(true);
    } finally {
      await stopGroup(pid, 2_000);
      app.close();
    }
  });
});
