/**
 * Vendored from @4pm/dto (book-index.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
import { bookRowsById, type ApprovalState } from "./autonomous-approval";
import type { DocsSidecar, LineageSidecar } from "./autonomous-docs";
import { parseBookClaims } from "./book-guards";
import { bookGroupOf } from "./book-ids";
import { BOOK_ASSIGNEES_MAX, isValidDue, parseAssigneesCell, parseTagsCell } from "./book-meta";
import { parseBookState } from "./book-state";
import { formatIssueRef, parseIssueRef } from "./issue-sync";
import { DONE_REVIEW_STATES, type DoneReviewsSidecar } from "./done-reviews";
export const BOOK_INDEX_BOOKS = ["userTodo", "userQa", "aiTodo", "aiDone"] as const;
export type BookIndexBook = (typeof BOOK_INDEX_BOOKS)[number];
export const BOOK_INDEX_APPROVALS = ["approved", "pending", "stale", "unsigned", "invalid"] as const;
export type BookIndexApproval = (typeof BOOK_INDEX_APPROVALS)[number];
export const BOOK_INDEX_STATES = ["open", "intake", "running", "review", "done"] as const;
export type BookIndexState = (typeof BOOK_INDEX_STATES)[number];
export const BOOK_INDEX_TITLE_MAX = 200;
export const BOOK_INDEX_SNIPPET_MAX = 1000;
export const BOOK_INDEX_DONE_MAX = 500;
export const BOOK_INDEX_REQUEST_MAX = 20000;
export const BOOK_INDEX_ROWS_MAX = 5000;
export const bookIndexRowSchema = z.object({
    book: z.enum(BOOK_INDEX_BOOKS),
    id: z.string().min(1).max(64),
    team: z.string().max(32),
    group: z.string().max(16),
    title: z.string().max(BOOK_INDEX_TITLE_MAX),
    snippet: z.string().max(BOOK_INDEX_SNIPPET_MAX),
    tags: z.array(z.string().max(32)).max(20),
    due: z.string().nullable(),
    assigneeIds: z.array(z.string().max(64)).max(BOOK_ASSIGNEES_MAX).optional(),
    authorId: z.string().max(64).nullable(),
    authorAt: z.string().max(40).nullable(),
    requesterId: z.string().max(64).nullable(),
    requestId: z.string().max(64).nullable(),
    approval: z.enum(BOOK_INDEX_APPROVALS),
    partyGroups: z.array(z.string().max(16)).max(8),
    state: z.enum(BOOK_INDEX_STATES),
    answered: z.boolean().optional(),
    reviewRound: z.number().int().min(0).optional(),
    prUrl: z.string().max(500).optional(),
    doneAt: z.string().max(40).optional(),
    issueRef: z.string().max(200).optional(),
    request: z.string().max(BOOK_INDEX_REQUEST_MAX).optional(),
    doneReview: z.enum(DONE_REVIEW_STATES).optional(),
});
export type BookIndexRow = z.infer<typeof bookIndexRowSchema>;
export const bookIndexPayloadSchema = z.object({
    commitSha: z.string().min(1).max(64),
    committedAt: z.string().min(1).max(40),
    truncated: z.boolean(),
    rows: z.array(bookIndexRowSchema).max(BOOK_INDEX_ROWS_MAX),
});
export type BookIndexPayload = z.infer<typeof bookIndexPayloadSchema>;
export interface BookIndexInput {
    books: {
        userTodo: string;
        userQa: string;
        aiTodo: string;
        aiDone: string;
        aiProgress: string;
    };
    approvalStates: Readonly<Record<string, ApprovalState>>;
    partyGroups: Readonly<Record<string, readonly string[]>>;
    authors: Readonly<Record<string, {
        by?: string;
        at?: string;
    } | undefined>>;
    claimedTasks: Readonly<Record<string, {
        desc?: string;
        team?: string;
        group?: string;
        tags?: string;
        due?: string;
        assignees?: string;
    } | undefined>>;
    docs: DocsSidecar;
    lineage: LineageSidecar;
    doneReviews?: DoneReviewsSidecar;
}
function clip(text: string, max: number): string {
    const s = text.replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function titleOf(text: string): string {
    const plain = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<br\s*\/?>/gi, "\n");
    return clip(plain.split("\n").find((l) => l.trim()) ?? "", BOOK_INDEX_TITLE_MAX);
}
function stampIso(stamp: string): string | undefined {
    const iso = stamp.trim().replace(" ", "T");
    const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
function prUrlOf(notes: string): string | undefined {
    return /https?:\/\/\S+?\/(?:pull|merge_requests)\/\d+/.exec(notes)?.[0];
}
function requestOf(id: string, lineage: LineageSidecar): string | null {
    if (id.startsWith("REQ-"))
        return id;
    const entry = lineage[bookGroupOf(id) ?? ""];
    const src = entry?.root ?? entry?.source ?? null;
    return src && src.startsWith("REQ-") ? src : null;
}
export function buildBookIndex(input: BookIndexInput): {
    rows: BookIndexRow[];
    truncated: boolean;
} {
    const { books, approvalStates, partyGroups, authors, claimedTasks, docs, lineage } = input;
    const claims = parseBookClaims(books.aiProgress);
    const intakeClaimed = new Set(claims.filter((c) => c.kind === "intake").map((c) => c.id));
    const rows: BookIndexRow[] = [];
    const push = (book: BookIndexBook, id: string, team: string, cells: Record<string, string>, extra: Partial<BookIndexRow>): void => {
        const text = (k: string): string => cells[k] ?? "";
        const main = book === "userTodo" ? text("request") : book === "userQa" ? text("question / options") || text("original request") : text("task description");
        const rest = book === "userQa" ? [text("original request"), text("answer")] : [text("notes")];
        const due = text("due").trim();
        const requestId = requestOf(id, lineage);
        rows.push({
            book,
            id,
            team,
            group: bookGroupOf(id) ?? "",
            title: titleOf(main) || id,
            snippet: clip([main, ...rest].join(" "), BOOK_INDEX_SNIPPET_MAX),
            tags: parseTagsCell(text("tags")).slice(0, 20),
            due: isValidDue(due) ? due : null,
            assigneeIds: parseAssigneesCell(text("assignees")).slice(0, BOOK_ASSIGNEES_MAX),
            authorId: authors[id]?.by ?? null,
            authorAt: authors[id]?.at ?? null,
            requesterId: requestId ? (authors[requestId]?.by ?? null) : null,
            requestId,
            approval: (approvalStates[id] as BookIndexApproval | undefined) ?? "pending",
            partyGroups: [...(partyGroups[id] ?? [])].slice(0, 8),
            state: "open",
            ...extra,
        });
    };
    for (const [id, r] of bookRowsById(books.userTodo)) {
        if (!id.startsWith("REQ-") || parseBookState(r.cells.state))
            continue;
        const issue = parseIssueRef(r.cells.issue ?? "");
        push("userTodo", id, r.team, r.cells, {
            state: intakeClaimed.has(id) ? "intake" : "open",
            ...(issue ? { issueRef: formatIssueRef(issue), request: (r.cells.request ?? "").slice(0, BOOK_INDEX_REQUEST_MAX) } : {}),
        });
    }
    for (const [id, r] of bookRowsById(books.userQa)) {
        if (id.startsWith("QA-") && !parseBookState(r.cells.state)) {
            push("userQa", id, r.team, r.cells, { state: intakeClaimed.has(id) ? "intake" : "open", answered: Boolean((r.cells.answer ?? "").trim()) });
        }
    }
    const inTodo = new Set<string>();
    for (const [id, r] of bookRowsById(books.aiTodo)) {
        if (!/^(TSK|DOC)-/.test(id))
            continue;
        inTodo.add(id);
        const doc = id.startsWith("DOC-") || id.startsWith("AST-") ? docs[id] : undefined;
        push("aiTodo", id, r.team, r.cells, {
            state: doc?.state === "review" ? "review" : "open",
            ...(doc ? { reviewRound: doc.round } : {}),
        });
    }
    for (const c of claims) {
        if (c.kind !== "task" || inTodo.has(c.id))
            continue;
        const copy = claimedTasks[c.id];
        push("aiTodo", c.id, copy?.team ?? "", { "task description": copy?.desc ?? "", tags: copy?.tags ?? "", due: copy?.due ?? "", assignees: copy?.assignees ?? "" }, { state: "running" });
    }
    const done = [...bookRowsById(books.aiDone)].filter(([id]) => /^(TSK|DOC|AST)-/.test(id)).slice(-BOOK_INDEX_DONE_MAX);
    for (const [id, r] of done) {
        const doneAt = stampIso(r.cells.timestamp ?? "");
        const prUrl = prUrlOf(r.cells.notes ?? "");
        const review = input.doneReviews?.[id]?.state;
        push("aiDone", id, r.team, r.cells, { state: "done", approval: "approved", ...(doneAt ? { doneAt } : {}), ...(prUrl ? { prUrl } : {}), ...(review ? { doneReview: review } : {}) });
    }
    const truncated = rows.length > BOOK_INDEX_ROWS_MAX;
    return { rows: truncated ? rows.slice(0, BOOK_INDEX_ROWS_MAX) : rows, truncated };
}
