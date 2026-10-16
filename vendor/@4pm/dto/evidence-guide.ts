/**
 * Evidence guide (`EVIDENCE_GUIDE.md` at the repo root) — the pure half shared by the cli and the web: the file
 * name, the fixed section headings, splitting the Markdown into its sections, replacing one section's body (the
 * rest kept byte-for-byte), picking some sections for a prompt, and the size cap given to an agent.
 * @adr 0532
 */

/** The file at the repo root. */
export const EVIDENCE_GUIDE_FILE = "EVIDENCE_GUIDE.md";

/** The fixed level-2 sections, in order (heading text = id). */
export const EVIDENCE_GUIDE_SECTIONS = ["General", "Mockups", "Sequence diagrams", "Data model (ER)", "System diagram", "Task evidence"] as const;
export type EvidenceGuideSection = (typeof EVIDENCE_GUIDE_SECTIONS)[number];

/** The most guide text an agent prompt carries. */
export const EVIDENCE_GUIDE_MAX_CHARS = 20_000;

/** One `## …` section: heading text, body (without the heading line) and its line range in the file. */
export interface GuideSectionPart {
  heading: string;
  body: string;
  /** 0-based index of the heading line. */
  start: number;
  /** 0-based index one past the last line of the body. */
  end: number;
}

/** True for a level-2 heading line outside a code fence (the caller tracks fences). */
function headingOf(line: string): string | null {
  const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
  return m && !line.startsWith("###") ? m[1]!.trim() : null;
}

/** Split a guide into its level-2 sections (text before the first one is the preamble). */
export function splitGuideSections(md: string): { preamble: string; sections: GuideSectionPart[] } {
  const lines = md.split(/\r?\n/);
  const sections: GuideSectionPart[] = [];
  let fence = false;
  let first = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) fence = !fence;
    const h = fence ? null : headingOf(lines[i]!);
    if (h === null) continue;
    if (sections.length === 0) first = i;
    const prev = sections[sections.length - 1];
    if (prev) prev.end = i;
    sections.push({ heading: h, body: "", start: i, end: lines.length });
  }
  for (const s of sections) s.body = lines.slice(s.start + 1, s.end).join("\n").replace(/^\n+|\n+$/g, "");
  return { preamble: lines.slice(0, first).join("\n").replace(/\n+$/, ""), sections };
}

/** Is a heading the given fixed section (case / spacing insensitive)? */
function sameHeading(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

/** The body of one section ("" when absent). */
export function guideSectionBody(md: string, section: string): string {
  return splitGuideSections(md).sections.find((s) => sameHeading(s.heading, section))?.body ?? "";
}

/**
 * Replace one section's body (heading kept); every other line stays as it was. An absent section is inserted
 * in its fixed order (or appended).
 */
export function replaceGuideSection(md: string, section: string, body: string): string {
  const lines = md.split(/\r?\n/);
  const { sections } = splitGuideSections(md);
  const clean = body.replace(/^\s*##\s+[^\n]*\n/, "").replace(/^\n+|\s+$/g, "");
  const block = [`## ${section}`, ...(clean ? clean.split("\n") : []), ""];
  const hit = sections.find((s) => sameHeading(s.heading, section));
  if (hit) {
    lines.splice(hit.start, hit.end - hit.start, ...block);
    return lines.join("\n").replace(/\n{3,}$/, "\n\n").replace(/\n*$/, "\n");
  }
  const order = EVIDENCE_GUIDE_SECTIONS.findIndex((s) => sameHeading(s, section));
  const next = order < 0 ? undefined : sections.find((s) => EVIDENCE_GUIDE_SECTIONS.findIndex((x) => sameHeading(x, s.heading)) > order);
  if (next) {
    lines.splice(next.start, 0, ...block);
    return lines.join("\n");
  }
  return `${md.replace(/\s*$/, "")}\n\n${block.join("\n")}`.replace(/\n*$/, "\n");
}

/** The guide reduced to some sections (the preamble dropped), capped — what an implement prompt carries. */
export function pickGuideSections(md: string, names: readonly string[], max = EVIDENCE_GUIDE_MAX_CHARS): string {
  const picked = splitGuideSections(md).sections.filter((s) => names.some((n) => sameHeading(n, s.heading)) && s.body.trim());
  return capGuide(picked.map((s) => `## ${s.heading}\n${s.body}`).join("\n\n"), max);
}

/** Cap a guide text for a prompt (marked when cut). */
export function capGuide(md: string, max = EVIDENCE_GUIDE_MAX_CHARS): string {
  const t = md.trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n… (guide truncated)`;
}
