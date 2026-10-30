/**
 * A small unified diff for flow-map save previews: the common head / tail lines are kept as context and the middle is
 * shown as removed + added lines (the edits are header insertions or whole new files, so this stays exact enough
 * without an LCS). Capped so a huge file never floods the preview.
 * @adr 0698
 */

/** Context lines around the change. */
const CONTEXT = 3;
/** Most lines of one diff body. */
const MAX_LINES = 400;

/** A unified diff of `path` from `before` (null = new file) to `after`. Empty string when nothing changed. */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  if (before === after) return "";
  const a = before === null ? [] : before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const from = Math.max(0, head - CONTEXT);
  const aEnd = a.length - tail;
  const bEnd = b.length - tail;
  const ctxAfter = Math.min(tail, CONTEXT);
  const body: string[] = [];
  for (let i = from; i < head; i++) body.push(` ${a[i]}`);
  for (let i = head; i < aEnd; i++) body.push(`-${a[i]}`);
  for (let i = head; i < bEnd; i++) body.push(`+${b[i]}`);
  for (let i = aEnd; i < aEnd + ctxAfter; i++) body.push(` ${a[i]}`);
  const oldLen = aEnd - from + ctxAfter;
  const newLen = bEnd - from + ctxAfter;
  const header = [before === null ? "--- /dev/null" : `--- a/${path}`, `+++ b/${path}`, `@@ -${before === null ? 0 : from + 1},${before === null ? 0 : oldLen} +${from + 1},${newLen} @@`];
  const shown = body.length > MAX_LINES ? [...body.slice(0, MAX_LINES), `… ${body.length - MAX_LINES} more lines`] : body;
  return [...header, ...shown].join("\n");
}
