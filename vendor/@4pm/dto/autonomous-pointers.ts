/**
 * The submodule pointers sidecar: for each root branch delivered as a PR while its submodule PRs were open, the
 * submodule PRs it waits for. The cli moves each pointer to the submodule merge once that PR merges, turns the draft
 * root PR ready, and merges a root PR that only moves pointers.
 * @adr 0579
 */
import { SIDECAR_DIR, type DeliveryState } from "./autonomous-books-set";

/** The pointers sidecar path. */
export const POINTERS_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.pointers.json`;

/** One submodule PR a root PR waits for. */
export interface SubmodulePr {
  /** The submodule folder. */
  dir: string;
  /** The submodule's clone url. */
  url: string;
  /** Its head branch and base. */
  branch: string;
  base: string;
  /** The PR link (absent when the host CLI gave none). */
  prUrl?: string;
  state: DeliveryState;
  /** The commit the merge produced on the submodule's base (set once merged). */
  sha?: string;
  /** True once the root branch points at `sha`. */
  pointed?: boolean;
}

/** One root PR waiting for its submodule PRs. */
export interface PointerEntry {
  /** The row (`REQ-…` / `DOC-…` / `TSK-…`). */
  id: string;
  /** The root PR link. */
  url?: string;
  /** The root's base branch. */
  base: string;
  subs: SubmodulePr[];
  /** The draft was turned ready for review. */
  ready?: boolean;
  /** The cli merged the pointer-only root PR (`merged`) or turned on auto-merge (`auto`). */
  merge?: "merged" | "auto";
  /** Alerts already sent for this entry (`submodule-pr-closed:<dir>`, `pointer-pr-needs-merge`). */
  alerted?: string[];
}

/** The pointers sidecar: root branch → entry. */
export type PointersSidecar = Record<string, PointerEntry>;

const STATES: readonly DeliveryState[] = ["open", "merged", "closed", "direct"];

/** Parse one stored submodule PR (null when invalid). */
function parseSub(v: unknown): SubmodulePr | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<SubmodulePr>;
  if (typeof o.dir !== "string" || !o.dir || typeof o.branch !== "string" || !o.branch || typeof o.base !== "string" || typeof o.url !== "string") return null;
  return {
    dir: o.dir,
    url: o.url,
    branch: o.branch,
    base: o.base,
    state: o.state && STATES.includes(o.state) ? o.state : "open",
    ...(typeof o.prUrl === "string" && o.prUrl ? { prUrl: o.prUrl } : {}),
    ...(typeof o.sha === "string" && /^[0-9a-f]{40}$/.test(o.sha) ? { sha: o.sha } : {}),
    ...(o.pointed === true ? { pointed: true } : {}),
  };
}

/** Parse the pointers sidecar text (`{}` on anything invalid). */
export function parsePointers(text: string | null | undefined): PointersSidecar {
  try {
    const o = JSON.parse(text || "{}") as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: PointersSidecar = {};
    for (const [branch, v] of Object.entries(o as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const e = v as Partial<PointerEntry>;
      if (typeof e.id !== "string" || typeof e.base !== "string" || !Array.isArray(e.subs)) continue;
      const subs = e.subs.map(parseSub).filter((s): s is SubmodulePr => s !== null);
      if (!subs.length) continue;
      out[branch] = {
        id: e.id,
        base: e.base,
        subs,
        ...(typeof e.url === "string" && e.url ? { url: e.url } : {}),
        ...(e.ready === true ? { ready: true } : {}),
        ...(e.merge === "merged" || e.merge === "auto" ? { merge: e.merge } : {}),
        ...(Array.isArray(e.alerted) ? { alerted: e.alerted.filter((a): a is string => typeof a === "string") } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The submodule folder that owns a root-relative path — the longest folder prefix — else null (the root). A gitlink
 * path itself (`docs`) belongs to the root.
 */
export function submoduleOf<T extends { dir: string }>(subs: readonly T[], path: string): T | null {
  let best: T | null = null;
  for (const s of subs) {
    if (!s.dir || !path.startsWith(`${s.dir}/`)) continue;
    if (!best || s.dir.length > best.dir.length) best = s;
  }
  return best;
}
