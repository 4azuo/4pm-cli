/**
 * faq-compose — the worker side of the platform AI pool's ticket → FAQ synthesis (ADR-0333). On a
 * `faq.compose` dispatch the cli clones the `4pm-faq` repo into a throwaway folder using a SHORT-LIVED
 * WRITE token injected in the request (a per-job GitHub-App installation token), runs `claude` as a
 * write-capable agent to distil the selected support tickets into FAQ markdown, then commits, pushes a
 * branch, and opens a PR with `gh` (the token also authenticates `gh`). The clone (which holds the
 * token in its remote URL) is DELETED afterwards and the token is never written to any persistent
 * config — so a machine later reassigned to `rental` and rented by an org inherits no write access.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { FaqComposeReply, FaqComposeRequest, FaqTicket, FaqTicketResult } from "@4pm/ws";
import { logger } from "../common/logger/logger";
import { createAiStreamParser, estimateTokens, type AiUsage } from "./ai-stream";
import type { ResolvedClaudeProfile } from "../utils/ai-cli";

const execFileAsync = promisify(execFile);

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

/** Inject the write token into an https URL so clone/push authenticate without a prompt. */
function authedUrl(url: string, token: string): string {
  if (url.startsWith("https://")) return url.replace("https://", `https://x-access-token:${token}@`);
  return url;
}

/** Build the agent-write prompt: distil the tickets into FAQ markdown committed to the repo. */
function buildPrompt(tickets: FaqTicket[], customPrompt?: string): string {
  const transcript = tickets
    .map((t) => {
      const thread = t.messages.map((m) => `  [${m.author}] ${m.body}`).join("\n");
      return `### Ticket ${t.id} — ${t.subject} (${t.category})\n${thread}`;
    })
    .join("\n\n");
  const ids = tickets.map((t) => t.id);
  return [
    "You are maintaining the 4PM product FAQ, stored as markdown in THIS git repository (your CWD).",
    "From the resolved support tickets below, distil reusable, product-general FAQ entries and add or",
    "update the appropriate markdown file(s) in this repo (e.g. an FAQ.md, or the closest existing",
    "topic file — inspect the repo first and match its structure/style).",
    "",
    "Rules:",
    "- Write generalized Q&A, NOT ticket-specific replies; never include customer names, emails, ids,",
    "  org names or any personal data from the tickets.",
    "- Merge with existing entries instead of duplicating; keep the existing formatting and headings.",
    "- If a ticket yields no reusable FAQ value, skip it. If nothing is worth adding, make NO changes.",
    "- Only edit markdown documentation files; do not touch code, CI, or unrelated files.",
    "- Do NOT run git commit/push or open a PR yourself — just leave the edited files in the working",
    "  tree; the surrounding tooling handles commit + PR.",
    ...(customPrompt?.trim()
      ? ["", "Additional instruction from the operator (follow it too):", customPrompt.trim()]
      : []),
    "",
    "===== RESOLVED TICKETS =====",
    transcript,
    "",
    "===== REQUIRED FINAL OUTPUT =====",
    "After finishing all file edits, output — as the LAST thing, on its own — a single fenced JSON",
    "block summarizing what you did PER TICKET (created/updated which FAQ entry, or skipped + why):",
    "```json",
    `{"perTicket":[${ids.map((id) => `{"ticketId":"${id}","summary":"..."}`).join(",")}]}`,
    "```",
    "Include exactly one entry per ticket id above; keep each summary to one or two sentences.",
  ].join("\n");
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

/** One write-capable `claude` attempt (bypassPermissions) in the repo dir; captures usage. */
function runClaudeOnce(
  cmd: string,
  profile: ResolvedClaudeProfile | null,
  prompt: string,
  cwd: string,
  extraEnv: Record<string, string> | undefined,
): Promise<{ code: number; out: string; err: string; usage: AiUsage }> {
  return new Promise((resolve, reject) => {
    const isClaude = cmd.includes("claude");
    const args = [
      "-p",
      ...(profile?.model ? ["--model", profile.model] : []),
      ...(isClaude ? ["--output-format", "stream-json", "--verbose"] : []),
      // Write-capable headless agent (ADR-0271): auto-approve tools so it never stalls on a prompt.
      ...(isClaude ? ["--permission-mode", "bypassPermissions"] : []),
      ...(cmd.includes("codex") ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      ...(profile ? { CLAUDE_CONFIG_DIR: profile.dir } : {}),
    };
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });
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
    const { code, out, err, usage } = await runClaudeOnce(ai.cmd, attempts[i]!, prompt, cwd, ai.env);
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
  const workDir = join(tmpdir(), "4pm-faq-sync", randomUUID());
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const authed = authedUrl(req.repo.url, req.repo.token);
  try {
    mkdirSync(workDir, { recursive: true });
    await execFileAsync("git", ["clone", "--depth", "1", "--branch", req.repo.branch, authed, workDir], { env: gitEnv });
    // A 4PM commit identity (the token authorizes the push; identity is cosmetic).
    await execFileAsync("git", ["-C", workDir, "config", "user.name", "4PM FAQ Bot"], { env: gitEnv });
    await execFileAsync("git", ["-C", workDir, "config", "user.email", "faq-bot@4pm.app"], { env: gitEnv });
    await execFileAsync("git", ["-C", workDir, "checkout", "-b", req.headBranch], { env: gitEnv });

    const { usage, text } = await runClaudeWithFailover(buildPrompt(req.tickets, req.customPrompt), workDir, ai);
    const output = text.slice(0, MAX_OUTPUT_CHARS);
    const perTicket = parsePerTicket(text);

    await execFileAsync("git", ["-C", workDir, "add", "-A"], { env: gitEnv });
    // Nothing staged ⇒ the agent judged there was no reusable FAQ value; a successful no-op run.
    const staged = await execFileAsync("git", ["-C", workDir, "diff", "--cached", "--name-only"], { env: gitEnv });
    if (!staged.stdout.trim()) {
      return { prUrl: "", output, perTicket, tokens: usage.tokens || estimateTokens(text), finishedAt: new Date().toISOString() };
    }

    await execFileAsync("git", ["-C", workDir, "commit", "-m", "docs(faq): synthesize from support tickets (4PM)"], { env: gitEnv });
    await execFileAsync("git", ["-C", workDir, "push", "-u", "origin", req.headBranch], { env: gitEnv });
    // Open the PR with `gh` (the same token authenticates it); best-effort — a failed PR still leaves
    // the pushed branch, so surface the branch even when PR creation fails.
    let prUrl = "";
    try {
      const pr = await execFileAsync(
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
    // Wipe the clone (its remote URL embeds the write token) — nothing token-bearing persists.
    if (existsSync(workDir)) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // best-effort — a leftover throwaway clone is cleaned on the next boot's tmp sweep
      }
    }
  }
}
