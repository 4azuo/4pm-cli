/**
 * Vendored from @4pm/ws (messages/external-service.ts) by scripts/vendor-shared.mjs — do not edit.
 */
export type ExternalServiceCapability = "image.pixel" | "character.directions" | "animation.frames" | "tileset";
export interface ExternalServiceParams {
    description: string;
    width: number;
    height: number;
    directions?: number;
    frames?: number;
    firstFrame?: string;
    lower?: string;
    upper?: string;
    transition?: string;
    view?: string;
    noBackground?: boolean;
    seed?: number;
}
export interface ExternalServiceRunRequest {
    provider: string;
    capability: ExternalServiceCapability;
    params: ExternalServiceParams;
}
export interface ExternalServiceImage {
    label: string;
    base64: string;
}
export interface ExternalServiceRunReply {
    images?: ExternalServiceImage[];
    jobId?: string;
    error?: string;
    message?: string;
}
export interface ExternalServicePollRequest {
    provider: string;
    jobId: string;
}
export interface ExternalServicePollReply {
    state: "pending" | "done" | "failed";
    count?: number;
    error?: string;
    message?: string;
}
export interface ExternalServiceImageRequest {
    provider: string;
    jobId: string;
    index: number;
}
export interface ExternalServiceImageReply {
    image?: ExternalServiceImage;
    error?: string;
    message?: string;
}
