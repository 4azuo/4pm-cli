/**
 * Asset generation from the cli: ask the server to run a generation through the org's provider (`generator.run`),
 * poll its job (`generator.poll`) and fetch each finished image (`generator.image`). The provider token stays on the
 * server; a refusal comes back as a `GeneratorError` with its `GENERATOR_*` code.
 * @adr 0614
 */
import { WsChannels, type GeneratorCapability, type GeneratorImage, type GeneratorImageReply, type GeneratorParams, type GeneratorPollReply, type GeneratorRunReply } from "@4pm/ws";

/** What the helper needs from the WS client. */
export interface GeneratorTransport {
  request<T>(channel: typeof WsChannels.GENERATOR_RUN | typeof WsChannels.GENERATOR_POLL | typeof WsChannels.GENERATOR_IMAGE, data: unknown, timeoutMs?: number): Promise<T>;
}

/** A generation the server refused or the provider failed. */
export class GeneratorError extends Error {
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
  if (reply.error) throw new GeneratorError(reply.error, reply.message ?? reply.error);
}

/**
 * Generate and return the images: directly for a quick capability, else after polling the job until `deadlineMs`
 * (epoch ms). `signal` stops the wait (a stopped run).
 */
export async function generateImages(
  ws: GeneratorTransport,
  provider: string,
  capability: GeneratorCapability,
  params: GeneratorParams,
  opts: { deadlineMs: number; signal?: AbortSignal },
): Promise<GeneratorImage[]> {
  const run = await ws.request<GeneratorRunReply>(WsChannels.GENERATOR_RUN, { provider, capability, params }, CALL_TIMEOUT_MS);
  check(run);
  if (run.images?.length) return run.images;
  if (!run.jobId) throw new GeneratorError("GENERATOR_PROVIDER_ERROR", "the provider returned neither images nor a job");
  let count: number;
  for (;;) {
    if (opts.signal?.aborted) throw new GeneratorError("GENERATOR_STOPPED", "stopped");
    if (Date.now() > opts.deadlineMs) throw new GeneratorError("GENERATOR_TIMEOUT", "the generation did not finish in time");
    const poll = await ws.request<GeneratorPollReply>(WsChannels.GENERATOR_POLL, { provider, jobId: run.jobId }, CALL_TIMEOUT_MS);
    check(poll);
    if (poll.state === "failed") throw new GeneratorError("GENERATOR_PROVIDER_ERROR", poll.message ?? "the generation failed");
    if (poll.state === "done") {
      count = poll.count ?? 0;
      break;
    }
    await sleep(POLL_EVERY_MS, opts.signal);
  }
  const images: GeneratorImage[] = [];
  for (let index = 0; index < count; index++) {
    const reply = await ws.request<GeneratorImageReply>(WsChannels.GENERATOR_IMAGE, { provider, jobId: run.jobId, index }, CALL_TIMEOUT_MS);
    check(reply);
    if (reply.image) images.push(reply.image);
  }
  return images;
}
