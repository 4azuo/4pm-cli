/**
 * Asset generation from the cli: ask the server to run a generation through the org's provider (`externalService.run`),
 * poll its job (`externalService.poll`) and fetch each finished image (`externalService.image`). The provider token stays on the
 * server; a refusal comes back as a `ExternalServiceError` with its `EXTERNAL_SERVICE_*` code.
 * @adr 0614
 */
import { WsChannels, type ExternalServiceCapability, type ExternalServiceImage, type ExternalServiceImageReply, type ExternalServiceParams, type ExternalServicePollReply, type ExternalServiceRunReply } from "@4pm/ws";

/** What the helper needs from the WS client. */
export interface ExternalServiceTransport {
  request<T>(channel: typeof WsChannels.EXTERNAL_SERVICE_RUN | typeof WsChannels.EXTERNAL_SERVICE_POLL | typeof WsChannels.EXTERNAL_SERVICE_IMAGE, data: unknown, timeoutMs?: number): Promise<T>;
}

/** A generation the server refused or the provider failed. */
export class ExternalServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One provider call may take this long (the server's own cap is 120 s). */
const CALL_TIMEOUT_MS = 150_000;
/** Pause between polls of a running job. */
const POLL_EVERY_MS = 5_000;

/** Sleep (aborted early when `signal` fires). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Throw the reply's refusal, if any. */
function check(reply: { error?: string; message?: string }): void {
  if (reply.error) throw new ExternalServiceError(reply.error, reply.message ?? reply.error);
}

/**
 * Generate and return the images: directly for a quick capability, else after polling the job until `deadlineMs`
 * (epoch ms). `signal` stops the wait (a stopped run).
 */
export async function generateImages(
  ws: ExternalServiceTransport,
  provider: string,
  capability: ExternalServiceCapability,
  params: ExternalServiceParams,
  opts: { deadlineMs: number; signal?: AbortSignal },
): Promise<ExternalServiceImage[]> {
  const run = await ws.request<ExternalServiceRunReply>(WsChannels.EXTERNAL_SERVICE_RUN, { provider, capability, params }, CALL_TIMEOUT_MS);
  check(run);
  if (run.images?.length) return run.images;
  if (!run.jobId) throw new ExternalServiceError("EXTERNAL_SERVICE_ERROR", "the provider returned neither images nor a job");
  let count: number;
  for (;;) {
    if (opts.signal?.aborted) throw new ExternalServiceError("EXTERNAL_SERVICE_STOPPED", "stopped");
    if (Date.now() > opts.deadlineMs) throw new ExternalServiceError("EXTERNAL_SERVICE_TIMEOUT", "the generation did not finish in time");
    const poll = await ws.request<ExternalServicePollReply>(WsChannels.EXTERNAL_SERVICE_POLL, { provider, jobId: run.jobId }, CALL_TIMEOUT_MS);
    check(poll);
    if (poll.state === "failed") throw new ExternalServiceError("EXTERNAL_SERVICE_ERROR", poll.message ?? "the generation failed");
    if (poll.state === "done") {
      count = poll.count ?? 0;
      break;
    }
    await sleep(POLL_EVERY_MS, opts.signal);
  }
  const images: ExternalServiceImage[] = [];
  for (let index = 0; index < count; index++) {
    const reply = await ws.request<ExternalServiceImageReply>(WsChannels.EXTERNAL_SERVICE_IMAGE, { provider, jobId: run.jobId, index }, CALL_TIMEOUT_MS);
    check(reply);
    if (reply.image) images.push(reply.image);
  }
  return images;
}
