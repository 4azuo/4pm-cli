/**
 * Vendored from @4pm/dto (autonomous-pointers.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { SIDECAR_DIR, type DeliveryState } from "./autonomous-books-set";
export const POINTERS_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.pointers.json`;
export interface SubmodulePr {
    dir: string;
    url: string;
    branch: string;
    base: string;
    prUrl?: string;
    state: DeliveryState;
    sha?: string;
    pointed?: boolean;
}
export interface PointerEntry {
    id: string;
    url?: string;
    base: string;
    subs: SubmodulePr[];
    ready?: boolean;
    merge?: "merged" | "auto";
    alerted?: string[];
}
export type PointersSidecar = Record<string, PointerEntry>;
const STATES: readonly DeliveryState[] = ["open", "merged", "closed", "direct"];
function parseSub(v: unknown): SubmodulePr | null {
    if (!v || typeof v !== "object")
        return null;
    const o = v as Partial<SubmodulePr>;
    if (typeof o.dir !== "string" || !o.dir || typeof o.branch !== "string" || !o.branch || typeof o.base !== "string" || typeof o.url !== "string")
        return null;
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
export function parsePointers(text: string | null | undefined): PointersSidecar {
    try {
        const o = JSON.parse(text || "{}") as unknown;
        if (!o || typeof o !== "object" || Array.isArray(o))
            return {};
        const out: PointersSidecar = {};
        for (const [branch, v] of Object.entries(o as Record<string, unknown>)) {
            if (!v || typeof v !== "object")
                continue;
            const e = v as Partial<PointerEntry>;
            if (typeof e.id !== "string" || typeof e.base !== "string" || !Array.isArray(e.subs))
                continue;
            const subs = e.subs.map(parseSub).filter((s): s is SubmodulePr => s !== null);
            if (!subs.length)
                continue;
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
    }
    catch {
        return {};
    }
}
export function submoduleOf<T extends {
    dir: string;
}>(subs: readonly T[], path: string): T | null {
    let best: T | null = null;
    for (const s of subs) {
        if (!s.dir || !path.startsWith(`${s.dir}/`))
            continue;
        if (!best || s.dir.length > best.dir.length)
            best = s;
    }
    return best;
}
