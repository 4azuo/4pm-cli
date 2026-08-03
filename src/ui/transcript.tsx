/**
 * Transcript rendering helpers (ADR-0057): flatten transcript entries into single
 * display lines (splitting multi-line output) and render one line with a source tag.
 * Command output is passthrough — printed verbatim, not recolored — per
 * cli-display 0001. The body is a fixed-height viewport (see App), not <Static>.
 *
 * Readability (ADR-0107): entries are grouped into blocks by `(source, kind)` — the
 * source tag prints only on the block's first physical row (not every line), and a blank
 * spacer row separates adjacent blocks. A `<detail title="…">…</detail>` span (e.g. the
 * spec-context JSON of a dispatched suggest/review/compose prompt) is collapsed to a single
 * dim `▸ title` line so the viewport is not flooded — the underlying prompt is unchanged.
 */
import React from "react";
import { Box, Text } from "ink";
import { prettyResult } from "@4pm/utils";
import type { TranscriptEntry } from "../core/session-bus";

/** One physical line shown in the viewport. */
export interface DisplayLine {
  key: string;
  source: TranscriptEntry["source"];
  level: TranscriptEntry["level"];
  kind: TranscriptEntry["kind"];
  text: string;
  /** Render the source tag on this row (only the first row of a block — ADR-0107). */
  showTag: boolean;
  /** A collapsed/expanded fold marker row (dim `▸[N] …` / `▾[N] …`). */
  collapsed: boolean;
  /** A blank separator row between two blocks (no tag, no text). */
  spacer: boolean;
  /** The 1-based fold number on a marker row (`/expand N` targets it — ADR-0108). */
  blockIndex?: number;
}

/** Short colored tag per source. */
function sourceTag(source: TranscriptEntry["source"]): { text: string; color: string } {
  switch (source) {
    case "server":
      return { text: "server", color: "magenta" };
    case "local":
      return { text: "local", color: "cyan" };
    case "system":
      return { text: "system", color: "gray" };
  }
}

/** Text color for a line based on its kind/level. */
function textColor(line: DisplayLine): string | undefined {
  if (line.level === "error") return "red";
  if (line.level === "warn") return "yellow";
  if (line.kind === "cmd") return "white";
  if (line.kind === "exit") return "green";
  return undefined; // passthrough output / info — default terminal color
}

/**
 * Render an AI marker line ("<cmd> ‹ …" request / "<cmd> › …" response): the CLI name
 * before the arrow is colored so the prompt/response boundary stands out. Continuation
 * rows of a wrapped request (no arrow) fall back to the default color.
 */
function AiMarkerLine({ line }: { line: DisplayLine }): React.ReactElement {
  const arrow = line.kind === "aireq" ? "‹" : "›";
  const idx = line.text.indexOf(arrow);
  if (idx < 0) return <Text>{line.text || " "}</Text>;
  return (
    <Text>
      <Text color="cyan" bold>
        {line.text.slice(0, idx)}
      </Text>
      <Text dimColor>{arrow}</Text>
      <Text>{line.text.slice(idx + 1)}</Text>
    </Text>
  );
}

/**
 * Word-wrap one physical line to `width` columns, breaking words longer than the
 * width (so a long token — a URL, a path — is split instead of overflowing). Returns
 * one string per wrapped row; an empty input yields a single empty row.
 */
function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text];
  const rows: string[] = [];
  let line = "";
  for (const word of text.split(/(\s+)/)) {
    if (word === "") continue;
    // A single token wider than the viewport: flush, then hard-split it into chunks.
    if (word.length > width) {
      if (line) {
        rows.push(line);
        line = "";
      }
      for (let i = 0; i < word.length; i += width) rows.push(word.slice(i, i + width));
      line = rows.pop() ?? ""; // keep the remainder open so the next word can append
      continue;
    }
    if ((line + word).length > width) {
      rows.push(line.trimEnd());
      line = word.trimStart();
    } else {
      line += word;
    }
  }
  if (line) rows.push(line.trimEnd());
  return rows.length > 0 ? rows : [""];
}

/** One raw segment of an entry: a plain text line, or a collapsed `<detail>` marker (with body). */
interface Segment {
  text: string;
  collapsed: boolean;
  /** For a collapsed `<detail>` — its inner payload, shown pretty-printed when expanded. */
  body?: string;
}

/** Matches a `<detail title="…">…</detail>` span (payload may span newlines). */
const DETAIL_RE = /<detail\s+title="([^"]*)">([\s\S]*?)<\/detail>/g;

/**
 * Split an entry's raw text into segments, turning each `<detail title="…">…</detail>` span
 * into one collapsed marker segment (title + its payload body — ADR-0107/0108). The newline
 * right before/after a marker is absorbed so the collapsed line sits flush with surrounding
 * text. Text without a `<detail>` is just split on newlines (unchanged behavior).
 */
function toSegments(raw: string): Segment[] {
  if (!raw.includes("<detail")) {
    return raw.split("\n").map((text) => ({ text, collapsed: false }));
  }
  const out: Segment[] = [];
  const re = new RegExp(DETAIL_RE);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const before = raw.slice(last, m.index).replace(/\n$/, "");
    if (before.length > 0) for (const p of before.split("\n")) out.push({ text: p, collapsed: false });
    out.push({ text: m[1] || "details", collapsed: true, body: m[2] ?? "" });
    last = m.index + m[0].length;
    if (raw[last] === "\n") last += 1; // absorb one newline right after the marker
  }
  const rest = raw.slice(last);
  if (rest.length > 0) for (const p of rest.split("\n")) out.push({ text: p, collapsed: false });
  if (out.length === 0) out.push({ text: "", collapsed: false });
  return out;
}

/**
 * Push the display lines of one collapsible fold (a `<detail>` span or a `result` block —
 * ADR-0108): a numbered marker `▸[N] <title>` when folded, or `▾[N] <title>` followed by the
 * pretty-printed body when `expanded`. The source tag shows only on the marker's first row.
 */
function pushCollapsible(
  lines: DisplayLine[],
  entry: TranscriptEntry,
  opts: { blockNo: number; title: string; body: string; expanded: boolean; firstRow: boolean; textWidth: number; keyBase: string },
): void {
  const { blockNo, title, body, expanded, firstRow, textWidth, keyBase } = opts;
  const base = { source: entry.source, level: entry.level, kind: entry.kind };
  lines.push({
    ...base,
    key: `${keyBase}:m`,
    text: `${expanded ? "▾" : "▸"}[${blockNo}] ${title}`,
    showTag: firstRow,
    collapsed: true,
    spacer: false,
    blockIndex: blockNo,
  });
  if (!expanded) return;
  prettyResult(body)
    .split("\n")
    .forEach((seg, i) =>
      wrapToWidth(seg, textWidth).forEach((row, j) =>
        lines.push({ ...base, key: `${keyBase}:b:${i}:${j}`, text: row, showTag: false, collapsed: false, spacer: false }),
      ),
    );
}

/**
 * Flatten entries into display lines. Entries are grouped into **blocks** by consecutive
 * `(source, kind)` (ADR-0107): a blank spacer row separates adjacent blocks, and the source
 * tag shows only on the block's first physical row. Each line is split on embedded newlines
 * **and** wrapped to `textWidth`, so every DisplayLine stays exactly one physical row (the
 * fixed-height viewport math in App is unchanged). Collapsible folds — `<detail>` spans and
 * json/code `result` blocks (ADR-0108) — are numbered `▸[N]`; a fold whose number is in
 * `expanded` shows its pretty-printed body instead.
 */
export function flattenEntries(
  entries: TranscriptEntry[],
  textWidth: number,
  expanded: ReadonlySet<number> = new Set(),
): DisplayLine[] {
  const lines: DisplayLine[] = [];
  let prevKey: string | null = null;
  let blockNo = 0; // running fold counter across the whole pass (both <detail> and result)
  for (const entry of entries) {
    const blockKey = `${entry.source}|${entry.kind}`;
    const newBlock = blockKey !== prevKey;
    if (newBlock && lines.length > 0) {
      lines.push({
        key: `sp:${entry.id}`,
        source: entry.source,
        level: entry.level,
        kind: entry.kind,
        text: "",
        showTag: false,
        collapsed: false,
        spacer: true,
      });
    }
    prevKey = blockKey;
    // Tag only the very first physical row of a new block; continuation entries/rows omit it.
    let firstRow = newBlock;

    // A whole json/code AI result — one collapsible fold (ADR-0108). Title carries the
    // pretty-printed line count so the fold hints its size.
    if (entry.kind === "result") {
      blockNo += 1;
      const count = prettyResult(entry.text).split("\n").length;
      const title = `result · ${entry.resultKind ?? "json"} · ${count} ${count === 1 ? "line" : "lines"}`;
      pushCollapsible(lines, entry, { blockNo, title, body: entry.text, expanded: expanded.has(blockNo), firstRow, textWidth, keyBase: entry.id });
      continue;
    }

    const raw = entry.kind === "out" ? entry.text.replace(/\n$/, "") : entry.text;
    toSegments(raw).forEach((seg, i) => {
      if (seg.collapsed) {
        blockNo += 1;
        pushCollapsible(lines, entry, { blockNo, title: seg.text, body: seg.body ?? "", expanded: expanded.has(blockNo), firstRow, textWidth, keyBase: `${entry.id}:${i}` });
        firstRow = false;
        return;
      }
      wrapToWidth(seg.text, textWidth).forEach((row, j) => {
        lines.push({
          key: `${entry.id}:${i}:${j}`,
          source: entry.source,
          level: entry.level,
          kind: entry.kind,
          text: row,
          showTag: firstRow,
          collapsed: false,
          spacer: false,
        });
        firstRow = false;
      });
    });
  }
  return lines;
}

/** One transcript line (tag column + text). */
export function TranscriptLine({ line }: { line: DisplayLine }): React.ReactElement {
  const tag = sourceTag(line.source);
  return (
    <Box flexDirection="row">
      <Box width={7} marginRight={1}>
        {line.showTag ? (
          <Text color={tag.color} dimColor={line.source === "system"}>
            {tag.text}
          </Text>
        ) : null}
      </Box>
      <Box flexGrow={1}>
        {line.spacer ? (
          <Text> </Text>
        ) : line.collapsed ? (
          <Text dimColor wrap="truncate-end">
            {line.text || " "}
          </Text>
        ) : line.kind === "aireq" || line.kind === "aires" ? (
          <AiMarkerLine line={line} />
        ) : (
          <Text color={textColor(line)} wrap="truncate-end">
            {line.text || " "}
          </Text>
        )}
      </Box>
    </Box>
  );
}
