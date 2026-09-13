/**
 * Git channel handlers (machine-0008/0021-0024, ADR-0089/0173): read-only history/diff over the
 * served project's repos for the dashboard Git tab, plus the rented worker's ssh deploy-key ops.
 */
import {
  WsChannels,
  type GitCommitDiffRequest,
  type GitCommitRequest,
  type GitDiffRequest,
  type GitEnvRequest,
  type GitLogRequest,
  type GitSshKeyRequest,
  type WsEnvelope,
} from "@4pm/ws";
import { gitDiff } from "../../git-diff";
import { checkGitEnv } from "../../git-env";
import { manageSshKey } from "../../git-ssh-key";
import { gitCommit, gitCommitDiff, gitLog, gitRepos } from "../../git-history";
import type { WsHandlerCtx } from "../context";

/** Route the git.* channels; returns true when the message was handled. */
export function handleGitChannels(
  ctx: WsHandlerCtx,
  message: WsEnvelope,
  payload: Record<string, unknown>,
): boolean {
  switch (message.channel) {
    case WsChannels.GIT_DIFF:
      // Request/reply — HEAD vs working-tree content for Monaco diff.
      void gitDiff((payload as unknown as GitDiffRequest).path).then((reply) =>
        ctx.send(WsChannels.GIT_DIFF, reply, message.id),
      );
      return true;
    case WsChannels.GIT_ENV:
      // Request/reply (machine-0008).
      void checkGitEnv((payload as unknown as GitEnvRequest).provider).then((reply) =>
        ctx.send(WsChannels.GIT_ENV, reply, message.id),
      );
      return true;
    case WsChannels.GIT_REPOS:
      // Request/reply (machine-0021): repos under the physic project (read-only — ADR-0089).
      void gitRepos(ctx.physicRoot).then((reply) =>
        ctx.send(WsChannels.GIT_REPOS, reply, message.id),
      );
      return true;
    case WsChannels.GIT_SSH_KEY: {
      // Request/reply (ADR-0173): manage the rented worker's ssh deploy key (on the worker).
      const req = payload as unknown as GitSshKeyRequest;
      void manageSshKey(req.op, ctx.profileDir).then((reply) =>
        ctx.send(WsChannels.GIT_SSH_KEY, reply, message.id),
      );
      return true;
    }
    case WsChannels.GIT_LOG: {
      // Request/reply (machine-0022): commit history of a repo, paged.
      const req = payload as unknown as GitLogRequest;
      void gitLog(ctx.physicRoot, req.repo ?? "", req.skip ?? 0, req.limit ?? 50).then((reply) =>
        ctx.send(WsChannels.GIT_LOG, reply, message.id),
      );
      return true;
    }
    case WsChannels.GIT_COMMIT: {
      // Request/reply (machine-0023): files changed in a commit.
      const req = payload as unknown as GitCommitRequest;
      void gitCommit(ctx.physicRoot, req.repo ?? "", req.hash).then((reply) =>
        ctx.send(WsChannels.GIT_COMMIT, reply, message.id),
      );
      return true;
    }
    case WsChannels.GIT_COMMIT_DIFF: {
      // Request/reply (machine-0024): parent↔commit content of one file (Monaco diff).
      const req = payload as unknown as GitCommitDiffRequest;
      void gitCommitDiff(ctx.physicRoot, req.repo ?? "", req.hash, req.path).then((reply) =>
        ctx.send(WsChannels.GIT_COMMIT_DIFF, reply, message.id),
      );
      return true;
    }
    default:
      return false;
  }
}
