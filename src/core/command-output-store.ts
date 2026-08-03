/**
 * Persist each command's captured output to the profile dir so it can be replayed
 * later with `/output` (ADR-0057). One file per commandId under command-output/, kept
 * to the most recent N commands. Best-effort — never breaks command execution.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/** How many command-output files to keep (pruned oldest-first on init). */
const KEEP_FILES = 200;

let dir: string | null = null;

/** Wire the output dir (~/.4pm/profiles/<name>/command-output/) + prune old files. */
export function initCommandOutput(profileDir: string): void {
  dir = join(profileDir, "command-output");
  try {
    mkdirSync(dir, { recursive: true });
    prune();
  } catch {
    // best-effort
  }
}

/** Append one output chunk for a command (verbatim). */
export function appendCommandOutput(commandId: string, text: string): void {
  if (!dir || !text) return;
  try {
    appendFileSync(join(dir, `${commandId}.log`), text, "utf8");
  } catch {
    // best-effort — output capture must never break the command
  }
}

/** Read the full captured output of a command, or null when unavailable. */
export function readCommandOutput(commandId: string): string | null {
  if (!dir) return null;
  const path = join(dir, `${commandId}.log`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Keep only the most recent KEEP_FILES output files. */
function prune(): void {
  if (!dir) return;
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, t: statSync(join(dir!, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP_FILES)) rmSync(join(dir!, f), { force: true });
  } catch {
    // best-effort
  }
}

/** Remove output files older than `days` (ADR-0115); `days<=0` keeps the count-based default. */
export function pruneCommandOutputByAge(days: number): void {
  if (!dir || days <= 0) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".log"))) {
      const p = join(dir, f);
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    }
  } catch {
    // best-effort
  }
}
