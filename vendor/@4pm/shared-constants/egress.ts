/**
 * Vendored from @4pm/shared-constants (egress.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export interface EgressSystemHost {
    target: string;
    port: number | null;
}
export const EGRESS_PROVIDER_HOSTS = {
    anthropic: [
        { target: "api.anthropic.com", port: 443 },
        { target: "console.anthropic.com", port: 443 },
        { target: "platform.claude.com", port: 443 },
        { target: "claude.ai", port: 443 },
    ],
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
export const EGRESS_RAG_HOSTS: readonly EgressSystemHost[] = [
    { target: "registry.npmjs.org", port: 443 },
    { target: "huggingface.co", port: 443 },
    { target: "*.huggingface.co", port: 443 },
    { target: "*.hf.co", port: 443 },
];
export const EGRESS_GIT_PORTS = [443, 22] as const;
export const EGRESS_GIT_EXTRA_HOSTS: Readonly<Record<string, readonly string[]>> = {
    "github.com": ["api.github.com", "*.githubusercontent.com"],
};
