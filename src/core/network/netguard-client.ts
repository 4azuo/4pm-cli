/**
 * netguard client (Networks) — keeps the worker's kernel egress rules for the agent uid in step with the
 * policy: the served project's mode and its IP/CIDR allow / deny rules (an idle cli is held to Enforce with
 * the org denylist). It sends one JSON request per change (and a periodic resync) to the image's netguard
 * helper on its node-group unix socket; without the helper (no guard, older image) it does nothing.
 * @adr 0439
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { parseNetworkTarget, normalizeNetworkTarget, type NetworkMode, type NetworkPolicyRule } from "@4pm/dto";

/** The helper's socket (in the helper's own node-group dir). */
export const NETGUARD_SOCKET = "/tmp/4pm-netguard/netguard.sock";
/** Resync period (a helper restarted later, or a missed request). */
const RESYNC_MS = 60_000;

/** The kernel state the helper should hold. */
export interface KernelEgress {
  mode: NetworkMode;
  allow: { cidr: string; port: number | null }[];
  deny: { cidr: string; port: number | null }[];
}

let source: (() => KernelEgress) | null = null;
let lastSent = "";
let lastError: string | null = null;
let timer: NodeJS.Timeout | null = null;
let debounce: NodeJS.Timeout | null = null;

/** The IP/CIDR rules of a list as kernel rules (host / wildcard rules stay with the proxy). */
export function ipRules(rules: NetworkPolicyRule[]): { cidr: string; port: number | null }[] {
  const out: { cidr: string; port: number | null }[] = [];
  for (const r of rules) {
    if (parseNetworkTarget(r.target)?.kind !== "ip") continue;
    const cidr = normalizeNetworkTarget(r.target);
    if (cidr) out.push({ cidr, port: r.port });
  }
  return out;
}

/** The last helper error (shown as the egress reason), or null. */
export function netguardError(): string | null {
  return lastError;
}

/** Send one request to the helper; resolves its reply. */
function request(body: object): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const s = connect(NETGUARD_SOCKET);
    let buf = "";
    s.setTimeout(10_000, () => {
      s.destroy();
      resolve({ ok: false, error: "netguard timed out" });
    });
    s.on("connect", () => s.write(`${JSON.stringify(body)}\n`));
    s.on("data", (c: Buffer) => (buf += c.toString("utf8")));
    s.on("end", () => {
      try {
        resolve(JSON.parse(buf.trim()) as { ok: boolean; error?: string });
      } catch {
        resolve({ ok: false, error: "netguard sent no reply" });
      }
    });
    s.on("error", (err) => resolve({ ok: false, error: `netguard unreachable: ${err.message}` }));
  });
}

/** Push the current desired state if it changed (or `force`). Never throws. */
async function push(force: boolean): Promise<void> {
  if (!source || !existsSync(NETGUARD_SOCKET)) return;
  const want = source();
  const key = JSON.stringify(want);
  if (!force && key === lastSent && lastError === null) return;
  const reply = await request({ op: "apply", ...want });
  if (reply.ok) {
    lastSent = key;
    lastError = null;
  } else {
    lastError = reply.error ?? "netguard refused the rules";
  }
}

/** Start syncing with the helper from `desired` (idempotent). */
export function startNetguardSync(desired: () => KernelEgress): void {
  source = desired;
  if (!timer) {
    timer = setInterval(() => void push(true), RESYNC_MS);
    timer.unref();
  }
  requestNetguardSync();
}

/** Ask for a sync soon (debounced — a burst of policy updates sends one request). */
export function requestNetguardSync(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void push(false), 200);
  debounce.unref();
}
