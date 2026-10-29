/**
 * Handshake trust — verifies the cli-server's signature on `hello_ack` against the pinned keys (+ the dev key and
 * `FOURPM_WS_SERVER_KEYS` on a `0.0.0` build). A failure means the session key may come from an interceptor: the cli
 * closes the socket and retries with its normal back-off.
 * @adr 0681
 */
import { verifyHandshake } from "@4pm/ws";
import { WS_DEV_SERVER_PUBLIC_KEY, WS_SERVER_PUBLIC_KEYS } from "../config/ws-server-keys";
import { CLI_VERSION } from "../version";

/** Whether this is a dev build (workspace version) — only then the env override counts. */
export function isDevBuild(version: string = CLI_VERSION): boolean {
  return version === "0.0.0";
}

/** The keys this cli trusts: the pinned ones, plus the dev key and the env ones on a dev build. */
export function trustedServerKeys(env: NodeJS.ProcessEnv = process.env, version: string = CLI_VERSION): string[] {
  const extra = isDevBuild(version)
    ? [WS_DEV_SERVER_PUBLIC_KEY, ...(env.FOURPM_WS_SERVER_KEYS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((b64) => `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`)]
    : [];
  return [...WS_SERVER_PUBLIC_KEYS, ...extra];
}

/** True when `hello_ack`'s signature over (our key, its key) verifies with a trusted key. */
export function handshakeTrusted(clientPub: string, ack: { pubkey: string; kid?: string; sig?: string }, keys: readonly string[] = trustedServerKeys()): boolean {
  try {
    return verifyHandshake(keys, clientPub, ack.pubkey, ack.kid, ack.sig);
  } catch {
    return false;
  }
}
