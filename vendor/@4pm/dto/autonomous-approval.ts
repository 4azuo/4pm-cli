/**
 * Signed autonomous approvals — the pure, shared half of the scheme: which cells of a book row an
 * approval binds to, the canonical row text both the server (signer) and the cli (verifier) hash, the
 * signed payload string, and the entry / public-key shapes. Hashing and Ed25519 live in each app
 * (`node:crypto`); this module stays isomorphic so the web can import the types.
 * @adr 0438
 */
import { z } from "zod";

/** Signed-payload version prefix (bump only with a new payload layout). */
export const APPROVAL_PAYLOAD_VERSION = "4pm-approval:v1";

/**
 * The content cells an approval binds to, by row-id prefix. Cells the cli edits itself after approval
 * (`Group`, `Depends`, `Notes`, `Priority`, `Tag`, files) are left out on purpose — a question adds a
 * `Depends`, folding an answer appends to `Notes`, and neither may void the approval.
 */
export const APPROVAL_CONTENT_COLUMNS: Readonly<Record<"REQ-" | "QA-" | "TSK-", readonly string[]>> = {
  "REQ-": ["Request"],
  "QA-": ["Original request", "Question / options", "Answer"],
  "TSK-": ["Task description"],
};

/** The content columns for a row id, or null when the id is not an approvable book row. */
export function approvalContentColumns(rowId: string): readonly string[] | null {
  for (const [prefix, cols] of Object.entries(APPROVAL_CONTENT_COLUMNS)) {
    if (rowId.startsWith(prefix)) return cols;
  }
  return null;
}

/** Split one Markdown table line into cells (`\|` is a literal pipe inside a cell). */
function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Every Markdown table of a document as `{ header, rows }` (same rules as the cli's book parser). */
function tables(md: string): { header: string[]; rows: string[][] }[] {
  const lines = md.split("\n");
  const out: { header: string[]; rows: string[][] }[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!.trim();
    const next = lines[i + 1]?.trim() ?? "";
    if (l.startsWith("|") && /^\|[\s:|-]+\|?$/.test(next)) {
      const header = splitRow(l);
      let j = i + 2;
      const rows: string[][] = [];
      while (j < lines.length && lines[j]!.trim().startsWith("|")) {
        const cells = splitRow(lines[j]!);
        if (cells.some((c) => c.length > 0)) rows.push(cells);
        j++;
      }
      out.push({ header, rows });
      i = j;
    } else i++;
  }
  return out;
}

/**
 * The canonical text an approval of `rowId` binds to: the id plus its content cells (whitespace runs
 * collapsed), joined by U+0001 — plus `team:<code>` when the row has a non-empty `Team` cell (ADR-0450:
 * the approvers depend on the team, so moving a row voids its approval; an untagged row hashes as before).
 * Null when the book has no table with the id and every content column, or no such row. The caller hashes
 * it (`sha256:<hex>` = the entry's `h`).
 * @adr 0450
 */
export function approvalRowCanonical(markdown: string, rowId: string): string | null {
  const cols = approvalContentColumns(rowId);
  if (!cols) return null;
  for (const t of tables(markdown)) {
    const lower = t.header.map((h) => h.toLowerCase());
    const idCol = lower.indexOf("id");
    const idx = cols.map((c) => lower.indexOf(c.toLowerCase()));
    if (idCol < 0 || idx.some((k) => k < 0)) continue;
    const row = t.rows.find((r) => (r[idCol] ?? "") === rowId);
    if (!row) continue;
    const teamCol = lower.indexOf("team");
    const team = teamCol >= 0 ? (row[teamCol] ?? "").trim() : "";
    return [rowId, ...idx.map((k) => (row[k] ?? "").replace(/\s+/g, " ").trim()), ...(team ? [`team:${team}`] : [])].join("\u0001");
  }
  return null;
}

/** The `Team` cell of `rowId` in `markdown` ("" when untagged, absent or no such row). @adr 0450 */
export function bookRowTeam(markdown: string, rowId: string): string {
  for (const t of tables(markdown)) {
    const lower = t.header.map((h) => h.toLowerCase());
    const idCol = lower.indexOf("id");
    if (idCol < 0) continue;
    const row = t.rows.find((r) => (r[idCol] ?? "") === rowId);
    if (!row) continue;
    const teamCol = lower.indexOf("team");
    return teamCol >= 0 ? (row[teamCol] ?? "").trim() : "";
  }
  return "";
}

/**
 * Every row of a book's id-keyed tables: id → `{ team, cells }` (cells keyed by lower-cased header). Used
 * to diff a save (team / own-row / answer-only rules) on the server and the cli alike.
 * @adr 0450 @adr 0454
 */
export function bookRowsById(markdown: string): Map<string, { team: string; cells: Record<string, string> }> {
  const out = new Map<string, { team: string; cells: Record<string, string> }>();
  for (const t of tables(markdown)) {
    const lower = t.header.map((h) => h.toLowerCase());
    const idCol = lower.indexOf("id");
    if (idCol < 0) continue;
    for (const r of t.rows) {
      const id = (r[idCol] ?? "").trim();
      if (!id || out.has(id)) continue;
      const cells: Record<string, string> = {};
      lower.forEach((h, k) => (cells[h] = (r[k] ?? "").trim()));
      out.set(id, { team: (cells.team ?? "").trim(), cells });
    }
  }
  return out;
}

/** Signed-payload prefix of one party approval. @adr 0451 */
export const APPROVAL_PARTY_PAYLOAD_VERSION = "4pm-approval-party:v1";

/**
 * The approver groups of a project approval policy. `member` = an approver holding the book's approve
 * right who is in no required group (recorded, satisfies nothing).
 * @adr 0451
 */
export const APPROVAL_GROUPS = ["teamLead", "designated", "client", "member"] as const;
export type ApprovalGroup = (typeof APPROVAL_GROUPS)[number];

/** The exact string the server signs for one party approval. @adr 0451 */
export function approvalPartySigningPayload(p: { projectId: string; rowId: string; by: string; at: string; h: string; group: ApprovalGroup }): string {
  return [APPROVAL_PARTY_PAYLOAD_VERSION, p.projectId, p.rowId, p.by, p.at, p.h, p.group].join("|");
}

/** One party approval inside an approvals-file entry (`parties[]`). @adr 0451 */
export const approvalPartyEntrySchema = z.object({
  by: z.string().min(1),
  byLabel: z.string().optional(),
  group: z.enum(APPROVAL_GROUPS),
  at: z.string().min(1),
  h: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  kid: z.string().min(1).max(64).optional(),
  sig: z.string().regex(/^ed25519:[A-Za-z0-9+/=]+$/).optional(),
});
export type ApprovalPartyEntry = z.infer<typeof approvalPartyEntrySchema>;

/** The exact string the server signs for one approval (the projectId stops cross-project replay). */
export function approvalSigningPayload(p: { projectId: string; rowId: string; by: string; at: string; h: string }): string {
  return [APPROVAL_PAYLOAD_VERSION, p.projectId, p.rowId, p.by, p.at, p.h].join("|");
}

/** One entry of `.4pm/.autonomous.approvals.json` — signed by the server (an unsigned one, written before any signing key exists, lacks h/kid/sig). */
export const approvalEntrySchema = z.object({
  approved: z.literal(true),
  /** Stable userId of the approver (SoD key). */
  by: z.string().min(1),
  /** Display label (email/username). */
  byLabel: z.string().optional(),
  /** ISO time of the approval. */
  at: z.string().min(1),
  /** `sha256:<hex>` of {@link approvalRowCanonical} at approval time. */
  h: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  /** Signing key id. */
  kid: z.string().min(1).max(64).optional(),
  /** `ed25519:<base64>` signature over {@link approvalSigningPayload}. */
  sig: z.string().regex(/^ed25519:[A-Za-z0-9+/=]+$/).optional(),
});
export type ApprovalEntry = z.infer<typeof approvalEntrySchema>;

/** A server approval-signing public key pushed to the cli (`ws_token.approvalKeys`). */
export interface ApprovalPublicKey {
  kid: string;
  /** Ed25519 public key, SPKI DER, base64. */
  publicKey: string;
}

/**
 * Verification state of one row's approval, as `autonomous.read` reports it: `approved` (valid
 * signature, unchanged content), `unsigned` (no signing key yet), `invalid` (bad / unknown-key signature),
 * `stale` (content changed after approval). Ids without an entry are absent.
 */
export type ApprovalState = "approved" | "unsigned" | "invalid" | "stale";
