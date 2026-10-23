/**
 * Tests of the cli generator helper: direct images, a polled job, and a refusal.
 */
import { describe, expect, it } from "vitest";
import { WsChannels } from "@4pm/ws";
import { GeneratorError, generateImages, type GeneratorTransport } from "./autonomous-generator";

/** A transport answering from a script of replies per channel. */
function transport(replies: Record<string, unknown[]>): GeneratorTransport {
  return {
    request: async <T,>(channel: string) => {
      const next = replies[channel]?.shift();
      if (next === undefined) throw new Error(`no reply for ${channel}`);
      return next as T;
    },
  };
}
const params = { description: "a knight", width: 64, height: 64 };
const deadlineMs = Date.now() + 60_000;

describe("generateImages", () => {
  it("returns the images of a quick generation", async () => {
    const ws = transport({ [WsChannels.GENERATOR_RUN]: [{ images: [{ label: "image", base64: "AAA" }] }] });
    expect(await generateImages(ws, "pixellab", "image.pixel", params, { deadlineMs })).toEqual([{ label: "image", base64: "AAA" }]);
  });

  it("polls a job and fetches each image", async () => {
    const ws = transport({
      [WsChannels.GENERATOR_RUN]: [{ jobId: "j" }],
      [WsChannels.GENERATOR_POLL]: [{ state: "done", count: 2 }],
      [WsChannels.GENERATOR_IMAGE]: [{ image: { label: "south", base64: "S" } }, { image: { label: "north", base64: "N" } }],
    });
    const out = await generateImages(ws, "pixellab", "character.directions", params, { deadlineMs });
    expect(out.map((i) => i.label)).toEqual(["south", "north"]);
  });

  it("throws the server's refusal", async () => {
    const ws = transport({ [WsChannels.GENERATOR_RUN]: [{ error: "GENERATOR_NO_CREDITS", message: "no credits" }] });
    await expect(generateImages(ws, "pixellab", "image.pixel", params, { deadlineMs })).rejects.toBeInstanceOf(GeneratorError);
  });
});
