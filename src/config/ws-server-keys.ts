/**
 * Ed25519 public keys (PEM SPKI) of the cli-servers this cli trusts: each `hello_ack` must carry a signature of the
 * handshake (both ephemeral ECDH keys) by one of them, or the session is refused — so an intermediary that terminates
 * TLS cannot put its own key in. One entry per deployment (staging, production); a rotation adds the new key, ships a
 * release, switches the server, then drops the old one. Written by `41-scripts/ws-handshake-key.mjs`.
 * A dev build (version `0.0.0`) also trusts {@link WS_DEV_SERVER_PUBLIC_KEY} (the local stack's dev key) and
 * `FOURPM_WS_SERVER_KEYS` (comma-separated base64 SPKI DER); a release build ignores both.
 * @adr 0681
 */
export const WS_SERVER_PUBLIC_KEYS: readonly string[] = [
  // staging handshake key since 2026-10-28 (kid 439b04b6acba2c38) — 41-scripts/ws-handshake-key.mjs.
  `
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJc9vXdhLr7EflPY9zgAJ73dmog7RJ1xAtvWr2KiYBSg=
-----END PUBLIC KEY-----
`,
];

/** The public half of the cli-server's dev-only signing key — trusted by dev builds only. */
export const WS_DEV_SERVER_PUBLIC_KEY = `
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5cQX4cy3CuNVQri18uMcrv87ZS2KjU58LvV24E3gb6k=
-----END PUBLIC KEY-----
`;
