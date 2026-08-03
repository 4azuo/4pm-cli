/**
 * Rented-worker ssh deploy key (git.ssh-key channel — ADR-0173). The keypair is generated
 * **on the worker** with `ssh-keygen` and stored under the paired profile dir; git is
 * pointed at it via a global `core.sshCommand`. Only the public key + fingerprint ever
 * leave the worker — the private key never does. `generate` (re)creates the pair, `get`
 * reads the current public key, `delete` removes the pair + the git config (called on
 * rental release so a later server compromise cannot read the renter's repos).
 */
import { execFile } from "node:child_process";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitSshKeyReply } from "@4pm/ws";

const run = promisify(execFile);

/** The private/public key paths for a profile (`<profileDir>/.ssh/id_4pm[.pub]`). */
function keyPaths(profileDir: string): { dir: string; key: string; pub: string } {
  const dir = join(profileDir, ".ssh");
  const key = join(dir, "id_4pm");
  return { dir, key, pub: `${key}.pub` };
}

/** Read the public key text, or null when the key does not exist. */
async function readPublicKey(pub: string): Promise<string | null> {
  try {
    return (await readFile(pub, "utf8")).trim();
  } catch {
    return null;
  }
}

/** SHA256 fingerprint of the public key (via `ssh-keygen -lf`), or null when unavailable. */
async function fingerprintOf(pub: string): Promise<string | null> {
  try {
    const { stdout } = await run("ssh-keygen", ["-lf", pub], { timeout: 5000 });
    return stdout.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Point git at the profile's key for every ssh remote on this worker (rented, dedicated). */
async function configureGit(key: string): Promise<void> {
  await run(
    "git",
    ["config", "--global", "core.sshCommand", `ssh -i ${key} -o IdentitiesOnly=yes`],
    { timeout: 5000 },
  ).catch(() => undefined);
}

/** Generate a fresh ed25519 keypair on the worker (overwriting any existing one). */
async function generate(profileDir: string): Promise<GitSshKeyReply> {
  const { dir, key, pub } = keyPaths(profileDir);
  await mkdir(dir, { recursive: true });
  await rm(key, { force: true });
  await rm(pub, { force: true });
  await run("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-C", "4pm-deploy-key"], {
    timeout: 15_000,
  });
  await configureGit(key);
  return { publicKey: await readPublicKey(pub), fingerprint: await fingerprintOf(pub) };
}

/** Remove the keypair + the git ssh config (rental release / explicit remove). */
async function remove(profileDir: string): Promise<GitSshKeyReply> {
  const { key, pub } = keyPaths(profileDir);
  await rm(key, { force: true });
  await rm(pub, { force: true });
  await run("git", ["config", "--global", "--unset", "core.sshCommand"], { timeout: 5000 }).catch(
    () => undefined,
  );
  return { publicKey: null, fingerprint: null };
}

/** Read the current public key + fingerprint (null when none has been generated). */
async function get(profileDir: string): Promise<GitSshKeyReply> {
  const { pub } = keyPaths(profileDir);
  const publicKey = await readPublicKey(pub);
  return { publicKey, fingerprint: publicKey ? await fingerprintOf(pub) : null };
}

/** Handle a git.ssh-key request for the given op. Never throws — errors map to a null key. */
export async function manageSshKey(
  op: "generate" | "get" | "delete",
  profileDir: string,
): Promise<GitSshKeyReply> {
  try {
    if (op === "generate") return await generate(profileDir);
    if (op === "delete") return await remove(profileDir);
    return await get(profileDir);
  } catch {
    return { publicKey: null, fingerprint: null };
  }
}
