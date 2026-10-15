/**
 * AI account lease client — the cli half of the cross-worker AI account choice. Each AI attempt is
 * leased on its account (`ai.account` acquire): the server returns the account to run on — the pin,
 * else the first idle one (this plan's head first), else the least-loaded — and the attempts are
 * re-ordered to match. The lease is renewed while the attempt runs and released after it; an attempt
 * that fails on a usage limit marks its account exhausted for every cli until the reset. Any transport
 * error or a reply slower than 2 s fails OPEN: the attempt runs in the local order, unleased.
 * @adr 0518
 */
import { createHash } from "node:crypto";
import {
  AI_ACCOUNT_EXHAUSTED_DEFAULT_MS,
  AI_ACCOUNT_RENEW_MS,
  WsChannels,
  type AiAccountReply,
  type MachineUsagePayload,
} from "@4pm/ws";
import { logger } from "../../common/logger/logger";
import { collectFingerprint } from "../profile/fingerprint";
import { planPolicyRun, profileAccountEmail, type AiAttempt, type AiCliConfig } from "../../utils/ai-cli";

/** Longest the cli waits for an `ai.account` reply before running unleased (ms). */
const ACQUIRE_TIMEOUT_MS = 2_000;

/** The transport the leaser needs (the WS request channel). */
export interface AccountLeaseTransport {
  request<T>(channel: typeof WsChannels.AI_ACCOUNT, data: unknown): Promise<T>;
}

/** Per-run account leaser handed to `runAiFailover`. */
export interface AccountLeaser {
  /**
   * Before an attempt: lease an account for one of `remaining` (plan order) and return the index in
   * `remaining` to run now (0 = keep the plan head). Never throws.
   */
  next(remaining: AiAttempt[]): Promise<number>;
  /** After an attempt: stop renewing and release its lease (idempotent). */
  done(): void;
  /** The attempt failed on a usage limit / out of credits: mark its account exhausted. */
  exhausted(attempt: AiAttempt): void;
}

/** Options for one run's leaser. */
export interface AccountLeaserOptions {
  /** The operator-pinned credential key — always chosen while it is still a candidate. @adr 0250 */
  pinnedCredential: string | null;
  /** The latest subscription usage snapshot — supplies the 5 h reset time of an exhausted account. */
  usage: () => MachineUsagePayload | null;
  /** Transcript line when the run has to share an account that is already busy. */
  onShared?: (label: string) => void;
}

/** sha256 hex of a string. */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** This machine's fingerprint, read once (the local fallback key needs it). */
let machineId: string | null = null;

/** The machine fingerprint (cached). */
function fingerprint(): string {
  if (machineId === null) {
    try {
      machineId = collectFingerprint().fingerprint;
    } catch {
      machineId = "unknown";
    }
  }
  return machineId;
}

/**
 * The global account key of an attempt: the signed-in account (provider + email) when readable, else
 * the managed API key's descriptor (an inline key only as its hash), else this machine's profile dir —
 * which de-duplicates within one machine only. The key never carries the raw email or key.
 */
export function accountKeyOf(attempt: AiAttempt): string {
  const email = attempt.dir ? profileAccountEmail(attempt.dir) : null;
  if (email) return sha256(`${attempt.cmd}:${email.toLowerCase()}`);
  const k = attempt.apiKey;
  if (k) {
    const ref = k.source === "inline" ? sha256(k.value ?? "") : `${k.source}:${k.region ?? ""}:${k.name ?? k.secretId ?? ""}:${k.jsonKey ?? ""}`;
    return sha256(`apikey:${ref}`);
  }
  return sha256(`local:${fingerprint()}:${attempt.cmd}:${attempt.dir ?? "default"}`);
}

/** The account keys of every usable configured credential (reported in `machine.status`). @adr 0522 */
export function aiAccountKeys(config: AiCliConfig): string[] {
  const attempts = planPolicyRun("", config, {}, { args: () => [] }).attempts.filter((a) => a.dir !== null);
  return [...new Set(attempts.map(accountKeyOf))];
}

/** When an exhausted account frees up: its 5 h reset if the usage snapshot is about it, else +60 min. */
function exhaustedUntil(attempt: AiAttempt, usage: MachineUsagePayload | null): number {
  const email = attempt.dir ? profileAccountEmail(attempt.dir) : null;
  const reset = usage?.session.resetsAt ? Date.parse(usage.session.resetsAt) : NaN;
  if (email && usage?.profile === email && Number.isFinite(reset) && reset > Date.now()) return reset;
  return Date.now() + AI_ACCOUNT_EXHAUSTED_DEFAULT_MS;
}

/** Reject after `ms` — bounds an acquire so a slow server never delays the run. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ai.account timeout")), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Create the leaser for one AI run. */
export function createAccountLeaser(transport: AccountLeaseTransport, opts: AccountLeaserOptions): AccountLeaser {
  let held: { accountKey: string; lease: string; timer: ReturnType<typeof setInterval> } | null = null;

  /** Stop renewing + release the held lease. */
  const release = (): void => {
    if (!held) return;
    const { accountKey, lease, timer } = held;
    held = null;
    clearInterval(timer);
    transport.request<AiAccountReply>(WsChannels.AI_ACCOUNT, { op: "release", lease, accountKey }).catch(() => undefined);
  };

  return {
    async next(remaining) {
      if (remaining.length === 0) return 0;
      const keys = remaining.map(accountKeyOf);
      // Already leased for the head (picked before the plan was built) — run it.
      if (held && keys[0] === held.accountKey) return 0;
      release();
      const pinned = remaining.find((a) => a.key !== null && a.key === opts.pinnedCredential);
      let reply: AiAccountReply;
      try {
        reply = await withTimeout(
          transport.request<AiAccountReply>(WsChannels.AI_ACCOUNT, {
            op: "acquire",
            candidates: keys,
            ...(pinned ? { pinned: accountKeyOf(pinned) } : { preferred: keys[0] }),
          }),
          ACQUIRE_TIMEOUT_MS,
        );
      } catch (err) {
        logger.warn("ai.account.unavailable", { error: (err as Error).message });
        return 0;
      }
      if (!reply || !("accountKey" in reply)) return 0;
      const index = keys.indexOf(reply.accountKey);
      if (index < 0) return 0;
      const { accountKey, lease } = reply;
      const timer = setInterval(() => {
        transport.request<AiAccountReply>(WsChannels.AI_ACCOUNT, { op: "renew", lease, accountKey }).catch(() => undefined);
      }, AI_ACCOUNT_RENEW_MS);
      timer.unref?.();
      held = { accountKey, lease, timer };
      if (reply.busy) opts.onShared?.(remaining[index]!.label);
      return index;
    },
    done: release,
    exhausted(attempt) {
      const accountKey = accountKeyOf(attempt);
      const until = exhaustedUntil(attempt, opts.usage());
      transport.request<AiAccountReply>(WsChannels.AI_ACCOUNT, { op: "exhausted", accountKey, until }).catch(() => undefined);
    },
  };
}
