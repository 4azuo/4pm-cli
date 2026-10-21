/**
 * The AI Done delivery record (books sidecar `.4pm/.autonomous.delivery.json`): per AI Done row, every repo the row
 * delivered — root and submodules — with its branch, base, shas, PR, live state, mergeability and full file list. The
 * cli writes it at delivery and keeps the states fresh on every tick; the web reads it for the AI Done Files modal and
 * the structured Notes. `parseDoneNotes` reads the older free-text Notes the same way (rows without a record).
 * @adr 0582
 */
import { SIDECAR_DIR, type DeliveryState } from "./autonomous-books-set";

/** The delivery sidecar path. */
export const DELIVERY_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.delivery.json`;

/** How a delivered file changed: added, modified, deleted, renamed. */
export type DoneFileStatus = "A" | "M" | "D" | "R";

/** One changed file of a delivered repo (root-relative path). */
export interface DoneFile {
  path: string;
  status: DoneFileStatus;
}

/** One repo of a delivery: `"."` = the root, else the submodule folder. */
export interface DeliveryRepo {
  dir: string;
  /** The repo's clone url (for PR lookups). */
  url: string;
  branch: string;
  base: string;
  /** The merge-base with `origin/<base>` at delivery (the "before" of the files). */
  baseSha?: string;
  /** The branch tip at delivery. */
  headSha?: string;
  /** The PR / MR link (absent for a direct merge). */
  pr?: string;
  state: DeliveryState;
  /** The open PR conflicts with its base (host mergeability; last known). */
  conflict?: boolean;
  /** The commit the merge produced on the base (once merged / merged directly). */
  mergeSha?: string;
  files: DoneFile[];
}

/** The delivery record of one AI Done row. */
export interface DoneDelivery {
  repos: DeliveryRepo[];
  /** Other delivery remarks (a direct merge that fell back to a PR, …). */
  remarks?: string[];
  /** Seeded from an older row's Notes (no shas / file lists). */
  seeded?: boolean;
}

/** The delivery sidecar: AI Done row id → record. */
export type DeliverySidecar = Record<string, DoneDelivery>;

const STATES: readonly DeliveryState[] = ["open", "merged", "closed", "direct"];
const SHA = /^[0-9a-f]{7,40}$/;
const STATUSES: readonly DoneFileStatus[] = ["A", "M", "D", "R"];

/** Parse one stored repo entry (null when invalid). */
function parseRepo(v: unknown): DeliveryRepo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<DeliveryRepo>;
  if (typeof o.dir !== "string" || !o.dir || typeof o.branch !== "string" || typeof o.base !== "string") return null;
  const files = Array.isArray(o.files)
    ? o.files.flatMap((f) =>
        f && typeof f === "object" && typeof (f as DoneFile).path === "string" && (f as DoneFile).path
          ? [{ path: (f as DoneFile).path, status: STATUSES.includes((f as DoneFile).status) ? (f as DoneFile).status : ("M" as const) }]
          : [],
      )
    : [];
  return {
    dir: o.dir,
    url: typeof o.url === "string" ? o.url : "",
    branch: o.branch,
    base: o.base,
    state: o.state && STATES.includes(o.state) ? o.state : "open",
    files,
    ...(typeof o.baseSha === "string" && SHA.test(o.baseSha) ? { baseSha: o.baseSha } : {}),
    ...(typeof o.headSha === "string" && SHA.test(o.headSha) ? { headSha: o.headSha } : {}),
    ...(typeof o.pr === "string" && o.pr ? { pr: o.pr } : {}),
    ...(o.conflict === true ? { conflict: true } : {}),
    ...(typeof o.mergeSha === "string" && SHA.test(o.mergeSha) ? { mergeSha: o.mergeSha } : {}),
  };
}

/** Parse the delivery sidecar text (`{}` on anything invalid; invalid entries are dropped). */
export function parseDeliverySidecar(text: string | null | undefined): DeliverySidecar {
  try {
    const o = JSON.parse(text || "{}") as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: DeliverySidecar = {};
    for (const [id, v] of Object.entries(o as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || !Array.isArray((v as DoneDelivery).repos)) continue;
      const e = v as Partial<DoneDelivery>;
      const repos = (e.repos ?? []).map(parseRepo).filter((r): r is DeliveryRepo => r !== null);
      if (!repos.length) continue;
      out[id] = {
        repos,
        ...(Array.isArray(e.remarks) ? { remarks: e.remarks.filter((r): r is string => typeof r === "string" && r !== "") } : {}),
        ...(e.seeded === true ? { seeded: true } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Serialize the sidecar (ids sorted, pretty). */
export function serializeDeliverySidecar(s: DeliverySidecar): string {
  const sorted: DeliverySidecar = {};
  for (const id of Object.keys(s).sort()) sorted[id] = s[id]!;
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** Is every repo of the record final (merged / closed / direct)? Then it is never looked up again. */
export function deliverySettled(d: DoneDelivery): boolean {
  return d.repos.every((r) => r.state !== "open");
}

// ── Notes text (rows without a record) ───────────────────────────────────────────────────────────

/** One submodule named in a Notes text. */
export interface NotesSubmodule {
  dir: string;
  /** Its PR link, when the Notes gave one. */
  pr?: string;
  /** Merged directly at this commit. */
  mergedSha?: string;
  /** A branch name instead of a PR link (the host CLI gave no link). */
  branch?: string;
}

/** What an AI Done Notes text says about its delivery. */
export interface ParsedDoneNotes {
  branch?: string;
  /** The root PR link. */
  pr?: string;
  /** The root merged directly at this commit (`merged into <base>: <sha>`). */
  mergedSha?: string;
  /** The base the direct merge went into. */
  mergedInto?: string;
  submodules: NotesSubmodule[];
  /** `PR conflicts with <base> (<repos>)`: the base and the repos (`.` = root). */
  conflict?: { base: string; repos: string[] };
  /** Everything else, verbatim. */
  remarks: string[];
}

const URL_RE = /^https?:\/\/\S+$/;

/**
 * Parse the `;`-joined Notes text the cli writes on an AI Done row (`branch: …; PR: …; submodules: dir: url, …;
 * PR conflicts with <base> (…)`, `merged into <base>: <sha>; …`). Unknown segments stay as remarks.
 */
export function parseDoneNotes(notes: string | null | undefined): ParsedDoneNotes {
  const out: ParsedDoneNotes = { submodules: [], remarks: [] };
  for (const raw of (notes ?? "").split(/;\s*/)) {
    const seg = raw.trim();
    if (!seg) continue;
    let m: RegExpExecArray | null;
    if ((m = /^branch:\s*(\S+)$/.exec(seg))) out.branch = m[1];
    else if ((m = /^PR:\s*(\S+)$/.exec(seg))) {
      if (URL_RE.test(m[1]!)) out.pr = m[1];
      else out.remarks.push(seg);
    } else if ((m = /^merged into (\S+):\s*([0-9a-f]{7,40})$/.exec(seg))) {
      out.mergedInto = m[1];
      out.mergedSha = m[2];
    } else if ((m = /^submodules:\s*(.+)$/.exec(seg))) {
      for (const part of m[1]!.split(/,\s*/)) {
        const s = /^([^:\s]+):\s*(.+)$/.exec(part.trim());
        if (!s) continue;
        const dir = s[1]!;
        const v = s[2]!.trim();
        const merged = /^merged\s+([0-9a-f]{7,40})$/.exec(v);
        out.submodules.push(merged ? { dir, mergedSha: merged[1] } : URL_RE.test(v) ? { dir, pr: v } : { dir, branch: v });
      }
    } else if ((m = /^PR conflicts with (\S+) \(([^)]*)\)$/.exec(seg))) {
      out.conflict = { base: m[1]!, repos: m[2]!.split(/,\s*/).filter(Boolean) };
    } else out.remarks.push(seg);
  }
  return out;
}
