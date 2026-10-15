/**
 * Ed25519 public keys that verify the cli self-update tarball signature (PEM SPKI). The signature check
 * is **mandatory**: a release is accepted when one of these keys verifies it, so a key
 * rotation ships one release that embeds both the new and the outgoing key, then drops the old one.
 * Their private counterparts sign releases in CI; the server exposes the signature via
 * `CLI_TARBALL_SIGNATURE` → GET /meta/cli-version. An empty list fails the build (signing.test.ts).
 * @adr 0015 @adr 0508
 */
export const CLI_SIGNING_PUBLIC_KEYS: readonly string[] = [
  `
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARlfzjaFhe5bhRrMp/ZuH6sVqg/S7f8B1dliuF21iDTw=
-----END PUBLIC KEY-----
`,
];
