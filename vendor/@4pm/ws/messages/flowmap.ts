/**
 * `flowmap.*` messages (server → cli, with reply) — flow maps on the serving worker: candidate sources from the graph +
 * RAG (`flowmap.context`), changes of the sources on `origin/<base>` since their pins (`flowmap.staleCheck`), and the
 * save of a version as a PR to the base with back-refs in the sources (`flowmap.savePlan` previews, `flowmap.save`
 * opens the PR on `4pm/flow/<slug>-v<n>` — never pushing `<base>`). Replies never throw: a refusal is `ok: false`
 * with a `code`.
 * @adr 0698 @arch 0076
 */

/** `flowmap.context` request. */
export interface FlowMapContextRequest {
  features: string[];
  nodes: string[];
  q?: string;
  depth: number;
  rag: boolean;
}

/** `flowmap.context` reply. */
export interface FlowMapContextReply {
  ok: boolean;
  files?: { path: string; why: string; bytes: number; distance: number }[];
  rag?: { installed: boolean; used: boolean };
  code?: string;
  error?: string;
}

/** `flowmap.staleCheck` request — each source with the commit after which a change counts. */
export interface FlowMapStaleCheckRequest {
  sources: { path: string; since: string }[];
  /** Paths whose unified diff `since..origin/<base>` is wanted (AI update). */
  diffs?: string[];
}

/** `flowmap.staleCheck` reply. */
export interface FlowMapStaleCheckReply {
  ok: boolean;
  base?: string;
  baseHead?: string;
  changed?: { path: string; commit: string; author: string; at: string; subject: string }[];
  diffs?: { path: string; diff: string }[];
  code?: string;
  error?: string;
}

/** The Doc Header facts of the diagram file the cli writes. */
export interface FlowMapDocMeta {
  /** `flow.<slug>` */
  id: string;
  title: string;
  features: string[];
  /** e.g. `4pm-flow-map v3 (2026-10-21)` */
  generatedBy: string;
}

/** `flowmap.savePlan` request. */
export interface FlowMapSavePlanRequest {
  slug: string;
  version: number;
  /** The model JSON (pretty-printed into the file). */
  modelJson: string;
  sources: { path: string; commit: string }[];
  folder: string;
  fileName: string;
  svg: string;
  docMeta: FlowMapDocMeta;
}

/** One file of a plan. */
export interface FlowMapPlanFileWire {
  path: string;
  status: "new" | "modified" | "unchanged" | "skipped";
  reason?: "no-header" | "missing" | "other-repo";
  diff?: string;
}

/** `flowmap.savePlan` reply. */
export interface FlowMapSavePlanReply {
  ok: boolean;
  base?: string;
  baseRef?: string;
  dirs?: string[];
  files?: FlowMapPlanFileWire[];
  planHash?: string;
  /** `FLOWMAP_PATH_INVALID` | `REPO_BUSY` | `FLOWMAP_SAVE_FAILED` */
  code?: string;
  error?: string;
}

/** `flowmap.save` request — `by` / `byLabel` are server-filled. The push runs under the link's own git scope. */
export interface FlowMapSaveRequest extends FlowMapSavePlanRequest {
  planHash: string;
  title: string;
  body: string;
  by: string;
  byLabel: string;
}

/** `flowmap.save` reply. `step` names where a `FLOWMAP_SAVE_FAILED` stopped. */
export interface FlowMapSaveReply {
  ok: boolean;
  branch?: string;
  prUrl?: string | null;
  number?: number | null;
  skipped?: { path: string; reason: string }[];
  /** `FLOWMAP_PLAN_CHANGED` | `FLOWMAP_PATH_INVALID` | `FLOWMAP_SAVE_FAILED` | `REPO_BUSY` */
  code?: string;
  step?: "base" | "push" | "pr";
  error?: string;
}
