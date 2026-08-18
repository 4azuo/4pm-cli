/**
 * Transport-security guard (ADR-0194 Phase-0 finding #1). The app-layer ECDH handshake
 * (arch 0004, `@4pm/ws`) is anonymous — it does NOT authenticate the server — so server
 * authentication and MITM protection rely entirely on TLS (`https`/`wss`). This flags a
 * plaintext server URL pointed at a non-local host, where the pairing hashcodes and the
 * daily `ws_token` would travel in cleartext to an unauthenticated peer.
 */

/** Loopback / in-container-dev hosts for which plaintext transport is acceptable. */
function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * True when `url` uses a plaintext scheme (`http`/`ws`) against a non-local host — the
 * case where credentials travel unencrypted and the server is unauthenticated. Returns
 * false for a secure scheme, a local host, or an unparseable URL (the caller's connect
 * attempt surfaces a bad URL on its own).
 */
export function isInsecureRemoteUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") return false;
  return !isLocalHost(parsed.hostname);
}

/** The shared warning line shown when a plaintext remote URL is detected. */
export const INSECURE_URL_WARNING =
  "⚠ Insecure transport: connecting over plaintext (http/ws) to a non-local host. " +
  "Pairing codes and the ws_token are sent in cleartext and the server is not " +
  "authenticated (the app-layer encryption does not protect against a man-in-the-middle). " +
  "Use an https:// server URL in production.";

/**
 * True when the operator has explicitly opted out of the plaintext-remote block via
 * `FOURPM_ALLOW_INSECURE_TRANSPORT=1` — an escape hatch for a deliberately isolated private
 * network. The default (unset) blocks; localhost is always allowed regardless (see
 * `isInsecureRemoteUrl`).
 */
export function insecureTransportAllowed(): boolean {
  const flag = (process.env.FOURPM_ALLOW_INSECURE_TRANSPORT ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

/** The fatal message shown when a plaintext remote URL is hard-blocked. */
export const INSECURE_URL_BLOCKED =
  "✗ Refusing to connect over plaintext (http/ws) to a non-local host: credentials " +
  "(pairing codes / ws_token) would travel in the clear to an unauthenticated server. " +
  "Use an https://server URL. To override on a trusted private network only, set " +
  "FOURPM_ALLOW_INSECURE_TRANSPORT=1.";

/**
 * Hard-block a plaintext remote transport. Throws when `url` is a plaintext scheme against
 * a non-local host and the operator has not opted out — the caller must abort before any
 * credential leaves the machine. A no-op for secure/local URLs (and when opted out).
 */
export function assertSecureRemoteUrl(url: string): void {
  if (isInsecureRemoteUrl(url) && !insecureTransportAllowed()) {
    throw new Error(INSECURE_URL_BLOCKED);
  }
}
