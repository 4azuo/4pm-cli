/**
 * Outbound-review engine on the reviewer cli (ADR-0082). When the server dispatches
 * `review.evaluate`, this vets an AI input from another machine cli against 4 criteria —
 * secret leak, other-environment impact, edit-scope, repo-scope — using a deterministic
 * rule scan and/or an AI judgment (each toggled by the project). Any violated criterion ⇒
 * NG. Never returns secret values, only violation categories.
 */
import { DEFAULT_OUTBOUND_RULES, compileRulePattern } from "@4pm/dto";
import type { ReviewEvaluatePayload, ReviewResultPayload } from "@4pm/ws";
import { aiOutboundReview } from "./ai-assist";
import { logger } from "../common/logger/logger";

/**
 * Compile rule sources (ADR-0087) into RegExps, skipping any that fail to compile so one
 * bad pattern never breaks the whole scan. `sources` undefined (older server) ⇒ the given
 * built-in default is used instead.
 */
function compilePatterns(sources: string[] | undefined, fallback: string[]): RegExp[] {
  const list = sources ?? fallback;
  const out: RegExp[] = [];
  for (const src of list) {
    try {
      out.push(compileRulePattern(src));
    } catch (err) {
      logger.warn("outbound-review.bad-pattern", {
        pattern: src,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Extract repo identifiers referenced in the input (github/gitlab URL or scp-like git). */
function referencedRepos(text: string): string[] {
  const repos = new Set<string>();
  const re =
    /(?:https?:\/\/|git@)([\w.-]+)[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[\s"')]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) repos.add(`${m[1]}/${m[2]}`.toLowerCase());
  return [...repos];
}

/**
 * Deterministic rule scan (ADR-0082) — returns the violated criteria categories. `allowedRepos`
 * empty ⇒ no repo restriction; `projectPath` = the folder the input may edit within. The
 * secret/environment regex come from the project policy (ADR-0087); path/repo stay built-in.
 */
function ruleReview(
  input: string,
  allowedRepos: string[],
  projectPath: string,
  secretPatterns?: string[],
  envPatterns?: string[],
): string[] {
  const reasons = new Set<string>();
  const secretRe = compilePatterns(secretPatterns, DEFAULT_OUTBOUND_RULES.secret);
  const envRe = compilePatterns(envPatterns, DEFAULT_OUTBOUND_RULES.environment);
  if (secretRe.some((re) => re.test(input))) reasons.add("secret");
  if (envRe.some((re) => re.test(input))) reasons.add("environment");
  // Path: parent-traversal or absolute system dirs outside the project folder.
  if (/(?:^|[\s"'(])(?:\.\.[/\\])+/.test(input)) reasons.add("path");
  const absSystem = /(?:^|[\s"'(=])(\/(?:etc|root|var|usr|bin|home|private|proc|sys)\b|[A-Za-z]:\\\\)/;
  if (absSystem.test(input) && projectPath && !input.includes(projectPath)) reasons.add("path");
  // Repo: any referenced repo not in the (non-empty) allowlist ⇒ out-of-scope commit target.
  if (allowedRepos.length) {
    const allow = allowedRepos.map((r) => r.toLowerCase());
    const refs = referencedRepos(input);
    if (refs.some((r) => !allow.some((a) => a.includes(r) || r.includes(a)))) reasons.add("repo");
  }
  return [...reasons];
}

/**
 * Evaluate an input as an outbound reviewer. Runs the enabled engines (ruleCheck and/or
 * aiReview) and returns the combined verdict. An AI infra error is best-effort (logged,
 * skipped) so a transient AI outage does not block on the AI path alone.
 */
export async function evaluateReview(
  payload: ReviewEvaluatePayload,
): Promise<ReviewResultPayload> {
  const reasons = new Set<string>();
  let tokens = 0;
  if (payload.ruleCheck) {
    const violations = ruleReview(
      payload.prompt,
      payload.allowedRepos,
      payload.projectPath ?? "",
      payload.secretPatterns,
      payload.envPatterns,
    );
    for (const r of violations) reasons.add(r);
  }
  if (payload.aiReview) {
    try {
      const ai = await aiOutboundReview(
        payload.prompt,
        payload.allowedRepos,
        payload.projectPath ?? "",
      );
      tokens = ai.tokens;
      if (!ai.ok) for (const r of ai.reasons) reasons.add(r);
    } catch (err) {
      logger.warn("outbound-review.ai-error", {
        commandId: payload.commandId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { commandId: payload.commandId, ok: reasons.size === 0, reasons: [...reasons], tokens };
}
