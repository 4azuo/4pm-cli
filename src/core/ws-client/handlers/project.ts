/**
 * Project-lifecycle channel handlers: keep the served physic project folder in sync with the
 * server — rename (PHYSIC_SYNC) / delete (PHYSIC_DELETE) the folder inside the profile (folder =
 * project name, ADR-0064), apply a live push of the project's token knobs (PROJECT_TOKENS,
 * ADR-0256), and scaffold (PROJECT_CREATE, ADR-0080) or register an existing (PROJECT_ADD,
 * ADR-0117) project with streamed progress.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  WsChannels,
  type PhysicDeletePayload,
  type PhysicSyncPayload,
  type ProjectAddPayload,
  type ProjectCreatePayload,
  type ProjectTokensPayload,
  type WsEnvelope,
} from "@4pm/ws";
import { uninstallCron } from "../../autonomous";
import { manageSshKey } from "../../git-ssh-key";
import { addProject, scaffoldProject } from "../../scaffold";
import { writeProfileConfig } from "../../../config/profile";
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
      // Attach / rename ⇒ (re)create the physic folder inside the profile (folder = project
      // name — ADR-0064). A rename PRESERVES the folder's cloned repos by moving it, instead
      // of deleting + recreating empty (ADR-0288); the repos are re-provisioned separately.
      const sync = payload as unknown as PhysicSyncPayload;
      const oldName = sync.oldName;
      const oldPath = oldName ? join(ctx.profileDir, oldName) : null;
      const newPath = join(ctx.profileDir, sync.newName);
      // Clean up the old physic project's cron before moving/dropping its folder (ADR-0152) — a
      // renamed/rebound project must not leave an orphan tick firing at the old path.
      if (oldName) {
        const oldRoot = ctx.physicFolderPath(oldName);
        if (oldRoot) void uninstallCron(oldRoot).catch(() => undefined);
      }
      if (oldPath && oldName !== sync.newName && existsSync(oldPath) && !existsSync(newPath)) {
        // Rename in place — keep the cloned repos + local work (ADR-0288).
        renameSync(oldPath, newPath);
      } else {
        // No old folder to move (fresh attach), or the target already exists: drop a stale old
        // folder and ensure the new one exists (empty until provisioning clones the repos).
        if (oldPath && oldName !== sync.newName && existsSync(oldPath)) rmSync(oldPath, { recursive: true, force: true });
        mkdirSync(newPath, { recursive: true });
      }
      ctx.physicRoot = ctx.physicFolderPath(sync.newName); // browse root follows the rename
      ctx.bus.setProject(sync.newName); // header updates live — now serving this project
      ctx.bus.log(t("project.folderSynced", { name: sync.newName }));
      return true;
    }
    case WsChannels.PHYSIC_DELETE: {
      // Project deleted ⇒ delete the physic folder inside the profile. The cli keeps
      // its pairing and goes idle (ADR-0068).
      const del = payload as unknown as PhysicDeletePayload;
      // Guard: an empty name would resolve to the profile dir itself — never delete that.
      if (del.name) {
        const delRoot = ctx.physicFolderPath(del.name);
        // Uninstall the physic project's cron first (ADR-0152) — no orphan tick after delete.
        if (delRoot) void uninstallCron(delRoot).catch(() => undefined);
        rmSync(join(ctx.profileDir, del.name), { recursive: true, force: true });
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
      logger.info("project.tokens.applied", {
        aiRunTimeoutSec: tokens.aiRunTimeoutSec ?? 0,
        autoClearIdleMinutes: tokens.autoClearIdleMinutes ?? 0,
      });
      return true;
    }
    case WsChannels.PROJECT_CREATE:
      // Scaffold into <profileDir>/<projectName> (ADR-0080) + AI init + stream progress.
      void scaffoldProject(
        payload as unknown as ProjectCreatePayload,
        ctx.profileDir,
        (p) => ctx.send(WsChannels.PROJECT_PROGRESS, p),
      ).then((reply) => ctx.send(WsChannels.PROJECT_CREATE, reply, message.id));
      return true;
    case WsChannels.PROJECT_ADD:
      // Register an existing project: clone/link its repos into <profileDir>/<projectName>
      // (ADR-0080/0117), no scaffold/AI-init + stream progress.
      void addProject(
        payload as unknown as ProjectAddPayload,
        ctx.profileDir,
        (p) => ctx.send(WsChannels.PROJECT_PROGRESS, p),
      ).then((reply) => ctx.send(WsChannels.PROJECT_ADD, reply, message.id));
      return true;
    default:
      return false;
  }
}
