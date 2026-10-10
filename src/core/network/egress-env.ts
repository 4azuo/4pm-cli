/**
 * Egress environment of agent processes (Networks) — the proxy variables every AI run and agent-uid
 * process gets: `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` with a per-run token, `NO_PROXY` for loopback,
 * the proxy in `JAVA_TOOL_OPTIONS`, a `ProxyCommand` on `GIT_SSH_COMMAND` (`4pm net-connect`) and
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. The run comes from an async context
 * ({@link withEgressRun}); without one, a cli serving a project attributes the process to the project,
 * an idle one to the strict project-less policy.
 * @adr 0439
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { egressProxyPort } from "./egress-proxy";
import { defaultEgressRun, mintEgressToken, type EgressRun, type EgressRunKind } from "./egress-state";

/** The run of the current async flow. */
const runCtx = new AsyncLocalStorage<Partial<EgressRun>>();

/** Run `fn` as (part of) one run — nested calls refine the outer context (e.g. a task id, then a run id). */
export function withEgressRun<T>(run: Partial<EgressRun>, fn: () => T): T {
  return runCtx.run({ ...(runCtx.getStore() ?? {}), ...run }, fn);
}

/** The env name of the proxy URL `4pm net-connect` reads. */
export const EGRESS_PROXY_ENV = "FOURPM_EGRESS_PROXY";

/** The current run, completed with defaults (`kind` from the served project). */
function currentRun(extra?: Partial<EgressRun>): EgressRun {
  const store = { ...(runCtx.getStore() ?? {}), ...(extra ?? {}) };
  const kind: EgressRunKind = store.kind ?? defaultEgressRun().kind;
  return { kind, ...(store.runId ? { runId: store.runId } : {}), ...(store.taskId ? { taskId: store.taskId } : {}) };
}

/**
 * The proxy variables for one child process, or `{}` when the proxy is not running. `base` is the env being
 * built (to extend an existing `GIT_SSH_COMMAND` / `JAVA_TOOL_OPTIONS` instead of replacing it).
 */
export function egressEnv(base: NodeJS.ProcessEnv = {}, extra?: Partial<EgressRun>): Record<string, string> {
  const port = egressProxyPort();
  if (!port) return {};
  const token = mintEgressToken(currentRun(extra));
  const url = `http://run:${token}@127.0.0.1:${port}`;
  // Extend (never stack) an existing ssh command / Java options: drop a proxy hop added by an earlier call.
  const ssh = (base.GIT_SSH_COMMAND || "ssh").replace(/\s+-o ProxyCommand="4pm net-connect %h %p"/g, "").trim() || "ssh";
  const javaBase = (base.JAVA_TOOL_OPTIONS ?? "").replace(/\s*-Dhttps?\.(?:proxyHost|proxyPort|nonProxyHosts)=\S+/g, "").trim();
  const java = [javaBase, `-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=${port} -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=${port}`, "-Dhttp.nonProxyHosts=localhost|127.0.0.1"]
    .filter(Boolean)
    .join(" ");
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    ALL_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    all_proxy: url,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    [EGRESS_PROXY_ENV]: url,
    GIT_SSH_COMMAND: `${ssh} -o ProxyCommand="4pm net-connect %h %p"`,
    JAVA_TOOL_OPTIONS: java,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}
