/**
 * `externalService.*` messages — the cli asks the server to generate project assets through the org's connected external service
 * provider (PixelLab first). The provider token never reaches the worker: the server makes every provider call.
 * cli → server (with reply), relayed by the cli-server to the server's internal gRPC. A long-running generation
 * returns a `jobId` the cli polls; finished images are fetched one at a time (each reply stays small).
 * @adr 0614
 */

/** What a generation produces, in 4PM's own vocabulary (each provider adapter maps it to its API). */
export type ExternalServiceCapability = "image.pixel" | "character.directions" | "animation.frames" | "tileset";

/** The provider-neutral parameters of one generation. */
export interface ExternalServiceParams {
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

/** `externalService.run` request. */
export interface ExternalServiceRunRequest {
  provider: string;
  capability: ExternalServiceCapability;
  params: ExternalServiceParams;
}

/** One generated image (PNG, base64) with a label (a direction, a frame number, a tile id). */
export interface ExternalServiceImage {
  label: string;
  base64: string;
}

/** A finished generation's images, or a job to poll; `error` = the code of a refusal (`EXTERNAL_SERVICE_*`). */
export interface ExternalServiceRunReply {
  images?: ExternalServiceImage[];
  jobId?: string;
  error?: string;
  message?: string;
}

/** `externalService.poll` request. */
export interface ExternalServicePollRequest {
  provider: string;
  jobId: string;
}

/** A job's state; once `done`, how many images it produced (fetch each with `externalService.image`). */
export interface ExternalServicePollReply {
  state: "pending" | "done" | "failed";
  count?: number;
  error?: string;
  message?: string;
}

/** `externalService.image` request — one image of a finished job. */
export interface ExternalServiceImageRequest {
  provider: string;
  jobId: string;
  index: number;
}

/** One image of a finished job (or an `error`). */
export interface ExternalServiceImageReply {
  image?: ExternalServiceImage;
  error?: string;
  message?: string;
}
