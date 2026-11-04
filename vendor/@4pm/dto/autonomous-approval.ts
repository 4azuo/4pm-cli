/**
 * Vendored from @4pm/dto (autonomous-approval.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export const APPROVAL_PAYLOAD_VERSION = "4pm-approval:v1";
export const APPROVAL_CONTENT_COLUMNS: Readonly<Record<"REQ-" | "QA-" | "TSK-" | "DOC-", readonly string[]>> = {
    "REQ-": ["Request"],
    "QA-": ["Original request", "Question / options", "Answer"],
    "TSK-": ["Task description"],
    "DOC-": ["Task description"],
};
export function approvalContentColumns(rowId: string): readonly string[] | null {
    for (const [prefix, cols] of Object.entries(APPROVAL_CONTENT_COLUMNS)) {
        if (rowId.startsWith(prefix))
            return cols;
    }
    return null;
}
function splitRow(line: string): string[] {
    const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
function tables(md: string): {
    header: string[];
    rows: string[][];
}[] {
    const lines = md.split("\n");
    const out: {
        header: string[];
        rows: string[][];
    }[] = [];
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
                if (cells.some((c) => c.length > 0))
                    rows.push(cells);
                j++;
            }
            out.push({ header, rows });
            i = j;
        }
        else
            i++;
    }
    return out;
}
export function approvalRowCanonical(markdown: string, rowId: string): string | null {
    const cols = approvalContentColumns(rowId);
    if (!cols)
        return null;
    for (const t of tables(markdown)) {
        const lower = t.header.map((h) => h.toLowerCase());
        const idCol = lower.indexOf("id");
        const idx = cols.map((c) => lower.indexOf(c.toLowerCase()));
        if (idCol < 0 || idx.some((k) => k < 0))
            continue;
        const row = t.rows.find((r) => (r[idCol] ?? "") === rowId);
        if (!row)
            continue;
        const teamCol = lower.indexOf("team");
        const team = teamCol >= 0 ? (row[teamCol] ?? "").trim() : "";
        return [rowId, ...idx.map((k) => (row[k] ?? "").replace(/\s+/g, " ").trim()), ...(team ? [`team:${team}`] : [])].join("\u0001");
    }
    return null;
}
export function bookRowTeam(markdown: string, rowId: string): string {
    for (const t of tables(markdown)) {
        const lower = t.header.map((h) => h.toLowerCase());
        const idCol = lower.indexOf("id");
        if (idCol < 0)
            continue;
        const row = t.rows.find((r) => (r[idCol] ?? "") === rowId);
        if (!row)
            continue;
        const teamCol = lower.indexOf("team");
        return teamCol >= 0 ? (row[teamCol] ?? "").trim() : "";
    }
    return "";
}
export function bookRowsById(markdown: string): Map<string, {
    team: string;
    cells: Record<string, string>;
}> {
    const out = new Map<string, {
        team: string;
        cells: Record<string, string>;
    }>();
    for (const t of tables(markdown)) {
        const lower = t.header.map((h) => h.toLowerCase());
        const idCol = lower.indexOf("id");
        if (idCol < 0)
            continue;
        for (const r of t.rows) {
            const id = (r[idCol] ?? "").trim();
            if (!id || out.has(id))
                continue;
            const cells: Record<string, string> = {};
            lower.forEach((h, k) => (cells[h] = (r[k] ?? "").trim()));
            out.set(id, { team: (cells.team ?? "").trim(), cells });
        }
    }
    return out;
}
export const APPROVAL_PARTY_PAYLOAD_VERSION = "4pm-approval-party:v1";
export const APPROVAL_GROUPS = ["teamLead", "designated", "client", "member"] as const;
export type ApprovalGroup = (typeof APPROVAL_GROUPS)[number];
export function approvalPartySigningPayload(p: {
    projectId: string;
    rowId: string;
    by: string;
    at: string;
    h: string;
    group: ApprovalGroup;
}): string {
    return [APPROVAL_PARTY_PAYLOAD_VERSION, p.projectId, p.rowId, p.by, p.at, p.h, p.group].join("|");
}
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
export function approvalSigningPayload(p: {
    projectId: string;
    rowId: string;
    by: string;
    at: string;
    h: string;
}): string {
    return [APPROVAL_PAYLOAD_VERSION, p.projectId, p.rowId, p.by, p.at, p.h].join("|");
}
export const approvalEntrySchema = z.object({
    approved: z.literal(true),
    by: z.string().min(1),
    byLabel: z.string().optional(),
    at: z.string().min(1),
    h: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    kid: z.string().min(1).max(64).optional(),
    sig: z.string().regex(/^ed25519:[A-Za-z0-9+/=]+$/).optional(),
});
export type ApprovalEntry = z.infer<typeof approvalEntrySchema>;
export interface ApprovalPublicKey {
    kid: string;
    publicKey: string;
}
export type ApprovalState = "approved" | "unsigned" | "invalid" | "stale";
