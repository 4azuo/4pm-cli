/**
 * Intake claims — the `AI_PROGRESS` row a worker pushes for the ONE approved request / answered intake question it
 * takes in, before the intake agent runs on that row's own branch. Pushed through `publishBooks` (the same
 * optimistic lock as a task claim), so two workers never spend an intake run on the same id. A claim lives
 * `claimTtlHours` like a task claim: an expired one (or a worker's own leftover) is dropped by the next claim and the
 * request is taken in again, resuming the WIP its branch holds. The mutators run inside `publishBooks`.
 * @adr 0529 @adr 0563
 */
import * as B from "./autonomous-books";

/** Is this intake claim row still live (within the claim TTL)? */
export function intakeClaimLive(row: B.ClaimRow, ttlHours: number): boolean {
  const t = B.parseStamp(row.started);
  return Number.isFinite(t) && Date.now() - t < ttlHours * 3_600_000;
}

/** The ids under a live intake claim of ANOTHER worker → that worker's name. */
export function intakeHeldByOthers(progress: string, worker: string, ttlHours: number): Map<string, string> {
  const held = new Map<string, string>();
  for (const r of B.parseClaims(progress).intake) {
    if (r.worker !== worker && intakeClaimLive(r, ttlHours)) held.set(r.id, r.worker);
  }
  return held;
}

/** The one-line description of an intake row: `Intake — <request / question>`, trimmed. */
export function intakeDesc(userTodo: string, userQa: string, id: string): string {
  const text = id.startsWith("REQ-")
    ? B.requestText(userTodo, id)
    : (() => {
        const q = B.parseQa(userQa).rows.find((r) => r.id === id);
        return q ? q.original || q.question : "";
      })();
  return `Intake — ${text.replace(/\s+/g, " ").trim()}`.slice(0, 200);
}

/** The claim this worker is about to push for one intake id. */
export interface IntakeClaimDraft {
  claim: string;
  worker: string;
  started: string;
  /** Set to the attempt of the claimed id. */
  attempt: number;
  /** Set to the id actually claimed (the first free of the wanted ones). */
  id: string;
}

/**
 * Claim one intake id (inside `publishBooks`): drops expired intake rows and this worker's own leftovers, skips the
 * `wanted` ids another worker holds live or that left the books meanwhile, and writes one row for the first free id.
 * Run on every publish attempt, so a worker that lost the race takes the next free id. Sets `mine.id`; false
 * (nothing to publish) when none is left.
 * @adr 0556 @adr 0563
 */
export async function applyIntakeClaim(
  root: string,
  wanted: readonly string[],
  mine: IntakeClaimDraft,
  ttlHours: number,
  teamOf: (id: string) => string,
  attemptOf: (id: string) => number,
): Promise<boolean> {
  const [prog, userTodo, userQa] = await Promise.all([
    B.readBook(root, "AI_PROGRESS.md"),
    B.readBook(root, "USER_TODO.md"),
    B.readBook(root, "USER_QA.md"),
  ]);
  const { claims, intake } = B.parseClaims(prog);
  const kept = intake.filter((r) => r.worker !== mine.worker && intakeClaimLive(r, ttlHours));
  const held = new Set(kept.map((r) => r.id));
  // Still open in its book — a row with a `State` was already taken in (ADR-0562).
  const open = new Set([...B.openRowIds(userTodo, "REQ-"), ...B.openRowIds(userQa, "QA-")]);
  const id = wanted.find((w) => !held.has(w) && open.has(w));
  if (!id) return false;
  mine.id = id;
  mine.attempt = attemptOf(id);
  const row: B.ClaimRow = {
    started: mine.started,
    id,
    team: teamOf(id),
    worker: mine.worker,
    claim: mine.claim,
    attempt: mine.attempt,
    desc: intakeDesc(userTodo, userQa, id),
  };
  await B.writeBook(root, "AI_PROGRESS.md", B.writeClaims(prog, claims, [...kept, row]));
  return true;
}
