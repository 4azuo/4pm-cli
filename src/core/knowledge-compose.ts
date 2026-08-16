/**
 * knowledge-compose — the worker side of AI knowledge distillation (ADR-0190). On a
 * `knowledge.compose` dispatch the cli runs the AI CLI (claude) IN THE PROJECT'S WORKING DIRECTORY
 * so it can read the code/docs, with a prompt to distil the project into a shareable knowledge
 * article, and returns the composed markdown. Profile handling (signed-in account + model +
 * auth/limit failover) mirrors the normal AI dispatch (ADR-0057) and the support agent (ADR-0170).
 */
import { spawn } from "node:child_process";
import type { KnowledgeComposeReply, KnowledgeComposeRequest } from "@4pm/ws";
import { isAuthFailure, isSessionLimit } from "./ai-runner";
import { reportToolResult } from "./tool-health";
import type { ResolvedClaudeProfile } from "../utils/ai-cli";

/** How to run the AI CLI for a compose (resolved by the caller from the profile config). */
export interface KnowledgeComposeAi {
  cmd: string;
  profiles: ResolvedClaudeProfile[];
  env?: Record<string, string>;
}

/** Max time to wait for the compose (ms). */
const COMPOSE_TIMEOUT_MS = 180_000;

/** Build the distillation prompt fed to the AI CLI (reads the project in cwd). */
function buildPrompt(req: KnowledgeComposeRequest): string {
  const focus = req.prompt ? `\n\nExtra focus from the author: ${req.prompt}` : "";
  return [
    `You are in the working directory of a software project named "${req.projectName}".`,
    "Read the project (code, docs, config) and write a concise, shareable KNOWLEDGE ARTICLE that",
    "distils it for other engineers. Use Markdown and this structure:",
    "- a single top-level title line starting with '# '",
    "- a one-paragraph summary",
    "- '## The problem' — what problem the project solves",
    "- '## The approach' — the key decisions and how it works",
    "- '## What we learned' — reusable takeaways",
    "Output ONLY the Markdown article, no preamble or code fences around the whole thing." + focus,
  ].join("\n");
}

/** Run the AI CLI once in the project dir; returns exit code + stdout/stderr. */
function runOnce(
  cmd: string,
  profile: ResolvedClaudeProfile | null,
  prompt: string,
  cwd: string,
  extraEnv: Record<string, string> | undefined,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", ...(profile?.model ? ["--model", profile.model] : [])];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      ...(profile ? { CLAUDE_CONFIG_DIR: profile.dir } : {}),
    };
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("knowledge compose timed out"));
    }, COMPOSE_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Distil the project into a markdown article, trying the configured claude profiles working-first
 * (auth/limit failover — ADR-0057). Returns `{ bodyMarkdown }` or `{ bodyMarkdown:"", error }`.
 */
export async function runKnowledgeCompose(
  req: KnowledgeComposeRequest,
  ai: KnowledgeComposeAi,
  physicRoot: string,
): Promise<KnowledgeComposeReply> {
  const prompt = buildPrompt(req);
  const attempts: (ResolvedClaudeProfile | null)[] = ai.profiles.length > 0 ? ai.profiles : [null];
  let lastReason = "no attempt";
  for (let i = 0; i < attempts.length; i++) {
    try {
      const { code, out, err } = await runOnce(ai.cmd, attempts[i]!, prompt, physicRoot, ai.env);
      if (code === 0 && out.trim()) {
        reportToolResult(ai.cmd, true); // AI CLI ran ok (ADR-0223)
        return { bodyMarkdown: out.trim() };
      }
      const combined = err || out;
      lastReason = `exited ${code}: ${combined.slice(0, 500)}`;
      if ((!isAuthFailure(combined) && !isSessionLimit(combined)) || i === attempts.length - 1) break;
    } catch (e) {
      lastReason = String(e);
      break;
    }
  }
  reportToolResult(ai.cmd, false, lastReason); // AI CLI failed across all profiles (ADR-0223)
  return { bodyMarkdown: "", error: lastReason };
}
