/**
 * Ed25519 public keys of the cli-servers this cli trusts, each pinned to the hosts it may sign for (data in
 * `ws-server-keys.json`, written by `41-scripts/ws-handshake-key.mjs`): a `hello_ack` must carry a signature of the
 * handshake (both ephemeral ECDH keys) by a key pinned for the host the cli dialed, or the session is refused — so an
 * intermediary that terminates TLS cannot put its own key in, and a key of one deployment is worthless against
 * another. The list ships inside the signed cli release, so only a release can change it. A rotation adds the new key,
 * ships a release, assigns it to the server, then drops the old one.
 * @adr 0681 @adr 0700
 */
import pins from "./ws-server-keys.json";

/** One pinned cli-server key. */
export interface PinnedServerKey {
  /** The deployment it belongs to (staging, production, local). */
  label: string;
  /** The day it was added (YYYY-MM-DD). */
  since: string;
  /** First 16 hex of sha256 over the SPKI DER — as `@4pm/ws`. */
  kid: string;
  /** Hostnames (lower-case, no port) of the cli-server WS URLs this key may sign for. */
  hosts: readonly string[];
  /** The public key, PEM SPKI. */
  pem: string;
}

/** The pinned keys, with each base64 SPKI DER wrapped as PEM. */
export const WS_SERVER_PUBLIC_KEYS: readonly PinnedServerKey[] = pins.map(({ publicKey, ...pin }) => ({
  ...pin,
  pem: `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----\n`,
}));
