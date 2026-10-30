/**
 * Flow-map back-refs — pure text edits that link a source file back to a saved flow map, in the graph standard:
 * a doc's Doc Header gets `flow.<slug>` under `refs.related`, a code file's header comment gets an `@flow <slug>`
 * line. A file without a header is never edited (the caller skips it). Each edit returns the new text, the same
 * text when the link is already there, or `null` when the file has no header to edit.
 * @adr 0698 @arch 0076
 */
import { parseCodeHeader } from "../../docs/doc-model";

/** The frontmatter block of a Markdown text: its line range (`start` = opening `---`, `end` = closing line). */
function frontmatter(lines: string[]): { start: number; end: number } | null {
  const first = (lines[0] ?? "").replace(/^\uFEFF/, "").trim();
  if (first !== "---") return null;
  for (let i = 1; i < Math.min(lines.length, 400); i++) {
    const t = (lines[i] ?? "").trim();
    if (t === "---" || t === "...") return { start: 0, end: i };
  }
  return null;
}

/** Leading spaces of a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Add `id` to `refs.related` of a Markdown Doc Header. */
export function addDocBackref(text: string, id: string): string | null {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const fm = frontmatter(lines);
  if (!fm) return null;
  const body = lines.slice(fm.start + 1, fm.end);
  const refsIdx = body.findIndex((l) => /^refs\s*:/.test(l));
  let out: string[];
  if (refsIdx < 0) {
    out = [...body, "refs:", "  related:", `    - ${id}`];
  } else {
    const refsLine = body[refsIdx]!;
    const inline = refsLine.replace(/^refs\s*:/, "").trim();
    if (inline && inline !== "{}") {
      // `refs: {related: [...]}` — a flow map inside a flow map is rare; append as a plain flow entry.
      if (inline.includes(id)) return text;
      return null;
    }
    // The block of `refs:` = the following lines indented deeper than it.
    let endRefs = refsIdx + 1;
    while (endRefs < body.length && (body[endRefs]!.trim() === "" || indentOf(body[endRefs]!) > 0)) endRefs++;
    const block = body.slice(refsIdx + 1, endRefs);
    const relIdx = block.findIndex((l) => /^\s+related\s*:/.test(l));
    if (relIdx < 0) {
      const ind = block.find((l) => l.trim())?.match(/^\s*/)?.[0] ?? "  ";
      const added = [`${ind}related:`, `${ind}  - ${id}`];
      out = [...body.slice(0, endRefs), ...added, ...body.slice(endRefs)];
      if (inline === "{}") out[refsIdx] = "refs:";
    } else {
      const relLine = block[relIdx]!;
      const relInd = indentOf(relLine);
      const value = relLine.replace(/^\s+related\s*:/, "").trim();
      if (value.startsWith("[")) {
        const items = value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (items.includes(id)) return text;
        const newBlock = [...block];
        newBlock[relIdx] = `${" ".repeat(relInd)}related: [${[...items, id].join(", ")}]`;
        out = [...body.slice(0, refsIdx + 1), ...newBlock, ...body.slice(endRefs)];
      } else if (value) {
        if (value === id) return text;
        const newBlock = [...block];
        newBlock[relIdx] = `${" ".repeat(relInd)}related: [${value}, ${id}]`;
        out = [...body.slice(0, refsIdx + 1), ...newBlock, ...body.slice(endRefs)];
      } else {
        let last = relIdx;
        const items: string[] = [];
        for (let i = relIdx + 1; i < block.length && (block[i]!.trim() === "" || indentOf(block[i]!) > relInd); i++) {
          if (block[i]!.trim().startsWith("-")) {
            items.push(block[i]!.trim().replace(/^-\s*/, "").replace(/\s+#.*$/, "").replace(/^["']|["']$/g, ""));
            last = i;
          }
        }
        if (items.includes(id)) return text;
        const itemInd = last > relIdx ? (block[last]!.match(/^\s*/)?.[0] ?? "") : " ".repeat(relInd + 2);
        const newBlock = [...block.slice(0, last + 1), `${itemInd}- ${id}`, ...block.slice(last + 1)];
        out = [...body.slice(0, refsIdx + 1), ...newBlock, ...body.slice(endRefs)];
      }
    }
  }
  return [...lines.slice(0, fm.start + 1), ...out, ...lines.slice(fm.end)].join(eol);
}

/** Add an `@flow <slug>` line to a source file's header comment. */
export function addCodeBackref(text: string, slug: string): string | null {
  if (!parseCodeHeader(text)) return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const tag = `@flow ${slug}`;
  const has = (from: number, to: number): boolean =>
    lines.slice(from, to + 1).some((l) => new RegExp(`@flow\\s+${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(l));
  // Skip a shebang / "use strict"-like line, then blank lines.
  let i = 0;
  if (lines[i]?.startsWith("#!")) i++;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (/^\s*"use [a-z]+";?\s*$/.test(lines[i] ?? "")) {
    i++;
    while (i < lines.length && lines[i]!.trim() === "") i++;
  }
  const first = lines[i] ?? "";
  if (/^\s*\/\*/.test(first)) {
    // Block comment: insert before the line holding `*/`.
    let end = i;
    while (end < lines.length && !lines[end]!.includes("*/")) end++;
    if (end >= lines.length) return null;
    if (has(i, end)) return text;
    if (end === i) {
      // One-line `/** text */` → expand.
      const inner = first.replace(/^\s*\/\*\*?\s?/, "").replace(/\s*\*\/\s*$/, "");
      const ind = first.match(/^\s*/)?.[0] ?? "";
      return [...lines.slice(0, i), `${ind}/**`, `${ind} * ${inner}`, `${ind} * ${tag}`, `${ind} */`, ...lines.slice(i + 1)].join(eol);
    }
    const closing = lines[end]!;
    const star = lines.slice(i + 1, end).find((l) => /^\s*\*/.test(l));
    const prefix = star ? (star.match(/^\s*\*/)?.[0] ?? " *") : (closing.match(/^\s*/)?.[0] ?? "") + " *";
    if (closing.trim() === "*/") return [...lines.slice(0, end), `${prefix} ${tag}`, ...lines.slice(end)].join(eol);
    // `… text */` on the last line → put the tag on its own line before the closing.
    const before = closing.slice(0, closing.lastIndexOf("*/")).replace(/\s+$/, "");
    const ind = closing.match(/^\s*/)?.[0] ?? "";
    return [...lines.slice(0, end), before, `${prefix} ${tag}`, `${ind}${ind ? "" : " "}*/`, ...lines.slice(end + 1)].join(eol);
  }
  if (/^\s*[ru]?"""/.test(first)) {
    if ((first.match(/"""/g) ?? []).length >= 2) {
      const ind = first.match(/^\s*/)?.[0] ?? "";
      const inner = first.trim().replace(/^[ru]?"""/, "").replace(/"""$/, "");
      if (inner.includes(tag)) return text;
      return [...lines.slice(0, i), `${ind}"""${inner}`, `${ind}${tag}`, `${ind}"""`, ...lines.slice(i + 1)].join(eol);
    }
    let end = i + 1;
    while (end < lines.length && !lines[end]!.includes('"""')) end++;
    if (end >= lines.length) return null;
    if (has(i, end)) return text;
    const ind = lines[end]!.match(/^\s*/)?.[0] ?? "";
    return [...lines.slice(0, end), `${ind}${tag}`, ...lines.slice(end)].join(eol);
  }
  const lead = /^\s*(\/\/|#)/.exec(first)?.[1];
  if (lead) {
    let end = i;
    while (end + 1 < lines.length && new RegExp(`^\\s*${lead === "#" ? "#" : "\\/\\/"}`).test(lines[end + 1]!)) end++;
    if (has(i, end)) return text;
    const ind = first.match(/^\s*/)?.[0] ?? "";
    return [...lines.slice(0, end + 1), `${ind}${lead} ${tag}`, ...lines.slice(end + 1)].join(eol);
  }
  return null;
}
