/**
 * One-shot migration off the OS crontab. Before the in-process scheduler, the engine was
 * armed by a crontab line (`<root>/.claude/hooks/autonomous-tick.sh`) AND `paused:false`. On the first
 * connect of an upgraded cli, per profile: a legacy line for the served root is removed (so it can't
 * tick twice beside the scheduler) and the `paused` state carries over; with NO line the engine was
 * effectively off, so a lingering `paused:false` is forced to `true` — an upgrade must never start an
 * engine nobody had armed. A marker in the profile dir makes it run once. Best-effort, never throws.
 * @adr 0392
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger } from "../../common/logger/logger";
import { autonomousConfigPath, readAutonomousConfig, writeAutonomousConfig } from "./autonomous-config";

const run = promisify(execFile);

const MARKER = ".autonomous-scheduler-migrated";
const TICK_REL = ".claude/hooks/autonomous-tick.sh";

/** Current crontab text; empty when there is none or `crontab` is unusable (no cron on the worker). */
async function crontabList(): Promise<string> {
  try {
    const { stdout } = await run("crontab", ["-l"], { timeout: 10_000 });
    return stdout;
  } catch {
    return "";
  }
}

/** Replace the crontab with `content` (via `crontab -`); false when it could not be written. */
async function crontabSet(content: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("crontab", ["-"], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(content.endsWith("\n") ? content : content + "\n");
  });
}

/** Migrate this profile's served root off the legacy crontab tick, once (see the file header). */
export async function migrateLegacyCron(root: string, profileDir: string): Promise<void> {
  const marker = join(profileDir, MARKER);
  if (existsSync(marker)) return;
  try {
    const script = join(root, TICK_REL);
    const lines = (await crontabList()).split("\n");
    const armed = lines.some((l) => l.includes(script) && !l.trim().startsWith("#"));
    if (armed) {
      // Keep `paused` as-is (the engine was armed); only drop the line. Retry next connect on failure.
      const kept = lines.filter((l) => l.trim() && !l.includes(script));
      if (!(await crontabSet(kept.join("\n")))) return;
    } else if (existsSync(autonomousConfigPath(profileDir))) {
      const cfg = await readAutonomousConfig(profileDir);
      if (!cfg.paused) await writeAutonomousConfig(profileDir, { ...cfg, paused: true });
    }
    await writeFile(marker, new Date().toISOString() + "\n", "utf8");
    logger.info("autonomous.scheduler.migrated", { hadCronLine: armed });
  } catch (err) {
    logger.warn("autonomous.scheduler.migrateFailed", { error: err instanceof Error ? err.message : String(err) });
  }
}
