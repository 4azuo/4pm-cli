/**
 * The agent side of a DOC round: the `cli.autonomous.docs` prompt (the spec's doc types + organization, the request,
 * the group's evidences on the books branch, the files of earlier rounds and every review so far) and the capture of
 * the group's evidences the agent rewrote on the DOC branch (mockups / sequences), which belong to the books branch.
 * @adr 0536
 */
import { posix } from "node:path";
import { DOC_NUMBERED_TYPES, designGroupKey, type DocEntry, type SpecDocs } from "@4pm/dto";
import { resolveCliPrompt } from "../ai/prompt-overrides";
import type { AutonomousConfig } from "./autonomous-config";
import type { LocalClaim } from "./autonomous-tasks";
import { freshBooksRef, gitQuiet } from "./autonomous-git";
import { docTypesBlock, previousFilesText, reviewHistoryText } from "./autonomous-docs";

/** The group's evidences on the books branch, listed for the docs agent with how to read them; "" when none. */
export async function docsDesignNote(root: string, base: string, cfg: Pick<AutonomousConfig, "mockupDir" | "sequenceDir" | "erDir" | "diagramDir">, docId: string): Promise<string> {
  const group = designGroupKey(docId);
  const ref = await freshBooksRef(root, base);
  if (!ref || !group) return "";
  const list = async (dir: string): Promise<string[]> => (await gitQuiet(root, ["ls-tree", "-r", "--name-only", ref, "--", `${dir}/`])).split("\n").filter(Boolean);
  const g = group.slice("TSK-".length);
  const mockups = (await list(cfg.mockupDir)).filter((p) => posix.basename(p).startsWith(`${group}--`));
  const sequences = (await list(cfg.sequenceDir)).filter((p) => new RegExp(`^(?:TSK|QA)-${g}-\\d{3}\\.md$`).test(posix.basename(p)));
  const changes = [...(await list(`${cfg.erDir}/changes`)), ...(await list(`${cfg.diagramDir}/changes`))];
  const lines = [...mockups, ...sequences].map((p) => `- \`${p}\``);
  if (!lines.length && !changes.length) return "";
  return `\nTHE GROUP'S EVIDENCES (on the books branch — read one with \`git show ${ref}:<path>\`; to update one, write the whole new file at the same path):\n${lines.join("\n") || "- (no mockups / sequences)"}\nOpen change requests are under \`${cfg.erDir}/changes/\` and \`${cfg.diagramDir}/changes/\` on the same ref.\n`;
}

/** Build the docs prompt of one round. */
export function buildDocsPrompt(
  cfg: AutonomousConfig,
  mine: LocalClaim,
  spec: SpecDocs,
  entry: DocEntry | undefined,
  request: string,
  designNote: string,
  evidenceGuide: string,
): string {
  const round = (entry?.round ?? 0) + 1;
  const files = previousFilesText(entry);
  const reviews = reviewHistoryText(entry);
  // Admin override (ADR-0381) for `cli.autonomous.docs`, else the shared registry default.
  return resolveCliPrompt("cli.autonomous.docs", {
    docId: mine.id,
    group: designGroupKey(mine.id),
    round,
    // People's text — wrapped as the request by the registry (ADR-0421).
    request: request || mine.task.desc,
    desc: mine.task.desc,
    notes: mine.task.notes || "(none)",
    designNote,
    docTypes: docTypesBlock(spec),
    numberedTypes: spec.types.filter((t) => DOC_NUMBERED_TYPES.includes(t)).join(", ") || "(none)",
    docsOrg: spec.org.trim() || "(none — use a clear, conventional layout)",
    evidenceGuide,
    filesNote: files ? `\nFILES THIS DOC ALREADY HAS on the branch (from earlier rounds — revise them, keep their names):\n${files}\n` : "",
    reviewNote: reviews ? `\nREVIEWS OF EARLIER ROUNDS (apply every point of the latest one; earlier ones still hold unless it says otherwise):\n${reviews}\n` : "",
    adrRule: spec.types.includes("adr")
      ? "An ADR is REQUIRED for every request, even when nothing else in the docs changes: write (at least) one new ADR recording what the request decides and why (context, decision, consequences)."
      : "Write an ADR only if the project keeps ADRs (it does not declare them — skip).",
    mockupDir: cfg.mockupDir,
    sequenceDir: cfg.sequenceDir,
    erDir: cfg.erDir,
    diagramDir: cfg.diagramDir,
    branch: mine.branch,
  });
}

/**
 * The group's mockups / sequences the agent added or rewrote on the DOC branch (they belong to the books branch):
 * path + content at `HEAD`, only names of this DOC's group.
 */
export async function captureDocEvidence(cwd: string, base: string, cfg: Pick<AutonomousConfig, "mockupDir" | "sequenceDir">, docId: string): Promise<{ path: string; content: string }[]> {
  const group = designGroupKey(docId);
  const fork = (await gitQuiet(cwd, ["merge-base", "HEAD", `origin/${base}`])).trim();
  if (!fork || !group) return [];
  const g = group.slice("TSK-".length);
  const changed = (await gitQuiet(cwd, ["diff", "--name-only", "--diff-filter=AM", fork, "HEAD", "--", `${cfg.mockupDir}/`, `${cfg.sequenceDir}/`]))
    .split("\n")
    .filter(Boolean)
    .filter((p) => {
      const name = posix.basename(p);
      return p.startsWith(`${cfg.mockupDir}/`) ? name.startsWith(`${group}--`) && name.endsWith(".html") : new RegExp(`^(?:TSK|QA)-${g}-\\d{3}\\.md$`).test(name);
    });
  const out: { path: string; content: string }[] = [];
  for (const p of changed) out.push({ path: p, content: await gitQuiet(cwd, ["show", `HEAD:${p}`]) });
  return out;
}

