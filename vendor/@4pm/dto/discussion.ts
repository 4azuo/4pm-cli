/**
 * User discussions: the repo file format of `.4pm/discussions/<DSC-ID>.md` (front matter +
 * one block per message, stable ids), its serializer / parser shared by the server (render, reconcile) and
 * the API DTOs of Content ▸ Discussions. Front-matter values are JSON (valid YAML) so the file stays
 * readable and parses without a YAML library. `tags` / `due` / `mentions` / `issues` are written only when set, so older
 * files keep their bytes.
 * @adr 0454 @adr 0543 @adr 0545
 */
import { z } from "zod";
import { TAG_CODE_RE, TAGS_PER_ITEM_MAX } from "@4pm/constants";
import { isValidDue } from "./book-meta";
import { ISSUE_REF_RE } from "./issue-sync";

/** Repo folder of the discussion files (on the books branch). */
export const DISCUSSIONS_DIR = ".4pm/discussions";

/** `DSC-YYYYMMDD-NNNN`. */
export const DISCUSSION_CODE_RE = /^DSC-\d{8}-\d{4}$/;

/** The repo path of a discussion file. */
export function discussionPath(code: string): string {
  return `${DISCUSSIONS_DIR}/${code}.md`;
}

/** Who wrote something: a customer or an internal member. */
export type DiscussionAuthorKind = "client" | "member";

/** One message as stored in the file. */
export interface DiscussionFileMessage {
  id: string;
  by: string;
  label: string;
  kind: DiscussionAuthorKind;
  at: string;
  body: string;
  edited?: string;
  deleted?: string;
}

/** A whole discussion file. */
export interface DiscussionFile {
  code: string;
  title: string;
  team: string;
  links: string[];
  status: "open" | "resolved";
  author: { id: string; label: string; kind: DiscussionAuthorKind };
  createdAt: string;
  /** Tag codes (empty = none). */
  tags: string[];
  /** Due date `YYYY-MM-DD` (null = none). */
  due: string | null;
  /** Users @mentioned in any message (empty = none). */
  mentions: string[];
  /** Linked issue refs (link-only — ADR-0546). */
  issues: string[];
  resolvedBy: string | null;
  resolvedAt: string | null;
  messages: DiscussionFileMessage[];
}

/** Message marker line: `<!-- msg id=… by=… kind=… at=… label="…" [edited=…] [deleted=…] -->`. */
const MSG_RE = /^<!-- msg (.+) -->$/;

/** Render a discussion file (deterministic — the same state always gives the same bytes). */
export function renderDiscussionFile(d: DiscussionFile): string {
  const fm = [
    "---",
    `id: ${JSON.stringify(d.code)}`,
    `title: ${JSON.stringify(d.title)}`,
    `team: ${JSON.stringify(d.team)}`,
    `links: ${JSON.stringify(d.links)}`,
    `status: ${JSON.stringify(d.status)}`,
    `author: ${JSON.stringify(d.author)}`,
    `createdAt: ${JSON.stringify(d.createdAt)}`,
    `resolvedBy: ${JSON.stringify(d.resolvedBy)}`,
    `resolvedAt: ${JSON.stringify(d.resolvedAt)}`,
    ...(d.tags.length ? [`tags: ${JSON.stringify(d.tags)}`] : []),
    ...(d.due ? [`due: ${JSON.stringify(d.due)}`] : []),
    ...(d.mentions.length ? [`mentions: ${JSON.stringify(d.mentions)}`] : []),
    ...(d.issues.length ? [`issues: ${JSON.stringify(d.issues)}`] : []),
    "---",
  ];
  const blocks = d.messages.map((m) => {
    const attrs = [
      `id=${m.id}`,
      `by=${m.by}`,
      `kind=${m.kind}`,
      `at=${m.at}`,
      `label=${JSON.stringify(m.label)}`,
      ...(m.edited ? [`edited=${m.edited}`] : []),
      ...(m.deleted ? [`deleted=${m.deleted}`] : []),
    ];
    const body = m.deleted ? "" : m.body.replace(/\r\n/g, "\n").replace(/<!-- msg /g, "<!--  msg ").trim();
    return `<!-- msg ${attrs.join(" ")} -->\n${body}`;
  });
  return `${fm.join("\n")}\n\n${blocks.join("\n\n")}\n`;
}

/** Parse the `key=value` attributes of a marker (a value is a token or a JSON string). */
function parseAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[2]!;
    try {
      out[m[1]!] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
    } catch {
      out[m[1]!] = raw;
    }
  }
  return out;
}

/** Parse a discussion file; null when it is not one (no front matter / no id). */
export function parseDiscussionFile(text: string): DiscussionFile | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const fm: Record<string, unknown> = {};
  for (const l of lines.slice(1, end)) {
    const m = /^(\w+):\s*(.*)$/.exec(l);
    if (!m) continue;
    try {
      fm[m[1]!] = JSON.parse(m[2]!);
    } catch {
      fm[m[1]!] = m[2];
    }
  }
  const code = typeof fm.id === "string" ? fm.id : "";
  if (!DISCUSSION_CODE_RE.test(code)) return null;
  const author = (fm.author ?? {}) as { id?: string; label?: string; kind?: string };
  const messages: DiscussionFileMessage[] = [];
  let cur: DiscussionFileMessage | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (cur) messages.push({ ...cur, body: cur.deleted ? "" : body.join("\n").trim() });
    body = [];
  };
  for (const l of lines.slice(end + 1)) {
    const m = MSG_RE.exec(l.trim());
    if (m) {
      flush();
      const a = parseAttrs(m[1]!);
      cur = {
        id: a.id ?? "",
        by: a.by ?? "",
        label: a.label ?? "",
        kind: a.kind === "client" ? "client" : "member",
        at: a.at ?? "",
        body: "",
        ...(a.edited ? { edited: a.edited } : {}),
        ...(a.deleted ? { deleted: a.deleted } : {}),
      };
    } else if (cur) body.push(l);
  }
  flush();
  return {
    code,
    title: typeof fm.title === "string" ? fm.title : "",
    team: typeof fm.team === "string" ? fm.team : "",
    links: Array.isArray(fm.links) ? fm.links.filter((x): x is string => typeof x === "string") : [],
    status: fm.status === "resolved" ? "resolved" : "open",
    author: { id: author.id ?? "", label: author.label ?? "", kind: author.kind === "client" ? "client" : "member" },
    createdAt: typeof fm.createdAt === "string" ? fm.createdAt : "",
    resolvedBy: typeof fm.resolvedBy === "string" ? fm.resolvedBy : null,
    resolvedAt: typeof fm.resolvedAt === "string" ? fm.resolvedAt : null,
    tags: Array.isArray(fm.tags) ? fm.tags.filter((x): x is string => typeof x === "string" && TAG_CODE_RE.test(x)) : [],
    due: typeof fm.due === "string" && isValidDue(fm.due) ? fm.due : null,
    mentions: Array.isArray(fm.mentions) ? fm.mentions.filter((x): x is string => typeof x === "string").slice(0, 200) : [],
    issues: Array.isArray(fm.issues) ? fm.issues.filter((x): x is string => typeof x === "string" && ISSUE_REF_RE.test(x)).slice(0, 10) : [],
    messages: messages.filter((x) => x.id),
  };
}

// ── API ──────────────────────────────────────────────────────────────────────────────────────────

/** A message as the web shows it. */
export interface DiscussionMessageResponse {
  id: string;
  authorId: string;
  authorName: string;
  authorKind: DiscussionAuthorKind;
  body: string;
  at: string;
  editedAt: string | null;
  deleted: boolean;
  /** Not yet committed to the repo. */
  syncing: boolean;
}

/** A discussion summary (list row). */
export interface DiscussionSummary {
  id: string;
  code: string;
  title: string;
  team: string;
  links: string[];
  /** Tag codes. @adr 0543 */
  tags: string[];
  /** Due date `YYYY-MM-DD`, or null. */
  due: string | null;
  /** Linked issue refs. */
  issues: string[];
  status: "open" | "resolved";
  /** The repo says resolved but nobody confirmed it in the web (doesn't count for the approval gate). */
  resolvedInRepo: boolean;
  authorId: string;
  authorName: string;
  authorKind: DiscussionAuthorKind;
  messageCount: number;
  lastActivityAt: string;
  createdAt: string;
  resolvedByName: string | null;
  resolvedAt: string | null;
  /** Changes not yet saved to the repo. */
  pendingOps: number;
  /** The caller may resolve / reopen it. */
  canResolve: boolean;
  /** The caller may edit its title / team / links / tags / due. */
  canEditMeta: boolean;
}

/** One discussion with its messages. */
export interface DiscussionDetail extends DiscussionSummary {
  messages: DiscussionMessageResponse[];
  addresseeIds: string[];
  participantIds: string[];
}

/** Repo sync state of a project's discussions. */
export interface DiscussionSyncState {
  pending: number;
  failed: number;
  lastError: string | null;
  lastCommitAt: string | null;
}

/** GET /projects/:id/discussions. @api project-0108 */
export interface DiscussionListResponse {
  items: DiscussionSummary[];
  sync: DiscussionSyncState;
}

/** Query GET /projects/:id/discussions. */
export const listDiscussionsQuerySchema = z.object({
  status: z.enum(["open", "resolved"]).optional(),
  rowId: z.string().min(1).max(64).optional(),
});
export type ListDiscussionsQuery = z.infer<typeof listDiscussionsQuerySchema>;

/** Tag codes of a discussion (catalog codes; the server checks them against the project's tags). */
const discussionTags = z.array(z.string().trim().toLowerCase().regex(TAG_CODE_RE)).max(TAGS_PER_ITEM_MAX);
/** Linked issue refs of a discussion. */
const discussionIssues = z.array(z.string().trim().regex(ISSUE_REF_RE)).max(10);
/** A due date `YYYY-MM-DD` (null clears it). */
const discussionDue = z.string().refine(isValidDue, { message: "invalid date" }).nullable();

/** Body POST /projects/:id/discussions — open a discussion. @api project-0110 */
export const createDiscussionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  team: z.string().max(16).default(""),
  links: z.array(z.string().regex(/^(REQ|TSK|DOC|QA)-[\w-]+$/)).max(20).default([]),
  addresseeUserIds: z.array(z.string().guid()).max(50).default([]),
  addresseeTeamIds: z.array(z.string().guid()).max(20).default([]),
  tags: discussionTags.default([]),
  due: discussionDue.default(null),
  issues: discussionIssues.default([]),
});
export type CreateDiscussionRequest = z.infer<typeof createDiscussionSchema>;

/** Body POST /projects/:id/discussions/:discussionId/messages. @api project-0111 */
export const postDiscussionMessageSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  mentionUserIds: z.array(z.string().guid()).max(20).default([]),
});
export type PostDiscussionMessageRequest = z.infer<typeof postDiscussionMessageSchema>;

/** Body PATCH /projects/:id/discussions/:discussionId/messages/:messageId — edit (or `deleted: true`). @api project-0112 */
export const editDiscussionMessageSchema = z.object({
  body: z.string().trim().min(1).max(20_000).optional(),
  deleted: z.boolean().optional(),
  /** The people @mentioned in the edited body; those not mentioned before are added and told (ADR-0585). */
  mentionUserIds: z.array(z.string().guid()).max(20).optional(),
});
export type EditDiscussionMessageRequest = z.infer<typeof editDiscussionMessageSchema>;

/** Body PATCH /projects/:id/discussions/:discussionId — title / team / links / tags / due / addressees / status. @api project-0113 */
export const updateDiscussionSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  team: z.string().max(16).optional(),
  links: z.array(z.string().regex(/^(REQ|TSK|DOC|QA)-[\w-]+$/)).max(20).optional(),
  tags: discussionTags.optional(),
  due: discussionDue.optional(),
  issues: discussionIssues.optional(),
  /** The full addressee list (replaces the current one — ADR-0585). */
  addresseeUserIds: z.array(z.string().guid()).max(50).optional(),
  status: z.enum(["open", "resolved"]).optional(),
});
export type UpdateDiscussionRequest = z.infer<typeof updateDiscussionSchema>;

/** Body POST /projects/:id/discussions/sync — ADMIN/PM recovery. @api project-0114 */
export const discussionSyncActionSchema = z.object({ action: z.enum(["rebuildFromRepo", "repushFromJournal", "flushNow"]) });
export type DiscussionSyncAction = z.infer<typeof discussionSyncActionSchema>;
