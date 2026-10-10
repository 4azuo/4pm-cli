/**
 * faq-compose — the worker side of the platform AI pool's ticket → FAQ synthesis (ADR-0333). On a
 * `faq.compose` dispatch (sent to a support agent since ADR-0346) the cli clones the `4pm-faq` repo
 * into a throwaway folder using a SHORT-LIVED WRITE token injected in the request (a per-job GitHub-App
 * installation token), runs `claude` with **file-edit tools only** to distil the selected support
 * tickets into FAQ markdown, then commits, pushes a branch, and opens a PR with `gh` itself.
 *
 * Hardening (ADR-0346) — the ticket bodies in the prompt are untrusted (guests can file tickets): the
 * agent gets no Bash / web tools and an allow-listed environment, and the token is passed per git
 * command (`http.extraHeader`) and to `gh` only — it is never written into the clone (whose remote URL
 * stays token-free) nor visible to the agent. The clone is deleted afterwards.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FaqComposeReply, FaqComposeRequest, FaqTicket, FaqTicketResult } from "@4pm/ws";
import { logger } from "../common/logger/logger";
import { createAiStreamParser, estimateTokens, type AiUsage } from "./ai-stream";
import type { ResolvedClaudeProfile } from "../utils/ai-cli";
import { agentEnv, gitAuthArgs } from "./agent-sandbox";
import { denySettingsArgs } from "../utils/agent-deny";
import { strictMcpArgs } from "../utils/agent-mcp";
import { resolveCliPrompt } from "./prompt-overrides";
import { agentSpawnArgs, execInProject } from "./agent-spawn";
import { makeAgentTempDir, unregisterAgentRoot } from "../utils/agent-user";


/** Zero usage — the fallback when a run captured no token counts. */
const NO_USAGE: AiUsage = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/** Max time the write-capable claude agent may run (ms) — an agent-write may take many turns. */
const COMPOSE_TIMEOUT_MS = 10 * 60 * 1000;

/** How to run claude for the synthesis — the operator's configured profiles (working-first, ADR-0057). */
export interface FaqComposeAi {
  cmd: string;
  profiles: ResolvedClaudeProfile[];
  env?: Record<string, string>;
}

/**
 * Tools denied to the synthesis agent (ADR-0346). Nothing is blanket-allowed: under `acceptEdits` the
 * agent may read and edit only inside its working directory (the throwaway clone) — reads/edits
 * elsewhere (e.g. the Claude credentials dir) would need an approval that a headless run never gets.
 */
const AGENT_DENIED_TOOLS = ["Bash", "WebFetch", "WebSearch", "NotebookEdit", "Task"];

/** Build the agent-write prompt: distil the tickets into FAQ markdown committed to the repo. */
function buildPrompt(tickets: FaqTicket[], customPrompt?: string): string {
  const transcript = tickets
    .map((t) => {
      const thread = t.messages.map((m) => `  [${m.author}] ${m.body}`).join("\n");
      return `### Ticket ${t.id} — ${t.subject} (${t.category})\n${thread}`;
    })
    .join("\n\n");
  const ids = tickets.map((t) => t.id);
  const ticketJsonSkeleton = `{"perTicket":[${ids.map((id) => `{"ticketId":"${id}","summary":"..."}`).join(",")}]}`;
  const customInstruction = customPrompt?.trim()
    ? `\n\nAdditional instruction from the operator (follow it too):\n${customPrompt.trim()}`
    : "";
  // Admin override (ADR-0381) for `cli.faq.compose`, else the shared registry default; the ticket
  // `transcript` is wrapped as untrusted data by the registry (ADR-0421), the operator's instruction is not.
  return resolveCliPrompt("cli.faq.compose", { transcript, ticketJsonSkeleton, customInstruction });
}

/** Parse the trailing ```json {"perTicket":[…]} ``` block from the agent output; [] when absent/invalid. */
function parsePerTicket(text: string): FaqTicketResult[] {
  // Find the LAST {"perTicket" object (tolerate fences / surrounding prose).
  const idx = text.lastIndexOf('"perTicket"');
  if (idx === -1) return [];
  const open = text.lastIndexOf("{", idx);
  if (open === -1) return [];
  // Scan forward to the matching closing brace.
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(open, i + 1)) as { perTicket?: unknown };
          if (Array.isArray(obj.perTicket)) {
            return obj.perTicket
              .filter((e): e is FaqTicketResult => !!e && typeof (e as FaqTicketResult).ticketId === "string")
              .map((e) => ({ ticketId: e.ticketId, summary: String(e.summary ?? "") }));
          }
        } catch {
          return [];
        }
        return [];
      }
    }
  }
  return [];
}

/** One edit-only `claude` attempt (acceptEdits + file tools) in the repo dir; captures usage. */
function runClaudeOnce(
  cmd: string,
  profile: ResolvedClaudeProfile | null,
  prompt: string,
  cwd: string,
  extraEnv: Record<string, string> | undefined,
  denyDirs: string[] = [],
): Promise<{ code: number; out: string; err: string; usage: AiUsage }> {
  return new Promise((resolve, reject) => {
    const isClaude = cmd.includes("claude");
    const args = [
      "-p",
      ...(profile?.model ? ["--model", profile.model] : []),
      ...(isClaude ? ["--output-format", "stream-json", "--verbose"] : []),
      // Secret-path deny rules (ADR-0347): reads are not confined to the clone, so the credential
      // dirs / cli profile / ssh / gh / git credentials are explicitly denied.
      // No MCP server on this run (ADR-0427): repo/user MCP config is ignored.
      ...strictMcpArgs(cmd),
      ...denySettingsArgs(cmd, [...denyDirs, profile?.dir]),
      // Edit-only headless agent (ADR-0346): file edits are auto-accepted, everything else (Bash, web)
      // is denied, since the prompt carries untrusted ticket text. git/PR are done by this module.
      ...(isClaude
        ? ["--permission-mode", "acceptEdits", "--disallowedTools", ...AGENT_DENIED_TOOLS]
        : []),
      ...(cmd.includes("codex") ? ["--sandbox", "workspace-write"] : []),
    ];
    // Allow-listed env only — the cli's own secrets never reach the agent (ADR-0346).
    const env = agentEnv(extraEnv, profile ? { CLAUDE_CONFIG_DIR: profile.dir } : undefined);
    // The AI CLI always runs as the agent user when uid separation is on (ADR-0430).
    const run = agentSpawnArgs(cmd, args, env);
    const child = spawn(run.cmd, run.args, { stdio: ["pipe", "pipe", "pipe"], cwd, env: run.env });
    const parser = createAiStreamParser(cmd);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("faq-compose agent timed out"));
    }, COMPOSE_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (d: Buffer) => (out += parser.push(d.toString())));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      out += parser.flush();
      resolve({ code: code ?? -1, out, err, usage: parser.usage() });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Run the agent across the configured profiles (working-first), failing over on any failed attempt. */
async function runClaudeWithFailover(
  prompt: string,
  cwd: string,
  ai: FaqComposeAi,
): Promise<{ usage: AiUsage; text: string }> {
  const attempts: (ResolvedClaudeProfile | null)[] = ai.profiles.length > 0 ? ai.profiles : [null];
  let lastReason = "no attempt";
  for (let i = 0; i < attempts.length; i++) {
    const { code, out, err, usage } = await runClaudeOnce(ai.cmd, attempts[i]!, prompt, cwd, ai.env, ai.profiles.map((p) => p.dir));
    if (code === 0) return { usage, text: out.trim() };
    lastReason = `exited ${code}: ${(err || out).slice(0, 500)}`;
    if (i === attempts.length - 1) break;
  }
  throw new Error(`claude ${lastReason}`);
}

/** Cap on the agent output text returned to the server (kept small for the run record + modal). */
const MAX_OUTPUT_CHARS = 8_000;

/**
 * Distil the selected tickets into FAQ markdown in the `4pm-faq` repo, commit, push a branch, and open
 * a PR — all with the short-lived write token, which (and the whole clone) is wiped afterwards. Any
 * failure is returned as `{ prUrl: "", error }` so the server marks the run failed rather than hanging.
 */
export async function runFaqCompose(req: FaqComposeRequest, ai: FaqComposeAi): Promise<FaqComposeReply> {
  if (!req.repo.token) return { prUrl: "", error: "no write token" };
  // A throwaway folder shared with the agent user (ADR-0430): the clone, the agent's edits and every git /
  // gh step in it run as the agent, so a hook planted in the clone never executes as the cli.
  const base = makeAgentTempDir("4pm-faq-sync-");
  const workDir = join(base, "repo");
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // Per-command auth (ADR-0346): the token rides a header on clone/push only; the clone's remote URL
  // and config stay token-free, so the agent working in it cannot read the token.
  const auth = gitAuthArgs("x-access-token", req.repo.token);
  try {
    await execInProject("git", [...auth, "clone", "--depth", "1", "--branch", req.repo.branch, req.repo.url, workDir], { cwd: base, env: gitEnv });
    // A 4PM commit identity (the token authorizes the push; identity is cosmetic).
    await execInProject("git", ["-C", workDir, "config", "user.name", "4PM FAQ Bot"], { env: gitEnv });
    await execInProject("git", ["-C", workDir, "config", "user.email", "faq-bot@4pm.app"], { env: gitEnv });
    await execInProject("git", ["-C", workDir, "checkout", "-b", req.headBranch], { env: gitEnv });

    const { usage, text } = await runClaudeWithFailover(buildPrompt(req.tickets, req.customPrompt), workDir, ai);
    const output = text.slice(0, MAX_OUTPUT_CHARS);
    const perTicket = parsePerTicket(text);

    await execInProject("git", ["-C", workDir, "add", "-A"], { env: gitEnv });
    // Nothing staged ⇒ the agent judged there was no reusable FAQ value; a successful no-op run.
    const staged = await execInProject("git", ["-C", workDir, "diff", "--cached", "--name-only"], { env: gitEnv });
    if (!staged.stdout.trim()) {
      return { prUrl: "", output, perTicket, tokens: usage.tokens || estimateTokens(text), finishedAt: new Date().toISOString() };
    }

    await execInProject("git", ["-C", workDir, "commit", "-m", "docs(faq): synthesize from support tickets (4PM)"], { env: gitEnv });
    await execInProject("git", [...auth, "-C", workDir, "push", "-u", "origin", req.headBranch], { env: gitEnv });
    // Open the PR with `gh` (the same token authenticates it); best-effort — a failed PR still leaves
    // the pushed branch, so surface the branch even when PR creation fails.
    let prUrl = "";
    try {
      const pr = await execInProject(
        "gh",
        ["pr", "create", "--fill", "--head", req.headBranch, "--base", req.repo.branch],
        { cwd: workDir, env: { ...gitEnv, GH_TOKEN: req.repo.token } },
      );
      prUrl = pr.stdout.trim().split("\n").pop() ?? "";
    } catch (err) {
      logger.warn("faq.compose.pr.failed", { error: String(err) });
    }
    const u = usage.tokens > 0 ? usage : { ...NO_USAGE };
    return {
      prUrl,
      branch: req.headBranch,
      output,
      perTicket,
      tokens: u.tokens,
      ...(usage.tokens > 0
        ? { tokensBreakdown: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheCreation: usage.cacheCreation } }
        : {}),
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn("faq.compose.failed", { error: String(err) });
    return { prUrl: "", error: String(err) };
  } finally {
    // Wipe the throwaway clone (token-free, but nothing of the job should linger).
    unregisterAgentRoot(base);
    if (existsSync(base)) {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        // best-effort — a leftover throwaway clone is cleaned on the next boot's tmp sweep
      }
    }
  }
}
