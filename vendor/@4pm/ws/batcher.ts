/**
 * OutputBatcher — batch cli → server output by interval/size threshold, with a
 * buffer cap to prevent OOM (cli-ws 0003).
 */

/** Batcher config (defaults per cli-ws 0003). */
export interface OutputBatcherOptions {
  flushIntervalMs?: number;
  flushSizeKb?: number;
  maxBufferKb?: number;
  /**
   * Hard cap (KiB) on the size of a **single** emitted frame (ADR-0322). A large AI output —
   * `claude -p --output-format json` emits its whole result in one stdout burst — arrives as one
   * huge `push`, and `flush` would otherwise emit the entire buffer as ONE `command.output` frame.
   * Bounded by the cli-server WS `maxPayload`, an over-cap frame is rejected (`WS_ERR_UNSUPPORTED_
   * MESSAGE_LENGTH`, 1009), which — before ADR-0322 — crashed the whole cli-server. `flush` slices
   * the buffer into frames no larger than this so a single burst can never exceed the transport cap.
   */
  maxFrameKb?: number;
  overflow?: "backpressure" | "truncate";
  /** Receive one batch to send. */
  onFlush: (chunk: string, truncated: boolean) => void;
  /** Called when the source must pause/resume (overflow = backpressure). */
  onPressure?: (paused: boolean) => void;
}

export class OutputBatcher {
  private readonly opts: Required<
    Pick<OutputBatcherOptions, "flushIntervalMs" | "flushSizeKb" | "maxBufferKb" | "maxFrameKb" | "overflow">
  > &
    OutputBatcherOptions;
  private buffer = "";
  private truncated = false;
  private paused = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: OutputBatcherOptions) {
    this.opts = {
      flushIntervalMs: 200,
      flushSizeKb: 64,
      maxBufferKb: 512,
      // Well under the cli-server WS maxPayload (8 MiB — ADR-0322) even after the enveloped frame's
      // AES-256-GCM + base64 + JSON inflation (~1.37×), and small enough to keep SSE replay chunks light.
      maxFrameKb: 256,
      overflow: "backpressure",
      ...options,
    };
  }

  /**
   * Push more output; flush at the threshold; apply backpressure/truncate when
   * over the cap.
   */
  push(chunk: string): void {
    if (this.buffer.length >= this.opts.maxBufferKb * 1024) {
      if (this.opts.overflow === "truncate") {
        this.truncated = true;
        return;
      }
      if (!this.paused) {
        this.paused = true;
        this.opts.onPressure?.(true);
      }
      // backpressure: the source must pause; still keep what was read so nothing is lost
    }
    this.buffer += chunk;
    if (this.buffer.length >= this.opts.flushSizeKb * 1024) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.opts.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  /**
   * Flush the current buffer immediately, splitting it into frames no larger than `maxFrameKb`
   * (ADR-0322) so a single large burst never produces one over-`maxPayload` WS frame. The
   * `truncated` flag is carried on the last frame only.
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0 && !this.truncated) return;
    const buf = this.buffer;
    const truncated = this.truncated;
    this.buffer = "";
    this.truncated = false;
    if (this.paused) {
      this.paused = false;
      this.opts.onPressure?.(false);
    }
    const max = this.opts.maxFrameKb * 1024;
    if (buf.length <= max) {
      this.opts.onFlush(buf, truncated);
      return;
    }
    // Slice by JS string length (code units): the receiver concatenates the chunks back, so a
    // multi-byte char split across a boundary reassembles losslessly (we never send raw bytes).
    for (let i = 0; i < buf.length; i += max) {
      const slice = buf.slice(i, i + max);
      const isLast = i + max >= buf.length;
      this.opts.onFlush(slice, isLast && truncated);
    }
  }
}
