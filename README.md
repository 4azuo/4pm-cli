# 4PM CLI (`@4pm/cli`)

**The agent that runs on a 4PM worker machine.** It pairs with the 4PM server, opens an
encrypted WebSocket, and orchestrates the AI CLIs (`claude` / `codex`) plus `git` / `gh` /
`glab` / shell on your machine — streaming their output back to the 4PM dashboard.

> **This repository is the public, source-available mirror of the 4PM CLI.** It is published
> for transparency and security auditing — you run an agent that spawns processes and uses
> your git credentials locally, so you can read exactly what it does. It is **not** open
> source: see [`LICENSE`](./LICENSE) (source-available, all rights reserved).

## Install (users)

```bash
npm i -g @4pm/cli      # official distribution (npm)
4pm link               # pair with your 4PM server, then:
4pm start              # run the worker
```

Container images are published to `ghcr.io/4azuo/4pm-cli`. Configuration is via `4pm link`
+ the profile's `config.json`; environment variables are documented in
[`.env.example`](./.env.example).

> **Security note:** use an `https://` server URL in production. The WebSocket session
> encryption (ephemeral ECDH) protects confidentiality but does **not** authenticate the
> server — TLS does. Connecting over plaintext to a non-local host emits a warning.

## Build from source

The repository is standalone — it needs no other 4PM code. The `@4pm/*` shared packages are
provided as a trimmed, vendored subset under [`vendor/`](./vendor) (only the code the CLI
actually uses; server-internal types are excluded).

```bash
pnpm install
pnpm build       # → dist/index.js (self-contained bundle)
pnpm typecheck
```

## How this repo relates to 4PM

The 4PM CLI is developed inside the private 4PM monorepo and embedded there as a git
submodule. The `vendor/` subset is generated from the monorepo's shared packages by
`scripts/vendor-shared.mjs`; do not hand-edit it. Releases are built and signed from the
monorepo and published here (npm + GitHub Release tarball + GHCR image).

## Layout

- `src/core/` — orchestration; `src/commands/` — subcommands (`link`/`start`/`attach`/…).
- `src/services/` — server REST calls; `src/ui/` — the Ink TUI (`4pm start` on a TTY).
- `src/common/`, `src/utils/`, `src/config/` — shared helpers, pure functions, config.
- `vendor/@4pm/*` — generated trimmed shared subset (see above).
