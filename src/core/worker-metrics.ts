/**
 * Worker resource sampler (ADR-0214) — collects the worker's live CPU / RAM / disk for the
 * `machine.metrics` stream. In a container it reads **cgroup v2** limits (`memory.max`, `cpu.max`,
 * `cpu.stat`) so the numbers are the container's own allotment (never the host's); on bare-metal /
 * VM (no cgroup limit) it falls back to `os.*` (there the worker is the whole machine). CPU% is a
 * delta between successive samples, so the sampler keeps the previous CPU counters. Never throws —
 * a read failure degrades to the `os` source.
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

/** Previous CPU counters for the delta (cgroup usage_usec or os idle/total ticks). */
interface CpuPrev {
  /** cgroup: cumulative usage microseconds; os: cumulative busy ticks. */
  busy: number;
  /** Wall clock (ms) for cgroup; total ticks for os. */
  ref: number;
}

/**
 * Create a sampler bound to a disk path (the worker's working dir). Returns `sample()` which
 * yields one `WorkerResources` snapshot; the first call seeds the CPU baseline (reports 0%).
 */
export function createWorkerMetricsSampler(diskPath: string): { sample: () => Promise<WorkerResources> } {
  const cgroupV2 = existsSync(`${CGROUP}/cpu.stat`) && existsSync(`${CGROUP}/memory.current`);
  let prev: CpuPrev | null = null;

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

  /** cgroup CPU% from the `usage_usec` delta over wall time, normalized by cpu count. */
  async function cgroupCpuPct(cpuCount: number): Promise<number> {
    const stat = await readCgroup("cpu.stat");
    const m = stat?.match(/usage_usec\s+(\d+)/);
    const usageUsec = m ? Number(m[1]) : NaN;
    const now = Date.now();
    if (!Number.isFinite(usageUsec)) return 0;
    if (!prev) {
      prev = { busy: usageUsec, ref: now };
      return 0;
    }
    const dUsage = usageUsec - prev.busy; // microseconds of CPU time
    const dWall = (now - prev.ref) * 1000; // microseconds of wall time
    prev = { busy: usageUsec, ref: now };
    if (dWall <= 0) return 0;
    return clampPct((dUsage / (dWall * cpuCount)) * 100);
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
    if (!prev) {
      prev = { busy, ref: total };
      return 0;
    }
    const dBusy = busy - prev.busy;
    const dTotal = total - prev.ref;
    prev = { busy, ref: total };
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

  return {
    async sample(): Promise<WorkerResources> {
      const at = new Date().toISOString();
      const { usedGb: diskUsedGb, totalGb: diskTotalGb } = await disk();
      const base = { platform: platform(), arch: arch(), diskUsedGb, diskTotalGb, at };

      if (cgroupV2) {
        const memMaxRaw = await readCgroup("memory.max");
        const memCurRaw = await readCgroup("memory.current");
        const memTotalBytes =
          memMaxRaw && memMaxRaw !== "max" ? Number(memMaxRaw) : totalmem();
        const memUsedBytes = memCurRaw ? Number(memCurRaw) : totalmem() - freemem();
        const cpuCount = await cgroupCpuCount();
        const cpuPct = await cgroupCpuPct(cpuCount);
        return {
          ...base,
          source: "cgroup",
          cpuCount,
          cpuPct,
          memUsedMb: Math.round(memUsedBytes / MB),
          memTotalMb: Math.round(memTotalBytes / MB),
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
