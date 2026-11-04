/**
 * Vendored from @4pm/dto (autonomous-books-set.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { AUDITS_DIR } from "./audit";
import { DISCUSSIONS_DIR } from "./discussion";
export const BOOKS_INDEX_REL = ".4pm/INDEX.md";
export const CONTEXT_DIR = ".4pm/context";
export const BOOK_FILES = ["USER_TODO.md", "USER_QA.md", "AI_TODO.md", "AI_PROGRESS.md", "AI_DONE.md"] as const;
export const SIDECAR_DIR = ".4pm";
export const APPROVALS_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.approvals.json`;
export const AUTHORS_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.authors.json`;
export const ATTEMPTS_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.attempts.json`;
export const HISTORIES_REL = `${SIDECAR_DIR}/.autonomous.histories.json`;
export const AUTONOMOUS_LOCK_REL = `${SIDECAR_DIR}/.autonomous.lock`;
export const TICK_LOG_DIR_REL = `${SIDECAR_DIR}/logs`;
export const ARCHIVE_DIR = `${SIDECAR_DIR}/archive`;
export const WIP_DIR = `${SIDECAR_DIR}/wip`;
export const ARCHIVE_INDEX_REL = `${SIDECAR_DIR}/archive/ids.json`;
export function parseArchiveIndex(text: string | null | undefined): Record<string, string> {
    try {
        const o = JSON.parse(text || "{}") as unknown;
        if (!o || typeof o !== "object" || Array.isArray(o))
            return {};
        return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter((e): e is [
            string,
            string
        ] => typeof e[1] === "string"));
    }
    catch {
        return {};
    }
}
export function archiveMonthDir(month: string): string {
    return `${ARCHIVE_DIR}/${month}`;
}
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
    ".autonomous.delivery.json",
    ".autonomous.done-reviews.json",
] as const;
export const SIDECAR_RELS: readonly string[] = SIDECAR_FILES.map((f) => `${SIDECAR_DIR}/${f}`);
export interface BooksSetDirs {
    evidenceDir: string;
    erDir: string;
    diagramDir: string;
}
function evidenceRoots(dirs: BooksSetDirs, defaultEvidenceRoot: string): string[] {
    return [...new Set([defaultEvidenceRoot, dirs.evidenceDir])];
}
export function booksSetDirs(dirs: BooksSetDirs): string[] {
    return [DISCUSSIONS_DIR, ARCHIVE_DIR, AUDITS_DIR, dirs.erDir, dirs.diagramDir];
}
function under(p: string, dir: string): boolean {
    return p === dir || p.startsWith(`${dir}/`);
}
export function isBooksSetPath(p: string, dirs: BooksSetDirs, defaultEvidenceRoot = ".4pm/evidence"): boolean {
    if ((BOOK_FILES as readonly string[]).includes(p))
        return true;
    if (SIDECAR_RELS.includes(p) || p === BOOKS_INDEX_REL)
        return true;
    if (under(p, CONTEXT_DIR))
        return true;
    if (booksSetDirs(dirs).some((d) => under(p, d)))
        return true;
    for (const root of evidenceRoots(dirs, defaultEvidenceRoot)) {
        if (!under(p, root))
            continue;
        const rest = p.slice(root.length + 1).split("/");
        if (rest.length < 3)
            return false;
        return !(rest[0] === "AI_DONE" && rest[rest.length - 1]!.startsWith("ai-"));
    }
    return false;
}
export type DeliveryState = "open" | "merged" | "closed" | "direct";
export interface DeliveryRecord {
    branch: string;
    url?: string;
    state: DeliveryState;
    reopen?: boolean;
}
export function parseDelivery(v: unknown): DeliveryRecord | undefined {
    if (!v || typeof v !== "object")
        return undefined;
    const o = v as Partial<DeliveryRecord>;
    if (typeof o.branch !== "string" || !o.branch)
        return undefined;
    const state: DeliveryState = o.state === "merged" || o.state === "closed" || o.state === "direct" ? o.state : "open";
    return { branch: o.branch, state, ...(typeof o.url === "string" && o.url ? { url: o.url } : {}), ...(o.reopen === true ? { reopen: true } : {}) };
}
export function deliveryLanded(d: DeliveryRecord | undefined): boolean {
    return !!d && (d.state === "merged" || d.state === "direct");
}
export function prNumberOf(url: string | undefined): number | null {
    const m = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#].*)?$/.exec(url ?? "");
    return m ? Number(m[1]) : null;
}
export function deliveryCell(state: DeliveryState, url?: string): string {
    if (state !== "open")
        return state;
    const n = prNumberOf(url);
    return n ? `PR open #${n}` : "PR open";
}
export function deliveryOfCell(cell: string): DeliveryState | null {
    const c = cell.trim().toLowerCase();
    if (c.startsWith("pr open"))
        return "open";
    return c === "merged" || c === "closed" || c === "direct" ? c : null;
}
