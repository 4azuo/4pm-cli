/**
 * The autonomous **books set** — every path that lives on the books branch `autonomous-books/<base>` and nowhere
 * else in the working flow: the five books, the cli-owned sidecars under `.4pm/` and its layout guide `INDEX.md`,
 * the discussions, the ER and the system diagram, the files people attach to book rows and the archive. A REQ / DOC / TSK branch only ever sees
 * them as a never-committed overlay; `<base>` gets them only through the books sync.
 * @adr 0563 @adr 0565
 */
import { DISCUSSIONS_DIR } from "./discussion";

/** The layout guide of the books set, kept current by the cli on the books branch (synced to `<base>`). @adr 0565 */
export const BOOKS_INDEX_REL = ".4pm/INDEX.md";

/** The per-run context manifests `<CONTEXT_DIR>/<ID>.md` — overlay-only, never committed. @adr 0565 */
export const CONTEXT_DIR = ".4pm/context";

/** The five book files at the repo root. */
export const BOOK_FILES = ["USER_TODO.md", "USER_QA.md", "AI_TODO.md", "AI_PROGRESS.md", "AI_DONE.md"] as const;

/** Folder of the cli-owned sidecars. */
export const SIDECAR_DIR = ".4pm";

/** The signed approvals sidecar. */
export const APPROVALS_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.approvals.json`;
/** Who wrote each row (separation of duties). */
export const AUTHORS_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.authors.json`;
/** Attempts per claimed row. */
export const ATTEMPTS_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.attempts.json`;
/** Run histories — local to the worker, git-ignored, never in the books set. */
export const HISTORIES_REL = `${SIDECAR_DIR}/.autonomous.histories.json`;
/** The cycle's lock file — local, git-ignored. */
export const AUTONOMOUS_LOCK_REL = `${SIDECAR_DIR}/.autonomous.lock`;
/** The per-day tick logs (`autonomous-tick-<day>.log`) — local, git-ignored. @adr 0568 */
export const TICK_LOG_DIR_REL = `${SIDECAR_DIR}/logs`;

/** Where archived book rows and sidecar entries go: `.4pm/archive/<YYYY-MM>/<same file names>`. */
export const ARCHIVE_DIR = `${SIDECAR_DIR}/archive`;
/** A request's unpublished row patch, carried on its WIP branch only. */
export const WIP_DIR = `${SIDECAR_DIR}/wip`;

/**
 * The archive index: every archived row id → the `YYYY-MM` folder it is in. An archived `TSK-…` / `DOC-…` still counts as
 * done for the `Depends` of live rows, and a person or an agent finds an archived row from its id alone.
 */
export const ARCHIVE_INDEX_REL = `${SIDECAR_DIR}/archive/ids.json`;

/** Parse the archive index (`{}` on anything invalid). */
export function parseArchiveIndex(text: string | null | undefined): Record<string, string> {
  try {
    const o = JSON.parse(text || "{}") as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** Archive folder of one month (`YYYY-MM`). */
export function archiveMonthDir(month: string): string {
  return `${ARCHIVE_DIR}/${month}`;
}

/**
 * The committed sidecars by file name (the deletion log, docs, lineage, ER and diagram sidecars are declared next
 * to their own models). Listed here so the books set sees them all.
 */
export const SIDECAR_FILES = [
  ".autonomous.approvals.json",
  ".autonomous.authors.json",
  ".autonomous.attempts.json",
  ".autonomous.docs.json",
  ".autonomous.lineage.json",
  ".autonomous.er.json",
  ".autonomous.diagram.json",
  ".autonomous.branch-deletions.json",
  ".autonomous.pointers.json",
] as const;

/** The committed sidecar paths (`.4pm/.autonomous.*.json`). */
export const SIDECAR_RELS: readonly string[] = SIDECAR_FILES.map((f) => `${SIDECAR_DIR}/${f}`);

/** The configurable folders that decide the books set. */
export interface BooksSetDirs {
  evidenceDir: string;
  erDir: string;
  diagramDir: string;
}

/** The evidence roots in use: the default one and the configured one. */
function evidenceRoots(dirs: BooksSetDirs, defaultEvidenceRoot: string): string[] {
  return [...new Set([defaultEvidenceRoot, dirs.evidenceDir])];
}

/** Folder prefixes whose every file is in the books set. */
export function booksSetDirs(dirs: BooksSetDirs): string[] {
  return [DISCUSSIONS_DIR, ARCHIVE_DIR, dirs.erDir, dirs.diagramDir];
}

/** True when `p` is `dir` or below it. */
function under(p: string, dir: string): boolean {
  return p === dir || p.startsWith(`${dir}/`);
}

/**
 * Is a repo-relative path in the books set? The book files, the committed sidecars, the books-set folders and the
 * files people attach to a book row (`<evidenceRoot>/<BOOK>/<ROW-ID>/<file>`) — except the agent's own `ai-*` evidence
 * of a finished task (`<evidenceRoot>/AI_DONE/<TSK>/ai-*`), which is work output and reaches `<base>` with the task PR.
 */
export function isBooksSetPath(p: string, dirs: BooksSetDirs, defaultEvidenceRoot = ".4pm/evidence"): boolean {
  if ((BOOK_FILES as readonly string[]).includes(p)) return true;
  if (SIDECAR_RELS.includes(p) || p === BOOKS_INDEX_REL) return true;
  // A context manifest an agent committed by mistake is stripped like the books (it is never on any branch).
  if (under(p, CONTEXT_DIR)) return true;
  if (booksSetDirs(dirs).some((d) => under(p, d))) return true;
  for (const root of evidenceRoots(dirs, defaultEvidenceRoot)) {
    if (!under(p, root)) continue;
    const rest = p.slice(root.length + 1).split("/");
    if (rest.length < 3) return false;
    return !(rest[0] === "AI_DONE" && rest[rest.length - 1]!.startsWith("ai-"));
  }
  return false;
}

/** Where a request / DOC / task PR stands: open, merged, closed without merge, or merged directly (`skipPullRequest`). */
export type DeliveryState = "open" | "merged" | "closed" | "direct";

/** How a REQ / DOC branch reached (or waits to reach) `<base>`. */
export interface DeliveryRecord {
  branch: string;
  /** The PR / MR link (absent for a direct merge). */
  url?: string;
  state: DeliveryState;
  /** A person pressed Retry on a closed PR: the next cycle opens a new one from the same branch. */
  reopen?: boolean;
}

/** Read a stored delivery record (undefined when invalid). */
export function parseDelivery(v: unknown): DeliveryRecord | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Partial<DeliveryRecord>;
  if (typeof o.branch !== "string" || !o.branch) return undefined;
  const state: DeliveryState = o.state === "merged" || o.state === "closed" || o.state === "direct" ? o.state : "open";
  return { branch: o.branch, state, ...(typeof o.url === "string" && o.url ? { url: o.url } : {}), ...(o.reopen === true ? { reopen: true } : {}) };
}

/** Is the delivery in `<base>` (merged by a PR or directly)? */
export function deliveryLanded(d: DeliveryRecord | undefined): boolean {
  return !!d && (d.state === "merged" || d.state === "direct");
}

/** The PR number at the end of a PR / MR url (`…/pull/12`, `…/merge_requests/12`), or null. */
export function prNumberOf(url: string | undefined): number | null {
  const m = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#].*)?$/.exec(url ?? "");
  return m ? Number(m[1]) : null;
}

/** The AI_DONE `Delivery` cell of a state: `PR open #12` · `merged` · `closed` · `direct`. */
export function deliveryCell(state: DeliveryState, url?: string): string {
  if (state !== "open") return state;
  const n = prNumberOf(url);
  return n ? `PR open #${n}` : "PR open";
}

/** Parse an AI_DONE `Delivery` cell back into its state ("" / unknown ⇒ null). */
export function deliveryOfCell(cell: string): DeliveryState | null {
  const c = cell.trim().toLowerCase();
  if (c.startsWith("pr open")) return "open";
  return c === "merged" || c === "closed" || c === "direct" ? c : null;
}
