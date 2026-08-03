/**
 * support-answer — the worker side of the AI support agent (ADR-0170). On a `support.answer`
 * dispatch the cli reads the shared docs/FAQ git repo from an isolated cache folder inside the
 * support agent's own profile (`<profileDir>/support-kb/`, never a customer project), gathers its
 * markdown as context, and runs `claude` grounded in that context to compose an answer. The clone
 * happens on first dispatch (when the repo URL is first known); `refreshSupportKb` then pulls it
 * daily on a background timer so the KB stays fresh without a per-request fetch. The private repo
 * token (if any) is used only for the initial clone. Returns the answer body, or an `error` the
 * server maps to "unavailable".
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SupportAnswerReply, SupportAnswerRequest } from "@4pm/ws";
import { logger } from "../common/logger/logger";
import { isAuthFailure, isSessionLimit } from "./ai-runner";
import type { ResolvedClaudeProfile } from "../utils/ai-cli";

/**
 * How to run claude for a support answer — resolved by the caller from the profile config so the
 * agent authenticates with the operator's configured account(s) (ADR-0057/0170), not claude's
 * default config.
 */
export interface SupportAnswerAi {
  /** The AI CLI command (config.aiCli — defaults to "claude"). */
  cmd: string;
  /** Configured claude profiles to try in order (working-first); empty ⇒ the CLI's default env. */
  profiles: ResolvedClaudeProfile[];
  /** Extra env for the AI CLI (config.aiEnv). */
  env?: Record<string, string>;
}

const execFileAsync = promisify(execFile);

/** Cap on the docs context handed to the model (chars) — keeps the prompt bounded. */
const MAX_CONTEXT_CHARS = 120_000;
/** Max time to wait for the `claude` answer (ms). */
const ANSWER_TIMEOUT_MS = 120_000;
/** Folders/extensions considered documentation in the KB repo. */
const DOC_EXTENSIONS = [".md", ".mdx", ".txt"];

/** Root cache dir for cloned KB repos — inside the support agent's own profile (ADR-0170). */
function kbRoot(profileDir: string): string {
  return join(profileDir, "support-kb");
}

/** A stable per-repo folder keyed by URL+branch so re-fetches reuse the clone. */
function repoDir(profileDir: string, url: string, branch: string): string {
  const key = createHash("sha1").update(`${url}#${branch}`).digest("hex").slice(0, 16);
  return join(kbRoot(profileDir), key);
}

/** Inject a read token into an https URL so a private repo can be fetched without a prompt. */
function authedUrl(url: string, token: string | null): string {
  if (!token) return url;
  if (url.startsWith("https://")) return url.replace("https://", `https://${token}@`);
  return url; // ssh / other — rely on the worker's own git creds
}

/**
 * Ensure the KB repo is cloned into the profile's cache dir; returns the local dir. The clone
 * happens only the first time (when the repo URL is first known from a dispatch) — subsequent
 * freshness is handled out-of-band by `refreshSupportKb` on a daily timer, so a dispatch never
 * blocks on a network fetch.
 */
async function ensureRepo(profileDir: string, repo: SupportAnswerRequest["repo"]): Promise<string> {
  const dir = repoDir(profileDir, repo.url, repo.branch);
  if (existsSync(join(dir, ".git"))) return dir;
  const url = authedUrl(repo.url, repo.token);
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  mkdirSync(kbRoot(profileDir), { recursive: true });
  await execFileAsync("git", ["clone", "--depth", "1", "--branch", repo.branch, url, dir], {
    env: gitEnv,
  });
  return dir;
}

/**
 * Refresh every KB clone already present in this profile's cache dir with a fast-forward pull
 * (ADR-0170). Called on a daily background timer so the support agent answers from an up-to-date
 * FAQ without fetching on each request. Best-effort: a no-op when nothing is cloned yet, and a
 * failed pull on one repo is logged and skipped (the stale clone still answers). The remote URL
 * (with its embedded token, if any) is already stored in the clone, so no token is needed here.
 */
export async function refreshSupportKb(profileDir: string): Promise<void> {
  const root = kbRoot(profileDir);
  if (!existsSync(root)) return;
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!existsSync(join(dir, ".git"))) continue;
    try {
      await execFileAsync("git", ["-C", dir, "pull", "--ff-only"], { env: gitEnv });
    } catch (err) {
      logger.warn("support.kb.refresh.failed", { dir, error: String(err) });
    }
  }
}

/** Recursively collect documentation text from the repo, bounded to MAX_CONTEXT_CHARS. */
function collectDocs(dir: string): string {
  const parts: string[] = [];
  let total = 0;
  const walk = (current: string): void => {
    if (total >= MAX_CONTEXT_CHARS) return;
    for (const entry of readdirSync(current)) {
      if (entry === ".git" || entry === "node_modules") continue;
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (DOC_EXTENSIONS.some((ext) => entry.toLowerCase().endsWith(ext))) {
        const rel = full.slice(dir.length + 1);
        const body = readFileSync(full, "utf8");
        const block = `\n\n===== ${rel} =====\n${body}`;
        parts.push(block.slice(0, MAX_CONTEXT_CHARS - total));
        total += block.length;
        if (total >= MAX_CONTEXT_CHARS) return;
      }
    }
  };
  walk(dir);
  return parts.join("");
}

/** Build the grounded, role-aware system+question prompt fed to `claude`. */
function buildPrompt(docs: string, question: string, askerRole: "admin" | "user"): string {
  const roleNote =
    askerRole === "admin"
      ? "The asker is a platform admin."
      : "The asker is a regular user — do NOT reveal admin-only features.";
  return [
    "You are the 4PM product support assistant. Answer the user's question about how to use 4PM",
    "using ONLY the documentation and FAQ provided below. If the answer is not in the docs, say",
    "you don't have that information and suggest contacting human support — do not invent details.",
    roleNote,
    "Answer concisely in the user's language; reference the relevant doc heading/path when useful.",
    "",
    "===== DOCUMENTATION =====",
    docs,
    "",
    "===== QUESTION =====",
    question,
  ].join("\n");
}

/**
 * One `claude -p` attempt against a specific profile — the prompt goes on stdin (it can be large,
 * so it must not be an argv arg). Resolves the exit code + captured output; rejects only on a
 * spawn error or timeout.
 */
function runClaudeOnce(
  cmd: string,
  profile: ResolvedClaudeProfile | null,
  prompt: string,
  extraEnv: Record<string, string> | undefined,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", ...(profile?.model ? ["--model", profile.model] : [])];
    // Select the signed-in account (the fix — ADR-0170): without CLAUDE_CONFIG_DIR claude falls
    // back to its default config, whose token is unrelated to the operator's configured profiles.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      ...(profile ? { CLAUDE_CONFIG_DIR: profile.dir } : {}),
    };
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude answer timed out"));
    }, ANSWER_TIMEOUT_MS);
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
 * Run the answer prompt across the operator's configured claude profiles (working-first), moving
 * to the next on an auth failure or a session/usage-limit hit — the same failover the normal AI
 * dispatch uses (ADR-0057). Resolves the answer text; throws a diagnosable tail if all fail.
 */
async function runClaudeWithFailover(prompt: string, ai: SupportAnswerAi): Promise<string> {
  // No profile configured ⇒ a single default-env attempt (matches the pre-profile behavior).
  const attempts: (ResolvedClaudeProfile | null)[] = ai.profiles.length > 0 ? ai.profiles : [null];
  let lastReason = "no attempt";
  for (let i = 0; i < attempts.length; i++) {
    const { code, out, err } = await runClaudeOnce(ai.cmd, attempts[i]!, prompt, ai.env);
    if (code === 0 && out.trim()) return out.trim();
    // claude may report the failure on stdout rather than stderr (empty stderr + exit 1).
    const combined = err || out;
    lastReason = `exited ${code}: ${combined.slice(0, 500)}`;
    if ((!isAuthFailure(combined) && !isSessionLimit(combined)) || i === attempts.length - 1) break;
  }
  throw new Error(`claude ${lastReason}`);
}

/**
 * Answer a support question from the shared KB repo. Any failure (clone, spawn, timeout) is
 * returned as `{ body: "", error }` so the server degrades to human support rather than hanging.
 */
export async function runSupportAnswer(
  req: SupportAnswerRequest,
  ai: SupportAnswerAi,
  profileDir: string,
): Promise<SupportAnswerReply> {
  try {
    const dir = await ensureRepo(profileDir, req.repo);
    const docs = collectDocs(dir);
    if (!docs.trim()) return { body: "", error: "KB repo has no documentation" };
    const body = await runClaudeWithFailover(buildPrompt(docs, req.question, req.askerRole), ai);
    if (!body) return { body: "", error: "empty answer" };
    return { body };
  } catch (err) {
    logger.warn("support.answer.failed", { error: String(err) });
    return { body: "", error: String(err) };
  }
}
