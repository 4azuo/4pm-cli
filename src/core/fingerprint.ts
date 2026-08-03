/**
 * Physical-machine fingerprint: the cli collects the OS machine-id + hostname and
 * hashes them (sha256) into an identifier — the server groups N cli on the same
 * machine into one worker. Renaming the host / reinstalling the OS changes the
 * fingerprint (Q-B: ADMIN merges manually).
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";

/** Result of collecting the machine identity. */
export interface MachineFingerprint {
  /** sha256(machineId + hostname) — sent to the server on pair/connect. */
  fingerprint: string;
  /** Hostname — the server uses it as the default worker name. */
  hostname: string;
}

/**
 * Read the machine-id per OS; if unavailable ⇒ fall back to the hostname
 * (a less stable fingerprint, but still usable).
 */
function readMachineId(): string {
  try {
    if (process.platform === "linux") {
      for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        if (existsSync(path)) return readFileSync(path, "utf8").trim();
      }
    }
    if (process.platform === "darwin") {
      const out = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: "utf8" },
      );
      const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (match?.[1]) return match[1];
    }
    if (process.platform === "win32") {
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: "utf8" },
      );
      const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      if (match?.[1]) return match[1];
    }
  } catch {
    // fall through to the fallback
  }
  return hostname();
}

/**
 * Collect the machine fingerprint (machine-id + hostname).
 */
export function collectFingerprint(): MachineFingerprint {
  const host = hostname();
  const fingerprint = createHash("sha256")
    .update(`${readMachineId()}:${host}`)
    .digest("hex");
  return { fingerprint, hostname: host };
}
