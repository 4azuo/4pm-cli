/**
 * Network egress control DTOs ("Networks") — the per-project policy (mode + allowlist + denylist) and the
 * org denylist stored in settings, the rule target grammar (host · `*.suffix` · IP/CIDR) with its
 * normalisation and matching, the pure policy decision the cli's proxy applies (and the server mirrors
 * for display / export), plus the API request/response shapes of the Networks routes.
 * @adr 0439
 */
import { z } from "zod";
import { baseRequestSchema } from "./base";

/** Policy modes: off (no filter, no log) · audit (log, block only denylisted) · enforce (allowlist only). */
export const NETWORK_MODES = ["off", "audit", "enforce"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];
/** Mode of a project that never saved a policy. */
export const DEFAULT_NETWORK_MODE: NetworkMode = "audit";

/** Where a rule came from. */
export const NETWORK_RULE_SOURCES = ["manual", "log", "request"] as const;
export type NetworkRuleSource = (typeof NETWORK_RULE_SOURCES)[number];

/** Max rules per list (project allow, project deny, org deny). */
export const NETWORK_RULES_MAX = 200;
/** Default days a network event is kept (org value; a project may set a shorter one). */
export const DEFAULT_NETWORK_LOG_RETENTION_DAYS = 30;
/** Hard upper bound of a retention value (the plan's `retentionDays` caps it further). */
export const NETWORK_LOG_RETENTION_MAX_DAYS = 3650;

/** One stored rule (`settings.network.allow|deny[]`). `port` null = any port. */
export interface NetworkRule {
  id: string;
  target: string;
  port: number | null;
  note?: string;
  source: NetworkRuleSource;
  addedBy: string;
  addedByName: string;
  addedAt: string;
}

/** The project policy (`project.settings.network`). */
export interface ProjectNetworkSettings {
  mode: NetworkMode;
  allow: NetworkRule[];
  deny: NetworkRule[];
  /** Shorter retention for this project's events; null = the org value. */
  logRetentionDays: number | null;
}

/** The org part (`organizations.settings.network`). */
export interface OrgNetworkSettings {
  deny: NetworkRule[];
  logRetentionDays: number;
}

// ── Targets ──────────────────────────────────────────────────────────────────────────────────────────

/** A parsed rule target. */
export type NetworkTarget =
  | { kind: "host"; host: string }
  | { kind: "wildcard"; suffix: string }
  | { kind: "ip"; version: 4 | 6; base: bigint; bits: number };

const HOST_LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Parse an IPv4 literal to its 32-bit value, or null. */
function parseIpv4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

/** Parse an IPv6 literal (with `::`, optional embedded IPv4) to its 128-bit value, or null. */
function parseIpv6(s: string): bigint | null {
  if (!/^[0-9a-f:.]+$/.test(s) || s.split("::").length > 2) return null;
  const expand = (part: string): string[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const last = groups[groups.length - 1] ?? "";
    if (last.includes(".")) {
      const v4 = parseIpv4(last);
      if (v4 === null) return null;
      groups.splice(groups.length - 1, 1, ((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16));
    }
    return groups.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? groups : null;
  };
  const [head, tail] = s.split("::") as [string, string | undefined];
  const h = expand(head);
  const t = tail === undefined ? [] : expand(tail);
  if (!h || !t) return null;
  const missing = 8 - h.length - t.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...h, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...t];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** Parse an IP literal (v4 or v6, brackets allowed) → `{ version, value }`, or null. */
export function parseIp(raw: string): { version: 4 | 6; value: bigint } | null {
  const s = raw.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const v4 = parseIpv4(s);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseIpv6(s);
  return v6 !== null ? { version: 6, value: v6 } : null;
}

/** Lower-case, trailing-dot-free, IDN→punycode hostname, or null when it is not a valid name. */
function normalizeHostname(raw: string): string | null {
  let h = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!h || h.length > 253) return null;
  if (/[^\x20-\x7e]/.test(h)) {
    try {
      h = new URL(`http://${h}`).hostname;
    } catch {
      return null;
    }
  }
  const labels = h.split(".");
  // An all-numeric last label is never a name (it is a malformed IP such as `300.1.1.1`).
  if (/^\d+$/.test(labels[labels.length - 1] ?? "")) return null;
  return labels.every((l) => HOST_LABEL_RE.test(l)) ? h : null;
}

/** Parse + normalise a rule target (host, `*.suffix`, IP or CIDR); null when invalid. */
export function parseNetworkTarget(raw: string): NetworkTarget | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const cidr = /^(.+)\/(\d{1,3})$/.exec(s);
  if (cidr) {
    const ip = parseIp(cidr[1]!);
    const bits = Number(cidr[2]);
    if (!ip || bits > (ip.version === 4 ? 32 : 128)) return null;
    return { kind: "ip", version: ip.version, base: ip.value, bits };
  }
  const ip = parseIp(s);
  if (ip) return { kind: "ip", version: ip.version, base: ip.value, bits: ip.version === 4 ? 32 : 128 };
  if (s.startsWith("*.")) {
    const suffix = normalizeHostname(s.slice(2));
    return suffix && suffix.includes(".") ? { kind: "wildcard", suffix } : null;
  }
  const host = normalizeHostname(s);
  return host ? { kind: "host", host } : null;
}

/** The canonical text of a target (what is stored and displayed), or null when invalid. */
export function normalizeNetworkTarget(raw: string): string | null {
  const t = parseNetworkTarget(raw);
  if (!t) return null;
  if (t.kind === "host") return t.host;
  if (t.kind === "wildcard") return `*.${t.suffix}`;
  const full = t.version === 4 ? 32 : 128;
  const ipText =
    t.version === 4
      ? [24n, 16n, 8n, 0n].map((sh) => ((t.base >> sh) & 0xffn).toString()).join(".")
      : Array.from({ length: 8 }, (_, i) => ((t.base >> BigInt((7 - i) * 16)) & 0xffffn).toString(16)).join(":");
  return t.bits === full ? ipText : `${ipText}/${t.bits}`;
}

/** Does an IP value fall inside a parsed IP target? */
function ipInTarget(ip: { version: 4 | 6; value: bigint }, t: Extract<NetworkTarget, { kind: "ip" }>): boolean {
  if (ip.version !== t.version) return false;
  const width = BigInt(t.version === 4 ? 32 : 128);
  const shift = width - BigInt(t.bits);
  return ip.value >> shift === t.base >> shift;
}

/**
 * Does `target` match a connection to `host` (a name or an IP literal)? A wildcard matches subdomains
 * only, never the apex. An IP/CIDR target matches an IP host, or the resolved `ip` of a named host.
 */
export function networkTargetMatches(target: string, host: string, ip?: string): boolean {
  const t = parseNetworkTarget(target);
  if (!t) return false;
  if (t.kind === "ip") {
    const literal = parseIp(host) ?? (ip ? parseIp(ip) : null);
    return literal ? ipInTarget(literal, t) : false;
  }
  const h = normalizeHostname(host);
  if (!h) return false;
  return t.kind === "host" ? h === t.host : h.endsWith(`.${t.suffix}`);
}

// ── Policy decision ──────────────────────────────────────────────────────────────────────────────────

/** A rule as pushed to the cli / evaluated (no authorship). */
export interface NetworkPolicyRule {
  target: string;
  port: number | null;
}

/** The effective policy of one project run (org deny already merged into `deny`). */
export interface NetworkPolicy {
  mode: NetworkMode;
  allow: NetworkPolicyRule[];
  deny: NetworkPolicyRule[];
}

/** A logged decision. */
export const NETWORK_DECISIONS = ["allowed", "would_block", "blocked", "denied"] as const;
export type NetworkDecision = (typeof NETWORK_DECISIONS)[number];

/** Does a rule match `host:port` (null rule port = any)? */
function ruleMatches(rule: NetworkPolicyRule, host: string, port: number, ip?: string): boolean {
  return (rule.port === null || rule.port === port) && networkTargetMatches(rule.target, host, ip);
}

/**
 * The decision for one connection: system hosts always pass; then a deny match is `denied`; then `off`
 * passes unlogged (`log: false`), `enforce` passes only an allow match (`blocked` otherwise), `audit`
 * passes everything and flags a non-allowed host `would_block`. `pass` says whether to connect.
 */
export function decideEgress(
  policy: NetworkPolicy,
  system: readonly NetworkPolicyRule[],
  host: string,
  port: number,
  ip?: string,
): { decision: NetworkDecision; pass: boolean; log: boolean; system: boolean } {
  if (system.some((r) => ruleMatches(r, host, port, ip))) return { decision: "allowed", pass: true, log: policy.mode !== "off", system: true };
  if (policy.deny.some((r) => ruleMatches(r, host, port, ip))) return { decision: "denied", pass: false, log: true, system: false };
  if (policy.mode === "off") return { decision: "allowed", pass: true, log: false, system: false };
  const allowed = policy.allow.some((r) => ruleMatches(r, host, port, ip));
  if (allowed) return { decision: "allowed", pass: true, log: true, system: false };
  return policy.mode === "enforce"
    ? { decision: "blocked", pass: false, log: true, system: false }
    : { decision: "would_block", pass: true, log: true, system: false };
}

/** True when an explicit allow rule names this IP (or a CIDR containing it) — lifts the SSRF guard. */
export function allowRuleNamesIp(policy: NetworkPolicy, ip: string, port: number): boolean {
  const literal = parseIp(ip);
  if (!literal) return false;
  return policy.allow.some((r) => {
    const t = parseNetworkTarget(r.target);
    return t?.kind === "ip" && (r.port === null || r.port === port) && ipInTarget(literal, t);
  });
}

// ── Settings readers ─────────────────────────────────────────────────────────────────────────────────

/** Read one stored rule list, dropping invalid entries (never throws). */
function readRules(raw: unknown): NetworkRule[] {
  if (!Array.isArray(raw)) return [];
  const out: NetworkRule[] = [];
  for (const item of raw.slice(0, NETWORK_RULES_MAX)) {
    const r = item as Partial<NetworkRule> | null;
    const target = typeof r?.target === "string" ? normalizeNetworkTarget(r.target) : null;
    if (!r || !target) continue;
    const port = typeof r.port === "number" && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 ? r.port : null;
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : `${target}:${port ?? "*"}`,
      target,
      port,
      ...(typeof r.note === "string" && r.note ? { note: r.note.slice(0, 200) } : {}),
      source: NETWORK_RULE_SOURCES.includes(r.source as NetworkRuleSource) ? (r.source as NetworkRuleSource) : "manual",
      addedBy: typeof r.addedBy === "string" ? r.addedBy : "",
      addedByName: typeof r.addedByName === "string" ? r.addedByName : "",
      addedAt: typeof r.addedAt === "string" ? r.addedAt : "",
    });
  }
  return out;
}

/** A retention value within [1, max], else null. */
function readDays(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= NETWORK_LOG_RETENTION_MAX_DAYS ? v : null;
}

/** Read `project.settings.network` with defaults (mode `audit`). */
export function readProjectNetworkSettings(raw: unknown): ProjectNetworkSettings {
  const n = (raw ?? {}) as Partial<Record<keyof ProjectNetworkSettings, unknown>>;
  return {
    mode: NETWORK_MODES.includes(n.mode as NetworkMode) ? (n.mode as NetworkMode) : DEFAULT_NETWORK_MODE,
    allow: readRules(n.allow),
    deny: readRules(n.deny),
    logRetentionDays: readDays(n.logRetentionDays),
  };
}

/** Read `organizations.settings.network` with defaults (30 days). */
export function readOrgNetworkSettings(raw: unknown): OrgNetworkSettings {
  const n = (raw ?? {}) as Partial<Record<keyof OrgNetworkSettings, unknown>>;
  return { deny: readRules(n.deny), logRetentionDays: readDays(n.logRetentionDays) ?? DEFAULT_NETWORK_LOG_RETENTION_DAYS };
}

/** The pushed / evaluated policy of a project (project deny + org deny). */
export function effectiveNetworkPolicy(project: ProjectNetworkSettings, org: OrgNetworkSettings): NetworkPolicy {
  const strip = (r: NetworkRule): NetworkPolicyRule => ({ target: r.target, port: r.port });
  return { mode: project.mode, allow: project.allow.map(strip), deny: [...project.deny, ...org.deny].map(strip) };
}

// ── API shapes ───────────────────────────────────────────────────────────────────────────────────────

/** One rule in a request body (authorship is server-filled). */
export const networkRuleInputSchema = z.object({
  target: z
    .string()
    .trim()
    .min(1)
    .max(260)
    .refine((t) => normalizeNetworkTarget(t) !== null, { message: "Invalid host, *.domain, IP or CIDR" }),
  port: z.number().int().min(1).max(65535).nullable().default(null),
  note: z.string().trim().max(200).optional(),
  source: z.enum(NETWORK_RULE_SOURCES).optional(),
});
export type NetworkRuleInput = z.infer<typeof networkRuleInputSchema>;

/** A rule list without duplicates (same normalised target + port). */
const ruleListSchema = z
  .array(networkRuleInputSchema)
  .max(NETWORK_RULES_MAX)
  .refine((list) => new Set(list.map((r) => `${normalizeNetworkTarget(r.target)}:${r.port ?? "*"}`)).size === list.length, {
    message: "Duplicate rules",
  });

/** Body PUT /projects/:id/network. @api project-0089 */
export const putProjectNetworkRequestSchema = z.object({
  mode: z.enum(NETWORK_MODES),
  allow: ruleListSchema,
  deny: ruleListSchema,
  logRetentionDays: z.number().int().min(1).max(NETWORK_LOG_RETENTION_MAX_DAYS).nullable().optional(),
});
export type PutProjectNetworkRequest = z.infer<typeof putProjectNetworkRequestSchema>;

/** Body of the org `settings.network` namespace (org-0002). */
export const orgNetworkSettingsInputSchema = z.object({
  deny: ruleListSchema.optional(),
  logRetentionDays: z.number().int().min(1).max(NETWORK_LOG_RETENTION_MAX_DAYS).optional(),
});

/** Kind of a system host (shown locked). */
export type NetworkSystemHostKind = "4pm" | "provider" | "git" | "mcp";

/** Egress capability of a serving cli. */
export type NetworkEgressCapability = "container" | "none";

/** Response of project-0088 / project-0089. */
export interface ProjectNetworkResponse extends ProjectNetworkSettings {
  orgDeny: NetworkRule[];
  systemHosts: { target: string; port: number | null; kind: NetworkSystemHostKind }[];
  orgLogRetentionDays: number;
  /** Plan cap of any retention value (days). */
  retentionCapDays: number;
  workers: { machineLinkId: string; name: string; online: boolean; egress: NetworkEgressCapability | null; reason?: string }[];
  pendingRequests: number;
}

/** Query of project-0090 / machine-0076 (+ BaseRequest paging; `search` = host substring). */
export const networkEventsQuerySchema = baseRequestSchema.extend({
  group: z.enum(["host", "none"]).default("host"),
  /** Comma list of decisions; default = all. */
  decision: z.string().max(80).optional(),
  machineLinkId: z.string().guid().optional(),
  /** machine-0076 only: one project, or `none` = project-less runs. */
  projectId: z.string().max(64).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type NetworkEventsQuery = z.infer<typeof networkEventsQuerySchema>;

/** One row of the network log (grouped by host + port + decision unless `group=none`). */
export interface NetworkEventRow {
  host: string;
  port: number;
  decision: NetworkDecision;
  count: number;
  firstAt: string;
  lastAt: string;
  workers: { machineLinkId: string; name: string }[];
  project?: { id: string; name: string } | null;
  lastRun: { runId?: string; taskId?: string } | null;
  ruleState: "allowed" | "denied" | "org_denied" | "system" | null;
}

/** Request kinds / statuses. */
export const NETWORK_REQUEST_KINDS = ["allow", "block"] as const;
export type NetworkRequestKind = (typeof NETWORK_REQUEST_KINDS)[number];
export const NETWORK_REQUEST_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type NetworkRequestStatus = (typeof NETWORK_REQUEST_STATUSES)[number];

/** Body POST /projects/:id/network/requests. @api project-0092 */
export const createNetworkRequestSchema = z.object({
  kind: z.enum(NETWORK_REQUEST_KINDS),
  target: networkRuleInputSchema.shape.target,
  port: z.number().int().min(1).max(65535).nullable().default(null),
  reason: z.string().trim().min(1).max(500),
});
export type CreateNetworkRequest = z.infer<typeof createNetworkRequestSchema>;

/** Body POST /projects/:id/network/requests/:requestId/decision. @api project-0093 */
export const decideNetworkRequestSchema = z.object({
  action: z.enum(["approve", "reject", "cancel"]),
  note: z.string().trim().max(500).optional(),
});
export type DecideNetworkRequest = z.infer<typeof decideNetworkRequestSchema>;

/** Query of project-0091 (+ BaseRequest paging). */
export const networkRequestsQuerySchema = baseRequestSchema.extend({
  /** Comma list of statuses; default `pending`. */
  status: z.string().max(80).optional(),
});
export type NetworkRequestsQuery = z.infer<typeof networkRequestsQuerySchema>;

/** One network request. */
export interface NetworkRequestItem {
  id: string;
  kind: NetworkRequestKind;
  target: string;
  port: number | null;
  reason: string;
  status: NetworkRequestStatus;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: string;
  decisionNote?: string;
}

/** Export formats of project-0094. */
export const NETWORK_EXPORT_FORMATS = ["domains", "dns-firewall", "network-firewall"] as const;
export type NetworkExportFormat = (typeof NETWORK_EXPORT_FORMATS)[number];
/** Query of project-0094. */
export const networkExportQuerySchema = z.object({ format: z.enum(NETWORK_EXPORT_FORMATS) });

/** Response of project-0094 — the web saves `content` as a file. */
export interface NetworkExportResponse {
  filename: string;
  contentType: string;
  content: string;
}
