/**
 * Worker network probe (ADR-0221). 4PM cannot enforce the worker's network from inside the cli, so
 * instead of a server-set policy the cli **detects** the worker's network posture (both directions)
 * and whether it runs containerized, and reports it on the `machine.usage` snapshot; the web then
 * warns when the network is left open. Observe-only — never blocks a dispatch. Never throws (ADR-0075).
 *
 * - `outbound`: can the worker reach the open internet (egress)? A restrictive egress allowlist would
 *   NOT list a neutral public host, so probing `FOURPM_SERVER` is useless (the worker always reaches
 *   it). We TCP-connect to public anycast endpoints (no data sent); reaching any ⇒ outbound is open.
 * - `inbound`: is the worker listening on a public interface (reachable from outside)? We read the
 *   kernel's LISTEN sockets and flag any bound to a non-loopback / wildcard address.
 */
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import type { WorkerNetworkProbe } from "@4pm/dto";

/** Neutral public anycast endpoints (TCP connect only, no payload) that a restrictive egress
 *  allowlist would block — reaching any means the worker's outbound is open. */
const CANARY_TARGETS: { host: string; port: number }[] = [
  { host: "1.1.1.1", port: 443 },
  { host: "8.8.8.8", port: 443 },
];
const PROBE_TIMEOUT_MS = 2500;

/** True when the worker detects it runs inside a container (`/.dockerenv` or a container cgroup). */
function detectContainerized(): boolean {
  try {
    if (existsSync("/.dockerenv")) return true;
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    return /docker|containerd|kubepods|libpod/.test(cgroup);
  } catch {
    return false;
  }
}

/** Resolve whether a single TCP connect succeeds within the timeout (no data sent). */
function canReach(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** `outbound:'open'` when any neutral public canary is reachable (⇒ not sandboxed); else restricted. */
async function probeOutbound(): Promise<"open" | "restricted"> {
  try {
    const results = await Promise.all(CANARY_TARGETS.map((t) => canReach(t.host, t.port)));
    return results.some(Boolean) ? "open" : "restricted";
  } catch {
    return "restricted";
  }
}

/**
 * `inbound:'exposed'` when the worker has any TCP socket in LISTEN state bound to a non-loopback,
 * non-link-local address (i.e. reachable from outside the host) — read from `/proc/net/tcp{,6}`.
 * Linux-only; anything unreadable/unparsable is treated as `isolated` (fail-safe, never throws).
 */
function probeInbound(): "exposed" | "isolated" {
  const isExposed = (path: string, loopbackHexPrefixes: string[]): boolean => {
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch {
      return false;
    }
    for (const line of body.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      // cols: [sl, local_address, rem_address, st, ...]; st '0A' = TCP_LISTEN.
      const local = cols[1];
      const st = cols[3];
      if (!local || st !== "0A") continue;
      const addrHex = local.split(":")[0]?.toUpperCase() ?? "";
      // Loopback bind (127.0.0.1 / ::1) = local-only ⇒ not exposed.
      if (loopbackHexPrefixes.some((p) => addrHex === p)) continue;
      // Anything else in LISTEN (0.0.0.0 / :: / a real IP) is reachable from outside.
      return true;
    }
    return false;
  };
  try {
    // IPv4 127.0.0.1 = little-endian "0100007F"; IPv6 ::1 = "...00000001000000000000000001000000".
    const v4 = isExposed("/proc/net/tcp", ["0100007F"]);
    const v6 = isExposed("/proc/net/tcp6", ["00000000000000000000000001000000"]);
    return v4 || v6 ? "exposed" : "isolated";
  } catch {
    return "isolated";
  }
}

/**
 * Probe the worker's network posture (outbound reachability + inbound exposure) and
 * containerized-ness. Never throws.
 */
export async function probeNetwork(): Promise<WorkerNetworkProbe> {
  return {
    outbound: await probeOutbound(),
    inbound: probeInbound(),
    containerized: detectContainerized(),
    checkedAt: new Date().toISOString(),
  };
}
