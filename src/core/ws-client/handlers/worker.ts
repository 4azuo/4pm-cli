/**
 * Worker-config channel handlers: the dashboard's per-project editors that read/write files inside
 * the served physic project — autonomous settings (ADR-0152), subagents/skills (ADR-0153), secrets
 * (ADR-0154), agent tool permissions (ADR-0183), packages (ADR-0185), the dependency graph
 * (ADR-0155), RAG (ADR-0156/0157), and the paired profile's config.json (ADR-0141). Each project
 * op is a no-op on an idle cli (no `physicRoot`); config.json ops target the profile dir directly.
 */
import {
  WsChannels,
  type AgentReadRequest,
  type AgentToolsReadRequest,
  type AgentToolsWriteRequest,
  type AgentWriteRequest,
  type AutonomousLogsRequest,
  type AutonomousWriteRequest,
  type ConfigReadReply,
  type ConfigWriteReply,
  type ConfigWriteRequest,
  type GraphBuildRequest,
  type PackagesInstallRequest,
  type PackagesPackRequest,
  type PackagesRemoveRequest,
  type RagInstallRequest,
  type RagQueryRequest,
  type SecretsWriteRequest,
  type WsEnvelope,
} from "@4pm/ws";
import { readAutonomous, readAutonomousLogs, writeAutonomous } from "../../autonomous";
import { listAgents, readAgent, writeAgent } from "../../agents";
import { readSecrets, writeSecrets } from "../../secrets";
import { readAgentTools, writeAgentTools } from "../../agent-tools";
import { installPackage, listPackages, packPackage, removePackage } from "../../packages";
import { buildGraph } from "../../graph";
import { ragInstall, ragQuery, ragReindex, ragStatus } from "../../rag";
import { applyConfigText, readConfigText } from "../../config-sync";
import type { WsHandlerCtx } from "../context";

/** Route the worker-config channels; returns true when the message was handled. */
export function handleWorkerChannels(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  payload: Record<string, unknown>,
): boolean {
  switch (message.channel) {
    case WsChannels.AUTONOMOUS_READ:
      // Request/reply (machine-0028, ADR-0152): settings + status + books + approvals.
      if (ctx.physicRoot) {
        void readAutonomous(ctx.physicRoot).then((reply) =>
          ctx.send(WsChannels.AUTONOMOUS_READ, reply, message.id),
        );
      }
      return true;
    case WsChannels.AUTONOMOUS_LOGS: {
      // Request/reply (machine-0030, ADR-0152): tail one day's tick log.
      const req = payload as unknown as AutonomousLogsRequest;
      if (ctx.physicRoot) {
        void readAutonomousLogs(ctx.physicRoot, req.date).then((reply) =>
          ctx.send(WsChannels.AUTONOMOUS_LOGS, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.AUTONOMOUS_WRITE: {
      // Request/reply (machine-0029, ADR-0152): settings/approvals/userTodo/cron. `by` (the
      // author, for trace) is filled server-side and rides the payload.
      const req = payload as unknown as AutonomousWriteRequest & { by?: string };
      if (ctx.physicRoot) {
        void writeAutonomous(ctx.physicRoot, req, req.by ?? "unknown").then((reply) =>
          ctx.send(WsChannels.AUTONOMOUS_WRITE, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.AGENTS_LIST:
      // Request/reply (machine-0031, ADR-0153): list subagents + skills.
      if (ctx.physicRoot) {
        void listAgents(ctx.physicRoot).then((reply) =>
          ctx.send(WsChannels.AGENTS_LIST, reply, message.id),
        );
      }
      return true;
    case WsChannels.AGENTS_READ: {
      // Request/reply (machine-0032, ADR-0153): one subagent/skill's content (+ subagent memory).
      const req = payload as unknown as AgentReadRequest;
      if (ctx.physicRoot) {
        void readAgent(ctx.physicRoot, req.kind, req.name).then((reply) =>
          ctx.send(WsChannels.AGENTS_READ, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.AGENTS_WRITE: {
      // Request/reply (machine-0033, ADR-0153): create/edit or delete a subagent/skill.
      const req = payload as unknown as AgentWriteRequest;
      if (ctx.physicRoot) {
        void writeAgent(ctx.physicRoot, req).then((reply) =>
          ctx.send(WsChannels.AGENTS_WRITE, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.SECRETS_READ:
      // Request/reply (machine-0034, ADR-0154): security docs + placeholder keys (no values).
      if (ctx.physicRoot) {
        void readSecrets(ctx.physicRoot).then((reply) =>
          ctx.send(WsChannels.SECRETS_READ, reply, message.id),
        );
      }
      return true;
    case WsChannels.SECRETS_WRITE: {
      // Request/reply (machine-0035, ADR-0154): write a doc, or set/rotate/delete a secret value.
      const req = payload as unknown as SecretsWriteRequest;
      if (ctx.physicRoot) {
        void writeSecrets(ctx.physicRoot, req).then((reply) =>
          ctx.send(WsChannels.SECRETS_WRITE, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.AGENT_TOOLS_READ: {
      // Request/reply (machine-0044, ADR-0183): the permissions block of a settings file.
      const req = payload as unknown as AgentToolsReadRequest;
      if (ctx.physicRoot) {
        void readAgentTools(ctx.physicRoot, req.scope).then((reply) =>
          ctx.send(WsChannels.AGENT_TOOLS_READ, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.AGENT_TOOLS_WRITE: {
      // Request/reply (machine-0045, ADR-0183): replace a permissions block (preserve rest + secrets deny).
      const req = payload as unknown as AgentToolsWriteRequest;
      if (ctx.physicRoot) {
        void writeAgentTools(ctx.physicRoot, req.scope, req.permissions).then((reply) =>
          ctx.send(WsChannels.AGENT_TOOLS_WRITE, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.PACKAGES_PACK: {
      // Request/reply (machine-0049, ADR-0185): read a subagent/skill into a payload file set.
      const req = payload as unknown as PackagesPackRequest;
      if (ctx.physicRoot) {
        void packPackage(ctx.physicRoot, req.kind, req.name).then((reply) =>
          ctx.send(WsChannels.PACKAGES_PACK, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.PACKAGES_INSTALL: {
      // Request/reply (machine-0046, ADR-0185): write a package version into .claude (drift-guarded).
      const req = payload as unknown as PackagesInstallRequest;
      if (ctx.physicRoot) {
        void installPackage(ctx.physicRoot, req).then((reply) =>
          ctx.send(WsChannels.PACKAGES_INSTALL, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.PACKAGES_LIST:
      // Request/reply (machine-0047, ADR-0185): installed manifest + on-disk sha256 (drift).
      if (ctx.physicRoot) {
        void listPackages(ctx.physicRoot).then((reply) =>
          ctx.send(WsChannels.PACKAGES_LIST, reply, message.id),
        );
      }
      return true;
    case WsChannels.PACKAGES_REMOVE: {
      // Request/reply (machine-0048, ADR-0185): delete an installed artifact + manifest entry.
      const req = payload as unknown as PackagesRemoveRequest;
      if (ctx.physicRoot) {
        void removePackage(ctx.physicRoot, req.slug).then((reply) =>
          ctx.send(WsChannels.PACKAGES_REMOVE, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.GRAPH_BUILD: {
      // Request/reply (machine-0036, ADR-0155): build the docs/code dependency graph.
      const req = payload as unknown as GraphBuildRequest;
      if (ctx.physicRoot) {
        void buildGraph(ctx.physicRoot, req.mode).then((reply) =>
          ctx.send(WsChannels.GRAPH_BUILD, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.RAG_STATUS:
      // Request/reply (machine-0037, ADR-0156): probe RAG capability + install state.
      if (ctx.physicRoot) {
        void ragStatus(ctx.physicRoot).then((reply) =>
          ctx.send(WsChannels.RAG_STATUS, reply, message.id),
        );
      }
      return true;
    case WsChannels.RAG_INSTALL: {
      // Request/reply (machine-0038, ADR-0156): launch a background RAG install.
      const req = payload as unknown as RagInstallRequest;
      if (ctx.physicRoot) {
        void ragInstall(ctx.physicRoot, req.model).then((reply) =>
          ctx.send(WsChannels.RAG_INSTALL, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.RAG_REINDEX:
      // Request/reply (machine-0039, ADR-0157): (re)build the vector index in the background.
      if (ctx.physicRoot) {
        void ragReindex(ctx.physicRoot).then((reply) =>
          ctx.send(WsChannels.RAG_REINDEX, reply, message.id),
        );
      }
      return true;
    case WsChannels.RAG_QUERY: {
      // Request/reply (machine-0040, ADR-0157): semantic search over the index.
      const req = payload as unknown as RagQueryRequest;
      if (ctx.physicRoot) {
        void ragQuery(ctx.physicRoot, req.query, req.k).then((reply) =>
          ctx.send(WsChannels.RAG_QUERY, reply, message.id),
        );
      }
      return true;
    }
    case WsChannels.CONFIG_READ:
      // Request/reply (machine-0025, ADR-0141): the paired profile's config.json as text.
      ctx.send(
        WsChannels.CONFIG_READ,
        { config: readConfigText(ctx.profileDir) } satisfies ConfigReadReply,
        message.id,
      );
      return true;
    case WsChannels.CONFIG_WRITE: {
      // Request/reply (machine-0026, ADR-0141): validate + replace config.json; server-managed
      // fields (physicPath + ws_token mirror) are preserved from the current file.
      const res = applyConfigText(ctx.profileDir, (payload as unknown as ConfigWriteRequest).config);
      ctx.send(WsChannels.CONFIG_WRITE, res satisfies ConfigWriteReply, message.id);
      return true;
    }
    default:
      return false;
  }
}
