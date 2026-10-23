/**
 * `generator.*` messages — the cli asks the server to generate project assets through the org's connected generator
 * provider (PixelLab first). The provider token never reaches the worker: the server makes every provider call.
 * cli → server (with reply), relayed by the cli-server to the server's internal gRPC. A long-running generation
 * returns a `jobId` the cli polls; finished images are fetched one at a time (each reply stays small).
 * @adr 0614
 */

/** What a generation produces, in 4PM's own vocabulary (each provider adapter maps it to its API). */
export type GeneratorCapability = "image.pixel" | "character.directions" | "animation.frames" | "tileset";

/** The provider-neutral parameters of one generation. */
export interface GeneratorParams {
  description: string;
  width: number;
  height: number;
  /** character.directions: 4 or 8 views. */
  directions?: number;
  /** animation.frames: how many frames (and the first frame, PNG base64). */
  frames?: number;
  firstFrame?: string;
  /** tileset: the two terrains and the transition between them. */
  lower?: string;
  upper?: string;
  transition?: string;
  /** e.g. "side", "low top-down" — passed through when the provider knows it. */
  view?: string;
  noBackground?: boolean;
  seed?: number;
}

/** `generator.run` request. */
export interface GeneratorRunRequest {
  provider: string;
  capability: GeneratorCapability;
  params: GeneratorParams;
}

/** One generated image (PNG, base64) with a label (a direction, a frame number, a tile id). */
export interface GeneratorImage {
  label: string;
  base64: string;
}

/** A finished generation's images, or a job to poll; `error` = the code of a refusal (`GENERATOR_*`). */
export interface GeneratorRunReply {
  images?: GeneratorImage[];
  jobId?: string;
  error?: string;
  message?: string;
}

/** `generator.poll` request. */
export interface GeneratorPollRequest {
  provider: string;
  jobId: string;
}

/** A job's state; once `done`, how many images it produced (fetch each with `generator.image`). */
export interface GeneratorPollReply {
  state: "pending" | "done" | "failed";
  count?: number;
  error?: string;
  message?: string;
}

/** `generator.image` request — one image of a finished job. */
export interface GeneratorImageRequest {
  provider: string;
  jobId: string;
  index: number;
}

/** One image of a finished job (or an `error`). */
export interface GeneratorImageReply {
  image?: GeneratorImage;
  error?: string;
  message?: string;
}
