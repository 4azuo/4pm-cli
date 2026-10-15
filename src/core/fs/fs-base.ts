/**
 * The `target: "base"` side of the web file channels: list / read / download from `origin/<base>` and
 * write / mutate / upload as one commit pushed to `<base>` (`core/git/base-edit`). Each function returns
 * `null` when the project has no remote base, and the handler then falls back to the working tree. Reply
 * shapes match the working-tree functions (absolute `path`), plus `target` / `blob` / `commit`.
 * @adr 0511
 */
import { basename, join, resolve } from "node:path";
import { FS_TRANSFER_MAX_BYTES } from "@4pm/dto";
import type {
  FsDownloadReply,
  FsListReply,
  FsMutateReply,
  FsMutateRequest,
  FsReadReply,
  FsUploadReply,
  FsWriteReply,
  FsWriteRequest,
} from "@4pm/ws";
import { BaseEditError, baseKind, commitToBase, listBaseDir, locateBase, readBaseFile, rootRel, type BaseEdit } from "../git/base-edit";
import { guessMime } from "./fs-transfer";

/** Max bytes returned by a text read (mirrors the working-tree read). */
const READ_MAX_BYTES = 256 * 1024;
/** Max bytes of a text write (mirrors the working-tree write). */
const WRITE_MAX_BYTES = 2 * 1024 * 1024;

/** Who commits: the web user (trailer) and the machine user (author). */
export interface BaseActor {
  by?: string;
  machineUsername?: string;
}

/** The absolute path of a root-relative path (reply shape of the working-tree functions). */
function abs(root: string, rel: string): string {
  return rel ? join(resolve(root), rel) : resolve(root);
}

/** An error message the server maps (the code itself for a `BaseEditError`). */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** List a folder of `origin/<base>` (+ the ref / commit read, shown by the web). */
export async function baseList(root: string, path: string): Promise<FsListReply | null> {
  const rel = rootRel(root, path && path.trim() ? path : ".") ?? "";
  const listed = await listBaseDir(root, rel);
  if (!listed) return null;
  return { path: abs(root, rel), entries: listed.entries, target: "base", ref: listed.ref, commit: listed.commit };
}

/** Read a text file of `origin/<base>` (+ its blob id for the next write). */
export async function baseRead(root: string, path: string): Promise<FsReadReply | null> {
  const rel = rootRel(root, path);
  if (rel === null) return null;
  const r = await readBaseFile(root, rel);
  if (!r) return null;
  const buf = r.data ?? Buffer.alloc(0);
  return {
    path: abs(root, rel),
    content: buf.subarray(0, READ_MAX_BYTES).toString("utf8"),
    truncated: buf.byteLength > READ_MAX_BYTES,
    target: "base",
    blob: r.blob,
  };
}

/** Download a file of `origin/<base>`. */
export async function baseDownload(root: string, path: string): Promise<FsDownloadReply | null> {
  const rel = rootRel(root, path);
  if (rel === null) return { error: "path escapes the project root" };
  const r = await readBaseFile(root, rel);
  if (!r) return null;
  if (!r.data) return { error: "not a file" };
  if (r.data.byteLength > FS_TRANSFER_MAX_BYTES) return { error: `file too large (max ${FS_TRANSFER_MAX_BYTES} bytes)` };
  return { contentBase64: r.data.toString("base64"), contentType: guessMime(rel), name: basename(rel), size: r.data.byteLength };
}

/** Commit edits that all live in the repo owning `anchor`; null ⇒ no base. */
async function commit(
  root: string,
  anchor: string,
  build: (toRepo: (rootPath: string) => string | null) => BaseEdit[] | string,
  message: string,
  actor: BaseActor,
): Promise<{ commit?: string } | { error: string } | null> {
  const loc = await locateBase(root, anchor);
  if (!loc) return null;
  // Every path must be inside the same repo as the anchor (no cross-submodule move).
  const toRepo = (p: string): string | null => {
    const rel = rootRel(root, p);
    if (rel === null) return null;
    if (!loc.repoRel) return rel;
    return rel === loc.repoRel ? "" : rel.startsWith(loc.repoRel + "/") ? rel.slice(loc.repoRel.length + 1) : null;
  };
  const edits = build(toRepo);
  if (typeof edits === "string") return { error: edits };
  try {
    const sha = await commitToBase(root, loc, edits, { message, ...actor });
    return sha ? { commit: sha } : {};
  } catch (err) {
    if (err instanceof BaseEditError && err.message === "no remote base") return null;
    return { error: errText(err) };
  }
}

/** Write a text file as a commit on `<base>`. */
export async function baseWrite(root: string, req: FsWriteRequest, actor: BaseActor): Promise<FsWriteReply | null> {
  const rel = rootRel(root, req.path);
  if (rel === null || !rel) return { ok: false, path: req.path, bytes: 0, error: "path escapes the project root" };
  const bytes = Buffer.byteLength(req.content, "utf8");
  if (bytes > WRITE_MAX_BYTES) return { ok: false, path: abs(root, rel), bytes: 0, error: `content too large (max ${WRITE_MAX_BYTES} bytes)` };
  const res = await commit(
    root,
    rel,
    (toRepo) => {
      const p = toRepo(rel);
      if (!p) return "path escapes the project root";
      return [{ op: "put", path: p, data: Buffer.from(req.content, "utf8"), ...(req.expectBlob !== undefined ? { expectBlob: req.expectBlob } : {}) }];
    },
    `web: update ${rel}`,
    actor,
  );
  if (!res) return null;
  if ("error" in res) return { ok: false, path: abs(root, rel), bytes: 0, error: res.error, target: "base" };
  return { ok: true, path: abs(root, rel), bytes, target: "base", ...res };
}

/** Upload bytes as a commit on `<base>`. */
export async function baseUpload(root: string, path: string, contentBase64: string, actor: BaseActor): Promise<FsUploadReply | null> {
  const rel = rootRel(root, path);
  if (rel === null || !rel) return { ok: false, path, bytes: 0, error: "path escapes the project root" };
  const buf = Buffer.from(contentBase64, "base64");
  if (buf.byteLength > FS_TRANSFER_MAX_BYTES) return { ok: false, path: abs(root, rel), bytes: 0, error: `file too large (max ${FS_TRANSFER_MAX_BYTES} bytes)` };
  const res = await commit(
    root,
    rel,
    (toRepo) => {
      const p = toRepo(rel);
      return p ? [{ op: "put", path: p, data: buf }] : "path escapes the project root";
    },
    `web: upload ${rel}`,
    actor,
  );
  if (!res) return null;
  if ("error" in res) return { ok: false, path: abs(root, rel), bytes: 0, error: res.error, target: "base" };
  return { ok: true, path: abs(root, rel), bytes: buf.byteLength, target: "base", ...res };
}

/** Create / move / delete as a commit on `<base>`. */
export async function baseMutate(root: string, req: FsMutateRequest, actor: BaseActor): Promise<FsMutateReply | null> {
  const anchor = req.op === "move" ? (req.from ?? "") : (req.path ?? "");
  const rel = rootRel(root, anchor);
  if (rel === null) return { ok: false, path: anchor, error: "path escapes the project root" };
  if (!rel) return { ok: false, path: abs(root, rel), error: req.op === "move" ? "cannot move the project root" : req.op === "delete" ? "cannot delete the project root" : "path escapes the project root" };
  let outPath = abs(root, rel);
  // Dropping onto an existing folder ⇒ move INTO it (keep the source name), like the working tree.
  let moveTo: string | null = null;
  if (req.op === "move") {
    moveTo = rootRel(root, req.to ?? "");
    if (moveTo !== null && (await baseKind(root, moveTo)) === "dir") moveTo = moveTo ? `${moveTo}/${basename(rel)}` : basename(rel);
  }
  const res = await commit(
    root,
    rel,
    (toRepo) => {
      const p = toRepo(rel);
      if (!p) return "path escapes the project root";
      switch (req.op) {
        case "mkdir":
          return [{ op: "mkdir", path: p }];
        case "create": {
          const content = req.content ?? "";
          if (Buffer.byteLength(content, "utf8") > WRITE_MAX_BYTES) return `content too large (max ${WRITE_MAX_BYTES} bytes)`;
          return [{ op: "put", path: p, data: Buffer.from(content, "utf8"), expectBlob: null }];
        }
        case "delete":
          return [{ op: "delete", path: p }];
        case "move": {
          const toRel = moveTo;
          if (toRel === null || !toRel) return "path escapes the project root";
          const to = toRepo(toRel);
          if (to === null || !to) return "cannot move across repositories";
          outPath = abs(root, toRel);
          return [{ op: "move", from: p, to }];
        }
        default:
          return "unknown op";
      }
    },
    `web: ${req.op} ${rel}${moveTo ? ` -> ${moveTo}` : ""}`,
    actor,
  );
  if (!res) return null;
  if ("error" in res) {
    const error = res.error === "FILE_CHANGED_UPSTREAM" && req.op === "create" ? "already exists" : res.error;
    return { ok: false, path: outPath, error, target: "base" };
  }
  return { ok: true, path: outPath, target: "base", ...res };
}
