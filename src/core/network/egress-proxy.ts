/**
 * Egress proxy (Networks) — a loopback HTTP proxy run by the cli (uid `node`): every agent-uid process
 * gets `HTTPS_PROXY` / `HTTP_PROXY` pointing here with a per-run token. With the launcher's firewall rules
 * it is the agent's only way out. Each connection is decided by the run's policy (system hosts → deny →
 * mode), checked against private / metadata addresses (SSRF guard: only an explicit IP/CIDR allow rule
 * lifts it) after resolving the name itself, logged, then tunnelled (`CONNECT`) or forwarded (plain HTTP).
 * When the cli itself sits behind a corporate proxy (`HTTPS_PROXY` in its own env), connections are chained
 * through it.
 * @adr 0439
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { allowRuleNamesIp, decideEgress, networkTargetMatches, type NetworkDecision } from "@4pm/dto";
import { recordEgress } from "./egress-events";
import { defaultEgressRun, policyFor, runOfToken, servedProjectId, systemHosts, type EgressRun } from "./egress-state";

/** Addresses never reached unless an allow rule names them (loopback, private, link-local, metadata…). */
const PRIVATE_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];

/** True when an IP is private / loopback / link-local / metadata (IPv4-mapped IPv6 unwrapped). */
export function isPrivateIp(ip: string): boolean {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = v4mapped ? v4mapped[1]! : ip;
  return PRIVATE_CIDRS.some((c) => networkTargetMatches(c, addr));
}

/** Split `host:port` / `[v6]:port`; null when malformed. */
export function splitHostPort(s: string, defPort: number): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1]!.toLowerCase(), port };
}

/** The token of a `Proxy-Authorization: Basic base64(run:<token>)` header, or null. */
function tokenOf(req: IncomingMessage): string | null {
  const h = req.headers["proxy-authorization"];
  const m = typeof h === "string" ? /^Basic\s+(.+)$/i.exec(h) : null;
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const i = decoded.indexOf(":");
  return i >= 0 ? decoded.slice(i + 1) : null;
}

/** The cli's own upstream proxy (corporate), from its environment at start; null when none. */
function upstreamProxy(): URL | null {
  const raw = process.env.FOURPM_EGRESS_UPSTREAM || process.env.HTTPS_PROXY || process.env.https_proxy || "";
  try {
    return raw ? new URL(raw) : null;
  } catch {
    return null;
  }
}

/** Outcome of deciding one connection. */
interface Verdict {
  pass: boolean;
  /** The address to connect to (when passing and not via an upstream proxy). */
  ip: string | null;
  reason: string;
}

/** Metadata / link-local addresses (cloud instance credentials) — refused in every mode unless named. */
const METADATA_CIDRS = ["169.254.0.0/16", "fd00:ec2::254/128"];

/** True when an IP is a metadata / link-local address. */
export function isMetadataIp(ip: string): boolean {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = v4mapped ? v4mapped[1]! : ip;
  return METADATA_CIDRS.some((c) => networkTargetMatches(c, addr));
}

/**
 * Decide (and log) one connection of `run` to `host:port`, in two steps. By name first — a name that may
 * not pass is never resolved, so the proxy cannot become a DNS exfiltration channel for the agent. Then the
 * resolved address: IP deny rules, and the private-address guard (metadata / link-local always; any other
 * private address only in Enforce — Off and Audit keep LAN registries and services working). Only an
 * explicit IP/CIDR allow rule lifts the guard.
 */
async function judge(run: EgressRun, host: string, port: number): Promise<Verdict> {
  const policy = policyFor(run.kind);
  const system = systemHosts();
  const literal = isIP(host) ? host : null;
  const log = (decision: NetworkDecision, always: boolean, logFlag: boolean): void => {
    if (!logFlag && !always) return;
    recordEgress({
      host,
      port,
      decision,
      mode: policy.mode,
      projectId: run.kind === "project" ? servedProjectId() : null,
      ...(run.runId ? { runId: run.runId } : {}),
      ...(run.taskId ? { taskId: run.taskId } : {}),
    });
  };
  const first = decideEgress(policy, system, host, port, literal ?? undefined);
  if (!first.pass) {
    log(first.decision, true, true);
    return { pass: false, ip: null, reason: `${host} is ${first.decision === "denied" ? "on the denylist" : "not on the allowlist"}` };
  }
  let ip = literal;
  if (!ip) {
    try {
      ip = (await lookup(host)).address;
    } catch {
      ip = null;
    }
  }
  let decision: NetworkDecision = first.decision;
  if (ip && !first.system) {
    const second = decideEgress(policy, system, host, port, ip);
    if (!second.pass) {
      log(second.decision, true, true);
      return { pass: false, ip: null, reason: `${host} (${ip}) is ${second.decision === "denied" ? "on the denylist" : "not on the allowlist"}` };
    }
    if (isPrivateIp(ip) && !allowRuleNamesIp(policy, ip, port)) {
      if (policy.mode === "enforce" || isMetadataIp(ip)) {
        log("blocked", true, true);
        return { pass: false, ip: null, reason: `${host} resolves to a private address (${ip}); add an allow rule for that IP/CIDR` };
      }
      // Audit: a private destination would be refused under Enforce — flag it, let it through.
      if (policy.mode === "audit") decision = "would_block";
    }
  }
  log(decision, false, first.log);
  if (!ip && !upstreamProxy()) return { pass: false, ip: null, reason: `cannot resolve ${host}` };
  return { pass: true, ip, reason: "" };
}

/**
 * The run of a request. No / unknown token (a client that cannot send proxy credentials, e.g. Java's
 * system properties) ⇒ the default run of this cli — dropping the token never loosens a policy.
 */
function runOf(req: IncomingMessage): EgressRun {
  return runOfToken(tokenOf(req)) ?? defaultEgressRun();
}

/** Open a TCP tunnel to `host:port` — directly to the checked `ip`, or through the upstream proxy. */
function openTunnel(host: string, port: number, ip: string | null): Promise<Socket> {
  const up = upstreamProxy();
  return new Promise((resolve, reject) => {
    if (!up) {
      const s = connect({ host: ip ?? host, port }, () => resolve(s));
      s.once("error", reject);
      return;
    }
    const s = connect({ host: up.hostname, port: Number(up.port) || 8080 }, () => {
      const auth = up.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`).toString("base64")}\r\n` : "";
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      if (/^HTTP\/1\.[01] 200/.test(buf)) {
        const rest = Buffer.from(buf.slice(end + 4), "latin1");
        if (rest.length) s.unshift(rest);
        resolve(s);
      } else reject(new Error(`upstream proxy refused: ${buf.split("\r\n")[0]}`));
    };
    s.on("data", onData);
    s.once("error", reject);
  });
}

/** Refuse a CONNECT with a readable reason. */
function refuseSocket(socket: Socket, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nContent-Type: text/plain\r\nX-4PM-Egress: blocked\r\n\r\n4PM Networks: ${reason}\n`);
}

/** Handle `CONNECT host:port` (TLS and any other tunnelled protocol, git over ssh included). */
async function onConnect(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
  client.on("error", () => client.destroy());
  const hp = splitHostPort(req.url ?? "", 443);
  if (!hp) return refuseSocket(client, 400, "malformed CONNECT target");
  const v = await judge(runOf(req), hp.host, hp.port);
  if (!v.pass) return refuseSocket(client, 403, v.reason);
  try {
    const upstream = await openTunnel(hp.host, hp.port, v.ip);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  } catch (err) {
    refuseSocket(client, 502, `cannot reach ${hp.host}:${hp.port} (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Handle a plain-HTTP proxied request (absolute URI). */
async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "");
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("4PM Networks: not a proxy request\n");
    return;
  }
  if (url.protocol !== "http:") {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("4PM Networks: use CONNECT for https\n");
    return;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = Number(url.port) || 80;
  const v = await judge(runOf(req), host, port);
  if (!v.pass) {
    res.writeHead(403, { "Content-Type": "text/plain", "X-4PM-Egress": "blocked" }).end(`4PM Networks: ${v.reason}\n`);
    return;
  }
  const headers = { ...req.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const up = upstreamProxy();
  const out = httpRequest(
    up
      ? { host: up.hostname, port: Number(up.port) || 8080, method: req.method, path: url.toString(), headers }
      : { host: v.ip ?? host, port, method: req.method, path: `${url.pathname}${url.search}`, headers: { ...headers, host: url.host } },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  out.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`4PM Networks: cannot reach ${host}:${port} (${err.message})\n`);
  });
  req.pipe(out);
}

let server: Server | null = null;
let port = 0;

/** Start the proxy on a random loopback port (idempotent); resolves the port, or 0 when it cannot start. */
export async function startEgressProxy(): Promise<number> {
  if (server) return port;
  const s = createServer((req, res) => void onRequest(req, res));
  s.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => void onConnect(req, socket, head));
  s.on("clientError", (_err, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => resolve());
    });
  } catch {
    return 0;
  }
  const addr = s.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  server = s;
  s.unref();
  return port;
}

/** The proxy port, or 0 when it is not running. */
export function egressProxyPort(): number {
  return port;
}

/** Stop the proxy (tests). */
export async function stopEgressProxy(): Promise<void> {
  const s = server;
  server = null;
  port = 0;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
}
