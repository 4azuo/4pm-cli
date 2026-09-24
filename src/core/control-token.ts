/**
 * Control-channel token (ADR-0320 hardening) — the shared secret a `4pm attach` / `4pm auto-run` client
 * must present before the headless daemon accepts control frames. The daemon writes a fresh random
 * secret (mode 0600) at startup; clients read it. This is defense-in-depth over the OS boundary (a
 * same-OS-user process can still read the 0600 file — the real isolation is the OS user + container);
 * it blocks other users and stray/non-4pm local connections. I/O helpers live here so `control-protocol`
 * stays pure types.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { CONTROL_TOKEN_FILE } from "./control-protocol";

/** The token file path under a profile dir. */
export function controlTokenPath(profileDir: string): string {
  return join(profileDir, CONTROL_TOKEN_FILE);
}

/**
 * Generate a fresh 256-bit token, write it 0600, and return it (daemon, on startup). Written with an
 * explicit mode AND chmod'd so a permissive umask or a pre-existing file can't leave it world-readable.
 */
export function writeControlToken(profileDir: string): string {
  const token = randomBytes(32).toString("hex");
  const path = controlTokenPath(profileDir);
  writeFileSync(path, token, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort — mkdir/chmod may fail on a read-only mount; the socket 0600 still gates access */
  }
  return token;
}

/** Read the current token (client). `null` when it can't be read (no daemon / no access). */
export function readControlToken(profileDir: string): string | null {
  try {
    const v = readFileSync(controlTokenPath(profileDir), "utf8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Constant-time token comparison (avoids a timing side-channel); false on any length/format mismatch. */
export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
