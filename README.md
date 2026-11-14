# live-for-llm

A decoupled AI companion system combining a companion-first chat experience, persistent multi-kind memory (SQLite FTS5 + float32 embeddings + Markdown export/edit sync), a pluggable background task harness, persistent Playwright browser control with policy gates, and a mixed Rust + TSX desktop UI built with [`longbridge/nsh`](https://github.com/longbridge/nsh).

## Architecture

The workspace follows a strict acyclic dependency layering enforced by `scripts/check-boundaries.mjs` (see [`docs/architecture.md`](docs/architecture.md) for full details):

| Layer | Package | Path | Responsibility |
| --- | --- | --- | --- |
| L0 | `@live-for-llm/protocol` | [`packages/protocol`](packages/protocol) | Shared domain types, IDs, parsers, WS/HTTP schemas (no `node:` imports) |
| L0 | `@live-for-llm/ai` | [`packages/ai`](packages/ai) | Tiered `ModelRouter` across OpenAI-compatible, Anthropic, and Gemini APIs |
| L1 | `@live-for-llm/memory` | [`packages/memory`](packages/memory) | `node:sqlite` (`MemoryStore`: FTS5 trigram + vector cosine) and Markdown round-trip |
| L1 | `@live-for-llm/harness` | [`packages/harness`](packages/harness) | Unified `TaskRunner` interface, built-in tool loop, external CLI/RPC runner |
| L1 | `@live-for-llm/browser` | [`packages/browser`](packages/browser) | Persistent Playwright Chromium manager, snapshots, screenshots, `PolicyGuard` |
| L2 | `@live-for-llm/companion` | [`packages/companion`](packages/companion) | Persona prompt orchestration, memory extraction, `delegate_task`, proactive check-ins |
| L3 | `@live-for-llm/daemon` | [`packages/daemon`](packages/daemon) | HTTP + WebSocket API host, task queue, approval gate, bearer auth |
| L4 | `@live-for-llm/desktop` | [`apps/desktop`](apps/desktop) | `nsh` Rust + TSX desktop shell (chat stream + collapsible task/memory/policy drawer) |

## Quick Start

### 1. Enter the Nix devshell

Enter the shell once so Nix does not re-copy the workspace tree on every subcommand:

```bash
nix develop
```

First-time setup inside the shell:

```bash
pnpm install
```

### 2. Configure model & daemon environment

Defaults live in [`packages/daemon/src/config.ts`](packages/daemon/src/config.ts) (optionally overridden by `~/.config/live-for-llm/config.json` or `LIVE_FOR_LLM_CONFIG`):

```bash
export OPENAI_API_KEY="sk-..."
# Optional overrides:
# export LLM_BASE_URL="https://api.openai.com/v1"
# export COMPANION_MODEL="gpt-4o-mini"
# export MEMORY_MODEL="gpt-4o-mini"
# export TASK_MODEL="gpt-4o"
# export VISION_MODEL="gpt-4o"
# export EMBEDDING_MODEL="text-embedding-3-small"
# export LIVE_FOR_LLM_HOST="127.0.0.1"
# export LIVE_FOR_LLM_PORT="4777"
# export LIVE_FOR_LLM_TOKEN="your-shared-secret"
# export LIVE_FOR_LLM_DATA_DIR="$HOME/.local/share/live-for-llm"
```

### 3. Start the app (single command)

Inside `nix develop`, launch Livia with one command — the desktop shell automatically starts and supervises a local daemon sidecar if `http://127.0.0.1:4777` is not already running, and cleans it up on exit:

```bash
just start
# or: pnpm start
# or: just desktop
```

If you want to run the daemon standalone (e.g. headless background server for remote mobile connections via Tailscale), start it explicitly — the desktop app will detect the running daemon and reuse it without spawning a second copy:

```bash
just daemon
# or: pnpm --filter @live-for-llm/daemon start
```

Export or re-import readable Markdown memory snapshots via CLI:

```bash
pnpm --filter @live-for-llm/daemon exec node --experimental-strip-types src/cli.ts export-memories
pnpm --filter @live-for-llm/daemon exec node --experimental-strip-types src/cli.ts import-memories
```

## Verification

Inside `nix develop`:

```bash
just check   # Dependency boundaries + TypeScript / Rust + nsh check
just test    # Unit tests across all workspace packages + nsh headless UI test
just e2e     # Full live E2E against mock OpenAI SSE + real SQLite + Chromium + nsh
```

## Roadmap

- **Milestone 1B (Complete):** Decoupled monorepo, SQLite + Markdown memory, `TaskRunner` harness, persistent Playwright Chromium + `PolicyGuard`, daemon WS/HTTP host, and `nsh` desktop GUI.
- **Milestone 2 (Planned):** Mobile `nsh` client (`apps/mobile`, tracked in Beads `live-for-llm-cxv`) connecting to the daemon over Tailscale WebSocket for chat, task progress inspection, and remote approval.

## License

[MIT](LICENSE)
