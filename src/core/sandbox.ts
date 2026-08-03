/**
 * Sandbox egress policy on the worker (ADR-0192 §3). The cli process cannot firewall its own child
 * processes' network, so enforcement lives at the container/egress-proxy layer; this module only
 * **materializes** the server-managed allowlist (delivered on the daily `ws_token`) to a canonical
 * file the container entrypoint / egress proxy reads: `<profileDir>/sandbox-egress.txt`, one host
 * per line. `network:'open'` (or no policy) removes the file (no restriction).
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSandboxSettings } from "@4pm/dto";

/** The canonical egress-allowlist file the container reads (per profile). */
export const EGRESS_ALLOWLIST_FILE = "sandbox-egress.txt";

/**
 * Write (or clear) the egress allowlist for the serving project. When the policy restricts egress
 * (`network:'allowlist'`) the allowed hosts are written one per line; otherwise the file is removed.
 * Never throws — a sandbox-config write must not take the cli down (ADR-0075).
 */
export function writeEgressAllowlist(
  profileDir: string,
  policy: ProjectSandboxSettings | null,
): void {
  const path = join(profileDir, EGRESS_ALLOWLIST_FILE);
  try {
    if (policy && policy.network === "allowlist") {
      // Header marks the file machine-generated; the proxy/entrypoint ignores `#` lines.
      const body = ["# 4PM egress allowlist (ADR-0192) — generated from the project sandbox policy"]
        .concat(policy.allowedDomains)
        .join("\n");
      writeFileSync(path, `${body}\n`, "utf8");
    } else {
      rmSync(path, { force: true });
    }
  } catch {
    // Best-effort — leave the previous file in place on error.
  }
}
