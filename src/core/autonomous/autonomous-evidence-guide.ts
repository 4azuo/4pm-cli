/**
 * The project's evidence guide for the autonomous agents — `EVIDENCE_GUIDE.md` read from `origin/<base>` (else
 * the working tree), the whole file for intake and the sections an implement run needs, capped. The text is repo
 * content: the prompt catalog marks it untrusted (`evidenceGuide`).
 * @adr 0532
 */
import { join } from "node:path";
import { EVIDENCE_GUIDE_FILE, capGuide, pickGuideSections } from "@4pm/dto";
import { gitQuiet } from "./autonomous-git";
import { readFileInRoot } from "../../utils/safe-path";

/** What the prompt says when the project has no guide. */
const NO_GUIDE = "(none — this project has no evidence guide; use the defaults of this prompt)";

/** The guide text as on `origin/<base>`, else the working tree; "" when absent. */
export async function readEvidenceGuide(root: string, base: string): Promise<string> {
  if (base) {
    const ref = `origin/${base}`;
    const listed = (await gitQuiet(root, ["ls-tree", "--name-only", ref, "--", EVIDENCE_GUIDE_FILE]).catch(() => "")).trim();
    if (listed) return gitQuiet(root, ["show", `${ref}:${EVIDENCE_GUIDE_FILE}`]).catch(() => "");
  }
  return readFileInRoot(root, join(root, EVIDENCE_GUIDE_FILE), "utf8").catch(() => "");
}

/** The intake agent's `evidenceGuide`: the whole file, capped. */
export async function intakeEvidenceGuide(root: string, base: string): Promise<string> {
  const md = await readEvidenceGuide(root, base);
  return md.trim() ? capGuide(md) : NO_GUIDE;
}

/**
 * The implement agent's `evidenceGuide`: `General` + `Task evidence`, plus the sections of the evidences the task
 * carries (its mockups, sequence, ER, system diagram).
 */
export async function implementEvidenceGuide(root: string, base: string, has: { mockups: boolean; sequence: boolean; er: boolean; diagram: boolean }): Promise<string> {
  const md = await readEvidenceGuide(root, base);
  if (!md.trim()) return NO_GUIDE;
  const names = [
    "General",
    "Task evidence",
    ...(has.mockups ? ["Mockups"] : []),
    ...(has.sequence ? ["Sequence diagrams"] : []),
    ...(has.er ? ["Data model (ER)"] : []),
    ...(has.diagram ? ["System diagram"] : []),
  ];
  return pickGuideSections(md, names) || NO_GUIDE;
}
