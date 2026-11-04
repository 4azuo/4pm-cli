/**
 * Vendored from @4pm/dto (autonomous-delivery.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { SIDECAR_DIR, type DeliveryState } from "./autonomous-books-set";
export const DELIVERY_SIDECAR_REL = `${SIDECAR_DIR}/.autonomous.delivery.json`;
export type DoneFileStatus = "A" | "M" | "D" | "R";
export interface DoneFile {
    path: string;
    status: DoneFileStatus;
}
export interface DeliveryRepo {
    dir: string;
    url: string;
    branch: string;
    base: string;
    baseSha?: string;
    headSha?: string;
    pr?: string;
    state: DeliveryState;
    conflict?: boolean;
    mergeSha?: string;
    files: DoneFile[];
}
export interface DoneDelivery {
    repos: DeliveryRepo[];
    remarks?: string[];
    seeded?: boolean;
}
export type DeliverySidecar = Record<string, DoneDelivery>;
const STATES: readonly DeliveryState[] = ["open", "merged", "closed", "direct"];
const SHA = /^[0-9a-f]{7,40}$/;
const STATUSES: readonly DoneFileStatus[] = ["A", "M", "D", "R"];
function parseRepo(v: unknown): DeliveryRepo | null {
    if (!v || typeof v !== "object")
        return null;
    const o = v as Partial<DeliveryRepo>;
    if (typeof o.dir !== "string" || !o.dir || typeof o.branch !== "string" || typeof o.base !== "string")
        return null;
    const files = Array.isArray(o.files)
        ? o.files.flatMap((f) => f && typeof f === "object" && typeof (f as DoneFile).path === "string" && (f as DoneFile).path
            ? [{ path: (f as DoneFile).path, status: STATUSES.includes((f as DoneFile).status) ? (f as DoneFile).status : ("M" as const) }]
            : [])
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
export function parseDeliverySidecar(text: string | null | undefined): DeliverySidecar {
    try {
        const o = JSON.parse(text || "{}") as unknown;
        if (!o || typeof o !== "object" || Array.isArray(o))
            return {};
        const out: DeliverySidecar = {};
        for (const [id, v] of Object.entries(o as Record<string, unknown>)) {
            if (!v || typeof v !== "object" || !Array.isArray((v as DoneDelivery).repos))
                continue;
            const e = v as Partial<DoneDelivery>;
            const repos = (e.repos ?? []).map(parseRepo).filter((r): r is DeliveryRepo => r !== null);
            if (!repos.length)
                continue;
            out[id] = {
                repos,
                ...(Array.isArray(e.remarks) ? { remarks: e.remarks.filter((r): r is string => typeof r === "string" && r !== "") } : {}),
                ...(e.seeded === true ? { seeded: true } : {}),
            };
        }
        return out;
    }
    catch {
        return {};
    }
}
export function serializeDeliverySidecar(s: DeliverySidecar): string {
    const sorted: DeliverySidecar = {};
    for (const id of Object.keys(s).sort())
        sorted[id] = s[id]!;
    return `${JSON.stringify(sorted, null, 2)}\n`;
}
export function deliverySettled(d: DoneDelivery): boolean {
    return d.repos.every((r) => r.state !== "open");
}
export interface NotesSubmodule {
    dir: string;
    pr?: string;
    mergedSha?: string;
    branch?: string;
}
export interface ParsedDoneNotes {
    branch?: string;
    pr?: string;
    mergedSha?: string;
    mergedInto?: string;
    submodules: NotesSubmodule[];
    conflict?: {
        base: string;
        repos: string[];
    };
    remarks: string[];
}
const URL_RE = /^https?:\/\/\S+$/;
export function parseDoneNotes(notes: string | null | undefined): ParsedDoneNotes {
    const out: ParsedDoneNotes = { submodules: [], remarks: [] };
    for (const raw of (notes ?? "").split(/;\s*/)) {
        const seg = raw.trim();
        if (!seg)
            continue;
        let m: RegExpExecArray | null;
        if ((m = /^branch:\s*(\S+)$/.exec(seg)))
            out.branch = m[1];
        else if ((m = /^PR:\s*(\S+)$/.exec(seg))) {
            if (URL_RE.test(m[1]!))
                out.pr = m[1];
            else
                out.remarks.push(seg);
        }
        else if ((m = /^merged into (\S+):\s*([0-9a-f]{7,40})$/.exec(seg))) {
            out.mergedInto = m[1];
            out.mergedSha = m[2];
        }
        else if ((m = /^submodules:\s*(.+)$/.exec(seg))) {
            for (const part of m[1]!.split(/,\s*/)) {
                const s = /^([^:\s]+):\s*(.+)$/.exec(part.trim());
                if (!s)
                    continue;
                const dir = s[1]!;
                const v = s[2]!.trim();
                const merged = /^merged\s+([0-9a-f]{7,40})$/.exec(v);
                out.submodules.push(merged ? { dir, mergedSha: merged[1] } : URL_RE.test(v) ? { dir, pr: v } : { dir, branch: v });
            }
        }
        else if ((m = /^PR conflicts with (\S+) \(([^)]*)\)$/.exec(seg))) {
            out.conflict = { base: m[1]!, repos: m[2]!.split(/,\s*/).filter(Boolean) };
        }
        else
            out.remarks.push(seg);
    }
    return out;
}
