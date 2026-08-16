/**
 * Catalog of WS channels server ↔ cli (cli-ws 0002) — the source of truth at
 * implementation time; the 3 base channels come from @4pm/constants.
 */
import { WsChannel } from "@4pm/constants";

/** All channels (project cli + orchestrator cli). */
export const WsChannels = {
  ...WsChannel,
  FS_LIST: "fs.list",
  FS_READ: "fs.read",
  // server → cli (reply): write a file, path-clamped to the physic root (machine-0027,
  // ADR-0151) — the Git tab's manual conflict resolution (`project.git_write`); the only
  // git-tab write not carried by a git command over command dispatch.
  FS_WRITE: "fs.write",
  GIT_DIFF: "git.diff",
  GIT_ENV: "git.env",
  // server → cli (reply): read/write the paired profile's config.json (machine-0025/0026,
  // ADR-0141) — the machine-user Settings tab syncs the worker cli's config.
  CONFIG_READ: "config.read",
  CONFIG_WRITE: "config.write",
  // worker tools management (ADR-0206) — the Tools tab. `tools.list` probes the default
  // catalog + extra globals (reply); `tools.install`/`tools.uninstall` start a streamed op
  // (reply = accepted/rejected), then the cli pushes `tools.progress` lines and one
  // `tools.done` per opId back to the server (relayed to the browser over SSE).
  TOOLS_LIST: "tools.list",
  TOOLS_INSTALL: "tools.install",
  TOOLS_UNINSTALL: "tools.uninstall",
  TOOLS_PROGRESS: "tools.progress",
  TOOLS_DONE: "tools.done",
  // autonomous mode control (ADR-0152): read settings+status+books+approvals, tail logs, and
  // write {settings|approvals|userTodo|cron} — the dashboard drives the worker's autonomous engine.
  AUTONOMOUS_READ: "autonomous.read",
  AUTONOMOUS_WRITE: "autonomous.write",
  AUTONOMOUS_LOGS: "autonomous.logs",
  // subagents & skills management (ADR-0153): list/read/write .claude/agents + .claude/skills
  AGENTS_LIST: "agents.list",
  AGENTS_READ: "agents.read",
  AGENTS_WRITE: "agents.write",
  // skill/subagent marketplace (ADR-0185): pack a project artifact into a zip (publish),
  // install a package version into .claude/agents|skills + .4pm-packages.json, list installed
  // (with on-disk sha256 for drift), remove an installed package.
  PACKAGES_PACK: "packages.pack",
  PACKAGES_INSTALL: "packages.install",
  PACKAGES_LIST: "packages.list",
  PACKAGES_REMOVE: "packages.remove",
  // security & placeholder management (ADR-0154): AI_SECURITY/AI_PLACEHOLDER + write-only secrets
  SECRETS_READ: "secrets.read",
  SECRETS_WRITE: "secrets.write",
  // agent tool-permission editor (ADR-0183): read/write the `permissions` block of
  // .claude/settings.json (shared) or .claude/settings.local.json (per-cli local)
  AGENT_TOOLS_READ: "agentTools.read",
  AGENT_TOOLS_WRITE: "agentTools.write",
  // docs & code dependency graph (ADR-0155): build a {nodes,edges,orphans} graph per mode
  GRAPH_BUILD: "graph.build",
  // RAG capability + install (ADR-0156): probe the worker + install a worker-tuned model
  RAG_STATUS: "rag.status",
  RAG_INSTALL: "rag.install",
  // RAG index + query (ADR-0157): reindex docs into sqlite-vec, semantic query
  RAG_REINDEX: "rag.reindex",
  RAG_QUERY: "rag.query",
  // git history browse (read-through cli — ADR-0089): repos on the physic project,
  // commit log, changed files of a commit, parent↔commit diff of one file.
  GIT_REPOS: "git.repos",
  GIT_LOG: "git.log",
  GIT_COMMIT: "git.commit",
  GIT_COMMIT_DIFF: "git.commit-diff",
  // server → cli (reply): manage the rented worker's ssh deploy key (ADR-0173) — generate
  // (ed25519, on the worker) / get / delete. The private key never leaves the worker.
  GIT_SSH_KEY: "git.ssh-key",
  PROJECT_CREATE: "project.create",
  PROJECT_ADD: "project.add",
  PROJECT_PROGRESS: "project.progress",
  // server → cli: keep the physic folder name in sync with the project (folder =
  // project name — ADR-0064) when the project is renamed.
  PHYSIC_SYNC: "physic.sync",
  // server → cli: the project was deleted ⇒ delete the physic folder; the cli keeps
  // its pairing and goes idle (ADR-0068).
  PHYSIC_DELETE: "physic.delete",
  // command lifecycle
  COMMAND_ANNOUNCE: "command.announce",
  // console transcript sync (ADR-0150): the cli streams its authoritative SessionBus
  // transcript so the web Console renders it verbatim; gated by console.watch (server → cli:
  // whether a web viewer is attached) so an unwatched cli syncs nothing.
  CONSOLE_SYNC: "console.sync",
  CONSOLE_WATCH: "console.watch",
  // worker resource live-metrics (ADR-0214): the cli streams live CPU/RAM/disk (cgroup-accurate)
  // only while `metrics.watch` (server → cli: whether a web viewer has the Workers tab open) is on,
  // so an unwatched cli samples nothing. Buffered ephemerally in Redis (never the DB), separate from
  // the low-frequency, DB-authoritative `machine.status`.
  METRICS_WATCH: "metrics.watch",
  MACHINE_METRICS: "machine.metrics",
  // AI spec-assist (suggest/review/compose) moved off dedicated ai.* channels to
  // command.dispatch({ ai:true }) → the profile-failover AI path (ADR-0100).
  // quota & usage (ADR-0020)
  QUOTA_CHECK: "quota.check",
  USAGE_REPORT: "usage.report",
  // cli → server: Claude subscription usage snapshot (5h / weekly — ADR-0072)
  MACHINE_USAGE: "machine.usage",
  // cli → server: last-run result of an external tool (claude/codex/gh/glab/git — ADR-0223).
  // One-way, sent immediately after each direct tool invocation (last-wins per tool); the
  // server merges it into `MachineLink.usageSnapshot.toolHealth` for the admin pool lists.
  TOOL_HEALTH: "tool.health",
  // cli → server: durable per-command history record on finish (ADR-0072)
  COMMAND_HISTORY: "command.history",
  // cli → server: periodic upload of the cli's own JSONL log file (ADR-0122) — stored
  // server-side + counted in the machine user's storage footprint.
  MACHINE_LOG: "machine.log",
  // server → cli (reply): tail the cli's own JSONL logs on demand (ADR-0072)
  LOG_READ: "log.read",
  // server → cli (reply): read a finished command's captured output on demand (ADR-0115) —
  // cli stores command-output/{commandId}.log; returns null when pruned/unavailable.
  COMMAND_OUTPUT_READ: "command.output-read",
  // server → cli (reply): flush pending data before a rented machine is scrubbed (ADR-0210) —
  // the worker uploads its pending log tail (+ any queued history) then acks, so the release
  // sweep can finalise without waiting the full 5-minute timeout when the worker is online.
  RENTAL_FLUSH: "rental.flush",
  // outbound review (ADR-0082): machine→server request, server→outbound evaluate, result back
  REVIEW_REQUEST: "review.request",
  REVIEW_EVALUATE: "review.evaluate",
  REVIEW_RESULT: "review.result",
  // AI support answer (ADR-0170): server → support-agent cli request–reply. The dispatcher
  // sends the question + asker role + the shared docs/FAQ repo config; the worker clones/pulls
  // the repo, runs `claude` grounded in its docs+FAQ, and replies with the composed answer.
  SUPPORT_ANSWER: "support.answer",
  // AI knowledge distill (ADR-0190): server → project cli request–reply. The worker runs the AI CLI
  // in the project's working dir with a distillation prompt and replies with the composed markdown.
  KNOWLEDGE_COMPOSE: "knowledge.compose",
} as const;

/** Union type of channel names. */
export type WsChannelName = (typeof WsChannels)[keyof typeof WsChannels];
