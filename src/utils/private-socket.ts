/**
 * Bind a Unix socket with its permissions already restricted. `server.listen(path)` creates the
 * socket inode with the process umask, so a later `chmod` leaves a short window where another local
 * user could connect. Setting the umask for the (synchronous) bind closes that window; the old umask
 * is restored right after. The caller's `chmod` stays as the belt-and-braces step.
 * @adr 0447
 */
import type { Server } from "node:net";

/** `listen` on `socketPath` so the inode is created with at most `mode` permissions. */
export function listenPrivateSocket(server: Server, socketPath: string, mode: number, onListening: () => void): void {
  const previous = process.umask(0o777 & ~mode);
  try {
    // A pipe bind (no cluster, no DNS) happens synchronously inside listen().
    server.listen(socketPath, onListening);
  } finally {
    process.umask(previous);
  }
}
