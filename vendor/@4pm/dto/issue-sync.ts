/**
 * Vendored from @4pm/dto (issue-sync.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const ISSUE_PROVIDERS = ["jira", "backlog", "github", "gitlab"] as const;
export type IssueProvider = (typeof ISSUE_PROVIDERS)[number];
export const ISSUE_REF_RE = /^(?:(jira|backlog):([A-Za-z][A-Za-z0-9_]*-\d+)|(github):([\w.-]+\/[\w.-]+)#(\d+)|(gitlab):([\w.-]+(?:\/[\w.-]+)+)#(\d+))$/;
export interface IssueRef {
    provider: IssueProvider;
    key: string;
    repo?: string;
}
export function parseIssueRef(cell: string): IssueRef | null {
    const m = ISSUE_REF_RE.exec(cell.trim());
    if (!m)
        return null;
    if (m[1])
        return { provider: m[1] as IssueProvider, key: m[2]!.toUpperCase() };
    if (m[3])
        return { provider: "github", key: m[5]!, repo: m[4]! };
    return { provider: "gitlab", key: m[8]!, repo: m[7]! };
}
export const ISSUE_PROVIDER_LABEL: Record<IssueProvider, string> = { jira: "Jira", backlog: "Backlog", github: "GitHub", gitlab: "GitLab" };
export function issueRefHasRepo(provider: IssueProvider): boolean {
    return provider === "github" || provider === "gitlab";
}
export function formatIssueRef(ref: IssueRef): string {
    return issueRefHasRepo(ref.provider) ? `${ref.provider}:${ref.repo ?? ""}#${ref.key}` : `${ref.provider}:${ref.key}`;
}
export const ISSUE_STATUS_MARK = "<!-- 4pm:status -->";
const DUE_LINE_RE = /^due:\s*(\d{4}-\d{2}-\d{2})\s*$/im;
export interface IssueBodyParts {
    text: string;
    due: string | null;
    hasStatusBlock: boolean;
}
export function splitIssueBody(body: string): IssueBodyParts {
    const norm = body.replace(/\r\n/g, "\n");
    const at = norm.indexOf(ISSUE_STATUS_MARK);
    let text = at >= 0 ? norm.slice(0, at) : norm;
    let due: string | null = null;
    const m = DUE_LINE_RE.exec(text);
    if (m) {
        const d = new Date(`${m[1]}T00:00:00Z`);
        if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === m[1])
            due = m[1]!;
        text = text.replace(m[0], "");
    }
    return { text: text.replace(/\n{3,}/g, "\n\n").trim(), due, hasStatusBlock: at >= 0 };
}
export function composeIssueBody(parts: {
    text: string;
    due?: string | null;
    statusBlock?: string | null;
}): string {
    const out = [parts.text.trim()];
    if (parts.due)
        out.push(`Due: ${parts.due}`);
    if (parts.statusBlock)
        out.push(parts.statusBlock);
    return out.filter(Boolean).join("\n\n");
}
export interface IssueStatusBlockInput {
    phase: "approved" | "inProgress" | "done";
    date: string;
    tasks?: readonly string[];
    prUrl?: string | null;
}
export function renderIssueStatusBlock(input: IssueStatusBlockInput): string {
    const lines = input.phase === "approved"
        ? [`> **4PM:** approved ${input.date}.`, "> Edits here wait for the author's review in 4PM before they apply."]
        : input.phase === "inProgress"
            ? [
                `> **4PM:** taken in by the AI on ${input.date}${input.tasks?.length ? ` (${input.tasks.slice(0, 8).join(", ")}${input.tasks.length > 8 ? ", …" : ""})` : ""}.`,
                "> Edits here are not applied in 4PM any more — open a discussion in 4PM instead.",
            ]
            : [`> **4PM:** done ${input.date}${input.prUrl ? ` — ${input.prUrl}` : ""}.`];
    return [ISSUE_STATUS_MARK, ...lines].join("\n");
}
const TITLE_MAX = 200;
export function requestToIssue(request: string): {
    title: string;
    body: string;
} {
    const parts = request.split(/<br\s*\/?>/i);
    const head = (parts[0] ?? "").trim();
    if (parts.length > 1)
        return { title: head, body: parts.slice(1).join("\n").trim() };
    return head.length <= TITLE_MAX ? { title: head, body: "" } : { title: `${head.slice(0, TITLE_MAX - 1)}…`, body: head };
}
export function issueToRequest(title: string, body: string): string {
    const text = body.replace(/\r\n/g, "\n").trim();
    return [title.trim(), ...(text ? text.split("\n") : [])].join("<br>");
}
export type IssueStatus = "open" | "in_progress" | "done" | "closed";
export interface IssuePendingChange {
    title: string;
    body: string;
    at: string;
}
export interface IssueLinkResponse {
    rowId: string;
    ref: string;
    provider: IssueProvider;
    key: string;
    url: string | null;
    status: IssueStatus | null;
    active: boolean;
    lastSyncAt: string | null;
    lastError: string | null;
    pending: IssuePendingChange | null;
    current: {
        title: string;
        body: string;
    };
    afterIntake: boolean;
}
export interface IssueSyncEventResponse {
    at: string;
    field: string;
    direction: string;
    from: string | null;
    to: string | null;
    detail: string | null;
}
export interface IssueLinksResponse {
    links: IssueLinkResponse[];
    history: IssueSyncEventResponse[];
}
export const issueLinksQuerySchema = z.object({ rowId: z.string().regex(/^REQ-[\w-]+$/).optional() });
export type IssueLinksQuery = z.infer<typeof issueLinksQuerySchema>;
export const issuePendingActionSchema = z.object({ action: z.enum(["apply", "dismiss"]) });
export type IssuePendingAction = z.infer<typeof issuePendingActionSchema>;
