/**
 * Vendored from @4pm/dto (git-credential.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const GIT_CREDENTIAL_REPO_STATUSES = [
    "ok",
    "not_installed",
    "no_access",
    "insufficient_permissions",
    "host_mismatch",
    "ssh_url",
    "unchecked",
] as const;
export type GitCredentialRepoStatus = (typeof GIT_CREDENTIAL_REPO_STATUSES)[number];
export type GithubHostKind = "github" | "ghe-cloud" | "ghes";
export interface GitCredentialRepo {
    folder: string;
    url: string;
    owner: string;
    name: string;
    primary: boolean;
    installationId: string | null;
    installationSource: "auto" | "manual";
    status: GitCredentialRepoStatus;
    checkedAt: string | null;
}
export interface GitCredentialResponse {
    provider: "github-app";
    enterprise: boolean;
    host: string;
    apiBaseUrl: string | null;
    hasCaCert: boolean;
    appId: string;
    keyFingerprint: string;
    keyUnreadable: boolean;
    active: boolean;
    repos: GitCredentialRepo[];
    updatedAt: string;
    updatedBy: string | null;
}
const hostSchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/, "invalid host");
export const gitCredentialRepoInputSchema = z.object({
    url: z.string().trim().max(500),
    subdir: z.string().trim().max(120).optional().default(""),
    primary: z.boolean().optional().default(false),
});
export type GitCredentialRepoInput = z.infer<typeof gitCredentialRepoInputSchema>;
export const testGitCredentialRequestSchema = z.object({
    repos: z.array(gitCredentialRepoInputSchema).max(50).optional(),
});
export type TestGitCredentialRequest = z.infer<typeof testGitCredentialRequestSchema>;
export const putGitCredentialRequestSchema = z
    .object({
    appId: z.string().trim().regex(/^\d{1,20}$/, "App ID must be numeric"),
    privateKey: z.string().trim().max(16384).optional(),
    enterprise: z.boolean().default(false),
    host: hostSchema.optional(),
    apiBaseUrl: z.string().trim().url().startsWith("https://").max(500).nullable().optional(),
    caCert: z.string().trim().max(32768).nullable().optional(),
    installationOverrides: z
        .array(z.object({ url: z.string().trim().max(500), installationId: z.string().trim().regex(/^\d{1,20}$/).nullable() }))
        .max(50)
        .optional(),
    repos: z.array(gitCredentialRepoInputSchema).max(50).optional(),
})
    .superRefine((v, ctx) => {
    if (v.enterprise && !v.host) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["host"], message: "host is required for GitHub Enterprise" });
    }
});
export type PutGitCredentialRequest = z.infer<typeof putGitCredentialRequestSchema>;
export const GITLAB_CREDENTIAL_KINDS = ["group-token", "service-account"] as const;
export type GitLabCredentialKind = (typeof GITLAB_CREDENTIAL_KINDS)[number];
export interface GitLabCredentialResponse {
    provider: "gitlab-token";
    kind: GitLabCredentialKind;
    host: string;
    group: string;
    apiBaseUrl: string | null;
    hasCaCert: boolean;
    tokenFingerprint: string;
    active: boolean;
    updatedAt: string;
    updatedBy: string | null;
}
export const putGitLabCredentialRequestSchema = z.object({
    kind: z.enum(GITLAB_CREDENTIAL_KINDS).optional(),
    host: hostSchema.optional(),
    group: z.string().trim().min(1).max(200),
    token: z.string().trim().min(1).max(512).optional(),
    apiBaseUrl: z.string().trim().url().startsWith("https://").max(500).nullable().optional(),
    caCert: z.string().trim().max(32768).nullable().optional(),
});
export type PutGitLabCredentialRequest = z.infer<typeof putGitLabCredentialRequestSchema>;
export interface GitLabCredentialTestStep {
    step: "connect" | "authenticate" | "scope" | "api" | "mint";
    ok: boolean;
    message: string | null;
}
export interface GitLabCredentialTestResponse {
    steps: GitLabCredentialTestStep[];
}
export interface GitCredentialTestStep {
    step: "connect" | "authenticate" | "installations" | "permissions";
    ok: boolean;
    message: string | null;
}
export interface GitCredentialTestResponse {
    steps: GitCredentialTestStep[];
    repos: GitCredentialRepo[];
    ciMissing?: string[];
}
export interface ParsedRepoUrl {
    protocol: "https" | "http" | "ssh";
    host: string;
    owner: string;
    name: string;
}
export function parseRepoUrl(url: string): ParsedRepoUrl | null {
    const raw = url.trim();
    const scp = /^[\w.-]+@([^:/\s]+):([^/\s]+)\/(.+?)(?:\.git)?\/?$/.exec(raw);
    if (scp)
        return { protocol: "ssh", host: scp[1]!.toLowerCase(), owner: scp[2]!, name: scp[3]! };
    const std = /^(https?|ssh):\/\/(?:[^@/\s]+@)?([^/\s]+)\/([^/\s]+)\/(.+?)(?:\.git)?\/?$/.exec(raw);
    if (std) {
        return { protocol: std[1] as ParsedRepoUrl["protocol"], host: std[2]!.toLowerCase(), owner: std[3]!, name: std[4]! };
    }
    return null;
}
export function isSshRepoUrl(url: string): boolean {
    return parseRepoUrl(url)?.protocol === "ssh";
}
export function toHttpsRepoUrl(url: string): string {
    const p = parseRepoUrl(url);
    if (!p || p.protocol !== "ssh")
        return url;
    return `https://${p.host}/${p.owner}/${p.name}.git`;
}
export function githubHostKind(host: string): GithubHostKind {
    const h = host.toLowerCase();
    if (h === "github.com")
        return "github";
    if (h.endsWith(".ghe.com"))
        return "ghe-cloud";
    return "ghes";
}
export function githubApiBase(host: string, override?: string | null): string {
    if (override)
        return override.replace(/\/+$/, "");
    const h = host.toLowerCase();
    const kind = githubHostKind(h);
    if (kind === "github")
        return "https://api.github.com";
    if (kind === "ghe-cloud")
        return `https://api.${h}`;
    return `https://${h}/api/v3`;
}
export const scaffoldPublishRequestSchema = z.object({
    machineLinkId: z.string().guid().optional(),
});
export type ScaffoldPublishRequest = z.infer<typeof scaffoldPublishRequestSchema>;
export interface GitCredentialHealthCheck {
    key: "clone" | "push" | "pullRequest" | "workflows" | "api";
    ok: boolean;
}
export interface GitCredentialHealthRepo {
    repo: string;
    url: string;
    checks: GitCredentialHealthCheck[];
    status: "ok" | "missing" | "unreachable";
    blocking: boolean;
    detail: string | null;
}
export type GitTokenWarning = "long-lived" | "expiring" | "expired" | "over-scoped";
export interface GitTokenHealth {
    source: "stored" | "worker";
    label: string;
    host: string;
    expiryKnown: boolean;
    expiresAt: string | null;
    scopes: string[] | null;
    warnings: GitTokenWarning[];
}
export const GIT_TOKEN_LONG_LIVED_DAYS = 90;
export const GIT_TOKEN_EXPIRING_DAYS = 14;
export const OVERBROAD_GIT_SCOPES: readonly string[] = [
    "sudo",
    "admin_mode",
    "create_runner",
    "manage_runner",
    "k8s_proxy",
    "admin:org",
    "admin:enterprise",
    "delete_repo",
    "admin:repo_hook",
    "admin:org_hook",
    "admin:public_key",
    "admin:gpg_key",
    "write:packages",
    "delete:packages",
    "site_admin",
];
export function gitTokenWarnings(expiryKnown: boolean, expiresAt: string | null, scopes: string[] | null, now: Date = new Date()): GitTokenWarning[] {
    const out: GitTokenWarning[] = [];
    if (expiryKnown) {
        const at = expiresAt ? Date.parse(expiresAt) : NaN;
        if (Number.isNaN(at))
            out.push("long-lived");
        else {
            const days = (at - now.getTime()) / 86400000;
            if (days < 0)
                out.push("expired");
            else if (days <= GIT_TOKEN_EXPIRING_DAYS)
                out.push("expiring");
            else if (days > GIT_TOKEN_LONG_LIVED_DAYS)
                out.push("long-lived");
        }
    }
    if (scopes?.some((s) => OVERBROAD_GIT_SCOPES.includes(s)))
        out.push("over-scoped");
    return out;
}
export interface GitCredentialHealth {
    method: string | null;
    checkedAt: string | null;
    checkedByWorkers: boolean;
    repos: GitCredentialHealthRepo[];
    error: string | null;
    tokens?: GitTokenHealth[];
}
