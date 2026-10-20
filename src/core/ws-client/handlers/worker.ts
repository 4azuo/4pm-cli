/**
 * Worker-config channel handlers: the dashboard's per-project editors that read/write files inside
 * the served physic project — autonomous settings, subagents/skills, secrets,
 * agent tool permissions, packages, the dependency graph,
 * RAG, the paired profile's config.json, and the AI CLI's model
 * list. Each project
 * op is a no-op on an idle cli (no `physicRoot`); config.json ops target the profile dir directly.
 * The project ER (`er.read` / `er.write` — ADR-0453) and the system diagram (`diagram.read` / `diagram.write` —
 * ADR-0530) ride here too.
 * Book / ER writes are WorkTracker leases and are refused while the daemon drains.
 * @adr 0152 @adr 0153 @adr 0154 @adr 0183 @adr 0185 @adr 0155 @adr 0156 @adr 0157 @adr 0141 @adr 0394 @adr 0453 @adr 0505
 */
import { lifecycle } from "../../session/lifecycle";
import { work } from "../../session/work-tracker";
import {
  WsChannels,
  type AiModelsRequest,
  type AgentReadRequest,
  type AgentsListRequest,
  type AgentToolsReadRequest,
  type AgentToolsWriteRequest,
  type AgentWriteRequest,
  type AutonomousArchiveRequest,
  type AutonomousEvidenceRequest,
  type AutonomousEvidenceHistoryRequest,
  type AutonomousLogsRequest,
  type AutonomousReadRequest,
  type AutonomousWriteRequest,
  type ConfigReadReply,
  type ConfigWriteReply,
  type ConfigWriteRequest,
  type DiscussionsReadRequest,
  type DiagramReadRequest,
  type DiagramWriteRequest,
  type ErReadRequest,
  type ErWriteRequest,
  type GraphBuildRequest,
  type McpScanReply,
  type PackagesInstallRequest,
  type PackagesPackRequest,
  type PackagesRemoveRequest,
  type RagInstallRequest,
  type RagQueryRequest,
  type RagSettingsRequest,
  type SecretsWriteRequest,
  type WsEnvelope,
} from "@4pm/ws";
import { readAutonomous,
  readAutonomousArchive, readAutonomousEvidence, readAutonomousEvidenceHistory, readAutonomousLogs, writeAutonomous } from "../../autonomous/autonomous";
import { readDiscussions } from "../../autonomous/autonomous-discussions";
import { readEr, writeEr } from "../../autonomous/autonomous-er";
import { readDiagram, writeDiagram } from "../../autonomous/autonomous-diagram";
import { listAgents, readAgent, writeAgent } from "../../agent/agents";
import { readSecrets, writeSecrets } from "../../worker/secrets";
import { readAgentTools, writeAgentTools } from "../../agent/agent-tools";
import { scanMcpJson } from "../../../utils/agent-mcp";
import { installPackage, listPackages, packPackage, removePackage } from "../../agent/packages";
import { buildGraph } from "../../worker/graph";
import { ragInstall, ragQuery, ragReindex, ragSettings, ragStatus } from "../../knowledge/rag";
import { applyConfigText, readConfigText } from "../../profile/config-sync";
import { listAiModels } from "../../ai/ai-models";
import { readProfileConfig } from "../../../config/profile";
import { enabledAiProviders } from "../../../utils/ai-cli";
import { scheduleBookIndex } from "../../autonomous/autonomous-book-index";
import { notifyAutonomousChanged } from "../../autonomous/autonomous-policy";
import type { WsHandlerCtx } from "../context";

/** Route the worker-config channels; returns true when the message was handled. */
export function handleWorkerChannels(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  payload: Record<string, unknown>,
): boolean {
  switch (message.channel) {
    case WsChannels.AI_MODELS: {
      // Reply with the AI CLI's own model list — profile-wide, works on an idle cli too.
      void listAiModels(ctx.profileDir, payload as unknown as AiModelsRequest).then((reply) =>
        ctx.send(WsChannels.AI_MODELS, reply, message.id),
      );
      return true;
    }
    case WsChannels.AUTONOMOUS_READ:
      // Request/reply (machine-0028): settings + status + books (AI Done paged — ADR-0563) + the live sidecar entries.
      if (ctx.physicRoot) {
        void readAutonomous(ctx.physicRoot, ctx.profileDir, (payload ?? {}) as unknown as AutonomousReadRequest).then((reply) =>
          ctx.send(WsChannels.AUTONOMOUS_READ, reply, message.id),
        );
      }
      return true;
    case WsChannels.AUTONOMOUS_ARCHIVE: {
      // Request/reply (machine-0096): search the archived book rows on the books branch (ADR-0563).
      const root = ctx.physicRoot;
      const req = (payload ?? {}) as unknown as AutonomousArchiveRequest;
      void (root ? readAutonomousArchive(root, req) : Promise.resolve({ rows: [], total: 0, page: 1, size: 20, error: "no project served" })).then((reply) =>
        ctx.send(WsChannels.AUTONOMOUS_ARCHIVE, reply, message.id),
      );
      return true;
    }
    case WsChannels.DISCUSSIONS_READ: {
      // Request/reply (ADR-0454): discussion files on the books branch — blobs, contents, a batch commit.
      const root = ctx.physicRoot;
      const req = payload as unknown as DiscussionsReadRequest;
      void (root ? readDiscussions(root, req) : Promise.resolve({ files: [], error: "no project served" })).then((reply) =>
        ctx.send(WsChannels.DISCUSSIONS_READ, reply, message.id),
      );
      return true;
    }
    case WsChannels.AUTONOMOUS_EVIDENCE: {
      // Request/reply (machine-0073, ADR-0404): one committed book evidence file as base64.
      const req = payload as unknown as AutonomousEvidenceRequest;
      if (ctx.physicRoot) {
        void readAutonomousEvidence(ctx.physicRoot, ctx.profileDir, req).then((reply) =>
          ctx.send(WsChannels.AUTONOMOUS_EVIDENCE, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.AUTONOMOUS_EVIDENCE_HISTORY: {
      // Request/reply (machine-0085, ADR-0515): the commits that touched one mockup / sequence file.
      const req = payload as unknown as AutonomousEvidenceHistoryRequest;
      if (ctx.physicRoot) {
        void readAutonomousEvidenceHistory(ctx.physicRoot, ctx.profileDir, req).then((reply) =>
          ctx.send(WsChannels.AUTONOMOUS_EVIDENCE_HISTORY, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.ER_READ: {
      // Request/reply (machine-0077): the project ER on the books branch, optionally at a past version.
      const req = payload as unknown as ErReadRequest;
      if (ctx.physicRoot) {
        void readEr(ctx.physicRoot, ctx.profileDir, req)
          .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
          .then((reply) => ctx.send(WsChannels.ER_READ, reply, message.id));
      }
      return true;
    }
    case WsChannels.ER_WRITE: {
      // Request/reply (machine-0078/0079): save / withdraw / decide a change request; `by` is server-filled.
      const req = payload as unknown as ErWriteRequest;
      if (ctx.physicRoot) {
        const root = ctx.physicRoot;
        void work.track("bookWrite", "er.write", () => writeEr(root, ctx.profileDir, req)).then((reply) => ctx.send(WsChannels.ER_WRITE, reply, message.id));
      }
      return true;
    }
    case WsChannels.DIAGRAM_READ: {
      // Request/reply (machine-0087): the system diagram on the books branch, optionally at a past version.
      const req = payload as unknown as DiagramReadRequest;
      if (ctx.physicRoot) {
        void readDiagram(ctx.physicRoot, ctx.profileDir, req)
          .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
          .then((reply) => ctx.send(WsChannels.DIAGRAM_READ, reply, message.id));
      }
      return true;
    }
    case WsChannels.DIAGRAM_WRITE: {
      // Request/reply (machine-0088/0089): save / withdraw / decide a system-diagram change; `by` is server-filled.
      const req = payload as unknown as DiagramWriteRequest;
      if (ctx.physicRoot) {
        const root = ctx.physicRoot;
        void work.track("bookWrite", "diagram.write", () => writeDiagram(root, ctx.profileDir, req)).then((reply) => ctx.send(WsChannels.DIAGRAM_WRITE, reply, message.id));
      }
      return true;
    }
    case WsChannels.AUTONOMOUS_LOGS: {
      // Request/reply (machine-0030): tail one day's tick log.
      const req = payload as unknown as AutonomousLogsRequest;
      if (ctx.physicRoot) {
        void readAutonomousLogs(ctx.physicRoot, req.date).then((reply) =>
          ctx.send(WsChannels.AUTONOMOUS_LOGS, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.AUTONOMOUS_WRITE: {
      // Request/reply (machine-0029): settings/approvals/userTodo/cron. `by` (the
      // author, for trace) is filled server-side and rides the payload.
      const req = payload as unknown as AutonomousWriteRequest & { by?: string };
      // Draining for a restart: refuse the write (the web retries once the worker is back — ADR-0505).
      if (lifecycle.stopping) {
        ctx.send(WsChannels.AUTONOMOUS_WRITE, { ok: false, code: "CLI_RESTARTING", error: "CLI_RESTARTING" }, message.id);
        return true;
      }
      if (ctx.physicRoot) {
        const root = ctx.physicRoot;
        // A book write (side worktree + books-branch push) is a WorkTracker lease, so a restart waits for it.
        void work
          .track("bookWrite", `autonomous.write:${req.kind}`, () => writeAutonomous(root, ctx.profileDir, req, req.by ?? "unknown"))
          .then((reply) => {
            ctx.send(WsChannels.AUTONOMOUS_WRITE, reply, message.id);
            // The worker switch (`paused`) shows at once, not on the next heartbeat (ADR-0574).
            if (reply.ok && req.kind === "settings") notifyAutonomousChanged();
            // A web write moved the books — refresh the server's book index (ADR-0545).
            if (reply.ok) scheduleBookIndex(ctx);
          });
      }
      return true;
    }
    case WsChannels.AGENTS_LIST:
      // Request/reply (machine-0031): list subagents + skills.
      if (ctx.physicRoot) {
        void listAgents(ctx.physicRoot, (payload as unknown as AgentsListRequest).target).then((reply) =>
          ctx.send(WsChannels.AGENTS_LIST, reply, message.id),
        );
      }
      return true;
    case WsChannels.AGENTS_READ: {
      // Request/reply (machine-0032): one subagent/skill's content (+ subagent memory).
      const req = payload as unknown as AgentReadRequest;
      if (ctx.physicRoot) {
        void readAgent(ctx.physicRoot, req.kind, req.name, req.target).then((reply) =>
          ctx.send(WsChannels.AGENTS_READ, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.AGENTS_WRITE: {
      // Request/reply (machine-0033): create/edit or delete a subagent/skill.
      const req = payload as unknown as AgentWriteRequest;
      if (ctx.physicRoot) {
        void writeAgent(ctx.physicRoot, req, {
          ...(req.by ? { by: req.by } : {}),
          ...(ctx.machineUsername ? { machineUsername: ctx.machineUsername } : {}),
        }).then((reply) =>
          ctx.send(WsChannels.AGENTS_WRITE, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.SECRETS_READ:
      // Request/reply (machine-0034): security docs + placeholder keys (no values).
      if (ctx.physicRoot) {
        void readSecrets(ctx.physicRoot).then((reply) =>
          ctx.send(WsChannels.SECRETS_READ, reply, message.id),
        );
      }
      return true;
    case WsChannels.SECRETS_WRITE: {
      // Request/reply (machine-0035): write a doc, or set/rotate/delete a secret value.
      const req = payload as unknown as SecretsWriteRequest;
      if (ctx.physicRoot) {
        void writeSecrets(ctx.physicRoot, req).then((reply) =>
          ctx.send(WsChannels.SECRETS_WRITE, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.AGENT_TOOLS_READ: {
      // Request/reply (machine-0044): the permissions block of a settings file.
      const req = payload as unknown as AgentToolsReadRequest;
      if (ctx.physicRoot) {
        void readAgentTools(ctx.physicRoot, req.scope).then((reply) =>
          ctx.send(WsChannels.AGENT_TOOLS_READ, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.AGENT_TOOLS_WRITE: {
      // Request/reply (machine-0045): replace a permissions block (preserve rest + secrets deny).
      const req = payload as unknown as AgentToolsWriteRequest;
      if (ctx.physicRoot) {
        void writeAgentTools(ctx.physicRoot, req.scope, req.permissions).then((reply) =>
          ctx.send(WsChannels.AGENT_TOOLS_WRITE, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.MCP_SCAN: {
      // Request/reply (machine-0075, ADR-0427): parse + hash the repo `.mcp.json` files. Read-only —
      // nothing is started; the web compares the hashes with the approved list.
      const reply: McpScanReply = ctx.physicRoot
        ? { files: scanMcpJson(ctx.physicRoot) }
        : { files: [], error: "no project" };
      ctx.send(WsChannels.MCP_SCAN, reply, message.id);
      return true;
    }
    case WsChannels.PACKAGES_PACK: {
      // Request/reply (machine-0049): read a subagent/skill into a payload file set.
      const req = payload as unknown as PackagesPackRequest;
      if (ctx.physicRoot) {
        void packPackage(ctx.physicRoot, req.kind, req.name).then((reply) =>
          ctx.send(WsChannels.PACKAGES_PACK, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.PACKAGES_INSTALL: {
      // Request/reply (machine-0046): write a package version into.claude (drift-guarded).
      const req = payload as unknown as PackagesInstallRequest;
      if (ctx.physicRoot) {
        void installPackage(ctx.physicRoot, req).then((reply) =>
          ctx.send(WsChannels.PACKAGES_INSTALL, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.PACKAGES_LIST:
      // Request/reply (machine-0047): installed manifest + drift + the enabled AI providers.
      if (ctx.physicRoot) {
        void listPackages(ctx.physicRoot, enabledAiProviders(readProfileConfig(ctx.profileDir))).then((reply) =>
          ctx.send(WsChannels.PACKAGES_LIST, reply, message.id),
        );
      }
      return true;
    case WsChannels.PACKAGES_REMOVE: {
      // Request/reply (machine-0048): delete an installed artifact + manifest entry.
      const req = payload as unknown as PackagesRemoveRequest;
      if (ctx.physicRoot) {
        void removePackage(ctx.physicRoot, req).then((reply) =>
          ctx.send(WsChannels.PACKAGES_REMOVE, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.GRAPH_BUILD: {
      // Request/reply (machine-0036): build the docs / code / all structure graph (ADR-0488).
      const req = payload as unknown as GraphBuildRequest;
      if (ctx.physicRoot) {
        void buildGraph(ctx.physicRoot, req.mode).then((reply) =>
          ctx.send(WsChannels.GRAPH_BUILD, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.RAG_STATUS:
      // Request/reply (machine-0037): probe RAG capability + install state.
      if (ctx.physicRoot) {
        void ragStatus(ctx.physicRoot).then((reply) =>
          ctx.send(WsChannels.RAG_STATUS, reply, message.id),
        );
      }
      return true;
    case WsChannels.RAG_INSTALL: {
      // Request/reply (machine-0038): launch a background RAG install.
      const req = payload as unknown as RagInstallRequest;
      if (ctx.physicRoot) {
        void ragInstall(ctx.physicRoot, req.model).then((reply) =>
          ctx.send(WsChannels.RAG_INSTALL, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.RAG_REINDEX:
      // Request/reply (machine-0039): (re)build the vector index in the background.
      if (ctx.physicRoot) {
        void ragReindex(ctx.physicRoot).then((reply) =>
          ctx.send(WsChannels.RAG_REINDEX, reply, message.id),
        );
      }
      return true;
    case WsChannels.RAG_QUERY: {
      // Request/reply (machine-0040): semantic search over the index.
      const req = payload as unknown as RagQueryRequest;
      if (ctx.physicRoot) {
        void ragQuery(ctx.physicRoot, req.query, typeof req.k === "number" ? req.k : undefined, Array.isArray(req.kinds) ? req.kinds : undefined).then((reply) =>
          ctx.send(WsChannels.RAG_QUERY, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.RAG_SETTINGS: {
      // Request/reply (machine-0083): save this machine user's search settings.
      const req = payload as unknown as RagSettingsRequest;
      if (ctx.physicRoot) {
        void ragSettings(ctx.physicRoot, { minScore: Number(req.minScore), topK: Number(req.topK) }).then((reply) =>
          ctx.send(WsChannels.RAG_SETTINGS, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.CONFIG_READ:
      // Request/reply (machine-0025): the paired profile's config.json as text.
      ctx.send(
        WsChannels.CONFIG_READ,
        { config: readConfigText(ctx.profileDir) } satisfies ConfigReadReply,
        message.id,
      );
      return true;
    case WsChannels.CONFIG_WRITE: {
      // Request/reply (machine-0026): validate + replace config.json; server-managed
      // fields (physicPath + ws_token mirror) are preserved from the current file.
      const res = applyConfigText(ctx.profileDir, (payload as unknown as ConfigWriteRequest).config);
      ctx.send(WsChannels.CONFIG_WRITE, res satisfies ConfigWriteReply, message.id);
      return true;
    }
    default:
      return false;
  }
}
