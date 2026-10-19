/**
 * The agent side of a DOC round: the `cli.autonomous.docs` prompt — the spec's doc types + organization, the request,
 * the files of earlier rounds and every review so far. The group's evidences, the discussions, the evidence guide and
 * the doc templates are read by the agent from its working tree (books overlay + `<base>`), not pasted in.
 * @adr 0536 @adr 0563 @adr 0564
 */
import { DOC_NUMBERED_TYPES, designGroupKey, type DocEntry, type SpecDocs } from "@4pm/dto";
import { resolveCliPrompt } from "../ai/prompt-overrides";
import type { AutonomousConfig } from "./autonomous-config";
import type { LocalClaim } from "./autonomous-tasks";
import { docTypesBlock, previousFilesText, reviewHistoryText } from "./autonomous-docs";
import { contextRel } from "./autonomous-context";

/** Build the docs prompt of one round. */
export function buildDocsPrompt(
  cfg: AutonomousConfig,
  mine: LocalClaim,
  spec: SpecDocs,
  entry: DocEntry | undefined,
  request: string,
): string {
  const round = (entry?.round ?? 0) + 1;
  const files = previousFilesText(entry);
  const reviews = reviewHistoryText(entry);
  // Admin override (ADR-0381) for `cli.autonomous.docs`, else the shared registry default.
  return resolveCliPrompt("cli.autonomous.docs", {
    docId: mine.id,
    // The run's context manifest in the overlay (ADR-0565).
    contextFile: contextRel(mine.id),
    group: designGroupKey(mine.id),
    round,
    // People's text — wrapped as the request by the registry (ADR-0421).
    request: request || mine.task.desc,
    desc: mine.task.desc,
    notes: mine.task.notes || "(none)",
    docTypes: docTypesBlock(spec),
    numberedTypes: spec.types.filter((t) => (spec.numbered ?? DOC_NUMBERED_TYPES).includes(t)).join(", ") || "(none)",
    docsOrg: spec.org.trim() || "(none — use a clear, conventional layout)",
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
