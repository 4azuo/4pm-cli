/**
 * Project create / provision failure codes. The worker reports a raw error text (a git / shell / node message);
 * the server classifies it into a `ProjectFailCode` so the web shows an i18n message, never the raw text.
 * @adr 0501
 */

/** Every failure code, `UNKNOWN` last (the fallback). */
export const PROJECT_FAIL_CODES = [
  "GIT_AUTH",
  "GIT_REPO_NOT_FOUND",
  "GIT_BRANCH_NOT_FOUND",
  "GIT_NETWORK",
  "GIT_REJECTED",
  "FOLDER_NOT_EMPTY",
  "WORKER_PERMISSION",
  "DISK_FULL",
  "WORKER_UNREACHABLE",
  "UNKNOWN",
] as const;

/** A classified project failure. */
export type ProjectFailCode = (typeof PROJECT_FAIL_CODES)[number];

/**
 * Patterns per code, checked in order — the first match wins. More specific causes come first: an auth
 * failure also prints "unable to access", and a missing repo may print "Permission denied (publickey)".
 */
const RULES: readonly [ProjectFailCode, RegExp][] = [
  ["DISK_FULL", /no space left on device|\bENOSPC\b/i],
  // The server's own forward errors (gateway/ws-forward) when the worker never answers.
  ["WORKER_UNREACHABLE", /forward reply timeout|link is not connected|not connected on any instance|link (is )?offline/i],
  ["GIT_REPO_NOT_FOUND", /repository ['"]?[^\n]*['"]? not found|repository not found|does not appear to be a git repository|\b404\b.*not found/i],
  ["GIT_BRANCH_NOT_FOUND", /remote branch \S+ not found|couldn't find remote ref|did not match any file\(s\) known to git|invalid reference:/i],
  [
    "GIT_AUTH",
    /could not read (username|password)|authentication failed|permission denied \(publickey|terminal prompts disabled|invalid username or (password|token)|returned error: 40[13]\b|\b40[13]\b.*(forbidden|unauthorized)|bad credentials|host key verification failed/i,
  ],
  ["GIT_REJECTED", /\[rejected\]|\[remote rejected\]|non-fast-forward|protected branch|failed to push some refs/i],
  [
    "GIT_NETWORK",
    /could not resolve host|could not resolve hostname|connection (timed out|refused|reset)|network is unreachable|failed to connect to|unable to access|operation timed out|ssl[_ ]|tls handshake|early eof/i,
  ],
  ["FOLDER_NOT_EMPTY", /already exists and is not an empty directory|already holds \d+ file\(s\)/i],
  ["WORKER_PERMISSION", /not accessible to the agent user|\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|read-only file system/i],
];

/** Classify a raw failure text (`UNKNOWN` when empty or unrecognised). */
export function classifyProjectFailure(raw: string | null | undefined): ProjectFailCode {
  const text = (raw ?? "").trim();
  if (!text) return "UNKNOWN";
  for (const [code, re] of RULES) if (re.test(text)) return code;
  return "UNKNOWN";
}

/** Narrow an unknown value to a `ProjectFailCode` (null when it is not one). */
export function readProjectFailCode(v: unknown): ProjectFailCode | null {
  return typeof v === "string" && (PROJECT_FAIL_CODES as readonly string[]).includes(v) ? (v as ProjectFailCode) : null;
}
