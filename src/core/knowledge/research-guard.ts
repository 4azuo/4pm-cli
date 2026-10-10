/**
 * research-guard — the content-policy backstop for org AI Research. The PRIMARY moderation is
 * the system policy in the research prompt (the model returns a structured `REFUSED:` line for a
 * disallowed question). This module is the secondary, deterministic check: it recognizes the model's
 * refusal and, conservatively, flags a small set of unambiguous attack-intent requests (probing /
 * exploiting other systems) so a jailbroken run never returns such content. It is intentionally narrow
 * to avoid blocking legitimate defensive-security questions ("how do I protect against X").
 * @adr 0380
 */

/** The marker the research prompt instructs the model to emit when it declines a question. */
const REFUSAL_PREFIX = "REFUSED:";

/**
 * High-precision phrases that signal intent to attack/compromise a system the asker does not own. Kept
 * deliberately narrow (explicit wrongdoing verbs) so defensive questions are not caught.
 */
const ATTACK_INTENT: RegExp[] = [
  /\b(hack|break|breare|breach|compromise|exploit|gain (unauthorized )?access to|take over|take control of|ddos|dos attack)\b[^.?!]{0,60}\b(into|someone|their|his|her|another|the victim'?s|a target|account|server|network|website|wifi|camera|phone|system|database)\b/i,
  /\b(write|create|build|generate|give me)\b[^.?!]{0,40}\b(malware|ransomware|a virus|a keylogger|a trojan|spyware|a rootkit|a worm|a botnet|an exploit|a phishing (kit|page|email|site))\b/i,
  /\bbypass\b[^.?!]{0,40}\b(authentication|login|the firewall|a paywall|security|2fa|mfa|licen[sc]e|drm)\b/i,
  /\b(steal|harvest|exfiltrate|dump|crack)\b[^.?!]{0,40}\b(credentials|passwords|password hashes|credit cards?|personal data|pii|session tokens)\b/i,
  /\bbrute[- ]?force\b[^.?!]{0,40}\b(login|password|account|credential)/i,
];

/** The outcome of a guard screen. */
export interface GuardVerdict {
  /** True when the text must be treated as a refusal (no answer stored). */
  blocked: boolean;
  /** A short, user-safe reason when blocked. */
  reason?: string;
}

/** Whether the model's own output is the structured refusal. */
export function isModelRefusal(text: string): boolean {
  return text.trimStart().toUpperCase().startsWith(REFUSAL_PREFIX);
}

/** Extract the model's refusal reason (the text after `REFUSED:`), trimmed and capped. */
export function refusalReasonOf(text: string): string {
  const after = text.trim().slice(REFUSAL_PREFIX.length).trim();
  return (after || "This question is outside what Research can answer.").slice(0, 300);
}

/**
 * Screen a question BEFORE dispatch: block only unambiguous attack-intent requests. Returns `blocked`
 * with a reason, or `{ blocked: false }`.
 */
export function screenQuestion(question: string): GuardVerdict {
  if (ATTACK_INTENT.some((re) => re.test(question))) {
    return { blocked: true, reason: "The question asks to attack or compromise a system, which Research does not do." };
  }
  return { blocked: false };
}

/**
 * Screen the model's ANSWER after the run: treat the structured refusal as blocked, and catch the same
 * narrow attack-intent patterns in case the model produced disallowed content anyway.
 */
export function screenAnswer(answer: string): GuardVerdict {
  if (isModelRefusal(answer)) return { blocked: true, reason: refusalReasonOf(answer) };
  if (ATTACK_INTENT.some((re) => re.test(answer))) {
    return { blocked: true, reason: "The answer was withheld by the content policy." };
  }
  return { blocked: false };
}
