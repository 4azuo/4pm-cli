/**
 * DTO for the meta domain (21-api/meta-0001 — cli-version, ADR-0015).
 */

/** Self-download tarball source for machines without npm (ADR-0015). */
export interface CliDownloadSource {
  tarballUrl: string;
  /** sha256 hex of the tarball — the cli verifies it before replacing. */
  checksum: string;
  /** Signature (optional) — verified with the public key embedded in the cli. */
  signature?: string;
}

/** Data 200 GET /meta/cli-version (meta-0001). */
export interface CliVersionResponse {
  /** Latest version (semver). */
  latest: string;
  /** Minimum version the server still accepts at the WS handshake. */
  minSupported: string;
  source: CliDownloadSource;
}
