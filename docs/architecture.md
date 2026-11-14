# Architecture and Milestone 1B plan

This document defines the package boundaries, core data shapes, and staged delivery plan for Milestone 1B.

## Package layering

The repository follows a strict acyclic dependency graph inspired by `pi-mono`. Lower layers never import upper layers. The script `scripts/check-boundaries.mjs` enforces this rule in CI and local checks.

### Layer 0. Foundation

- `packages/protocol` (`@live-for-llm/protocol`). Shared domain types, branded identifiers, state machines, Zod boundary parsers, and WebSocket event schemas. This package has zero Node-only imports so both the TypeScript daemon and the `nsh` QuickJS UI runtime import it directly.
- `packages/ai` (`@live-for-llm/ai`). Tiered model router and provider adapters for OpenAI-compatible, Anthropic Messages, and Gemini APIs. Routes calls by role across `companion_chat`, `memory_extract`, `task_planner`, `vision_browser`, and `embedding`.

### Layer 1. Core capabilities

- `packages/memory` (`@live-for-llm/memory`). Local storage built on Node 24 `node:sqlite`, FTS5 full-text search, and float32 embedding cosine scoring. Stores four memory kinds (`fact`, `episode`, `preference`, `relationship`) and synchronizes readable Markdown snapshots for user inspection and editing.
- `packages/harness` (`@live-for-llm/harness`). Defines the `TaskRunner` interface and runner registry. Includes an in-process tool execution loop plus pluggable adapters for external CLI or RPC harnesses such as `pi` and Claude Code.
- `packages/browser` (`@live-for-llm/browser`). Manages persistent Playwright Chromium user-data profiles so site logins persist across runs. Supports headless execution, visible window takeover for login or verification challenges, DOM/accessibility snapshots, screenshots, and a pre-send `PolicyGuard`.

### Layer 2. Orchestration

- `packages/companion` (`@live-for-llm/companion`). Composes the main companion prompt from persona state, retrieved memories, and active background task status. Runs post-turn memory extraction, delegates heavy tasks via `delegate_task`, and schedules proactive check-ins with configurable quiet hours.

### Layer 3. Daemon host

- `packages/daemon` (`@live-for-llm/daemon`). Exposes the local HTTP and WebSocket API, owns SQLite and browser session lifecycles, manages the `TaskManager` queue and `ApprovalGate`, and supports bearer-token authentication over Tailscale for Milestone 2 mobile clients.

### Layer 4. Client applications

- `apps/desktop` (`longbridge/nsh` mixed Rust and TSX). Imports only `@live-for-llm/protocol` from the workspace and communicates with `packages/daemon` over WebSocket and HTTP. Uses Rust (`src/lib.rs`) for native desktop host helpers and TSX (`App.tsx`) for the companion chat stream and collapsible right-side drawer (tasks, browser screenshots, approvals, memory inspector, and trust policy settings).
- `apps/mobile` (Milestone 2, deferred). Reuses `@live-for-llm/protocol` and shared `nsh` TSX components over Tailscale WebSocket.

## Trust mode and approval gate design

Your answers selected trust mode (auto-execute after authorization) alongside a confirmation gate primitive for future mobile remote approvals. Both requirements live inside one `PolicyGuard` state machine in `@live-for-llm/protocol` and `@live-for-llm/browser`:

- Every browser or external-send action carries an `ActionRiskTier` (`read_only`, `local_write`, `external_send`, `destructive`).
- Under the default `trust_auto` profile, `read_only`, `local_write`, and authorized `external_send` actions proceed without interrupting chat, while `destructive` actions, unauthenticated logins, and CAPTCHAs transition the task to `paused_for_user` or `awaiting_approval`.
- Switching any domain or tier to `confirm_external` in settings activates the interactive approval card on desktop (and mobile in Milestone 2) without changing any runner or companion code.

## Milestone 1B phases

1. **Phase 0 (`live-for-llm-8fl.1`).** Nix `flake.nix` devshell with `nsh`, Rust, Node, pnpm, and Chromium, monorepo workspace config, boundary checker, and Beads issue graph.
2. **Phase 1 (`live-for-llm-8fl.2`).** `@live-for-llm/protocol` and `@live-for-llm/ai` with unit tests verifying schema parsing and tiered routing.
3. **Phase 2 (`live-for-llm-8fl.3`).** `@live-for-llm/memory` with SQLite + FTS5 + embedding scoring and Markdown export/edit round-trip tests.
4. **Phase 3 (`live-for-llm-8fl.4`).** `@live-for-llm/harness` and `@live-for-llm/browser` with mock/local-server Playwright persistence and `PolicyGuard` tests.
5. **Phase 4 (`live-for-llm-8fl.5`).** `@live-for-llm/companion` and `@live-for-llm/daemon` with WebSocket event streaming, proactive scheduler, and end-to-end integration tests.
6. **Phase 5 (`live-for-llm-8fl.6`).** `apps/desktop` (`nsh` mixed Rust and TSX) with `nsh check`, `nsh test`, and live screenshot-verified desktop run against the daemon.
