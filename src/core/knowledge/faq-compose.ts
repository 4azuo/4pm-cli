/**
 * faq-compose — the worker side of the platform AI pool's ticket → FAQ synthesis. On a
 * `faq.compose` dispatch (sent to a support agent since ADR-0346) the cli clones the `4pm-faq` repo
 * into a throwaway folder using a SHORT-LIVED WRITE token injected in the request (a per-job GitHub-App
 * installation token), runs `claude` with **file-edit tools only** to distil the selected support
 * tickets into FAQ markdown, then commits, pushes a branch, and opens a PR with `gh` itself.
 *
 * Hardening — the ticket bodies in the prompt are untrusted (guests can file tickets): the
 * agent gets no Bash / web tools and an allow-listed environment, and the token is passed per git
 * command (`http.extraHeader`) and to `gh` only — it is never written into the clone (whose remote URL
 * stays token-free) nor visible to the agent. The clone is deleted afterwards.
 * @adr 0333 @adr 0346
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FaqComposeReply, FaqComposeRequest, FaqTicket, FaqTicketResult } from "@4pm/ws";
import { logger } from "../../common/logger/logger";
import { estimateTokens, type AiUsage } from "../ai/ai-stream";
import type { AiTextRunner } from "../ai/ai-text-run";
import type { AiRunPolicy } from "../../utils/ai-cli";
import { gitAuthArgs } from "../agent/agent-sandbox";
import { resolveCliPrompt } from "../ai/prompt-overrides";
import { execInProject } from "../agent/agent-spawn";
import { makeAgentTempDir, unregisterAgentRoot } from "../../utils/agent-user";


/** Zero usage — the fallback when a run captured no token counts. */
const NO_USAGE: AiUsage = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/** Max time the write-capable claude agent may run (ms) — an agent-write may take many turns. */
const COMPOSE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Tools denied to the synthesis agent. Nothing is blanket-allowed: under `acceptEdits` the
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

/**
 * The FAQ-compose run policy — an edit-only headless agent: file edits are auto-accepted, shell / web /
 * sub-agents are denied (the prompt carries untrusted ticket text; git / PR are done by this module).
 * codex runs in a workspace-write sandbox.
 * @adr 0520
 */
const FAQ_POLICY: AiRunPolicy = {
  args: (cmd) =>
    cmd.includes("claude")
      ? ["--permission-mode", "acceptEdits", "--disallowedTools", ...AGENT_DENIED_TOOLS]
      : cmd.includes("codex")
        ? ["--sandbox", "workspace-write"]
        : null,
};

/** Cap on the agent output text returned to the server (kept small for the run record + modal). */
const MAX_OUTPUT_CHARS = 8_000;

/**
 * Distil the selected tickets into FAQ markdown in the `4pm-faq` repo, commit, push a branch, and open
 * a PR — all with the short-lived write token, which (and the whole clone) is wiped afterwards. Any
 * failure is returned as `{ prUrl: "", error }` so the server marks the run failed rather than hanging.
 */
export async function runFaqCompose(req: FaqComposeRequest, run: AiTextRunner): Promise<FaqComposeReply> {
  if (!req.repo.token) return { prUrl: "", error: "no write token" };
  // A throwaway folder shared with the agent user (ADR-0430): the clone, the agent's edits and every git /
  // gh step in it run as the agent, so a hook planted in the clone never executes as the cli.
  const base = makeAgentTempDir("4pm-faq-sync-");
  const workDir = join(base, "repo");
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // Per-command auth: the token rides a header on clone/push only; the clone's remote URL
  // and config stay token-free, so the agent working in it cannot read the token.
  const auth = gitAuthArgs("x-access-token", req.repo.token);
  try {
    await execInProject("git", [...auth, "clone", "--depth", "1", "--branch", req.repo.branch, req.repo.url, workDir], { cwd: base, env: gitEnv });
    // A 4PM commit identity (the token authorizes the push; identity is cosmetic).
    await execInProject("git", ["-C", workDir, "config", "user.name", "4PM FAQ Bot"], { env: gitEnv });
    await execInProject("git", ["-C", workDir, "config", "user.email", "faq-bot@4pm.app"], { env: gitEnv });
    await execInProject("git", ["-C", workDir, "checkout", "-b", req.headBranch], { env: gitEnv });

    const result = await run(buildPrompt(req.tickets, req.customPrompt), {
      label: "faq-compose", source: "faq",
      policy: FAQ_POLICY,
      cwd: workDir,
      timeoutMs: COMPOSE_TIMEOUT_MS,
      envKind: "projectless",
      allowEmpty: true,
    });
    if (!result.ok) throw new Error(`AI ${result.error ?? "failed"}`);
    const { usage, text } = result;
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
