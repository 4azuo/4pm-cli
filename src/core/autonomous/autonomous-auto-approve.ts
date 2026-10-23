/**
 * Automatic approvals (Rigor · Best performance): each cycle the cli lists the requests (`REQ-…`) and AI Todo rows
 * (`TSK-` / `DOC-` / `AST-…`) that hold no valid approval, asks the server to sign them as the actor `auto`
 * (`autonomous.autoApprove` — the server signs only while the project's rigor is `fast`), and writes the returned
 * entries to the approvals record on the books branch. USER_QA answers always need a person.
 * @adr 0608 @arch 0065
 */
import { WsChannels, type AutonomousAutoApproveReply } from "@4pm/ws";
import { approvalStates, buildApprovalEntries, mergeApprovalWrite, type ApprovalBooks } from "./autonomous-approvals";
import { readBook, rowIds, writeBook } from "./autonomous-books";
import { APPROVALS_REL } from "./autonomous-er-store";
import { publishBooks } from "./autonomous-git";

/** The actor recorded on automatic approvals. */
export const AUTO_APPROVER = "auto";

/** The server call the step needs. */
export interface AutoApproveWs {
  request<T>(channel: typeof WsChannels.AUTONOMOUS_AUTO_APPROVE, data: unknown, timeoutMs?: number): Promise<T>;
}

/** Parse a JSON object (`{}` on error). */
function parseMap(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text || "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The approval-targetable books in `dir`. */
async function booksIn(dir: string): Promise<ApprovalBooks> {
  const [userTodo, userQa, aiTodo] = await Promise.all([readBook(dir, "USER_TODO.md"), readBook(dir, "USER_QA.md"), readBook(dir, "AI_TODO.md")]);
  return { userTodo, userQa, aiTodo };
}

/** The rows waiting for an approval that `auto` may give: requests and AI Todo rows without a valid entry. */
export function autoApprovableIds(books: ApprovalBooks, approvals: Record<string, unknown>): string[] {
  const states = approvalStates(approvals, books);
  const ids = [...rowIds(books.userTodo, "REQ-"), ...["TSK-", "DOC-", "AST-"].flatMap((p) => rowIds(books.aiTodo, p))];
  return ids.filter((id) => states[id] !== "approved" && states[id] !== "unsigned");
}

/**
 * Approve every waiting row as `auto` on the books branch (from the books worktree `bdir`). Returns how many rows were
 * approved; 0 when there is nothing to approve or the server refuses.
 */
export async function autoApproveWaiting(ws: AutoApproveWs, bdir: string, base: string, log: (line: string) => Promise<void>): Promise<number> {
  const books = await booksIn(bdir);
  const wanted = autoApprovableIds(books, parseMap(await readBook(bdir, APPROVALS_REL)));
  if (!wanted.length) return 0;
  let reply: AutonomousAutoApproveReply;
  try {
    reply = await ws.request<AutonomousAutoApproveReply>(WsChannels.AUTONOMOUS_AUTO_APPROVE, { rowIds: wanted, books: { userTodo: books.userTodo, aiTodo: books.aiTodo } });
  } catch (err) {
    await log(`[warn] auto-approve: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  if (reply.error || !reply.rowIds.length) {
    if (reply.error) await log(`[auto-approve] refused: ${reply.error}`);
    return 0;
  }
  let count = 0;
  const res = await publishBooks(bdir, base, () => `chore(auto): approve ${count} row(s) automatically (Best performance)`, async () => {
    const now = await booksIn(bdir);
    const map = parseMap(await readBook(bdir, APPROVALS_REL));
    // Rows that changed since the server signed them are left for the next cycle.
    const ids = reply.rowIds.filter((id) => !reply.signed[id] || buildApprovalEntries([id], reply.signed, now, AUTO_APPROVER, AUTO_APPROVER).ok);
    const built = buildApprovalEntries(ids, reply.unsigned ? undefined : reply.signed, now, AUTO_APPROVER, AUTO_APPROVER);
    if (!built.ok || !ids.length) return false;
    if (!mergeApprovalWrite(map, built.entries, undefined, now).ok) return false;
    count = ids.length;
    await writeBook(bdir, APPROVALS_REL, JSON.stringify(map, null, 2) + "\n");
    return true;
  });
  if (res === "failed") await log("[warn] auto-approve: could not push the approvals");
  else if (count) await log(`[auto-approve] ${count} row(s) approved as ${AUTO_APPROVER}`);
  return res === "failed" ? 0 : count;
}
