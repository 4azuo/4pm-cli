# CLAUDE.md — `@4pm/cli`

Node ESM agent on the worker machine. Role: [`README.md`](./README.md). Shared app
conventions: [`../CLAUDE.md`](../CLAUDE.md). Directory tree: [`README.md`](../../README.md) (root).

## Code organization

- **Orchestration logic** in `src/core/`; **subcommands** in `src/commands/`.
- **Server communication** through `src/services/` (uses `@4pm/sdk`).
- **Shared parts** in `src/common/` (errors, logger, io); pure functions in `src/utils/`.
- **Interactive TUI** (`4pm start` on a TTY — ADR-0057) in `src/ui/` (Ink/React): banner,
  transcript, command input; the event bridge is `core/session-bus.ts`. No TTY ⇒ a console
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
