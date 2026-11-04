/**
 * Vendored from @4pm/dto (time-zone.ts) by scripts/vendor-shared.mjs — do not edit.
 */
import { z } from "zod";
export function isValidTimeZone(tz: unknown): tz is string {
    if (typeof tz !== "string" || !tz || tz.length > 64)
        return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    }
    catch {
        return false;
    }
}
export const timeZoneSchema = z.string().trim().refine(isValidTimeZone, { message: "invalid time zone" });
export function readUserTimeZone(settings: Record<string, unknown> | null | undefined): string | null {
    const v = (settings ?? {})["timezone"];
    return isValidTimeZone(v) ? v : null;
}
export function effectiveTimeZone(own: string | null | undefined, org: string | null | undefined): string {
    if (isValidTimeZone(own))
        return own;
    if (isValidTimeZone(org))
        return org;
    return "UTC";
}
function zoneOffsetMs(tz: string, instant: number): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(new Date(instant));
    const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - (instant - (instant % 1000));
}
export function zonedDayStart(day: string, tz = "UTC"): Date | null {
    const guess = Date.parse(`${day}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(guess))
        return null;
    const zone = isValidTimeZone(tz) ? tz : "UTC";
    const first = zoneOffsetMs(zone, guess);
    let t = guess - first;
    const second = zoneOffsetMs(zone, t);
    if (second !== first)
        t = guess - second;
    return new Date(t);
}
export function zonedDayRange(from: string | undefined, to: string | undefined, tz = "UTC"): {
    gte?: Date;
    lt?: Date;
} {
    const out: {
        gte?: Date;
        lt?: Date;
    } = {};
    const start = from ? zonedDayStart(from, tz) : null;
    if (start)
        out.gte = start;
    if (to) {
        const next = new Date(Date.parse(`${to}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
        const end = zonedDayStart(next, tz);
        if (end)
            out.lt = end;
    }
    return out;
}
