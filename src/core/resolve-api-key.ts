/**
 * Resolve a profile's managed `ANTHROPIC_API_KEY` (ADR-0378) just-in-time at spawn. `inline` returns
 * the stored value; `ssm` fetches an AWS SSM Parameter Store parameter; `secretsManager` fetches an AWS
 * Secrets Manager secret (optionally a JSON key within it), using the worker's own AWS credential chain
 * (ECS task role / env / shared config). The AWS SDK clients are loaded via a **dynamic, computed**
 * import so they are optional — only AWS workers that actually use ssm/secretsManager need the packages
 * installed; a non-AWS worker (inline / OAuth) never loads them. A resolve failure returns null so the
 * run falls over to the next profile instead of hanging; values are cached per descriptor for the run.
 */
import type { ApiKeyDescriptor } from "../utils/ai-cli";
import { logger } from "../common/logger/logger";

/** In-process cache of resolved remote secrets, keyed by the descriptor (avoids re-fetching per spawn). */
const cache = new Map<string, string>();

/** Load an optional AWS SDK package by a computed specifier (kept external — installed on AWS workers only). */
async function loadAws(pkg: string): Promise<Record<string, unknown>> {
  const spec = pkg;
  return (await import(spec)) as Record<string, unknown>;
}

/** Fetch an API key from AWS SSM Parameter Store (SecureString decrypted). */
async function fetchSsm(d: ApiKeyDescriptor): Promise<string | null> {
  const aws = await loadAws("@aws-sdk/client-ssm");
  const SSMClient = aws.SSMClient as new (cfg: Record<string, unknown>) => {
    send: (cmd: unknown) => Promise<{ Parameter?: { Value?: string } }>;
  };
  const GetParameterCommand = aws.GetParameterCommand as new (input: Record<string, unknown>) => unknown;
  const client = new SSMClient(d.region ? { region: d.region } : {});
  const res = await client.send(new GetParameterCommand({ Name: d.name, WithDecryption: true }));
  return res.Parameter?.Value?.trim() || null;
}

/** Fetch an API key from AWS Secrets Manager (optionally a `jsonKey` within a JSON secret). */
async function fetchSecretsManager(d: ApiKeyDescriptor): Promise<string | null> {
  const aws = await loadAws("@aws-sdk/client-secrets-manager");
  const SecretsManagerClient = aws.SecretsManagerClient as new (cfg: Record<string, unknown>) => {
    send: (cmd: unknown) => Promise<{ SecretString?: string }>;
  };
  const GetSecretValueCommand = aws.GetSecretValueCommand as new (input: Record<string, unknown>) => unknown;
  const client = new SecretsManagerClient(d.region ? { region: d.region } : {});
  const res = await client.send(new GetSecretValueCommand({ SecretId: d.secretId }));
  const raw = (res.SecretString ?? "").trim();
  if (!raw) return null;
  if (d.jsonKey) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const v = obj[d.jsonKey];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Resolve the descriptor to an API key string, or null (no descriptor / empty / fetch failed). A null
 * result ⇒ the spawn proceeds without a managed key (OAuth), and a failed remote fetch fails the attempt
 * over to the next profile.
 */
export async function resolveApiKey(desc: ApiKeyDescriptor | undefined): Promise<string | null> {
  if (!desc || !desc.source) return null;
  if (desc.source === "inline") return desc.value?.trim() || null;
  const cacheKey = JSON.stringify(desc);
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  try {
    const val =
      desc.source === "ssm"
        ? await fetchSsm(desc)
        : desc.source === "secretsManager"
          ? await fetchSecretsManager(desc)
          : null;
    if (val) {
      cache.set(cacheKey, val);
      return val;
    }
    return null;
  } catch (err) {
    logger.warn("ai.apiKey.resolve.failed", { source: desc.source, error: String(err) });
    return null;
  }
}
