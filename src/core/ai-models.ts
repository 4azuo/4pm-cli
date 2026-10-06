/**
 * `ai.models` (ADR-0394) — the models the worker's AI CLI supports, read from the CLI itself rather than a
 * hard-coded list. Claude: spawn `claude -p --input-format stream-json --output-format stream-json`, send
 * one `initialize` control request and read `models[]` from its `control_response` (the handshake the
 * Agent SDK uses for `supportedModels()` — no turn is run, so no tokens are spent), then kill the process.
 * Results are cached in memory per (provider, config dir) for an hour; failures are not cached.
 * codex / antigravity have no catalog yet ⇒ an empty list + an error (the web falls back to free text).
 */
import { spawn } from "node:child_process";
import type { AiModelsReply, AiModelsRequest } from "@4pm/ws";
import { readProfileConfig } from "../config/profile";
import { claudeHomeDirs } from "../utils/ai-cli";
import { getWorkingProfile } from "./ai-profile-state";

/** How long a successful list is reused. */
const CACHE_TTL_MS = 60 * 60 * 1000;
/** Hard stop for the handshake (CLI start-up included). */
const PROBE_TIMEOUT_MS = 20_000;
/** Cap on buffered stdout while waiting for the reply. */
const MAX_STDOUT = 4 * 1024 * 1024;

type Model = AiModelsReply["models"][number];

/** Cached lists keyed by `provider|dir`. */
const cache = new Map<string, { at: number; models: Model[] }>();

/** Map one raw `models[]` entry from the CLI to the wire shape; null when it has no usable value. */
function toModel(raw: unknown): Model | null {
  const m = (raw ?? {}) as Record<string, unknown>;
  const value = typeof m.value === "string" ? m.value.trim() : "";
  if (!value) return null;
  return {
    value,
    resolvedModel: typeof m.resolvedModel === "string" ? m.resolvedModel : null,
    displayName: typeof m.displayName === "string" && m.displayName ? m.displayName : value,
    description: typeof m.description === "string" ? m.description : "",
  };
}

/**
 * Run the Claude CLI's `initialize` handshake with `CLAUDE_CONFIG_DIR = dir` (when given) and resolve its
 * model list; rejects on spawn failure, timeout, or a reply without models.
 */
function probeClaude(cmd: string, dir: string | null): Promise<Model[]> {
  return new Promise((resolve, reject) => {
    let out = "";
    let settled = false;
    const child = spawn(cmd, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
      env: { ...process.env, ...(dir ? { CLAUDE_CONFIG_DIR: dir } : {}) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    /** Settle once, always killing the CLI (it would otherwise wait for a user turn). */
    const finish = (err: Error | null, models?: Model[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(models ?? []);
    };
    const timer = setTimeout(() => finish(new Error("The AI CLI did not answer the model handshake in time.")), PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (e) => finish(new Error(`Could not start ${cmd}: ${e.message}`)));
    child.on("exit", () => finish(new Error("The AI CLI exited before listing its models.")));
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > MAX_STDOUT) return finish(new Error("The AI CLI output was too large."));
      let nl: number;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          const msg = JSON.parse(line) as { type?: string; response?: { request_id?: string; subtype?: string; error?: string; response?: { models?: unknown[] } } };
          if (msg.type !== "control_response" || msg.response?.request_id !== "4pm-models") continue;
          if (msg.response.subtype === "error") return finish(new Error(msg.response.error || "The AI CLI refused the handshake."));
          const models = (msg.response.response?.models ?? []).map(toModel).filter((m): m is Model => m !== null);
          return models.length > 0 ? finish(null, models) : finish(new Error("The AI CLI reported no models."));
        } catch {
          // A non-JSON / partial line — keep reading.
        }
      }
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.write(`${JSON.stringify({ type: "control_request", request_id: "4pm-models", request: { subtype: "initialize" } })}\n`);
  });
}

/** Handle `ai.models` for this profile: cached or freshly probed list, or an empty list + the reason. */
export async function listAiModels(profileDir: string, req: AiModelsRequest): Promise<AiModelsReply> {
  const provider = req?.provider ?? "claude";
  if (provider !== "claude") return { provider, models: [], error: `No model catalog for ${provider} yet.` };
  try {
    const config = readProfileConfig(profileDir);
    const aiCli = config.aiCli && config.aiCli.includes("claude") ? config.aiCli : "claude";
    // The profile in use first (its account decides availability), else the first configured one.
    const working = getWorkingProfile(profileDir, aiCli);
    const dir = working ?? claudeHomeDirs(config)[0] ?? null;
    const key = `${provider}|${dir ?? ""}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { provider, models: hit.models, error: null };
    const models = await probeClaude(aiCli, dir);
    cache.set(key, { at: Date.now(), models });
    return { provider, models, error: null };
  } catch (err) {
    return { provider, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}
