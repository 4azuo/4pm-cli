/**
 * Ed25519 public key used to verify the auto-update tarball signature
 * (ADR-0015). Leave empty to skip signature verification (checksum only). When
 * set to a PEM SPKI public key, the CLI requires a valid signature — whose
 * private counterpart signs releases in CI, and the server exposes it via
 * `CLI_TARBALL_SIGNATURE` → GET /meta/cli-version.
 */
export const CLI_SIGNING_PUBLIC_KEY = `
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARlfzjaFhe5bhRrMp/ZuH6sVqg/S7f8B1dliuF21iDTw=
-----END PUBLIC KEY-----
`;
