/**
 * Worker resource sampler (ADR-0214 / ADR-0218) — collects the worker's live resources for the
 * `machine.metrics` stream. In a container it reads **cgroup v2** so the numbers are the container's
 * own allotment (never the host's); on bare-metal / VM (no cgroup) it falls back to `os.*` (there the
 * worker is the whole machine). Beyond CPU / RAM / disk it collects the rest of the portable,
 * container-accurate cgroup v2 set (ADR-0218): CPU throttling (`cpu.stat`), PSI pressure
 * (`cpu/memory/io.pressure`), memory breakdown + swap (`memory.stat` / `memory.swap.*`), block-I/O
 * throughput (`io.stat`), process count (`pids.*`) and OOM-kill events (`memory.events`). Rate/delta
 * metrics keep the previous counters. Host-level temperature/GPU and network are out of scope. Never
 * throws — a read failure degrades to the `os` source and any unavailable field is simply omitted.
 */
import { statfs, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { totalmem, freemem, cpus, platform, arch } from "node:os";
import type { WorkerResources } from "@4pm/dto";

const CGROUP = "/sys/fs/cgroup";
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

/** Read a cgroup file as text, or null when unavailable. */
async function readCgroup(file: string): Promise<string | null> {
  try {
    return (await readFile(`${CGROUP}/${file}`, "utf8")).trim();
  } catch {
    return null;
  }
}

/** Parse `key value` lines (memory.stat / memory.events) into a lookup. */
function parseKv(text: string | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!text) return map;
  for (const line of text.split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined) {
      const n = Number(v);
      if (Number.isFinite(n)) map.set(k, n);
    }
  }
  return map;
}

/** PSI `some avg10` (0–100) from a `*.pressure` file, or undefined when unavailable. */
function parsePressureSome(text: string | null): number | undefined {
  if (!text) return undefined;
  const some = text.split("\n").find((l) => l.startsWith("some "));
  const m = some?.match(/avg10=([\d.]+)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? clampPct(n) : undefined;
}

/** Sum `rbytes`/`wbytes` across all devices in `io.stat`. */
function parseIoStat(text: string | null): { rBytes: number; wBytes: number } | null {
  if (!text) return null;
  let rBytes = 0;
  let wBytes = 0;
  for (const line of text.split("\n")) {
    const r = line.match(/\brbytes=(\d+)/);
    const w = line.match(/\bwbytes=(\d+)/);
    if (r) rBytes += Number(r[1]);
    if (w) wBytes += Number(w[1]);
  }
  return { rBytes, wBytes };
}

/** Parse a single cgroup value that may be the literal `max` (⇒ null = unlimited). */
function parseMaybeMax(text: string | null): number | null {
  if (text === null) return null;
  if (text === "max") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Previous counters for cgroup rate/delta metrics (CPU%, throttling, block I/O). */
interface CgroupPrev {
  /** cumulative CPU usage microseconds (`cpu.stat` usage_usec). */
  usageUsec: number;
  /** cumulative throttled periods (`cpu.stat` nr_throttled). */
  nrThrottled: number;
  /** cumulative CPU periods (`cpu.stat` nr_periods). */
  nrPeriods: number;
  /** cumulative bytes read/written (`io.stat`). */
  ioR: number;
  ioW: number;
  /** wall clock (ms) of the sample. */
  wallMs: number;
}

/** Previous CPU counters for the `os` fallback delta (idle/total ticks). */
interface OsPrev {
  busy: number;
  total: number;
}

/**
 * Create a sampler bound to a disk path (the worker's working dir). Returns `sample()` which
 * yields one `WorkerResources` snapshot; the first call seeds the baselines (reports 0% / omits
 * rate-based fields until the next sample).
 */
export function createWorkerMetricsSampler(diskPath: string): { sample: () => Promise<WorkerResources> } {
  const cgroupV2 = existsSync(`${CGROUP}/cpu.stat`) && existsSync(`${CGROUP}/memory.current`);
  let cgPrev: CgroupPrev | null = null;
  let osPrev: OsPrev | null = null;

  /** cgroup CPU count from `cpu.max` ("quota period"); "max" ⇒ host cores. */
  async function cgroupCpuCount(): Promise<number> {
    const raw = await readCgroup("cpu.max");
    if (raw) {
      const [quota, period] = raw.split(/\s+/);
      if (quota && quota !== "max" && period) {
        const n = Number(quota) / Number(period);
        if (n > 0) return Math.max(1, Math.round(n * 10) / 10);
      }
    }
    return cpus().length;
  }

  /** os CPU% from the aggregate idle/total tick delta across all cores. */
  function osCpuPct(): number {
    let busy = 0;
    let total = 0;
    for (const c of cpus()) {
      const t = c.times;
      busy += t.user + t.nice + t.sys + t.irq;
      total += t.user + t.nice + t.sys + t.irq + t.idle;
    }
    if (!osPrev) {
      osPrev = { busy, total };
      return 0;
    }
    const dBusy = busy - osPrev.busy;
    const dTotal = total - osPrev.total;
    osPrev = { busy, total };
    if (dTotal <= 0) return 0;
    return clampPct((dBusy / dTotal) * 100);
  }

  /** Disk used/total (GB) of the filesystem holding the worker's working dir. */
  async function disk(): Promise<{ usedGb: number; totalGb: number }> {
    try {
      const fs = await statfs(diskPath);
      const total = fs.blocks * fs.bsize;
      const free = fs.bavail * fs.bsize;
      return { usedGb: round1((total - free) / GB), totalGb: round1(total / GB) };
    } catch {
      return { usedGb: 0, totalGb: 0 };
    }
  }

  /**
   * Collect the extended cgroup v2 metrics (ADR-0218). Reads the CPU counters (already needed for
   * CPU%), PSI pressure, memory breakdown/swap, block I/O and pids; folds the delta-based ones
   * (CPU%, throttling, I/O throughput) against `cgPrev`. Best-effort — every field is optional.
   */
  async function cgroupExtended(cpuCount: number, now: number): Promise<{
    cpuPct: number;
    extra: Partial<WorkerResources>;
  }> {
    const [cpuStatRaw, memStatRaw, ioStatRaw, cpuPsi, memPsi, ioPsi, swapCurRaw, swapMaxRaw, memEventsRaw, pidsCurRaw, pidsMaxRaw] =
      await Promise.all([
        readCgroup("cpu.stat"),
        readCgroup("memory.stat"),
        readCgroup("io.stat"),
        readCgroup("cpu.pressure"),
        readCgroup("memory.pressure"),
        readCgroup("io.pressure"),
        readCgroup("memory.swap.current"),
        readCgroup("memory.swap.max"),
        readCgroup("memory.events"),
        readCgroup("pids.current"),
        readCgroup("pids.max"),
      ]);

    const cpuStat = parseKv(cpuStatRaw);
    const usageUsec = cpuStat.get("usage_usec") ?? NaN;
    const nrThrottled = cpuStat.get("nr_throttled") ?? 0;
    const nrPeriods = cpuStat.get("nr_periods") ?? 0;
    const io = parseIoStat(ioStatRaw);

    const extra: Partial<WorkerResources> = {};

    // Instantaneous (no delta) metrics — always present when their file is readable.
    extra.cpuPressurePct = parsePressureSome(cpuPsi);
    extra.memPressurePct = parsePressureSome(memPsi);
    extra.ioPressurePct = parsePressureSome(ioPsi);

    const memStat = parseKv(memStatRaw);
    if (memStat.has("anon")) extra.memAnonMb = Math.round(memStat.get("anon")! / MB);
    if (memStat.has("file")) extra.memCacheMb = Math.round(memStat.get("file")! / MB);

    if (swapCurRaw !== null) extra.swapUsedMb = Math.round(Number(swapCurRaw) / MB);
    if (swapMaxRaw !== null) {
      const max = parseMaybeMax(swapMaxRaw);
      extra.swapTotalMb = max === null ? null : Math.round(max / MB);
    }

    const memEvents = parseKv(memEventsRaw);
    if (memEvents.has("oom_kill")) extra.oomKills = memEvents.get("oom_kill")!;

    if (pidsCurRaw !== null) {
      const n = Number(pidsCurRaw);
      if (Number.isFinite(n)) extra.pidsCurrent = n;
    }
    if (pidsMaxRaw !== null) extra.pidsMax = parseMaybeMax(pidsMaxRaw);

    // Delta-based metrics — computed only when a previous sample exists.
    let cpuPct = 0;
    if (Number.isFinite(usageUsec)) {
      if (cgPrev) {
        const dWallUsec = (now - cgPrev.wallMs) * 1000;
        if (dWallUsec > 0) cpuPct = clampPct(((usageUsec - cgPrev.usageUsec) / (dWallUsec * cpuCount)) * 100);
        const dPeriods = nrPeriods - cgPrev.nrPeriods;
        if (dPeriods > 0) extra.cpuThrottledPct = clampPct(((nrThrottled - cgPrev.nrThrottled) / dPeriods) * 100);
        if (io) {
          const dSec = (now - cgPrev.wallMs) / 1000;
          if (dSec > 0) {
            extra.diskReadMbps = round1((io.rBytes - cgPrev.ioR) / MB / dSec);
            extra.diskWriteMbps = round1((io.wBytes - cgPrev.ioW) / MB / dSec);
          }
        }
      }
      cgPrev = {
        usageUsec,
        nrThrottled,
        nrPeriods,
        ioR: io?.rBytes ?? 0,
        ioW: io?.wBytes ?? 0,
        wallMs: now,
      };
    }

    return { cpuPct, extra };
  }

  return {
    async sample(): Promise<WorkerResources> {
      const now = Date.now();
      const at = new Date(now).toISOString();
      const { usedGb: diskUsedGb, totalGb: diskTotalGb } = await disk();
      const base = { platform: platform(), arch: arch(), diskUsedGb, diskTotalGb, at };

      if (cgroupV2) {
        const memMaxRaw = await readCgroup("memory.max");
        const memCurRaw = await readCgroup("memory.current");
        const memTotalBytes =
          memMaxRaw && memMaxRaw !== "max" ? Number(memMaxRaw) : totalmem();
        const memUsedBytes = memCurRaw ? Number(memCurRaw) : totalmem() - freemem();
        const cpuCount = await cgroupCpuCount();
        const { cpuPct, extra } = await cgroupExtended(cpuCount, now);
        return {
          ...base,
          source: "cgroup",
          cpuCount,
          cpuPct,
          memUsedMb: Math.round(memUsedBytes / MB),
          memTotalMb: Math.round(memTotalBytes / MB),
          ...extra,
        };
      }

      const total = totalmem();
      return {
        ...base,
        source: "os",
        cpuCount: cpus().length,
        cpuPct: osCpuPct(),
        memUsedMb: Math.round((total - freemem()) / MB),
        memTotalMb: Math.round(total / MB),
      };
    },
  };
}

/** Clamp a percentage into [0, 100] rounded to 1 decimal. */
function clampPct(n: number): number {
  return round1(Math.min(100, Math.max(0, n)));
}

/** Round to 1 decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
