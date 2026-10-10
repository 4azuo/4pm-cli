/**
 * System egress hosts (Networks) — the hosts an AI run must always reach, by provider, which no project
 * or org rule can deny. The cli adds its own 4PM endpoints (from its config), the project's git hosts
 * and the approved http/sse MCP hosts; this file holds the provider part. `{region}` is filled from the
 * run's AWS / Google region. Versioned with the cli: a provider endpoint change needs a release.
 * @adr 0439
 */

/** One system host: target (exact host or `*.suffix`) + port (null = any). */
export interface EgressSystemHost {
  target: string;
  port: number | null;
}

/** Provider API + login endpoints (claude / codex; Bedrock / Vertex only when their region is set). */
export const EGRESS_PROVIDER_HOSTS = {
  // Claude Code: API, OAuth login / refresh, the WebFetch domain pre-check.
  anthropic: [
    { target: "api.anthropic.com", port: 443 },
    { target: "console.anthropic.com", port: 443 },
    { target: "platform.claude.com", port: 443 },
    { target: "claude.ai", port: 443 },
  ],
  // Codex: API key and ChatGPT-login backends.
  openai: [
    { target: "api.openai.com", port: 443 },
    { target: "auth.openai.com", port: 443 },
    { target: "chatgpt.com", port: 443 },
  ],
  bedrock: [{ target: "bedrock-runtime.{region}.amazonaws.com", port: 443 }],
  vertex: [
    { target: "{region}-aiplatform.googleapis.com", port: 443 },
    { target: "oauth2.googleapis.com", port: 443 },
  ],
} as const satisfies Record<string, readonly EgressSystemHost[]>;

/**
 * Hosts a 4PM-started RAG install / index / query needs (the Python packages + the embedding model),
 * granted only to those runs, never to the agent's own work.
 */
export const EGRESS_RAG_HOSTS: readonly EgressSystemHost[] = [
  { target: "pypi.org", port: 443 },
  { target: "files.pythonhosted.org", port: 443 },
  { target: "huggingface.co", port: 443 },
  { target: "*.huggingface.co", port: 443 },
  { target: "*.hf.co", port: 443 },
];

/** Ports a git host is reachable on (https + ssh). */
export const EGRESS_GIT_PORTS = [443, 22] as const;

/**
 * Extra hosts a git host needs beyond its own name (https only): GitHub's API (`gh`, PR / issue calls)
 * and its content / LFS storage.
 */
export const EGRESS_GIT_EXTRA_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "github.com": ["api.github.com", "*.githubusercontent.com"],
};
