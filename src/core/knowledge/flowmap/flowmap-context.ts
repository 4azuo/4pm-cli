/**
 * `flowmap.context` — candidate source files of a new flow map: the graph (Doc Header + code headers + imports) is
 * walked from the chosen features / nodes up to `depth` edges in either direction, then the RAG hits of the
 * description are added when RAG is installed. Nearest first, at most 60 files. Never throws.
 * @adr 0698 @arch 0076
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { FlowMapContextReply, FlowMapContextRequest } from "@4pm/ws";
import { buildGraph } from "../../worker/graph";
import { ragQuery } from "../rag";

/** Most files returned. */
const MAX_FILES = 60;
/** RAG hits asked for. */
const RAG_K = 10;

/** One candidate while it is collected. */
interface Candidate {
  path: string;
  why: string;
  distance: number;
}

/** Build the candidate list for a request on the project at `root`. */
export async function flowMapContext(root: string, req: FlowMapContextRequest): Promise<FlowMapContextReply> {
  try {
    const depth = Math.min(4, Math.max(1, Math.trunc(req.depth) || 2));
    const graph = await buildGraph(root, "all");
    const byId = new Map(graph.nodes.filter((n) => n.layer !== "er").map((n) => [n.id, n]));
    const features = new Set((req.features ?? []).map((f) => f.toLowerCase()));
    const wanted = new Set(req.nodes ?? []);
    const found = new Map<string, Candidate>();
    const seen = new Map<string, number>();
    let frontier: string[] = [];
    for (const n of byId.values()) {
      const hitFeature = (n.feature ?? []).find((f) => features.has(f.toLowerCase()));
      if (wanted.has(n.id) || wanted.has(n.file) || hitFeature) {
        seen.set(n.id, 0);
        frontier.push(n.id);
        found.set(n.file, { path: n.file, why: hitFeature ? `feature: ${hitFeature}` : "start node", distance: 0 });
      }
    }
    // Undirected adjacency with the edge type, for the BFS.
    const adj = new Map<string, { to: string; type: string }[]>();
    for (const e of graph.edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push({ to: e.to, type: e.type });
      (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push({ to: e.from, type: e.type });
    }
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const { to, type } of adj.get(id) ?? []) {
          if (seen.has(to)) continue;
          seen.set(to, d);
          next.push(to);
          const node = byId.get(to)!;
          if (!found.has(node.file)) found.set(node.file, { path: node.file, why: `graph: ${type}`, distance: d });
        }
      }
      frontier = next;
    }
    let ragInfo = { installed: false, used: false };
    if (req.rag && req.q && req.q.trim()) {
      const reply = await ragQuery(root, req.q.slice(0, 2000), RAG_K);
      ragInfo = { installed: !reply.error, used: reply.results.length > 0 };
      for (const r of reply.results) {
        if (!found.has(r.path)) found.set(r.path, { path: r.path, why: `RAG ${r.score.toFixed(2)}`, distance: depth + 1 });
      }
    }
    const picked = [...found.values()].sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path)).slice(0, MAX_FILES);
    const files = await Promise.all(
      picked.map(async (c) => ({ ...c, bytes: await stat(join(root, c.path)).then((s) => s.size).catch(() => 0) })),
    );
    return { ok: true, files: files.filter((f) => f.bytes > 0), rag: ragInfo };
  } catch (err) {
    return { ok: false, code: "FLOWMAP_CONTEXT_FAILED", error: err instanceof Error ? err.message : String(err) };
  }
}
