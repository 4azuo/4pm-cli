/**
 * support-answer — the worker side of the AI support agent (ADR-0170). On a `support.answer`
 * dispatch the cli reads the shared docs/FAQ git repo from an isolated cache folder inside the
 * support agent's own profile (`<profileDir>/support-kb/`, never a customer project), gathers its
 * markdown as context, and runs `claude` grounded in that context to compose an answer. The clone
 * happens on first dispatch (when the repo URL is first known); `refreshSupportKb` then pulls it
 * daily on a background timer so the KB stays fresh without a per-request fetch. Returns the answer
 * body, or an `error` the server maps to "unavailable".
 *
 * Hardening (ADR-0346) — questions (and, for drafts, ticket text) are untrusted: the private repo token
 * is never stored in the clone (per-command `http.extraHeader`, kept in memory only), and claude runs
 * in an empty throwaway directory with an allow-listed environment and no Bash / edit / web tools.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type {
  SupportAnswerImage,
  SupportAnswerModeration,
  SupportAnswerReply,
  SupportAnswerRequest,
  SupportAnswerTask,
} from "@4pm/ws";
import { logger } from "../common/logger/logger";
import { createAiStreamParser, estimateTokens, type AiUsage } from "./ai-stream";
import type { ResolvedClaudeProfile } from "../utils/ai-cli";
import { agentEnv, gitAuthArgs } from "./agent-sandbox";
import { denySettingsArgs } from "../utils/agent-deny";

/** Zero usage — the fallback when a run captured no token counts. */
const NO_USAGE: AiUsage = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

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
/** Max time for a legal-document draft (ms) — a whole Terms/Policy body is long to write (ADR-0360). */
const LEGAL_DRAFT_TIMEOUT_MS = 540_000;
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

/** Tools denied to every support agent run (ADR-0346): no shell, no edits, no web, no sub-agents. */
const DENIED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"];

/** A KB pull is due after this long (the daily refresh cadence). */
const KB_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The last-known read token per KB clone dir — in memory only (never on disk), learned from each
 * dispatch, so the daily refresh can authenticate a private repo without a token in `.git/config`.
 */
const kbTokens = new Map<string, string>();

/** Per-command git auth for a KB read token (`https://<token>@host` semantics — token as the user). */
function kbAuth(token: string | null | undefined): string[] {
  return token ? gitAuthArgs(token, "") : [];
}

/** Fast-forward pull one KB clone with its in-memory token (if any). */
async function pullKb(dir: string): Promise<void> {
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  await execFileAsync("git", [...kbAuth(kbTokens.get(dir)), "-C", dir, "pull", "--ff-only"], { env: gitEnv });
}

/**
 * Ensure the KB repo is cloned into the profile's cache dir; returns the local dir. The clone
 * happens only the first time (when the repo URL is first known from a dispatch) — subsequent
 * freshness is handled by `refreshSupportKb` on a daily timer, plus a background pull here when the
 * clone is stale (e.g. after a restart, before the timer knew the token), so a dispatch never blocks
 * on a network fetch. An older clone whose remote URL still embeds a token is scrubbed to the plain
 * URL (ADR-0346).
 */
async function ensureRepo(profileDir: string, repo: SupportAnswerRequest["repo"]): Promise<string> {
  const dir = repoDir(profileDir, repo.url, repo.branch);
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (repo.token) kbTokens.set(dir, repo.token);
  else kbTokens.delete(dir);
  if (existsSync(join(dir, ".git"))) {
    // Scrub a token-bearing remote URL left by an older cli (the token must not sit in the clone).
    const current = await execFileAsync("git", ["-C", dir, "remote", "get-url", "origin"], { env: gitEnv })
      .then((r) => r.stdout.trim())
      .catch(() => repo.url);
    if (current !== repo.url) {
      await execFileAsync("git", ["-C", dir, "remote", "set-url", "origin", repo.url], { env: gitEnv }).catch(() => undefined);
    }
    const marker = existsSync(join(dir, ".git", "FETCH_HEAD")) ? join(dir, ".git", "FETCH_HEAD") : join(dir, ".git", "HEAD");
    if (Date.now() - statSync(marker).mtimeMs > KB_STALE_MS) {
      void pullKb(dir).catch((err: unknown) => logger.warn("support.kb.refresh.failed", { dir, error: String(err) }));
    }
    return dir;
  }
  mkdirSync(kbRoot(profileDir), { recursive: true });
  await execFileAsync("git", [...kbAuth(repo.token), "clone", "--depth", "1", "--branch", repo.branch, repo.url, dir], {
    env: gitEnv,
  });
  return dir;
}

/**
 * Refresh every KB clone already present in this profile's cache dir with a fast-forward pull
 * (ADR-0170). Called on a daily background timer so the support agent answers from an up-to-date
 * FAQ without fetching on each request. Best-effort: a no-op when nothing is cloned yet, and a
 * failed pull on one repo is logged and skipped (the stale clone still answers). A private repo's
 * token comes from the in-memory map learned on dispatch (never stored in the clone — ADR-0346).
 */
export async function refreshSupportKb(profileDir: string): Promise<void> {
  const root = kbRoot(profileDir);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!existsSync(join(dir, ".git"))) continue;
    try {
      await pullKb(dir);
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
    // Structured output for inline moderation (ADR-0237): the same run also classifies the question.
    "Return ONLY a single JSON object (no markdown fences, no prose around it) with these keys:",
    '  "onTopic": boolean   — false if the question is NOT about how to use the 4PM product,',
    '  "sensitive": boolean — true if the question is inappropriate / abusive OR asks how to hack,',
    "                         bypass security, gain unauthorized access, take over or steal another",
    "                         user's/org's account or data, obtain credentials, or any malicious intent,",
    '  "reason": string     — a short reason when onTopic is false or sensitive is true, else "",',
    '  "answer": string     — your reply to the user, in markdown (in the user\'s language).',
    "Refusal policy (ADR-0237): if the question is off-topic (onTopic false) OR sensitive, DO NOT",
    "answer it. Set \"answer\" to this EXACT same polite refusal for BOTH cases (in the user's",
    "language, do not reveal which category or hint at the reason): \"Sorry, I can only help with",
    "questions about how to use 4PM. For anything else, please contact human support.\" Only answer",
    "normally when onTopic is true AND sensitive is false.",
    "",
    "===== DOCUMENTATION =====",
    docs,
    "",
    "===== QUESTION =====",
    question,
  ].join("\n");
}

/**
 * Build the admin drafting prompt (ADR-0345): the agent writes, as the 4PM support team, either a
 * reply to a support ticket or an outreach message, grounded in the same docs/FAQ. Unlike the Q&A
 * prompt there is no refusal policy and no moderation JSON — the whole output is the markdown draft.
 */
function buildDraftPrompt(docs: string, context: string, task: SupportAnswerTask): string {
  if (task === "legal_draft") return buildLegalDraftPrompt(docs, context);
  const goal =
    task === "reply_draft"
      ? [
          "You are drafting a reply FROM the 4PM support team TO the customer in the support ticket below.",
          "Address the customer's latest message, using the whole conversation for context. Be accurate,",
          "friendly and concise. Write in the language the customer uses in the ticket.",
        ]
      : [
          "You are drafting an outreach message FROM the 4PM platform team TO the customer organizations.",
          "Use the subject and any current draft below as the starting point. Be clear, friendly and concise.",
          "Write in the language of the subject/draft (or of the admin's instructions when those are empty).",
        ];
  return [
    ...goal,
    "Use the documentation and FAQ below for any product facts; never invent features, prices or",
    "commitments that are not in the docs — leave a clear [placeholder] for the admin to fill instead.",
    "Follow the admin's instructions when given. A human admin reviews and edits your draft before",
    "sending it.",
    "",
    "Output ONLY the message body in markdown — no subject line, no preamble, no explanation, no code",
    "fences around the whole message.",
    "",
    "===== DOCUMENTATION =====",
    docs,
    "",
    "===== CONTEXT =====",
    context,
  ].join("\n");
}

/**
 * The legal-document drafting prompt (ADR-0360): write or revise the WHOLE body of one 4PM legal
 * document in the target locale, grounded ONLY in the server-built facts (live plan catalog + billing
 * behaviour) and the docs — keeping `{{placeholders}}` verbatim and marking unknowns as `[TODO: …]`.
 * Output is the markdown body alone; a human admin reviews it (and counsel) before publishing.
 */
function buildLegalDraftPrompt(docs: string, context: string): string {
  return [
    "You are drafting the body of one of 4PM's legal documents (Terms of Service, Privacy Policy,",
    "Add-on Terms, Rented Machine Addendum, …) for the platform admin to review and publish.",
    "Write or revise the WHOLE document body in the target locale given in the context. Keep the",
    "existing heading structure and numbering unless the admin's instructions say otherwise.",
    "When the target locale is not English and an English reference is given, follow its meaning closely.",
    "Rules:",
    "- Every {{placeholder}} (e.g. {{companyName}}) must be kept verbatim — never fill or rename it.",
    "- Describe plans, prices, upgrades, downgrades, cancellations, renewals, refunds and add-ons ONLY",
    "  as stated in the PLAN CATALOG and BILLING FACTS below or the documentation; never invent",
    "  commitments, prices or legal guarantees. Where something is unknown write `[TODO: …]`.",
    "- Plain, precise legal English (or the target language); short numbered sections and bullet lists.",
    "- This is a draft, not legal advice; do not add a disclaimer about that inside the document.",
    "",
    "Output ONLY the document body in markdown — no title line, no preamble, no explanation, no code",
    "fences around the whole document.",
    "",
    "===== DOCUMENTATION =====",
    docs,
    "",
    "===== CONTEXT =====",
    context,
  ].join("\n");
}

/** File extension for a materialized help image's MIME. */
function imageExt(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

/**
 * Materialize the pasted help images (ADR-0273) into a throwaway folder and rewrite each `[Image#N]`
 * placeholder in the question to the on-disk path so the agent can `Read` the screenshot (mirrors the
 * Console command-image pipeline, ADR-0257). Returns the folder to clean up + the rewritten question.
 */
function materializeImages(images: SupportAnswerImage[], question: string): { dir: string; question: string } {
  // A throwaway folder under the OS temp dir — NOT under the cli profile (`~/.4pm/`), which the
  // ADR-0347 deny rules block for every agent read.
  const dir = mkdtempSync(join(tmpdir(), "4pm-help-images-"));
  let rewritten = question;
  images.forEach((img, i) => {
    const file = join(dir, `image-${i + 1}.${imageExt(img.mime)}`);
    writeFileSync(file, Buffer.from(img.dataBase64, "base64"));
    if (img.placeholder) rewritten = rewritten.split(img.placeholder).join(file);
  });
  return { dir, question: rewritten };
}

/** The parsed structured answer: the reply body + an optional moderation verdict (ADR-0237). */
interface ParsedAnswer {
  body: string;
  moderation?: SupportAnswerModeration;
}

/**
 * Parse the model's structured JSON output `{ onTopic, sensitive, reason, answer }` into the answer
 * body + moderation verdict (ADR-0237). Tolerates markdown fences / surrounding prose by extracting
 * the first `{`…last `}` slice. Degrades gracefully: when no valid JSON object with an `answer`
 * string is found, the whole text becomes the body and the verdict is omitted (treated on-topic).
 */
function parseModeratedAnswer(text: string): ParsedAnswer {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as {
        onTopic?: unknown;
        sensitive?: unknown;
        reason?: unknown;
        answer?: unknown;
      };
      if (typeof obj.answer === "string" && obj.answer.trim()) {
        const onTopic = obj.onTopic !== false; // default on-topic unless explicitly false
        const sensitive = obj.sensitive === true;
        const reason = typeof obj.reason === "string" ? obj.reason : "";
        return { body: obj.answer.trim(), moderation: { onTopic, sensitive, reason } };
      }
    } catch {
      // fall through to the plain-text fallback
    }
  }
  return { body: text.trim() };
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
  imageDir?: string,
  denyDirs: string[] = [],
  timeoutMs: number = ANSWER_TIMEOUT_MS,
): Promise<{ code: number; out: string; err: string; usage: AiUsage }> {
  return new Promise((resolve, reject) => {
    // Ask claude for `--output-format stream-json --verbose` so the run's real token usage is
    // captured (ADR-0072/0224) — the same lane the normal AI dispatch uses; the parser turns the
    // JSON events back into the readable answer text. codex/other CLIs pass through unchanged.
    const isClaude = cmd.includes("claude");
    const args = [
      "-p",
      ...(profile?.model ? ["--model", profile.model] : []),
      ...(isClaude ? ["--output-format", "stream-json", "--verbose"] : []),
      // No shell / edits / web for an untrusted question (ADR-0346). Reads need no grant inside the
      // (empty) working dir and any added dir; anywhere else they would need an approval a headless
      // run never gets.
      // Secret-path deny rules (ADR-0347) — reads are not confined to the working dir.
      ...denySettingsArgs(cmd, [...denyDirs, profile?.dir]),
      ...(isClaude ? ["--disallowedTools", ...DENIED_TOOLS] : []),
      // When the question references pasted images (ADR-0273), add the materialized folder so the
      // agent can Read them (the question already carries their absolute paths) — scoped to it only.
      ...(isClaude && imageDir ? ["--add-dir", imageDir] : []),
    ];
    // Select the signed-in account (the fix — ADR-0170): without CLAUDE_CONFIG_DIR claude falls
    // back to its default config, whose token is unrelated to the operator's configured profiles.
    // Allow-listed env only — the cli's own secrets never reach the agent (ADR-0346).
    const env = agentEnv(extraEnv, profile ? { CLAUDE_CONFIG_DIR: profile.dir } : undefined);
    // Run in an empty throwaway dir (the docs are in the prompt) so there is nothing to read nearby.
    const cwd = mkdtempSync(join(tmpdir(), "4pm-support-"));
    const cleanup = (): void => {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // best-effort — an empty leftover temp dir is harmless
      }
    };
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env, cwd });
    // Parse claude stream-json → readable text + usage; a non-json cmd passes text through verbatim.
    const parser = createAiStreamParser(cmd);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude answer timed out"));
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (d: Buffer) => (out += parser.push(d.toString())));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      out += parser.flush();
      resolve({ code: code ?? -1, out, err, usage: parser.usage() });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Run the answer prompt across the operator's configured claude profiles (working-first), moving
 * to the next on **any** failed attempt — the same failover the normal AI dispatch uses
 * (ADR-0057, ADR-0240). Resolves the answer text; throws a diagnosable tail once all profiles fail.
 */
async function runClaudeWithFailover(
  prompt: string,
  ai: SupportAnswerAi,
  imageDir?: string,
  timeoutMs: number = ANSWER_TIMEOUT_MS,
): Promise<{ text: string; usage: AiUsage }> {
  // No profile configured ⇒ a single default-env attempt (matches the pre-profile behavior).
  const attempts: (ResolvedClaudeProfile | null)[] = ai.profiles.length > 0 ? ai.profiles : [null];
  let lastReason = "no attempt";
  for (let i = 0; i < attempts.length; i++) {
    const { code, out, err, usage } = await runClaudeOnce(
      ai.cmd,
      attempts[i]!,
      prompt,
      ai.env,
      imageDir,
      ai.profiles.map((p) => p.dir),
      timeoutMs,
    );
    if (code === 0 && out.trim()) return { text: out.trim(), usage };
    // claude may report the failure on stdout rather than stderr (empty stderr + exit 1).
    const combined = err || out;
    lastReason = `exited ${code}: ${combined.slice(0, 500)}`;
    // Any failed attempt fails over to the next profile (ADR-0240); stop once all are exhausted.
    if (i === attempts.length - 1) break;
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
  // Materialize any pasted images (ADR-0273) into a throwaway folder + rewrite the question's
  // `[Image#N]` placeholders to their on-disk paths so the agent can Read them; cleaned up after.
  let imageDir: string | undefined;
  let question = req.question;
  if (req.images?.length) {
    const m = materializeImages(req.images, req.question);
    imageDir = m.dir;
    question = m.question;
  }
  try {
    const dir = await ensureRepo(profileDir, req.repo);
    const docs = collectDocs(dir);
    if (!docs.trim()) return { body: "", error: "KB repo has no documentation" };
    // A drafting task (ADR-0345) uses its own prompt and returns the text as-is (no moderation).
    const prompt = req.task ? buildDraftPrompt(docs, question, req.task) : buildPrompt(docs, question, req.askerRole);
    const timeoutMs = req.task === "legal_draft" ? LEGAL_DRAFT_TIMEOUT_MS : ANSWER_TIMEOUT_MS;
    const { text, usage } = await runClaudeWithFailover(prompt, ai, imageDir, timeoutMs);
    if (!text) return { body: "", error: "empty answer" };
    // Split the structured output into the answer body + inline moderation verdict (ADR-0237);
    // a non-JSON run degrades to the whole text as the body with no verdict.
    const { body, moderation } = req.task ? { body: text.trim(), moderation: undefined } : parseModeratedAnswer(text);
    if (!body) return { body: "", error: "empty answer" };
    // Report the run's token usage so the server records it against the FAQ project (ADR-0224);
    // fall back to a length estimate when the stream carried no usage (older claude / non-json cli).
    const u = usage.tokens > 0 ? usage : { ...NO_USAGE, tokens: estimateTokens(body) };
    return {
      body,
      ...(moderation ? { moderation } : {}),
      tokens: u.tokens,
      ...(usage.tokens > 0
        ? {
            tokensBreakdown: {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheCreation: usage.cacheCreation,
            },
          }
        : {}),
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn("support.answer.failed", { error: String(err) });
    return { body: "", error: String(err) };
  } finally {
    if (imageDir) {
      try {
        rmSync(imageDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup — a leftover throwaway image folder is harmless
      }
    }
  }
}
