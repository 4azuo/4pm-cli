/**
 * Issue links of book rows (ADR-0544 / ADR-0546): the `Issue` cell ref format, the issue body layout 4PM manages
 * (the body, the GitHub `Due:` line, the `<!-- 4pm:status -->` block at the end), and the API shapes of the links
 * and their sync history. Pure — shared by the server, community and the web.
 * @adr 0544 @adr 0546
 */
import { z } from "zod";

/** The providers an issue ref may name. */
export const ISSUE_PROVIDERS = ["jira", "backlog", "github"] as const;
export type IssueProvider = (typeof ISSUE_PROVIDERS)[number];

/** `jira:KEY-12` · `backlog:KEY-3` · `github:owner/repo#12`. */
export const ISSUE_REF_RE = /^(?:(jira|backlog):([A-Za-z][A-Za-z0-9_]*-\d+)|github:([\w.-]+\/[\w.-]+)#(\d+))$/;

/** A parsed issue ref; `key` is the provider's issue id (GitHub: the number), `repo` the GitHub `owner/repo`. */
export interface IssueRef {
  provider: IssueProvider;
  key: string;
  repo?: string;
}

/** Parse an `Issue` cell (trimmed); null when it is not a valid ref. */
export function parseIssueRef(cell: string): IssueRef | null {
  const m = ISSUE_REF_RE.exec(cell.trim());
  if (!m) return null;
  if (m[1]) return { provider: m[1] as IssueProvider, key: m[2]!.toUpperCase() };
  return { provider: "github", key: m[4]!, repo: m[3]! };
}

/** Render a ref. */
export function formatIssueRef(ref: IssueRef): string {
  return ref.provider === "github" ? `github:${ref.repo ?? ""}#${ref.key}` : `${ref.provider}:${ref.key}`;
}

/** The marker that starts the 4PM status block (everything after it is 4PM's). */
export const ISSUE_STATUS_MARK = "<!-- 4pm:status -->";
/** The GitHub due-date line (`Due: YYYY-MM-DD`, alone on its line). */
const DUE_LINE_RE = /^due:\s*(\d{4}-\d{2}-\d{2})\s*$/im;

/** An issue body split into the people's text, the `Due:` line value and whether a status block was present. */
export interface IssueBodyParts {
  text: string;
  due: string | null;
  hasStatusBlock: boolean;
}

/** Split an issue body: drop the status block (from the marker to the end) and the first valid `Due:` line. */
export function splitIssueBody(body: string): IssueBodyParts {
  const norm = body.replace(/\r\n/g, "\n");
  const at = norm.indexOf(ISSUE_STATUS_MARK);
  let text = at >= 0 ? norm.slice(0, at) : norm;
  let due: string | null = null;
  const m = DUE_LINE_RE.exec(text);
  if (m) {
    const d = new Date(`${m[1]}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === m[1]) due = m[1]!;
    text = text.replace(m[0], "");
  }
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), due, hasStatusBlock: at >= 0 };
}

/** Compose an issue body: the text, then the `Due:` line (GitHub only), then the status block. */
export function composeIssueBody(parts: { text: string; due?: string | null; statusBlock?: string | null }): string {
  const out = [parts.text.trim()];
  if (parts.due) out.push(`Due: ${parts.due}`);
  if (parts.statusBlock) out.push(parts.statusBlock);
  return out.filter(Boolean).join("\n\n");
}

/** What the status block says. */
export interface IssueStatusBlockInput {
  phase: "approved" | "inProgress" | "done";
  /** `YYYY-MM-DD` of the phase. */
  date: string;
  tasks?: readonly string[];
  prUrl?: string | null;
}

/** Render the managed status block (English — issue trackers have no per-reader locale). */
export function renderIssueStatusBlock(input: IssueStatusBlockInput): string {
  const lines =
    input.phase === "approved"
      ? [`> **4PM:** approved ${input.date}.`, "> Edits here wait for the author's review in 4PM before they apply."]
      : input.phase === "inProgress"
        ? [
            `> **4PM:** taken in by the AI on ${input.date}${input.tasks?.length ? ` (${input.tasks.slice(0, 8).join(", ")}${input.tasks.length > 8 ? ", …" : ""})` : ""}.`,
            "> Edits here are not applied in 4PM any more — open a discussion in 4PM instead.",
          ]
        : [`> **4PM:** done ${input.date}${input.prUrl ? ` — ${input.prUrl}` : ""}.`];
  return [ISSUE_STATUS_MARK, ...lines].join("\n");
}

/** Longest issue title taken from a request without a `<br>` (the rest goes to the body). */
const TITLE_MAX = 200;

/**
 * A USER_TODO `Request` cell as issue title + body. Book cells hold no newlines, so the request keeps them as `<br>`:
 * the part before the first `<br>` is the title, the rest the body. A request without `<br>` is all title — cut at
 * `TITLE_MAX` with the whole text kept as the body.
 */
export function requestToIssue(request: string): { title: string; body: string } {
  const parts = request.split(/<br\s*\/?>/i);
  const head = (parts[0] ?? "").trim();
  if (parts.length > 1) return { title: head, body: parts.slice(1).join("\n").trim() };
  return head.length <= TITLE_MAX ? { title: head, body: "" } : { title: `${head.slice(0, TITLE_MAX - 1)}…`, body: head };
}

/** The `Request` cell of an issue: title, then the body with its newlines as `<br>`. */
export function issueToRequest(title: string, body: string): string {
  const text = body.replace(/\r\n/g, "\n").trim();
  // The book writers escape `|` themselves.
  return [title.trim(), ...(text ? text.split("\n") : [])].join("<br>");
}

/** The normalized issue status 4PM sets. */
export type IssueStatus = "open" | "in_progress" | "done" | "closed";

/** A held edit made in the issue to an approved row. */
export interface IssuePendingChange {
  title: string;
  body: string;
  at: string;
}

/** One link as project-0132 returns it. @api project-0132 */
export interface IssueLinkResponse {
  rowId: string;
  ref: string;
  provider: IssueProvider;
  key: string;
  url: string | null;
  /** The issue's status as last seen. */
  status: IssueStatus | null;
  active: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pending: IssuePendingChange | null;
  /** 4PM's title / body of the row as last synced (for the review). */
  current: { title: string; body: string };
  /** The request was taken in by the AI — only the status still syncs. */
  afterIntake: boolean;
}

/** One sync decision. */
export interface IssueSyncEventResponse {
  at: string;
  field: string;
  /** `out` · `in` · `override` · `held` · `reset` · `error` · `ignored`. */
  direction: string;
  from: string | null;
  to: string | null;
  detail: string | null;
}

/** GET /projects/:id/issue-links. @api project-0132 */
export interface IssueLinksResponse {
  links: IssueLinkResponse[];
  history: IssueSyncEventResponse[];
}

/** Query GET /projects/:id/issue-links. @api project-0132 */
export const issueLinksQuerySchema = z.object({ rowId: z.string().regex(/^REQ-[\w-]+$/).optional() });
export type IssueLinksQuery = z.infer<typeof issueLinksQuerySchema>;

/** Body POST /projects/:id/issue-links/:rowId/pending. @api project-0133 */
export const issuePendingActionSchema = z.object({ action: z.enum(["apply", "dismiss"]) });
export type IssuePendingAction = z.infer<typeof issuePendingActionSchema>;
