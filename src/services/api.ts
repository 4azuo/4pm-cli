/**
 * A minimal REST client for calling the server (BaseResponse) for the
 * cli's public endpoints: confirm pairing, request ws_token, check version.
 * @adr 0009
 */
import type {
  BaseResponse,
  CliVersionResponse,
  ConfirmResponse,
  WhoamiResponse,
  WsTokenResponse,
} from "@4pm/dto";
import type { MachineFingerprint } from "../core/profile/fingerprint";
import { assertSecureRemoteUrl } from "../utils/secure-url";

/** An error from the server carrying an errorCode. */
export class CliApiError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CliApiError";
  }
}

/**
 * Unwrap a BaseResponse — throws CliApiError when success=false.
 */
async function unwrap<T>(res: Response): Promise<T> {
  const envelope = (await res.json().catch(() => null)) as BaseResponse<T> | null;
  if (!envelope || !envelope.success) {
    throw new CliApiError(
      envelope?.errorCode ?? "INTERNAL_ERROR",
      envelope?.message ?? `HTTP ${res.status}`,
      res.status,
    );
  }
  return envelope.data as T;
}

/**
 * POST JSON to the server.
 */
async function post<T>(serverUrl: string, path: string, body: unknown): Promise<T> {
  // Hard-block plaintext transport to a non-local host before any credential leaves the
  // machine (ADR-0194 finding #1): the hashcodes/ws_token below travel unauthenticated.
  assertSecureRemoteUrl(serverUrl);
  const res = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return unwrap<T>(res);
}

/**
 * Confirm hashcode (2) ⇒ receive hashcode (3).
 * Includes the machine fingerprint so the server can match/create a worker.
 * @api machine-0002
 */
export function confirmPairing(
  serverUrl: string,
  hashcode2: string,
  machine: MachineFingerprint,
): Promise<ConfirmResponse> {
  return post<ConfirmResponse>(serverUrl, "/machine-links/confirm", {
    hashcode2,
    fingerprint: machine.fingerprint,
    hostname: machine.hostname,
  });
}

/**
 * Headless pairing — exchange a provisioning token for hashcode (3) with no
 * interactive hashcode dance (for a container/pool worker booting from an injected token).
 * @adr 0192 §6
 */
export function pairWithToken(
  serverUrl: string,
  token: string,
  machine: MachineFingerprint,
): Promise<ConfirmResponse> {
  return post<ConfirmResponse>(serverUrl, "/machine-links/pair-token", {
    token,
    fingerprint: machine.fingerprint,
    hostname: machine.hostname,
  });
}

/**
 * Request a ws_token using hashcode (3) (daily).
 * @api machine-0003
 */
export function requestWsToken(serverUrl: string, hashcode3: string): Promise<WsTokenResponse> {
  return post<WsTokenResponse>(serverUrl, "/machine-links/token", { hashcode3 });
}

/**
 * Read this cli's account + teams/projects (for /whoami).
 * @api machine-0020
 */
export function fetchWhoami(serverUrl: string, hashcode3: string): Promise<WhoamiResponse> {
  return post<WhoamiResponse>(serverUrl, "/machine-links/whoami", { hashcode3 });
}

/**
 * Self-revoke this link on `4pm unlink` (auth by hashcode3). The server
 * closes the WS + soft-deletes the link/physic; the cli then removes its local .cre.
 * @api machine-0006b
 */
export function selfUnlink(serverUrl: string, hashcode3: string): Promise<null> {
  return post<null>(serverUrl, "/machine-links/self-unlink", { hashcode3 });
}

/**
 * The latest / minimum cli version (auto-update). Bounded by a 20s timeout so a
 * stalled server never leaves the auto-update stuck on "checking for a new version…" forever.
 * With `version` (the running one) the server adds that version's policy status.
 * @api meta-0001 @adr 0074 @adr 0363 @adr 0015
 */
export async function fetchCliVersion(serverUrl: string, version?: string): Promise<CliVersionResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const query = version ? `?version=${encodeURIComponent(version)}` : "";
    const res = await fetch(`${serverUrl}/meta/cli-version${query}`, { signal: ctrl.signal });
    return unwrap<CliVersionResponse>(res);
  } finally {
    clearTimeout(timer);
  }
}
