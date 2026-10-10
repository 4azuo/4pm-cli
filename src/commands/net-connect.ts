/**
 * `4pm net-connect <host> <port>` — ssh `ProxyCommand` for agent-run git over ssh (Networks): opens a
 * `CONNECT` tunnel through the cli's egress proxy (`FOURPM_EGRESS_PROXY`, set on every agent process) and
 * pipes stdin/stdout through it, so ssh is decided and logged like any other connection. Exits non-zero
 * with the proxy's reason when the host is blocked.
 * @adr 0439
 */
import { connect } from "node:net";

/** Run the tunnel; resolves when either side closes. */
export async function runNetConnect(host: string | undefined, port: string | undefined): Promise<void> {
  const proxy = process.env.FOURPM_EGRESS_PROXY ?? "";
  if (!host || !port || !proxy) {
    process.stderr.write("4pm net-connect: usage 4pm net-connect <host> <port> (needs FOURPM_EGRESS_PROXY)\n");
    process.exitCode = 2;
    return;
  }
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    process.stderr.write("4pm net-connect: invalid FOURPM_EGRESS_PROXY\n");
    process.exitCode = 2;
    return;
  }
  const auth = url.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}\r\n` : "";
  const target = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  await new Promise<void>((resolve) => {
    const sock = connect({ host: url.hostname, port: Number(url.port) }, () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onHead = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      sock.off("data", onHead);
      const head = buf.subarray(0, end).toString("latin1");
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        process.stderr.write(`4pm net-connect: ${buf.subarray(end + 4).toString("utf8").trim() || head.split("\r\n")[0]}\n`);
        process.exitCode = 1;
        sock.destroy();
        resolve();
        return;
      }
      const rest = buf.subarray(end + 4);
      if (rest.length) process.stdout.write(rest);
      process.stdin.pipe(sock);
      sock.pipe(process.stdout);
    };
    sock.on("data", onHead);
    sock.on("error", (err) => {
      process.stderr.write(`4pm net-connect: ${err.message}\n`);
      process.exitCode = 1;
      resolve();
    });
    sock.on("close", () => resolve());
  });
}
