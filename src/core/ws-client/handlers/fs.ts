/**
 * Worker filesystem channel handlers (machine-0007/0027/0059): browse/read/write/mutate files
 * inside the served physic project root for the dashboard Files + Git tabs. Every op is clamped
 * to `ctx.physicRoot` so the web can only go inward, never out.
 */
import {
  WsChannels,
  type FsListRequest,
  type FsMutateRequest,
  type FsReadRequest,
  type FsWriteRequest,
  type WsEnvelope,
} from "@4pm/ws";
import { listDir } from "../../fs-browse";
import { readWorkerFile } from "../../fs-read";
import { writeWorkerFile } from "../../fs-write";
import { mutateFs } from "../../fs-mutate";
import type { WsHandlerCtx } from "../context";

/** Route the fs.* channels; returns true when the message was handled. */
export function handleFsChannels(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  payload: Record<string, unknown>,
): boolean {
  switch (message.channel) {
    case WsChannels.FS_LIST:
      // Request/reply (machine-0007): reply on the same channel via replyTo. Scoped to
      // the physic project root — the browser can only go inward, never out.
      void listDir((payload as unknown as FsListRequest).path, ctx.physicRoot).then((reply) =>
        ctx.send(WsChannels.FS_LIST, reply, message.id),
      );
      return true;
    case WsChannels.FS_READ:
      // Request/reply — read a file for the dashboard files tab.
      void readWorkerFile((payload as unknown as FsReadRequest).path).then((reply) =>
        ctx.send(WsChannels.FS_READ, reply, message.id),
      );
      return true;
    case WsChannels.FS_WRITE: {
      // Request/reply (machine-0027, ADR-0151): write a file, clamped to the physic root —
      // the Git tab's manual conflict resolution.
      const req = payload as unknown as FsWriteRequest;
      void writeWorkerFile(ctx.physicRoot, req.path, req.content).then((reply) =>
        ctx.send(WsChannels.FS_WRITE, reply, message.id),
      );
      return true;
    }
    case WsChannels.FS_MUTATE: {
      // Request/reply (machine-0059, ADR-0260): create/rename/move/delete a file or folder,
      // each op clamped to the physic root (`project.files_write`).
      const req = payload as unknown as FsMutateRequest;
      void mutateFs(ctx.physicRoot, req).then((reply) =>
        ctx.send(WsChannels.FS_MUTATE, reply, message.id),
      );
      return true;
    }
    default:
      return false;
  }
}
