/**
 * ensureDir — mkdir -p with a friendly, actionable error when the mounted home is not
 * writable (ADR-0192). The cli runs as the unprivileged "node" user (uid 1000); a reused
 * root-owned Docker volume or a host bind-mount shadows the image's node-owned home, so a
 * raw `EACCES: mkdir` is opaque. We rethrow with the one-time chown fix instead.
 */
import { mkdirSync } from "node:fs";

/** GHCR image used in the fix hint — kept in sync with the docs / web container tab. */
const CLI_IMAGE = "ghcr.io/4azuo/4pm-cli:full";

/**
 * Create `dir` recursively; on EACCES/EPERM rethrow a clear message telling the operator to
 * chown the mount to uid 1000 once (the cli stays fully non-root). Other errors pass through.
 */
export function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `Cannot write "${dir}" — the mounted home is owned by root. A reused Docker volume ` +
          `or a host bind-mount shadows the image's node-owned home, and the cli runs as the ` +
          `unprivileged "node" user (uid 1000), so it cannot chown it.\n` +
          `Fix the mount ONCE, then retry:\n` +
          `  docker run --rm --user 0 --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE \\\n` +
          `    --security-opt=no-new-privileges --entrypoint chown \\\n` +
          `    -v <volume>:/home/node/.4pm ${CLI_IMAGE} -R node:node /home/node/.4pm\n` +
          `(host bind-mount: run \`sudo chown -R 1000:1000 <host-path>\` on the host instead;` +
          ` a FRESH named volume needs none of this.)`,
      );
    }
    throw err;
  }
}
