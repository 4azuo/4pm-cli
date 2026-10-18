/**
 * Intake claims — the `AI_PROGRESS` rows a worker pushes for the approved requests / answered intake
 * questions it is about to take in, before the intake agent runs. Pushed through `publishBooks` (the same
 * optimistic lock as a task claim), so two workers never spend an intake run on the same id; removed in the
 * intake commit itself, or released by a separate books commit when the intake does not publish. A claim
 * lives `runTimeoutMinutes` + 15 min; an expired one, or a worker's own leftover one, is dropped by the next
 * intake claim. The mutators run inside `publishBooks` (they edit the working-tree books).
 * @adr 0529
 */
import * as B from "./autonomous-books";
import { publishBooks } from "./autonomous-git";

/** Grace added to the run timeout before an intake claim counts as abandoned. */
const INTAKE_CLAIM_GRACE_MIN = 15;

/** One intake batch held by this worker. */
export interface IntakeClaim {
  /** One UUID for the whole batch. */
  claim: string;
  worker: string;
  started: string;
  /** The ids actually claimed (a subset of the requested ones). */
  ids: string[];
}

/** How long an intake claim lives (minutes). */
export function intakeClaimTtlMinutes(runTimeoutMinutes: number): number {
  return runTimeoutMinutes + INTAKE_CLAIM_GRACE_MIN;
}

/** Is this intake claim row still live (within its TTL)? */
export function intakeClaimLive(row: B.ClaimRow, ttlMinutes: number): boolean {
  const t = B.parseStamp(row.started);
  return Number.isFinite(t) && Date.now() - t < ttlMinutes * 60_000;
}

/** The ids under a live intake claim of ANOTHER worker → that worker's name. */
export function intakeHeldByOthers(progress: string, worker: string, ttlMinutes: number): Map<string, string> {
  const held = new Map<string, string>();
  for (const r of B.parseClaims(progress).intake) {
    if (r.worker !== worker && intakeClaimLive(r, ttlMinutes)) held.set(r.id, r.worker);
  }
  return held;
}

/** The one-line description of an intake row: `Intake — <request / question>`, trimmed. */
function intakeDesc(userTodo: string, userQa: string, id: string): string {
  const text = id.startsWith("REQ-")
    ? B.requestText(userTodo, id)
    : (() => {
        const q = B.parseQa(userQa).rows.find((r) => r.id === id);
        return q ? q.original || q.question : "";
      })();
  return `Intake — ${text.replace(/\s+/g, " ").trim()}`.slice(0, 200);
}

/**
 * Claim intake ids (inside `publishBooks`): drops expired intake rows and this worker's own leftovers, skips the
 * `wanted` ids another worker holds live or that left the books meanwhile, picks the batch from the rest (`pick`,
 * on the current USER_QA; default: all of them) and writes one row per picked id. Run on every publish attempt, so
 * a worker that lost the race to an id takes the next free one. Sets `mine.ids` to what was claimed; false (nothing
 * to publish) when none is left.
 * @adr 0556
 */
export async function applyIntakeClaim(
  root: string,
  wanted: readonly string[],
  mine: IntakeClaim,
  ttlMinutes: number,
  teamOf: (id: string) => string,
  pick: (free: string[], userQa: string) => string[] = (free) => free,
): Promise<boolean> {
  const [prog, userTodo, userQa] = await Promise.all([
    B.readBook(root, "AI_PROGRESS.md"),
    B.readBook(root, "USER_TODO.md"),
    B.readBook(root, "USER_QA.md"),
  ]);
  const { claims, intake } = B.parseClaims(prog);
  const kept = intake.filter((r) => r.worker !== mine.worker && intakeClaimLive(r, ttlMinutes));
  const held = new Set(kept.map((r) => r.id));
  const present = (id: string): boolean => (id.startsWith("REQ-") ? userTodo : userQa).includes(id);
  mine.ids = pick(wanted.filter((id) => !held.has(id) && present(id)), userQa);
  if (mine.ids.length === 0) return false;
  const rows: B.ClaimRow[] = mine.ids.map((id) => ({
    started: mine.started,
    id,
    team: teamOf(id),
    worker: mine.worker,
    claim: mine.claim,
    attempt: 1,
    desc: intakeDesc(userTodo, userQa, id),
  }));
  await B.writeBook(root, "AI_PROGRESS.md", B.writeClaims(prog, claims, [...kept, ...rows]));
  return true;
}

/** Remove this batch's intake rows from the working-tree `AI_PROGRESS`; false when none was there. */
export async function removeIntakeClaim(root: string, claim: string): Promise<boolean> {
  const prog = await B.readBook(root, "AI_PROGRESS.md");
  const { claims, intake } = B.parseClaims(prog);
  const rest = intake.filter((r) => r.claim !== claim);
  if (rest.length === intake.length) return false;
  await B.writeBook(root, "AI_PROGRESS.md", B.writeClaims(prog, claims, rest));
  return true;
}

/** Release an intake batch that did not publish: its own books commit (best-effort). */
export async function releaseIntakeClaim(root: string, base: string, mine: IntakeClaim): Promise<void> {
  await publishBooks(root, base, `chore(auto): release intake of ${mine.ids.join(", ")} by ${mine.worker}`, () => removeIntakeClaim(root, mine.claim)).catch(
    () => undefined,
  );
}
