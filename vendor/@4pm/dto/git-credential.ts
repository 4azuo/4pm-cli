/**
 * DTOs + pure helpers for a project's GitHub-App git-auth credential (ADR-0356): the credential status
 * (never the private key), the set/test requests, and the repo-URL helpers shared by web + server
 * (https check, ssh→https rewrite, host/owner/name parsing, API base + host kind from a host).
 */
import { z } from "zod";

/** Per-repo coverage status of the project's GitHub App (from the last resolve/test). */
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

/** Kind of GitHub host — decides the API base and the `gh` token env. */
export type GithubHostKind = "github" | "ghe-cloud" | "ghes";

/** One declared repo (primary + submodules) and whether the App covers it. */
export interface GitCredentialRepo {
  /** Folder the repo lives in (`root` for the primary, else the submodule path). */
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

/** Data — GET /projects/:id/git-credential (project-0070); `null` when none is saved. */
export interface GitCredentialResponse {
  provider: "github-app";
  enterprise: boolean;
  host: string;
  apiBaseUrl: string | null;
  hasCaCert: boolean;
  appId: string;
  keyFingerprint: string;
  /** Whether `settings.gitAuth.method` is `github-app`. */
  active: boolean;
  repos: GitCredentialRepo[];
  updatedAt: string;
  updatedBy: string | null;
}

/** A bare hostname (no scheme/path/port-less check beyond the basic shape). */
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/, "invalid host");

/**
 * A declared repo passed by the caller (the wizard's in-progress list before the spec is saved); the
 * server otherwise reads the project's spec / draft repos.
 */
export const gitCredentialRepoInputSchema = z.object({
  url: z.string().trim().max(500),
  subdir: z.string().trim().max(120).optional().default(""),
  primary: z.boolean().optional().default(false),
});
export type GitCredentialRepoInput = z.infer<typeof gitCredentialRepoInputSchema>;

/** Body — POST /projects/:id/git-credential/test (project-0073); `repos` optional (wizard). */
export const testGitCredentialRequestSchema = z.object({
  repos: z.array(gitCredentialRepoInputSchema).max(50).optional(),
});
export type TestGitCredentialRequest = z.infer<typeof testGitCredentialRequestSchema>;

/** Body — PUT /projects/:id/git-credential (project-0071). */
export const putGitCredentialRequestSchema = z
  .object({
    appId: z.string().trim().regex(/^\d{1,20}$/, "App ID must be numeric"),
    /** PEM; omit to keep the stored key (required on first save — enforced server-side). */
    privateKey: z.string().trim().max(16_384).optional(),
    enterprise: z.boolean().default(false),
    host: hostSchema.optional(),
    apiBaseUrl: z.string().trim().url().startsWith("https://").max(500).nullable().optional(),
    caCert: z.string().trim().max(32_768).nullable().optional(),
    installationOverrides: z
      .array(z.object({ url: z.string().trim().max(500), installationId: z.string().trim().regex(/^\d{1,20}$/).nullable() }))
      .max(50)
      .optional(),
    /** The wizard's in-progress repos (else the project's spec / draft repos are used). */
    repos: z.array(gitCredentialRepoInputSchema).max(50).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.enterprise && !v.host) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["host"], message: "host is required for GitHub Enterprise" });
    }
  });
export type PutGitCredentialRequest = z.infer<typeof putGitCredentialRequestSchema>;

// ── GitLab group/project access token (ADR-0382) ───────────────────────────────────────────────────

/** Data — GET /projects/:id/gitlab-credential (project-0078); `null` when none is saved. */
export interface GitLabCredentialResponse {
  provider: "gitlab-token";
  host: string;
  group: string;
  apiBaseUrl: string | null;
  hasCaCert: boolean;
  /** SHA-256 of the token ("SHA256:<base64>") — shown instead of the token. */
  tokenFingerprint: string;
  /** Whether `settings.gitAuth.method` is `gitlab-group-token`. */
  active: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

/** Body — PUT /projects/:id/gitlab-credential (project-0079). */
export const putGitLabCredentialRequestSchema = z.object({
  host: hostSchema.optional(),
  group: z.string().trim().min(1).max(200),
  /** The access token; omit to keep the stored one (required on first save — enforced server-side). */
  token: z.string().trim().min(1).max(512).optional(),
  apiBaseUrl: z.string().trim().url().startsWith("https://").max(500).nullable().optional(),
  caCert: z.string().trim().max(32_768).nullable().optional(),
});
export type PutGitLabCredentialRequest = z.infer<typeof putGitLabCredentialRequestSchema>;

/** One step of a GitLab connection test (project-0081). */
export interface GitLabCredentialTestStep {
  /** `api` — the primary repo read through the REST API (`read_api`, ADR-0398). */
  step: "connect" | "authenticate" | "scope" | "api";
  ok: boolean;
  message: string | null;
}

/** Data — POST /projects/:id/gitlab-credential/test (project-0081). */
export interface GitLabCredentialTestResponse {
  steps: GitLabCredentialTestStep[];
}

/** One step of a connection test (project-0073). */
export interface GitCredentialTestStep {
  step: "connect" | "authenticate" | "installations" | "permissions";
  ok: boolean;
  message: string | null;
}

/** Data — POST /projects/:id/git-credential/test (project-0073). */
export interface GitCredentialTestResponse {
  steps: GitCredentialTestStep[];
  repos: GitCredentialRepo[];
}

/** Parsed pieces of a git remote URL (https or scp-like ssh). */
export interface ParsedRepoUrl {
  protocol: "https" | "http" | "ssh";
  host: string;
  owner: string;
  name: string;
}

/**
 * Parse a git remote URL — `https://host/owner/name(.git)`, `ssh://git@host/owner/name`, or scp-like
 * `git@host:owner/name(.git)`. Returns null for anything else. Host is lower-cased; `name` drops `.git`.
 */
export function parseRepoUrl(url: string): ParsedRepoUrl | null {
  const raw = url.trim();
  const scp = /^[\w.-]+@([^:/\s]+):([^/\s]+)\/(.+?)(?:\.git)?\/?$/.exec(raw);
  if (scp) return { protocol: "ssh", host: scp[1]!.toLowerCase(), owner: scp[2]!, name: scp[3]! };
  const std = /^(https?|ssh):\/\/(?:[^@/\s]+@)?([^/\s]+)\/([^/\s]+)\/(.+?)(?:\.git)?\/?$/.exec(raw);
  if (std) {
    return { protocol: std[1] as ParsedRepoUrl["protocol"], host: std[2]!.toLowerCase(), owner: std[3]!, name: std[4]! };
  }
  return null;
}

/** Whether a remote URL uses ssh (scp-like or `ssh://`) — the GitHub App token needs https. */
export function isSshRepoUrl(url: string): boolean {
  return parseRepoUrl(url)?.protocol === "ssh";
}

/** Rewrite an ssh remote to its https form (`https://host/owner/name.git`); other URLs unchanged. */
export function toHttpsRepoUrl(url: string): string {
  const p = parseRepoUrl(url);
  if (!p || p.protocol !== "ssh") return url;
  return `https://${p.host}/${p.owner}/${p.name}.git`;
}

/** Host kind: github.com, a GHE Cloud data-residency host (`*.ghe.com`), or a GHE Server. */
export function githubHostKind(host: string): GithubHostKind {
  const h = host.toLowerCase();
  if (h === "github.com") return "github";
  if (h.endsWith(".ghe.com")) return "ghe-cloud";
  return "ghes";
}

/** REST API base for a GitHub host (an explicit override wins). */
export function githubApiBase(host: string, override?: string | null): string {
  if (override) return override.replace(/\/+$/, "");
  const h = host.toLowerCase();
  const kind = githubHostKind(h);
  if (kind === "github") return "https://api.github.com";
  if (kind === "ghe-cloud") return `https://api.${h}`;
  return `https://${h}/api/v3`;
}

/** Body — POST /projects/:id/scaffold/publish (project-0074, ADR-0368): optionally pick the worker. */
export const scaffoldPublishRequestSchema = z.object({
  machineLinkId: z.string().guid().optional(),
});
export type ScaffoldPublishRequest = z.infer<typeof scaffoldPublishRequestSchema>;
