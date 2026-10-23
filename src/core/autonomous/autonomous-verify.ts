/**
 * Automatic AI Verify (Rigor · Full power): the same read-only verify prompts as the books' AI menu (`web.verify` on
 * the rows an intake just published, `web.verifyDone` on a row that just reached AI_DONE), answered one line per row
 * and written to the book's `AI verify` column — a column outside the approval hash, so it never touches an
 * approval. Follow-up proposals of the done-verify are kept in the verdict cell for a person to act on. Informational:
 * a failed or empty run changes nothing and never blocks.
 * @adr 0608 @arch 0065
 */
import { findTables, replaceRows, type MdTable } from "./autonomous-books";

/** The literal column header that holds AI-verify answers (same as the web grids). */
export const VERIFY_COL = "AI verify";

/** The question of the automatic book verify. */
export const AUTO_VERIFY_QUESTION =
  "Is this entry clear, consistent with the other entries and the project, and implementable as written? Name any gap, contradiction or risk; answer OK when there is none.";

/** The question of the automatic done verify. */
export const AUTO_VERIFY_DONE_QUESTION =
  "Was the task delivered as described, with tests? Name missing parts, bugs or risks; answer OK when there is none.";

/** The table holding `ids` (the first table with an ID column that has one of them). */
function tableOf(md: string, ids: ReadonlySet<string>): MdTable | null {
  for (const t of findTables(md)) {
    const idc = t.header.findIndex((h) => h.toLowerCase() === "id");
    if (idc >= 0 && t.rows.some((r) => ids.has((r[idc] ?? "").trim()))) return t;
  }
  return null;
}

/** `[<ID>] Header: value · …` per row (empty cells and the verify column skipped). */
export function verifyEntries(md: string, ids: readonly string[]): string {
  const wanted = new Set(ids);
  const t = tableOf(md, wanted);
  if (!t) return "";
  const idc = t.header.findIndex((h) => h.toLowerCase() === "id");
  return t.rows
    .filter((r) => wanted.has((r[idc] ?? "").trim()))
    .map((r) => {
      const text = t.header
        .map((h, i) => ({ h, v: (r[i] ?? "").trim() }))
        .filter(({ h, v }) => v && h.toLowerCase() !== "id" && h.toLowerCase() !== VERIFY_COL.toLowerCase())
        .map(({ h, v }) => `${h}: ${v}`)
        .join(" · ");
      return `[${(r[idc] ?? "").trim()}] ${text}`;
    })
    .join("\n");
}

/** Parse `[<ID>] answer` lines (and `FOLLOWUP [<ID>] text` lines, appended to that row's answer) for `ids`. */
export function parseVerifyAnswers(out: string, ids: readonly string[]): Record<string, string> {
  const wanted = new Set(ids);
  const answers: Record<string, string> = {};
  const followUps: Record<string, string[]> = {};
  for (const line of out.split("\n")) {
    const f = /^\s*FOLLOWUP\s*\[([^\]]+)\]\s*(.+)$/i.exec(line);
    if (f && wanted.has(f[1]!.trim())) {
      (followUps[f[1]!.trim()] ??= []).push(f[2]!.trim());
      continue;
    }
    const m = /^\s*\[([^\]]+)\]\s*(.+)$/.exec(line);
    if (m && wanted.has(m[1]!.trim()) && answers[m[1]!.trim()] === undefined) answers[m[1]!.trim()] = m[2]!.trim();
  }
  for (const [id, list] of Object.entries(followUps)) {
    answers[id] = `${answers[id] ?? ""}${answers[id] ? " — " : ""}follow-up: ${list.join("; ")}`;
  }
  for (const id of Object.keys(answers)) answers[id] = `🤖 ${answers[id]!}`.slice(0, 600);
  return answers;
}

/** Write `answers` into the `AI verify` column (added once when absent) of the table holding them. */
export function applyVerifyAnswers(md: string, answers: Record<string, string>): string {
  const ids = Object.keys(answers);
  if (!ids.length) return md;
  const t = tableOf(md, new Set(ids));
  if (!t) return md;
  let header = t.header;
  let vc = header.findIndex((h) => h.toLowerCase() === VERIFY_COL.toLowerCase());
  if (vc < 0) {
    header = [...header, VERIFY_COL];
    vc = header.length - 1;
  }
  const idc = header.findIndex((h) => h.toLowerCase() === "id");
  const rows = t.rows.map((r) => {
    const next = [...r];
    while (next.length < header.length) next.push("");
    const ans = answers[(next[idc] ?? "").trim()];
    if (ans) next[vc] = ans;
    return next;
  });
  return replaceRows(md, { ...t, header }, rows);
}
