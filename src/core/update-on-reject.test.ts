/**
 * Tests for the self-update after a version reject: waits for idle, maps every update outcome to
 * restart / retry / locked, and never throws.
 * @adr 0547
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateToLatest = vi.fn();
let locked = false;

vi.mock("./update", () => ({ cliUpdateLocked: () => locked, updateToLatest }));

const { work } = await import("./session/work-tracker");
const { updateAfterVersionReject } = await import("./update-on-reject");

describe("updateAfterVersionReject", () => {
  beforeEach(() => {
    updateToLatest.mockReset();
    locked = false;
  });

  it("updates when idle and holds a cliUpdate lease while installing", async () => {
    updateToLatest.mockImplementation(async () => {
      expect(work.kinds()).toContain("cliUpdate");
      return { action: "updated", version: "1.80.0" };
    });
    await expect(updateAfterVersionReject("https://api.example", 10)).resolves.toEqual({
      action: "updated",
      version: "1.80.0",
    });
    expect(updateToLatest).toHaveBeenCalledWith("https://api.example");
    expect(work.idle()).toBe(true);
  });

  it("stops on an update-locked image without dialing the server", async () => {
    locked = true;
    await expect(updateAfterVersionReject("https://api.example", 10)).resolves.toEqual({ action: "locked" });
    expect(updateToLatest).not.toHaveBeenCalled();
  });

  it("retries later while work is still running", async () => {
    const lease = work.begin("aiRun", "run-1");
    try {
      const out = await updateAfterVersionReject("https://api.example", 10);
      expect(out).toMatchObject({ action: "retry" });
      expect(updateToLatest).not.toHaveBeenCalled();
    } finally {
      lease.end();
    }
  });

  it("retries on a failed update, no newer release, or an unreachable server", async () => {
    updateToLatest.mockResolvedValueOnce({ action: "failed", error: "bad signature", toVersion: "1.80.0" });
    await expect(updateAfterVersionReject("u", 10)).resolves.toEqual({ action: "retry", reason: "bad signature" });
    updateToLatest.mockResolvedValueOnce({ action: "already-latest", version: "1.69.0" });
    await expect(updateAfterVersionReject("u", 10)).resolves.toMatchObject({ action: "retry" });
    updateToLatest.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(updateAfterVersionReject("u", 10)).resolves.toMatchObject({ action: "retry" });
    expect(work.idle()).toBe(true);
  });
});
