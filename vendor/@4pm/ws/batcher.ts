/**
 * OutputBatcher — batch cli → server output by interval/size threshold, with a
 * buffer cap to prevent OOM (cli-ws 0003).
 */

/** Batcher config (defaults per cli-ws 0003). */
export interface OutputBatcherOptions {
  flushIntervalMs?: number;
  flushSizeKb?: number;
  maxBufferKb?: number;
  overflow?: "backpressure" | "truncate";
  /** Receive one batch to send. */
  onFlush: (chunk: string, truncated: boolean) => void;
  /** Called when the source must pause/resume (overflow = backpressure). */
  onPressure?: (paused: boolean) => void;
}

export class OutputBatcher {
  private readonly opts: Required<
    Pick<OutputBatcherOptions, "flushIntervalMs" | "flushSizeKb" | "maxBufferKb" | "overflow">
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
   * Flush the entire current buffer immediately (one batch).
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0 && !this.truncated) return;
    const chunk = this.buffer;
    const truncated = this.truncated;
    this.buffer = "";
    this.truncated = false;
    if (this.paused) {
      this.paused = false;
      this.opts.onPressure?.(false);
    }
    this.opts.onFlush(chunk, truncated);
  }
}
