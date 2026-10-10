/**
 * Egress state of the cli (Networks) — the policies its proxy applies: the served project's effective
 * policy (from `ws_token.network` / live `project.tokens`), the fixed policies of project-less runs, the
 * system hosts every run may reach (4PM endpoints, AI providers, the project's git hosts, approved MCP
 * hosts), the per-run proxy tokens that tie a connection to its run, and the enforcement capability the
 * launcher reported.
 * @adr 0439
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { EGRESS_GIT_EXTRA_HOSTS, EGRESS_GIT_PORTS, EGRESS_PROVIDER_HOSTS, EGRESS_RAG_HOSTS } from "@4pm/constants";
import { parseRepoUrl, type NetworkPolicy, type NetworkPolicyRule } from "@4pm/dto";
import type { NetworkPolicyPush } from "@4pm/ws";
import { agentUser } from "../../utils/agent-user";
import { ipRules, netguardError, requestNetguardSync, type KernelEgress } from "./netguard-client";

/** What kind of run a proxy connection belongs to (selects its policy). */
export type EgressRunKind = "project" | "projectless" | "research";

/** Extra hosts a 4PM-started operation is granted on top of its policy (`rag` = RAG install / index / query). */
export type EgressGrant = "rag";

/** One run known to the proxy. */
export interface EgressRun {
  kind: EgressRunKind;
  runId?: string;
  taskId?: string;
  grants?: EgressGrant[];
}

/** The launcher's status file (root-owned, written before the drop to `node`). */
export const EGRESS_STATUS_FILE = "/run/4pm/egress.json";

/** Policy pushed by the server; null until the first `ws_token` with `network` (Audit, no rules). */
let pushed: NetworkPolicyPush | null = null;
/** 4PM endpoint URLs this cli talks to (server + WS). */
let endpoints: string[] = [];
/** Declared repo URLs of the served project. */
let repoUrls: string[] = [];
/** Approved http/sse MCP server URLs. */
let mcpUrls: string[] = [];
/** Per-run tokens → run (pruned after a day). */
const tokens = new Map<string, EgressRun & { at: number }>();

/** Apply the pushed policy (`undefined` = an older server ⇒ keep the current one); resyncs the kernel rules. */
export function setNetworkPolicy(policy: NetworkPolicyPush | undefined): void {
  if (policy) pushed = policy;
  requestNetguardSync();
}

/**
 * The kernel state for the agent uid: the served project's mode + its IP/CIDR rules (deny includes the org
 * denylist); an idle cli (no project) is held to Enforce with the org denylist.
 */
export function kernelEgress(): KernelEgress {
  if (pushed && pushed.projectId) return { mode: pushed.mode, allow: ipRules(pushed.allow), deny: ipRules(pushed.deny) };
  return { mode: "enforce", allow: [], deny: ipRules(pushed?.orgDeny ?? []) };
}

/** Record the 4PM endpoints (server URL + WS URL). */
export function setEgressEndpoints(urls: string[]): void {
  endpoints = urls.filter(Boolean);
}

/** Record the served project's declared repos. */
export function setEgressRepos(urls: string[]): void {
  repoUrls = urls.filter(Boolean);
}

/** Record the approved http/sse MCP URLs. */
export function setEgressMcpUrls(urls: string[]): void {
  mcpUrls = urls.filter(Boolean);
}

/** The served project id (events are attributed to it), or null. */
export function servedProjectId(): string | null {
  return pushed?.projectId ?? null;
}

/** Hostname of a URL, or null. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The system hosts of this cli right now (always allowed, never denied). */
export function systemHosts(): NetworkPolicyRule[] {
  const out: NetworkPolicyRule[] = [];
  const add = (target: string | null, port: number | null): void => {
    if (target && !out.some((r) => r.target === target && r.port === port)) out.push({ target, port });
  };
  for (const u of endpoints) add(hostOf(u), null);
  const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
  const gcpRegion = process.env.CLOUD_ML_REGION || "";
  for (const [provider, list] of Object.entries(EGRESS_PROVIDER_HOSTS)) {
    const region = provider === "bedrock" ? awsRegion : provider === "vertex" ? gcpRegion : "";
    for (const h of list as readonly NetworkPolicyRule[]) {
      if (h.target.includes("{region}")) {
        if (region) add(h.target.replace("{region}", region.toLowerCase()), h.port);
      } else add(h.target, h.port);
    }
  }
  for (const r of repoUrls) {
    const host = parseRepoUrl(r)?.host ?? null;
    for (const port of EGRESS_GIT_PORTS) add(host, port);
    for (const extra of (host && EGRESS_GIT_EXTRA_HOSTS[host]) || []) add(extra, 443);
  }
  for (const u of mcpUrls) add(hostOf(u), null);
  return out;
}

/** The policy a run of `kind` is held to; `grants` add a 4PM operation's fixed hosts (deny still wins). */
export function policyFor(kind: EgressRunKind, grants: readonly EgressGrant[] = []): NetworkPolicy {
  const orgDeny = pushed?.orgDeny ?? [];
  const base: NetworkPolicy =
    kind === "projectless"
      ? { mode: "enforce", allow: [], deny: orgDeny }
      : kind === "research"
        ? { mode: "audit", allow: [], deny: orgDeny }
        : pushed
          ? { mode: pushed.mode, allow: pushed.allow, deny: pushed.deny }
          : { mode: "audit", allow: [], deny: [] };
  if (!grants.includes("rag")) return base;
  return { ...base, allow: [...base.allow, ...EGRESS_RAG_HOSTS.map((h) => ({ target: h.target, port: h.port }))] };
}

/** Mint a proxy token for one run (the proxy maps it back to the run's policy). */
export function mintEgressToken(run: EgressRun): string {
  const now = Date.now();
  if (tokens.size > 5000) {
    for (const [k, v] of tokens) if (now - v.at > 86_400_000) tokens.delete(k);
  }
  const token = randomBytes(18).toString("base64url");
  tokens.set(token, { ...run, at: now });
  return token;
}

/** The default run of this cli: the served project's, else the strict project-less one. */
export function defaultEgressRun(): EgressRun {
  return { kind: servedProjectId() ? "project" : "projectless" };
}

/** The run of a token, or null (unknown ⇒ the proxy applies the cli's default run). */
export function runOfToken(token: string | null): EgressRun | null {
  return token ? (tokens.get(token) ?? null) : null;
}

/** The enforcement capability the launcher reported (`container` = agent-uid rules installed). */
export function egressCapability(): { egress: "container" | "none"; reason?: string } {
  try {
    const s = JSON.parse(readFileSync(EGRESS_STATUS_FILE, "utf8")) as { enforce?: boolean; reason?: string };
    if (s.enforce !== true) return { egress: "none", reason: s.reason || "egress rules not installed" };
    const helper = netguardError() ?? (s.reason || null);
    return helper ? { egress: "container", reason: helper } : { egress: "container" };
  } catch {
    return {
      egress: "none",
      reason: agentUser() ? "egress guard not installed (an older 4PM image)" : "agent user separation is off (the container does not start as root)",
    };
  }
}

/** Test hook: reset the state. */
export function resetEgressStateForTest(): void {
  pushed = null;
  endpoints = [];
  repoUrls = [];
  mcpUrls = [];
  tokens.clear();
}
