/**
 * `ai.account` messages — the cross-worker AI account lease. Before each AI attempt the cli sends the
 * candidate accounts of its plan (hashed `accountKey`s, config order); the server picks one — the pin,
 * else the first idle non-exhausted candidate (the cli's preferred one first), else the least-loaded —
 * leases it and returns the full ranking. The lease is renewed while the attempt runs and released on
 * exit; an attempt that fails on a usage limit marks its account exhausted until the reset, so every cli
 * ranks it last. cli → server (with reply), relayed by the cli-server to the server's internal gRPC
 * `AiAccountLease`. Keys are global (the subscription is the unit), never per org.
 * @adr 0518
 */

/** Lease lifetime (s) — the cli renews every {@link AI_ACCOUNT_RENEW_MS}. */
export const AI_ACCOUNT_LEASE_TTL_SEC = 120;
/** How often the cli renews a held account lease (ms). */
export const AI_ACCOUNT_RENEW_MS = 45_000;
/** Most candidates one `acquire` may carry. */
export const AI_ACCOUNT_MAX_CANDIDATES = 32;
/** Exhaustion window when the account's reset time is unknown (ms). */
export const AI_ACCOUNT_EXHAUSTED_DEFAULT_MS = 60 * 60_000;
/** Longest exhaustion window the server accepts (ms) — a weekly limit at most. */
export const AI_ACCOUNT_EXHAUSTED_MAX_MS = 7 * 24 * 60 * 60_000;

/** An `ai.account` request. `accountKey` = lower-case sha256 hex. */
export type AiAccountRequest =
  | {
      op: "acquire";
      /** The plan's candidate accounts, config order (duplicates collapsed by the server). */
      candidates: string[];
      /** The operator's pinned account — always chosen. */
      pinned?: string;
      /** The cli's working-first / session-pressure choice — first among the idle ones. */
      preferred?: string;
    }
  | { op: "renew"; lease: string; accountKey: string }
  | { op: "release"; lease: string; accountKey: string }
  // The account hit a usage limit: rank it last until `until` (ms epoch).
  | { op: "exhausted"; accountKey: string; until: number };

/**
 * An `ai.account` reply. `acquire` ⇒ the chosen account + its lease; `busy` = it already had a run (no
 * idle candidate left); `order` = every candidate ranked (idle → busy by load → exhausted).
 * `renew` / `release` / `exhausted` ⇒ `{ ok }`.
 */
export type AiAccountReply =
  | { accountKey: string; lease: string; leaseTtlSec: number; busy: boolean; order: string[] }
  | { ok: boolean };
