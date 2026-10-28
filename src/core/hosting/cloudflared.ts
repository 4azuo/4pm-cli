/**
 * `cloudflared` for worker hosting: installed on first use into the tools dir (the release binary for this OS / arch,
 * like gh / glab), then run detached per environment — a quick tunnel to the edge port (its `trycloudflare.com` URL
 * read from the log) or a named tunnel with the connector token passed in the environment (never on the command line).
 * Connection state is read from the log. Outbound only: 443 / 7844 to Cloudflare.
 * @adr 0664 @arch 0070
 */
import { chmod, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../common/logger/logger";
import { toolBinDir } from "../worker/agent-ai-cli";
import { downloadTo } from "../worker/toolchain";
import { readText, startDetached } from "./hosting-process";

/** Release asset names per platform / arch (Linux and macOS workers). */
function assetName(): string | null {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!arch) return null;
  if (process.platform === "linux") return `cloudflared-linux-${arch}`;
  return null;
}

/** The installed binary path. */
export function cloudflaredPath(): string {
  return join(toolBinDir(), "cloudflared");
}

let installing: Promise<boolean> | null = null;

/** Make sure `cloudflared` is installed (single-flight); false when it cannot be. */
export function ensureCloudflared(): Promise<boolean> {
  if (existsSync(cloudflaredPath())) return Promise.resolve(true);
  installing ??= (async () => {
    try {
      const asset = assetName();
      if (!asset) throw new Error(`no cloudflared build for ${process.platform}/${process.arch}`);
      await mkdir(toolBinDir(), { recursive: true });
      const tmp = `${cloudflaredPath()}.download`;
      await downloadTo(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`, tmp);
      await chmod(tmp, 0o755);
      await rename(tmp, cloudflaredPath());
      logger.info("hosting.cloudflared.installed", { path: cloudflaredPath() });
      return true;
    } catch (err) {
      logger.warn("hosting.cloudflared.install.failed", { error: String(err) });
      return false;
    } finally {
      installing = null;
    }
  })();
  return installing;
}

/** Start a tunnel connector; returns its pid. */
export function startTunnel(kind: "quick" | "named", edgePort: number, token: string | null, logFile: string): number {
  const args =
    kind === "quick"
      ? ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${edgePort}`]
      : ["tunnel", "--no-autoupdate", "run"];
  const env = { ...process.env, ...(kind === "named" && token ? { TUNNEL_TOKEN: token } : {}) };
  return startDetached(cloudflaredPath(), args, { env, logFile });
}

/** What the connector's log says: the quick URL and whether a connection is registered. */
export function tunnelLogState(logFile: string): { url: string | null; connected: boolean } {
  const text = readText(logFile).slice(-64 * 1024);
  const urls = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  return { url: urls ? urls[urls.length - 1]! : null, connected: /Registered tunnel connection/i.test(text) };
}
