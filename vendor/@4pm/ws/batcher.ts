/**
 * Vendored from @4pm/ws (batcher.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export interface OutputBatcherOptions {
    flushIntervalMs?: number;
    flushSizeKb?: number;
    maxBufferKb?: number;
    maxFrameKb?: number;
    overflow?: "backpressure" | "truncate";
    onFlush: (chunk: string, truncated: boolean) => void;
    onPressure?: (paused: boolean) => void;
}
export class OutputBatcher {
    private readonly opts: Required<Pick<OutputBatcherOptions, "flushIntervalMs" | "flushSizeKb" | "maxBufferKb" | "maxFrameKb" | "overflow">> & OutputBatcherOptions;
    private buffer = "";
    private truncated = false;
    private paused = false;
    private timer: NodeJS.Timeout | null = null;
    constructor(options: OutputBatcherOptions) {
        this.opts = {
            flushIntervalMs: 200,
            flushSizeKb: 64,
            maxBufferKb: 512,
            maxFrameKb: 256,
            overflow: "backpressure",
            ...options,
        };
    }
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
    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.buffer.length === 0 && !this.truncated)
            return;
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
        for (let i = 0; i < buf.length; i += max) {
            const slice = buf.slice(i, i + max);
            const isLast = i + max >= buf.length;
            this.opts.onFlush(slice, isLast && truncated);
        }
    }
}
