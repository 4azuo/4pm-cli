/**
 * People of a delivered row on the host: who goes into the content commits' `Co-authored-by` trailers, the PR's
 * assignees and reviewers and its *Requested by* line. Read from the books (the row's `Assignees`, its request's
 * author, its approvers — else the project's PMs) and mapped to the members' verified accounts the server pushed
 * with the policy (memory only). Runs only when the project's `hostPeople` allows it (`auto`: private / internal
 * repos). Every login is checked against the host syntax; nobody outside the pushed members can be named.
 * @adr 0671
 */
import {
  HOST_PEOPLE_MAX,
  HOST_REVIEWERS_MAX,
  coAuthorTrailer,
  isValidGitLogin,
  type GitAccountRef,
  type HostPeopleMode,
} from "@4pm/dto";
import { logger } from "../../common/logger/logger";
import { endGitScope, issuePeopleToken } from "../git/git-auth";
import { repoHost, repoVisibility, setPrPeople } from "../git/git-host";
import { readBookIndexRows } from "./autonomous-book-index";
import { deliverPr } from "./autonomous-git";
import { hostPeople } from "./autonomous-policy";

/** The people of one row, as host accounts of the repo's host. */
export interface RowHostPeople {
  coAuthors: GitAccountRef[];
  assignees: string[];
  reviewers: string[];
  /** `Requested by @x (REQ-…) · assigned to @y` — empty when nobody is linked. */
  line: string;
}

const NOBODY: RowHostPeople = { coAuthors: [], assignees: [], reviewers: [], line: "" };
/** Visibility answers are kept this long per repo. */
const VISIBILITY_TTL_MS = 60 * 60_000;
const visibility = new Map<string, { at: number; allowed: boolean }>();

/** Does `mode` let the cli name people on this repo's host? `auto` = only a private / internal repo (unknown ⇒ no). */
export async function hostPeopleAllowed(mode: HostPeopleMode, url: string): Promise<boolean> {
  if (mode === "off") return false;
  if (mode === "on") return true;
  const hit = visibility.get(url);
  if (hit && Date.now() - hit.at < VISIBILITY_TTL_MS) return hit.allowed;
  const v = await repoVisibility(url);
  const allowed = v === "private" || v === "internal";
  visibility.set(url, { at: Date.now(), allowed });
  return allowed;
}

/** The pushed account of `userId` on `host` for `provider` (null when not linked / verified). */
function accountOf(userId: string, provider: "github" | "gitlab", host: string): GitAccountRef | null {
  const list = hostPeople().accounts[userId.toLowerCase()] ?? [];
  const a = list.find((x) => x.provider === provider && x.host === host.toLowerCase());
  return a && isValidGitLogin(a.provider, a.login) ? a : null;
}

/** The approvers of a row from the approvals map: the final entry's `by` and every party's (never `auto`). */
function approversOf(entry: unknown): string[] {
  const e = (entry && typeof entry === "object" ? entry : {}) as { by?: unknown; parties?: { by?: unknown }[] };
  const ids = [e.by, ...(Array.isArray(e.parties) ? e.parties.map((p) => p?.by) : [])];
  return [...new Set(ids.filter((v): v is string => typeof v === "string" && v !== "auto"))];
}

/**
 * The host people of row `id` for the repo at `url`, or nobody when the setting / visibility says no, the host is
 * unknown or the books cannot be read.
 */
export async function rowHostPeople(root: string, base: string, url: string, id: string, mode: HostPeopleMode): Promise<RowHostPeople> {
  try {
    if (!(await hostPeopleAllowed(mode, url))) return NOBODY;
    const h = repoHost(url);
    const provider = h.provider === "gh" ? "github" : h.provider === "glab" ? "gitlab" : null;
    if (!provider) return NOBODY;
    const { rows, approvals } = await readBookIndexRows(root, base);
    const row = rows.find((r) => r.id === id && (r.assigneeIds?.length ?? 0) > 0) ?? rows.find((r) => r.id === id);
    if (!row) return NOBODY;
    const account = (userId: string | null | undefined) => (userId ? accountOf(userId, provider, h.host) : null);
    const assigneeIds = row.assigneeIds?.length ? row.assigneeIds : row.requesterId ? [row.requesterId] : [];
    const assignees = assigneeIds.map(account).filter((a): a is GitAccountRef => a !== null).slice(0, HOST_PEOPLE_MAX);
    const approverIds = approversOf(approvals[id]);
    const reviewerIds = approverIds.length ? approverIds : hostPeople().pmUserIds;
    const reviewers = reviewerIds.map(account).filter((a): a is GitAccountRef => a !== null).slice(0, HOST_REVIEWERS_MAX);
    const requester = account(row.requesterId);
    const parts = [
      ...(requester ? [`Requested by @${requester.login}${row.requestId ? ` (${row.requestId})` : ""}`] : []),
      ...(assignees.length ? [`assigned to ${assignees.map((a) => `@${a.login}`).join(", ")}`] : []),
    ];
    return {
      coAuthors: assignees,
      assignees: assignees.map((a) => a.login),
      reviewers: reviewers.map((a) => a.login),
      line: parts.join(" · "),
    };
  } catch (err) {
    logger.warn("autonomous.people.failed", { id, error: String(err) });
    return NOBODY;
  }
}

/** `message` with the co-author trailers appended (unchanged when there are none). */
export function withCoAuthors(message: string, people: RowHostPeople): string {
  if (!people.coAuthors.length) return message;
  return `${message}\n\n${people.coAuthors.map(coAuthorTrailer).join("\n")}`;
}

/** `body` with the requested-by line appended (unchanged when empty). */
export function withPeopleLine(body: string, people: RowHostPeople): string {
  return people.line ? `${body}\n\n${people.line}` : body;
}

/**
 * Set the PR's assignees and reviewers. On a GitHub App project a separate least-privilege `pr-people:` token is
 * used in-process and ended right after; elsewhere the worker's `gh` / `glab`. Failures are logged, never thrown.
 */
export async function applyPrPeople(url: string, prUrl: string, people: RowHostPeople, log?: (line: string) => void): Promise<void> {
  if (!prUrl || (!people.assignees.length && !people.reviewers.length)) return;
  const h = repoHost(url);
  const token = h.provider === "gh" ? await issuePeopleToken(h.host, h.slug).catch(() => null) : null;
  try {
    const errors = await setPrPeople(url, prUrl, { assignees: people.assignees, reviewers: people.reviewers }, token);
    for (const e of errors) log?.(`[pr] ${prUrl} people — ${e}`);
  } finally {
    if (token) await endGitScope(token.scope).catch(() => undefined);
  }
}

/** Where a delivered row's people come from: the served root, the books' base, the row and the project setting. */
export interface PeopleSource {
  root: string;
  booksBase: string;
  id: string;
  mode: HostPeopleMode;
  log?: (line: string) => void;
}

/**
 * `deliverPr` plus the row's people: the *Requested by* line in the body, then the assignees / reviewers once the PR
 * exists (best-effort — a refused person never fails the delivery).
 */
export async function deliverPrWithPeople(
  src: PeopleSource,
  cwd: string,
  url: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  draft = false,
): Promise<{ url: string | null; error: string | null }> {
  const people = await rowHostPeople(src.root, src.booksBase, url, src.id, src.mode);
  const pr = await deliverPr(cwd, url, branch, base, title, withPeopleLine(body, people), draft);
  if (pr.url) await applyPrPeople(url, pr.url, people, src.log);
  return pr;
}
