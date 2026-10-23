/**
 * The book index — a compact row per USER_TODO / USER_QA / AI_TODO / claimed task / AI_DONE row of a project's books
 * branch, built by the cli (`buildBookIndex`, pure) and pushed on `autonomous.bookIndex` so the server can list what
 * waits on each person (Home ▸ My work) without reading the repo. Derived and disposable: the repo stays the source
 * of truth.
 * @adr 0545 @adr 0585
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

/** The books an index row comes from. */
export const BOOK_INDEX_BOOKS = ["userTodo", "userQa", "aiTodo", "aiDone"] as const;
export type BookIndexBook = (typeof BOOK_INDEX_BOOKS)[number];

/** A row's approval as the index reports it (`pending` = no approval entry). */
export const BOOK_INDEX_APPROVALS = ["approved", "pending", "stale", "unsigned", "invalid"] as const;
export type BookIndexApproval = (typeof BOOK_INDEX_APPROVALS)[number];

/** Where a row stands: open · under an intake claim · a claimed (running) task · a DOC round awaiting review · done. */
export const BOOK_INDEX_STATES = ["open", "intake", "running", "review", "done"] as const;
export type BookIndexState = (typeof BOOK_INDEX_STATES)[number];

/** Limits of the index payload. */
export const BOOK_INDEX_TITLE_MAX = 200;
export const BOOK_INDEX_SNIPPET_MAX = 1000;
/** Only the newest AI_DONE rows are indexed. */
export const BOOK_INDEX_DONE_MAX = 500;
/** The full `Request` of a linked row is carried up to this length (issue sync — ADR-0546). */
export const BOOK_INDEX_REQUEST_MAX = 20_000;
/** At most this many rows per push (the rest is dropped and `truncated` set). */
export const BOOK_INDEX_ROWS_MAX = 5000;

/** Zod schema of one index row (validated by the server on ingest). */
export const bookIndexRowSchema = z.object({
  book: z.enum(BOOK_INDEX_BOOKS),
  id: z.string().min(1).max(64),
  team: z.string().max(32),
  group: z.string().max(16),
  title: z.string().max(BOOK_INDEX_TITLE_MAX),
  snippet: z.string().max(BOOK_INDEX_SNIPPET_MAX),
  tags: z.array(z.string().max(32)).max(20),
  due: z.string().nullable(),
  /** The people the row is given to (`Assignees` cell — ADR-0585); absent from older clis. */
  assigneeIds: z.array(z.string().max(64)).max(BOOK_ASSIGNEES_MAX).optional(),
  /** Last content writer (authors sidecar). */
  authorId: z.string().max(64).nullable(),
  authorAt: z.string().max(40).nullable(),
  /** The author of the request this row came from (itself for a request), via the lineage. */
  requesterId: z.string().max(64).nullable(),
  requestId: z.string().max(64).nullable(),
  approval: z.enum(BOOK_INDEX_APPROVALS),
  /** Policy groups already approved on the current content. */
  partyGroups: z.array(z.string().max(16)).max(8),
  state: z.enum(BOOK_INDEX_STATES),
  /** USER_QA: `Answer` filled. */
  answered: z.boolean().optional(),
  reviewRound: z.number().int().min(0).optional(),
  prUrl: z.string().max(500).optional(),
  /** AI_DONE: its Timestamp (ISO). */
  doneAt: z.string().max(40).optional(),
  /** USER_TODO: the linked issue ref (`Issue` cell) and the full `Request` text it syncs. */
  issueRef: z.string().max(200).optional(),
  request: z.string().max(BOOK_INDEX_REQUEST_MAX).optional(),
  /** AI_DONE: its follow-up review — absent when none was proposed. @adr 0616 */
  doneReview: z.enum(DONE_REVIEW_STATES).optional(),
});
export type BookIndexRow = z.infer<typeof bookIndexRowSchema>;

/** Zod schema of an `autonomous.bookIndex` payload. */
export const bookIndexPayloadSchema = z.object({
  commitSha: z.string().min(1).max(64),
  committedAt: z.string().min(1).max(40),
  truncated: z.boolean(),
  rows: z.array(bookIndexRowSchema).max(BOOK_INDEX_ROWS_MAX),
});
export type BookIndexPayload = z.infer<typeof bookIndexPayloadSchema>;

/** The inputs of `buildBookIndex`, read by the cli from the books branch. */
export interface BookIndexInput {
  books: { userTodo: string; userQa: string; aiTodo: string; aiDone: string; aiProgress: string };
  /** Verified approval state per row id (absent = pending). */
  approvalStates: Readonly<Record<string, ApprovalState>>;
  /** Party groups bound to each row's current content (row id → groups). */
  partyGroups: Readonly<Record<string, readonly string[]>>;
  /** `.autonomous.authors.json` (row id → `{by, at}`). */
  authors: Readonly<Record<string, { by?: string; at?: string } | undefined>>;
  /** Claimed tasks' copies from the attempts sidecar (task id → row fields). */
  claimedTasks: Readonly<Record<string, { desc?: string; team?: string; group?: string; tags?: string; due?: string; assignees?: string } | undefined>>;
  docs: DocsSidecar;
  lineage: LineageSidecar;
  /** `.autonomous.done-reviews.json` (absent from an older cli). @adr 0616 */
  doneReviews?: DoneReviewsSidecar;
}

/** Collapse whitespace and cut to `max` chars. */
function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The first line of a cell (markdown links / images reduced to their text). */
function titleOf(text: string): string {
  const plain = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<br\s*\/?>/gi, "\n");
  return clip(plain.split("\n").find((l) => l.trim()) ?? "", BOOK_INDEX_TITLE_MAX);
}

/** A books stamp (`YYYY-MM-DD HH:mm[:ss]`, UTC) as ISO, or undefined. */
function stampIso(stamp: string): string | undefined {
  const iso = stamp.trim().replace(" ", "T");
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** A PR / MR link in a Notes cell, if any. */
function prUrlOf(notes: string): string | undefined {
  return /https?:\/\/\S+?\/(?:pull|merge_requests)\/\d+/.exec(notes)?.[0];
}

/** The request id a row came from: itself for a REQ, else the lineage of its group (root first). */
function requestOf(id: string, lineage: LineageSidecar): string | null {
  if (id.startsWith("REQ-")) return id;
  const entry = lineage[bookGroupOf(id) ?? ""];
  const src = entry?.root ?? entry?.source ?? null;
  return src && src.startsWith("REQ-") ? src : null;
}

/** Build the index rows of a project's books (pure; the cli sends the result). */
export function buildBookIndex(input: BookIndexInput): { rows: BookIndexRow[]; truncated: boolean } {
  const { books, approvalStates, partyGroups, authors, claimedTasks, docs, lineage } = input;
  const claims = parseBookClaims(books.aiProgress);
  const intakeClaimed = new Set(claims.filter((c) => c.kind === "intake").map((c) => c.id));
  const rows: BookIndexRow[] = [];

  /** One row of the four books. */
  const push = (book: BookIndexBook, id: string, team: string, cells: Record<string, string>, extra: Partial<BookIndexRow>): void => {
    const text = (k: string): string => cells[k] ?? "";
    const main =
      book === "userTodo" ? text("request") : book === "userQa" ? text("question / options") || text("original request") : text("task description");
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

  // A request / question with a `State` is history (taken in / done — ADR-0562): indexed as before, when it was removed.
  for (const [id, r] of bookRowsById(books.userTodo)) {
    if (!id.startsWith("REQ-") || parseBookState(r.cells.state)) continue;
    // A linked row carries its ref and the full request text for the issue sync (ADR-0546).
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
    if (!/^(TSK|DOC)-/.test(id)) continue;
    inTodo.add(id);
    const doc = id.startsWith("DOC-") || id.startsWith("AST-") ? docs[id] : undefined;
    push("aiTodo", id, r.team, r.cells, {
      state: doc?.state === "review" ? "review" : "open",
      ...(doc ? { reviewRound: doc.round } : {}),
    });
  }
  // A claimed task has left AI_TODO: index it from its claim copy.
  for (const c of claims) {
    if (c.kind !== "task" || inTodo.has(c.id)) continue;
    const copy = claimedTasks[c.id];
    push(
      "aiTodo",
      c.id,
      copy?.team ?? "",
      { "task description": copy?.desc ?? "", tags: copy?.tags ?? "", due: copy?.due ?? "", assignees: copy?.assignees ?? "" },
      { state: "running" },
    );
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
