/**
 * A minimal REST client for calling the server (BaseResponse — ADR-0009) for the
 * cli's public endpoints: confirm pairing, request ws_token, check version.
 */
import type {
  BaseResponse,
  CliVersionResponse,
  ConfirmResponse,
  WhoamiResponse,
  WsTokenResponse,
} from "@4pm/dto";
import type { MachineFingerprint } from "../core/fingerprint";
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
 * machine-0002: confirm hashcode (2) ⇒ receive hashcode (3).
 * Includes the machine fingerprint so the server can match/create a worker.
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
 * ADR-0192 §6: headless pairing — exchange a provisioning token for hashcode (3) with no
 * interactive hashcode dance (for a container/pool worker booting from an injected token).
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
 * machine-0003: request a ws_token using hashcode (3) (daily).
 */
export function requestWsToken(serverUrl: string, hashcode3: string): Promise<WsTokenResponse> {
  return post<WsTokenResponse>(serverUrl, "/machine-links/token", { hashcode3 });
}

/**
 * machine-0020: read this cli's account + teams/projects (for /whoami).
 */
export function fetchWhoami(serverUrl: string, hashcode3: string): Promise<WhoamiResponse> {
  return post<WhoamiResponse>(serverUrl, "/machine-links/whoami", { hashcode3 });
}

/**
 * machine-0006b: self-revoke this link on `4pm unlink` (auth by hashcode3). The server
 * closes the WS + soft-deletes the link/physic; the cli then removes its local .cre.
 */
export function selfUnlink(serverUrl: string, hashcode3: string): Promise<null> {
  return post<null>(serverUrl, "/machine-links/self-unlink", { hashcode3 });
}

/**
 * meta-0001: the latest / minimum cli version (auto-update — ADR-0015).
 */
export async function fetchCliVersion(serverUrl: string): Promise<CliVersionResponse> {
  const res = await fetch(`${serverUrl}/meta/cli-version`);
  return unwrap<CliVersionResponse>(res);
}
