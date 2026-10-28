/**
 * Book index push — build the compact index of the served project's books branch (`buildBookIndex`, `@4pm/dto`) and
 * send it on `autonomous.bookIndex` so the server can list what waits on each person (Home ▸ My work). Scheduled
 * (debounced 15 s) on connect, after each books write the web asks for, and after every autonomous tick; nothing is
 * sent while the books head is the one last sent.
 * @adr 0545
 */
import { WsChannels } from "@4pm/ws";
import {
  APPROVALS_SIDECAR_REL,
  AUTHORS_SIDECAR_REL,
  DOCS_SIDECAR_REL,
  LINEAGE_SIDECAR_REL,
  buildBookIndex,
  parseDocsSidecar,
  parseLineage,
  type BookIndexPayload,
  DONE_REVIEWS_SIDECAR_REL,
  parseDoneReviews,
} from "@4pm/dto";
import type { WsHandlerCtx } from "../ws-client/context";
import { approvalRowHash, approvalStates, bookOfRow, type ApprovalBooks } from "./autonomous-approvals";
import { ATTEMPTS_REL } from "./autonomous-books";
import { freshBooksRef, gitQuiet, readBooksFile, resolveBases } from "./autonomous-git";

const APPROVALS_REL = APPROVALS_SIDECAR_REL;
const AUTHORS_REL = AUTHORS_SIDECAR_REL;
/** Debounce between a trigger and the push. */
const DEBOUNCE_MS = 15_000;

/** The books head last sent per served root (so an unchanged head is not re-sent). */
const lastSent = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Parse a JSON object ("{}" on any error). */
function parseObject(text: string | null): Record<string, unknown> {
  try {
    const v = JSON.parse(text || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Ask for an index push within 15 s (later triggers in that window share it). `force` re-sends an unchanged head. */
export function scheduleBookIndex(ctx: WsHandlerCtx, force = false): void {
  if (force && ctx.physicRoot) lastSent.delete(ctx.physicRoot);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void sendBookIndex(ctx).catch(() => undefined);
  }, DEBOUNCE_MS);
  timer.unref?.();
}

/** Build the index of the served project's books branch, or null when there is nothing to index / nothing new. */
export async function buildServedBookIndex(root: string): Promise<BookIndexPayload | null> {
  const base = (await resolveBases(root).catch(() => null))?.root.base ?? "";
  if (!base) return null;
  const ref = await freshBooksRef(root, base);
  if (!ref) return null;
  const commitSha = (await gitQuiet(root, ["rev-parse", ref]).catch(() => "")).trim();
  if (!commitSha || lastSent.get(root) === commitSha) return null;
  const committedAt = (await gitQuiet(root, ["show", "-s", "--format=%cI", ref]).catch(() => "")).trim() || new Date().toISOString();
  const { rows, truncated } = await readBookIndexRows(root, base);
  return { commitSha, committedAt, truncated, rows };
}

/**
 * The index rows of the books branch of `base` (assignees, requester, approval…) plus the raw approvals map — also
 * read by the delivery to name a row's people on the host.
 * @adr 0671
 */
export async function readBookIndexRows(
  root: string,
  base: string,
): Promise<{ rows: BookIndexPayload["rows"]; truncated: boolean; approvals: Record<string, unknown> }> {
  const read = async (rel: string): Promise<string> => (await readBooksFile(root, base, rel)) ?? "";
  const [userTodo, userQa, aiTodo, aiDone, aiProgress, approvalsText, authorsText, attemptsText, docsText, lineageText, doneReviewsText] = await Promise.all([
    read("USER_TODO.md"),
    read("USER_QA.md"),
    read("AI_TODO.md"),
    read("AI_DONE.md"),
    read("AI_PROGRESS.md"),
    read(APPROVALS_REL),
    read(AUTHORS_REL),
    read(ATTEMPTS_REL),
    read(DOCS_SIDECAR_REL),
    read(LINEAGE_SIDECAR_REL),
    read(DONE_REVIEWS_SIDECAR_REL),
  ]);
  const approvals = parseObject(approvalsText);
  const approvalBooks: ApprovalBooks = { userTodo, userQa, aiTodo };
  // Party groups bound to the row's current content (the index lists who still has to approve).
  const partyGroups: Record<string, string[]> = {};
  for (const [id, entry] of Object.entries(approvals)) {
    const parties = (entry as { parties?: { group?: string; h?: string }[] } | null)?.parties;
    if (!Array.isArray(parties) || !parties.length) continue;
    const h = approvalRowHash(bookOfRow(approvalBooks, id), id);
    partyGroups[id] = [...new Set(parties.filter((p) => p.h && p.h === h && p.group).map((p) => p.group!))];
  }
  const attempts = parseObject(attemptsText) as Record<string, { task?: Record<string, string> } | undefined>;
  const claimedTasks = Object.fromEntries(Object.entries(attempts).flatMap(([id, a]) => (a?.task ? [[id, a.task]] : [])));
  const { rows, truncated } = buildBookIndex({
    books: { userTodo, userQa, aiTodo, aiDone, aiProgress },
    approvalStates: approvalStates(approvals, approvalBooks),
    partyGroups,
    authors: parseObject(authorsText) as Record<string, { by?: string; at?: string }>,
    claimedTasks,
    docs: parseDocsSidecar(docsText),
    lineage: parseLineage(lineageText),
    doneReviews: parseDoneReviews(doneReviewsText),
  });
  return { rows, truncated, approvals };
}

/** Build and send the index now (no-op when unchanged or not serving a project). */
export async function sendBookIndex(ctx: WsHandlerCtx): Promise<void> {
  const root = ctx.physicRoot;
  if (!root) return;
  const payload = await buildServedBookIndex(root);
  if (!payload) return;
  ctx.send(WsChannels.AUTONOMOUS_BOOK_INDEX, payload);
  lastSent.set(root, payload.commitSha);
}
