/**
 * Time-formatting helpers for the transcript. The cli stamps the AI-run start time on the
 * `aireq` marker (ADR-0249) using the org timezone carried by the ws_token (ADR-0132) — a rented
 * worker follows its renter's org — so the TUI and the web Console render the same instant.
 */

/**
 * Format a `Date` as a fixed `yyyy/MM/dd HH:mm:ss` string in the given IANA timezone (24-hour).
 * An invalid/unknown timezone falls back to the process' local zone rather than throwing.
 */
export function formatTimestampInZone(date: Date, timeZone: string): string {
  const build = (tz?: string): string => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      ...(tz ? { timeZone: tz } : {}),
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    // `en-CA` renders midnight as "24"; normalize it to "00" for a stable HH range.
    const hour = get("hour") === "24" ? "00" : get("hour");
    return `${get("year")}/${get("month")}/${get("day")} ${hour}:${get("minute")}:${get("second")}`;
  };
  try {
    return build(timeZone);
  } catch {
    return build();
  }
}
