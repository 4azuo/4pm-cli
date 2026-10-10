/**
 * Project-lifecycle channel handlers: keep the served physic project folder in sync with the
 * server — rename (PHYSIC_SYNC) / delete (PHYSIC_DELETE) the folder inside the profile (folder =
 * project name), apply a live push of the project's token knobs (PROJECT_TOKENS,
 * ADR-0256), and scaffold (PROJECT_CREATE) or register an existing (PROJECT_ADD,
 * ADR-0117) project with streamed progress.
 * @adr 0064 @adr 0080
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import {
  WsChannels,
  type PhysicDeletePayload,
  type PhysicSyncPayload,
  type ProjectAddPayload,
  type ProjectCreatePayload,
  type ProjectTokensPayload,
  type WsEnvelope,
  type GitTokenReply,
  type ProjectPublishReply,
  type ProjectPublishRequest,
  type RepoProbeRequest,
} from "@4pm/ws";
import type { GitAuthMethod } from "@4pm/dto";
import { configureGitAuth } from "../../git/git-auth";
import { requestGitSnapshot } from "../../git/git-snapshot";
import { probeRepo } from "../../git/repo-probe";
import { pauseAutonomous } from "../../autonomous/autonomous-config";
import { manageSshKey } from "../../git/git-ssh-key";
import { createAiTaskRunner } from "../../ai/ai-task";
import { addProject, publishScaffold, scaffoldProject } from "../../project/scaffold";
import { projectFolder, writeProfileConfig } from "../../../config/profile";
import { setMcpServers } from "../../../utils/agent-mcp";
import { logger } from "../../../common/logger/logger";
import type { WsHandlerCtx } from "../context";
import { t } from "../../../i18n";

/** Route the project-lifecycle channels; returns true when the message was handled. */
export function handleProjectChannels(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  payload: Record<string, unknown>,
): boolean {
  switch (message.channel) {
    case WsChannels.PHYSIC_SYNC: {
      // Attach / rename ⇒ (re)create the physic folder in the profile's workspace (folder = project
      // name — ADR-0064, outside the profile dir — ADR-0430). A rename PRESERVES the folder's cloned
      // repos by moving it, instead of deleting + recreating empty (ADR-0288); the repos are
      // re-provisioned separately.
      const sync = payload as unknown as PhysicSyncPayload;
      const oldName = sync.oldName;
      const oldPath = oldName ? projectFolder(ctx.profileDir, oldName) : null;
      const newPath = projectFolder(ctx.profileDir, sync.newName);
      if (!newPath) return true;
      if (oldPath && oldPath !== newPath && existsSync(oldPath) && !existsSync(newPath)) {
        // Rename in place — keep the cloned repos + local work (ADR-0288).
        renameSync(oldPath, newPath);
      } else {
        // No old folder to move (fresh attach), or the target already exists: drop a stale old
        // folder and ensure the new one exists (empty until provisioning clones the repos).
        if (oldPath && oldPath !== newPath && existsSync(oldPath)) rmSync(oldPath, { recursive: true, force: true });
        mkdirSync(newPath, { recursive: true });
      }
      ctx.physicRoot = ctx.physicFolderPath(sync.newName); // browse root follows the rename
      requestGitSnapshot("physic-sync");
      ctx.bus.setProject(sync.newName); // header updates live — now serving this project
      ctx.bus.log(t("project.folderSynced", { name: sync.newName }));
      // A fresh/renamed folder may be empty — clone any missing declared repo into it (ADR-0289).
      void ctx.cloneServingRepos().catch(() => undefined);
      return true;
    }
    case WsChannels.PHYSIC_DELETE: {
      // Project deleted ⇒ delete the physic folder in the profile's workspace. The cli keeps
      // its pairing and goes idle (ADR-0068).
      const del = payload as unknown as PhysicDeletePayload;
      // Guard: an empty name would resolve to the profile dir itself — never delete that.
      if (del.name) {
        // Stop the autonomous engine (ADR-0392): its config is per-profile, so the next project bound
        // to this cli must start paused — no orphan ticks. (A rename needs nothing: the scheduler reads
        // the served root live.)
        void pauseAutonomous(ctx.profileDir).catch(() => undefined);
        const folder = projectFolder(ctx.profileDir, del.name);
        if (folder) rmSync(folder, { recursive: true, force: true });
        ctx.bus.log(t("project.folderDeleted", { name: del.name }));
      }
      // Scrub the ssh deploy key whenever the worker leaves a project — the key granted
      // access to the OLD project's repos, so a rented worker switching projects (or going
      // idle) must not keep it (ADR-0173 §5). No-op for an org's own worker (no `id_4pm`).
      void manageSshKey("delete", ctx.profileDir).catch(() => undefined);
      ctx.bus.setProject(null); // header goes idle — no longer serving a project
      ctx.physicRoot = null; // idle now ⇒ nothing to browse
      return true;
    }
    case WsChannels.PROJECT_TOKENS: {
      // Live push of the serving project's token knobs (ADR-0256): apply them exactly as the
      // connect handler applies `ws_token.projectTokens`, so a saved change (e.g. aiRunTimeoutSec)
      // takes effect on the NEXT run instead of only after a reconnect. `writeProfileConfig` merges,
      // so only these knobs change; `ws_token` still re-seeds them on the next (re)connect.
      const tokens = payload as unknown as ProjectTokensPayload;
      writeProfileConfig(ctx.profileDir, {
        sessionSwitchPct: tokens.sessionSwitchPct ?? 0,
        perPromptTokenLimit: tokens.perPromptTokenLimit ?? 0,
        projectAiRunTimeoutSec: tokens.aiRunTimeoutSec ?? 0,
        projectAutoClearIdleMinutes: tokens.autoClearIdleMinutes ?? 0,
        projectAiMemoryMode: tokens.memory?.mode ?? "inherit",
        projectAiMemoryBudgetChars: tokens.memory?.budgetChars ?? 0,
      });
      // Folder-scope hardening is applied per-prompt from this flag — mirror the connect handler.
      ctx.setRestrictToFolder(tokens.restrictToFolder === true);
      // Git-auth method/host (ADR-0368): re-scope the credential helper + gh shim live. `undefined` =
      // an older server that doesn't send it ⇒ leave git-auth as the last ws_token set it.
      if (tokens.gitAuth !== undefined) applyGitAuth(ctx, tokens.gitAuth, tokens.gitAuthHost ?? null);
      // MCP allowlist (ADR-0427): `undefined` = an older server ⇒ keep the list the ws_token set.
      if (tokens.mcpServers !== undefined) setMcpServers(tokens.mcpServers, ctx.profileDir);
      logger.info("project.tokens.applied", {
        aiRunTimeoutSec: tokens.aiRunTimeoutSec ?? 0,
        autoClearIdleMinutes: tokens.autoClearIdleMinutes ?? 0,
      });
      return true;
    }
    case WsChannels.PROJECT_CREATE:
      // Scaffold into <profileDir>/<projectName> + AI init + stream progress.
      void scaffoldProject(
        payload as unknown as ProjectCreatePayload,
        ctx.profileDir,
        (p) => ctx.send(WsChannels.PROJECT_PROGRESS, p),
        // AI init on the standard AI path + one org run slot (ADR-0362).
        createAiTaskRunner(ctx),
        (method, host) => applyGitAuth(ctx, method, host),
      ).then((reply) => {
        ctx.send(WsChannels.PROJECT_CREATE, reply, message.id);
        requestGitSnapshot("scaffold"); // the new project's first git state (ADR-0369)
      });
      return true;
    case WsChannels.REPO_PROBE: {
      // Probe a repo branch for the create wizard (ADR-0370, project-0076) with this worker's git creds.
      void probeRepo(payload as unknown as RepoProbeRequest).then((reply) => ctx.send(WsChannels.REPO_PROBE, reply, message.id));
      return true;
    }
    case WsChannels.PROJECT_PUBLISH: {
      // Retry the scaffold commit → push → PR in the served folder (ADR-0368, project-0074).
      const root = ctx.physicRoot;
      if (!root) {
        ctx.send(WsChannels.PROJECT_PUBLISH, { publish: null, error: "This worker has no project folder." } satisfies ProjectPublishReply, message.id);
        return true;
      }
      const projectId = (payload as unknown as ProjectPublishRequest).projectId;
      void publishScaffold(root, (step, msg) => ctx.send(WsChannels.PROJECT_PROGRESS, { projectId, step, message: msg }))
        .then((publish) => {
          ctx.send(WsChannels.PROJECT_PUBLISH, { publish } satisfies ProjectPublishReply, message.id);
          requestGitSnapshot("publish");
        })
        .catch((err: unknown) =>
          ctx.send(WsChannels.PROJECT_PUBLISH, { publish: null, error: String(err) } satisfies ProjectPublishReply, message.id),
        );
      return true;
    }
    case WsChannels.PROJECT_ADD:
      // Register an existing project: clone/link its repos into <profileDir>/<projectName>
      // (ADR-0080/0117), no scaffold/AI-init; a carried spec is written back + pushed (ADR-0393).
      void addProject(
        payload as unknown as ProjectAddPayload,
        ctx.profileDir,
        (p) => ctx.send(WsChannels.PROJECT_PROGRESS, p),
        // An add-with-scaffold runs AI init too (ADR-0362).
        createAiTaskRunner(ctx),
        // The Add-existing spec push re-applies the job's git-auth (ADR-0368/0393).
        (method, host) => applyGitAuth(ctx, method, host),
      ).then((reply) => {
        ctx.send(WsChannels.PROJECT_ADD, reply, message.id);
        requestGitSnapshot("provision"); // repos cloned/synced ⇒ report their state (ADR-0369)
      });
      return true;
    default:
      return false;
  }
}

/**
 * Apply a git-auth method/host pushed by the server — same call the ws_token connect path makes.
 * @adr 0368
 */
function applyGitAuth(ctx: WsHandlerCtx, method: string | null, host: string | null): void {
  configureGitAuth((method ?? null) as GitAuthMethod | null, host, ctx.profileDir, (req) =>
    ctx.request<GitTokenReply>(WsChannels.GIT_TOKEN, req),
  );
}
