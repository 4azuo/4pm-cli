/**
 * Sequence-diagram check before commit: parse the `mermaid` block of each `<sequenceDir>/<ID>.md` with Mermaid's
 * own parser (bundled, imported only when a check runs), hand each failure once to a fixer (the cli's one-shot
 * `cli.autonomous.fixDiagram` run), and write the reply back only when it parses.
 * @adr 0580
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A sequence file whose diagram Mermaid rejected. */
export interface SequenceFailure {
  /** Repo-relative path. */
  rel: string;
  /** Mermaid's parse message. */
  error: string;
}

/** Returns the fixed diagram source (any reply text — it is unfenced and re-parsed), or null when it could not. */
export type SequenceFixer = (rel: string, diagram: string, error: string) => Promise<string | null>;

/** The first ```mermaid block of a markdown file: its body and where it sits, or null. */
const MERMAID_BLOCK = /```+[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i;

/** A sequence file name the cli wrote or lets the agent write (`TSK-…` / `QA-…`). */
const SEQUENCE_FILE = /(?:^|\/)(?:TSK|QA)-\d{6}-\d{3}\.md$/;

/** Is `rel` a sequence diagram file (under `sequenceDir`, `TSK-…` / `QA-…` name)? */
export function isSequenceFile(rel: string, sequenceDir: string): boolean {
  return rel.startsWith(`${sequenceDir}/`) && SEQUENCE_FILE.test(rel) && !rel.includes("..");
}

/** The source inside the first ```mermaid block of `markdown`, or null when there is none. */
export function mermaidBlockOf(markdown: string): string | null {
  return MERMAID_BLOCK.exec(markdown)?.[1] ?? null;
}

/** Strip a ``` fence (and any text around it) from a diagram reply; a reply without a fence is taken as is. */
export function unfenceDiagram(text: string): string {
  const inner = mermaidBlockOf(text) ?? /```+[^\n]*\n([\s\S]*?)\n[ \t]*```/.exec(text)?.[1];
  return (inner ?? text).trim();
}

/** Mermaid's parse error for `source`, or null when it parses. */
export async function mermaidParseError(source: string): Promise<string | null> {
  const mermaid = (await import("mermaid")).default;
  try {
    await mermaid.parse(source);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The sequence files among `rels` whose mermaid block does not parse (a file without one is skipped). */
export async function checkSequenceFiles(root: string, rels: string[]): Promise<SequenceFailure[]> {
  const failures: SequenceFailure[] = [];
  for (const rel of rels) {
    const text = await readFile(join(root, rel), "utf8").catch(() => null);
    const block = text === null ? null : mermaidBlockOf(text);
    if (block === null) continue;
    const error = await mermaidParseError(block);
    if (error) failures.push({ rel, error });
  }
  return failures;
}

/**
 * Check `rels`; give each failing diagram ONE pass through `fix`; write the reply back when it is a
 * `sequenceDiagram` that parses. Returns the files that still fail.
 */
export async function repairSequenceFiles(
  root: string,
  rels: string[],
  fix: SequenceFixer,
  log: (line: string) => Promise<void>,
): Promise<SequenceFailure[]> {
  const left: SequenceFailure[] = [];
  for (const failure of await checkSequenceFiles(root, rels)) {
    const path = join(root, failure.rel);
    const text = await readFile(path, "utf8");
    const block = mermaidBlockOf(text) ?? "";
    const reply = await fix(failure.rel, block, failure.error).catch(() => null);
    const fixed = reply === null ? "" : unfenceDiagram(reply);
    const error = /^sequenceDiagram\b/.test(fixed) ? await mermaidParseError(fixed) : "the fix reply is not a sequenceDiagram";
    if (error) {
      await log(`[warn] ${failure.rel}: the sequence diagram does not parse and could not be fixed — ${firstLine(error)}`);
      left.push({ rel: failure.rel, error });
      continue;
    }
    await writeFile(path, text.replace(MERMAID_BLOCK, (m, body: string) => m.replace(body, () => fixed)), "utf8");
    await log(`[fix] ${failure.rel}: sequence diagram syntax fixed (was: ${firstLine(failure.error)})`);
  }
  return left;
}

/** The first line of a (multi-line) parse message, for a log line. */
function firstLine(message: string): string {
  return message.split("\n")[0]!.slice(0, 200);
}
