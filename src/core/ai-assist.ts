/**
 * AI helpers on the worker: run the AI CLI (default `claude` in print mode; override via
 * AI_CLI) with a prompt and return the result. Used by scaffold AI-init (`aiGenerate`) and
 * the outbound input review (`aiOutboundReview`, ADR-0082). Spec-assist (suggest/review/
 * compose) no longer lives here — it runs via command.dispatch({ ai:true }) → the
 * profile-failover path (ADR-0100). Requires the AI CLI installed + authenticated on the
 * worker (checked via git-env, machine-0008).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The AI CLI binary (default `claude`; also `codex`). Override via AI_CLI. */
function aiCli(): string {
  return process.env.AI_CLI || "claude";
}

/** Non-interactive args per provider (request machine-readable output). */
function aiArgs(cli: string, prompt: string): string[] {
  if (cli === "claude") return ["-p", prompt, "--output-format", "json"];
  if (cli === "codex") return ["exec", "--json", prompt];
  return ["-p", prompt];
}

/** Estimate tokens from prompt + output length (~4 chars/token) — fallback. */
function estimateTokens(prompt: string, output: string): number {
  return Math.max(1, Math.ceil((prompt.length + output.length) / 4));
}

/**
 * Parse the CLI stdout into {text, tokens}, reading the **real token usage** the
 * AI CLI reports (claude `--output-format json` → `usage`; codex `--json` stream
 * → `usage`). Falls back to a length estimate when usage isn't present.
 */
function parseAi(cli: string, stdout: string, prompt: string): { text: string; tokens: number } {
  if (cli === "claude") {
    try {
      const j = JSON.parse(stdout) as {
        result?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (j.result ?? "").trim();
      const tokens = (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0);
      if (text || tokens) return { text, tokens: tokens || estimateTokens(prompt, text) };
    } catch {
      // not JSON (older CLI) — fall through to plain
    }
  }
  if (cli === "codex") {
    try {
      let text = "";
      let tokens = 0;
      for (const line of stdout.split("\n").filter(Boolean)) {
        const obj = JSON.parse(line) as {
          text?: string;
          message?: string;
          usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number };
        };
        if (obj.text) text = obj.text;
        else if (obj.message) text = obj.message;
        if (obj.usage) {
          tokens =
            obj.usage.total_tokens ??
            (obj.usage.input_tokens ?? 0) + (obj.usage.output_tokens ?? 0);
        }
      }
      if (text || tokens) return { text: text.trim(), tokens: tokens || estimateTokens(prompt, text) };
    } catch {
      // not JSON-lines — fall through to plain
    }
  }
  const text = stdout.trim();
  return { text, tokens: estimateTokens(prompt, text) };
}

/** Run the AI CLI non-interactively with a prompt; return output + real tokens. */
async function runAi(prompt: string): Promise<{ text: string; tokens: number }> {
  const cli = aiCli();
  const { stdout } = await run(cli, aiArgs(cli, prompt), {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseAi(cli, stdout, prompt);
}

/** Run the AI CLI and return only the text (best-effort helper for AI init). */
export async function aiGenerate(prompt: string): Promise<string> {
  const { text } = await runAi(prompt);
  return text;
}

/**
 * Outbound-review verdict from the AI (ADR-0082): judge whether an input is safe to run
 * against the 4 criteria (secret leak, other-environment impact, edit-scope, repo-scope)
 * WITHOUT being given secret values. Replies with a strict JSON `{ok, reasons[]}`; parse
 * errors fail closed (ok=false, reason "ai_parse"). Throws on AI infra error so the caller
 * can fall back / try another reviewer.
 */
export async function aiOutboundReview(
  input: string,
  allowedRepos: string[],
  projectPath: string,
): Promise<{ ok: boolean; reasons: string[]; tokens: number }> {
  const prompt =
    `You are a security reviewer for an autonomous coding agent. Decide if the following ` +
    `INPUT is SAFE to run. It is UNSAFE if it: (1) asks the AI using secret VALUES ` +
    `(api keys, env values, passwords); (2) would affect other environments (only the ` +
    `sandbox project is allowed, no ssh/deploy/prod); (3) edits outside the project folder ` +
    `"${projectPath}"; (4) commits/pushes to a repo not in this allowlist: ` +
    `${allowedRepos.length ? allowedRepos.join(", ") : "(none declared)"}. Reply with ONLY ` +
    `JSON: {"ok": <true|false>, "reasons": ["secret"|"environment"|"path"|"repo", ...]}. ` +
    `INPUT:\n${input}`;
  const { text, tokens } = await runAi(prompt);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, reasons: ["ai_parse"], tokens };
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as { ok?: boolean; reasons?: unknown };
    const reasons = Array.isArray(j.reasons)
      ? j.reasons.filter((r): r is string => typeof r === "string")
      : [];
    return { ok: j.ok === true && reasons.length === 0, reasons, tokens };
  } catch {
    return { ok: false, reasons: ["ai_parse"], tokens };
  }
}
