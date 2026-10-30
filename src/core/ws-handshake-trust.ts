/**
 * Handshake trust — verifies the cli-server's signature on `hello_ack` against the keys pinned for the host the cli
 * dialed. A failure means the session key may come from an interceptor: the cli closes the socket and retries with its
 * normal back-off.
 * @adr 0681 @adr 0700
 */
import { verifyHandshake } from "@4pm/ws";
import { WS_SERVER_PUBLIC_KEYS, type PinnedServerKey } from "../config/ws-server-keys";

/** The hostname of a WS URL (lower-case, no port); "" when the URL does not parse. */
export function wsHost(wsUrl: string): string {
  try {
    return new URL(wsUrl).hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  } catch {
    return "";
  }
}

/** The public keys (PEM) pinned for `host`. */
export function trustedServerKeys(host: string, pins: readonly PinnedServerKey[] = WS_SERVER_PUBLIC_KEYS): string[] {
  return pins.filter((k) => k.hosts.includes(host)).map((k) => k.pem);
}

/** True when `hello_ack`'s signature over (our key, its key) verifies with a key pinned for `host`. */
export function handshakeTrusted(
  host: string,
  clientPub: string,
  ack: { pubkey: string; kid?: string; sig?: string },
  keys: readonly string[] = trustedServerKeys(host),
): boolean {
  if (keys.length === 0) return false;
  try {
    return verifyHandshake(keys, clientPub, ack.pubkey, ack.kid, ack.sig);
  } catch {
    return false;
  }
}
