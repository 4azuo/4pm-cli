# CLAUDE.md — `@4pm/cli`

Node ESM agent on the worker machine. Role: [`README.md`](./README.md). Shared app
conventions: [`../CLAUDE.md`](../CLAUDE.md). Directory tree: [`README.md`](../../README.md) (root).

## Code organization

- **Orchestration logic** in `src/core/`, grouped by concern (file names keep their prefix so a
  grep for e.g. `autonomous-config` still finds them):
  `ai/` (AI CLI runs, streams, profiles, prompt overrides) · `agent/` (agent spawn/sandbox, subagents,
  tool permissions, packages, outbound review) · `autonomous/` (the autonomous engine) · `knowledge/`
  (knowledge/FAQ compose, memory compaction, RAG, research, support answer) · `git/` · `fs/` ·
  `exec/` (command executor + history/output/images) · `control/` (local control socket) · `worker/`
  (metrics, tools, toolchain, health, network probe, secrets, graph) · `profile/` (`.cre`, instance
  lock, config sync, fingerprint, input history) · `session/` (session bus, idle clear) · `project/`
  (scaffold). `ws-client.ts` (+ `ws-client/` handlers) and `update*.ts` stay at the `core/` root —
  `update.ts` derives the install root from its own `import.meta.url`, so don't move it.
- **Subcommands** in `src/commands/`.
- **Tests** (`vitest`, `pnpm --filter @4pm/cli test`) sit next to the code as `*.test.ts`.
- **Server communication** through `src/services/` (uses `@4pm/sdk`).
- **Shared parts** in `src/common/` (errors, logger, io); pure functions in `src/utils/`.
- **Interactive TUI** (`4pm start` on a TTY — ADR-0057) in `src/ui/` (Ink/React): banner,
  transcript, command input; the event bridge is `core/session/session-bus.ts`. No TTY ⇒ a console
  sink (`ui/console-sink.ts`) keeps the old headless behavior.
- Plus `src/config/`, `src/index.ts`.

## Local conventions

- **Lifecycle:** pairing (`.cre` = hashcode) → request a daily `ws_token` → open a WS to
  the cli-server → receive `dispatch` → spawn the external CLI (claude/codex/gh/…), gather
  the output buffer (backpressure) and stream it back.
- **Two scopes** (ADR-0010): **project cli** (MACHINE, 1 cli : 1 physic project) and
  **orchestrator cli** (root/ADMIN, short-lived AI requests).
- **Multi-instance:** one profile per instance (`~/.4pm/profiles/<name>/` — ADR-0014);
  the server groups cli instances on the same machine into one **worker** by fingerprint.
- Detailed behavior spec: [`11-docs/61-cli/`](../../11-docs/61-cli/README.md).

## Reference

The old project template (project-sample, `.claude` config, PowerShell scripts) is kept
at [`project-sample/`](./project-sample/) for reference during the migration.
