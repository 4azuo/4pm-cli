/**
 * listenPrivateSocket tests — the socket inode is created with the restricted mode and the
 * process umask is restored afterwards.
 * @adr 0447
 */
import { createServer } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listenPrivateSocket } from "./private-socket";

describe.skipIf(process.platform === "win32")("listenPrivateSocket", () => {
  it("creates an owner-only socket and restores the umask", async () => {
    const dir = mkdtempSync(join(tmpdir(), "4pm-sock-"));
    const path = join(dir, "c.sock");
    const before = process.umask();
    const server = createServer();
    await new Promise<void>((resolve) => listenPrivateSocket(server, path, 0o600, resolve));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(process.umask()).toBe(before);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
});
