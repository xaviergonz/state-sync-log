# Copilot Instructions for state-sync-log

This repository is a pnpm workspace + Turborepo monorepo. The main deliverable is the `state-sync-log` package under `packages/state-sync-log`.

## Overview

`state-sync-log` is a **Validated Replicated State Machine** built on a custom, lightweight CRDT. Unlike traditional CRDTs that merge everything, every transaction is validated against your business logic before it is applied.

The library provides:
- Transaction-based state changes with validation.
- Custom CRDT layer (`SyncLogDoc`, `SyncLogMap`) optimized for set-once keys with range-based tombstone compression.
- Checkpoint compaction and retention for storage efficiency.
- State reconciliation for computing diffs between states.
- `createOps` — an immer-like API for generating operations from mutable-style mutations.
- Plain JSON data model (no special types required).

## Repository Structure

- `packages/state-sync-log/src`: library source.
- `packages/state-sync-log/test`: Vitest test suite.
- `packages/state-sync-log/docs/api`: generated TypeDoc output.
- Root-level `README.md`, `LICENSE`, `CHANGELOG.md` are copied into the package on build.

## Tech Stack

- **Language**: TypeScript (strict).
- **Build**: Vite + `vite-plugin-dts` (outputs ESM + UMD).
- **Testing**: Vitest.
- **Lint/Format**: Biome.
- **Monorepo**: pnpm workspaces + Turborepo.
- **Runtime dependencies**: `fast-deep-equal`, `nanoid`, `rfdc`, `tslib`.

## Key Concepts (library-specific)

When changing code, keep these behaviors stable:
- **StateSyncLog controller**: Main API created via `createStateSyncLog()` in `src/createStateSyncLog.ts`.
- **Operations**: Atomic ops (`set`, `delete`, `splice`, `addToSet`, `deleteFromSet`) defined in `src/operations.ts`.
- **CRDT layer**: Custom `SyncLogDoc` and `SyncLogMap` in `src/crdt/` — optimized for set-once keys with range-based tombstone compression.
- **createOps**: Immer-like proxy-based API for generating operations in `src/createOps/`.
- **Validation**: Transactions are validated via a user-provided `validate(state) => boolean` function.
- **Checkpoints**: Compaction and retention support in `src/checkpoints.ts` and `src/checkpointUtils.ts`.
- **Reconciliation**: Computing ops to transform one state to another in `src/reconcile.ts`.
- **Errors**: Use `StateSyncLogError` from `src/error.ts` — don't throw raw strings.

## Commands

Use `pnpm`. Prefer running commands from the repo root.

### Root (recommended)

- `pnpm -w lint` — lint with Biome.
- `pnpm -w lib:build` — build the `state-sync-log` package via Turbo.
- `pnpm -w lib:test` — run tests via Turbo. Might add `test test/<file>.test.ts` to target specific tests.
- `pnpm -w lib:test:ci` — run tests with coverage via Turbo.
- `pnpm -w lib:build-docs` — generate TypeDoc output via Turbo.

## Standards

- **Linting**: Biome is used for linting and formatting. Let it handle all formatting and linting concerns automatically. Always run `pnpm -w lint` before finishing a task.
- **Minimal, surgical changes**: Avoid refactors unless required by the task.
- **TypeScript**: keep types precise; prefer `unknown` over `any`.
- **Public API stability**: treat exports from `packages/state-sync-log/src/index.ts` as public surface. Avoid breaking changes unless explicitly requested.
- **Build artifacts**: Don’t edit generated files in `dist/`, `api-docs/`, `coverage/`. Always change source and re-generate.
- Don’t bump package versions or publish to npm unless explicitly requested.
- Package root files (`README.md`, `LICENSE`, `CHANGELOG.md`, `logo.png`) are copied into each package during builds; update the root copies if you need to change them.
- Don't import from `dist/` or generated type output; always work against `src/`.
- When adding new public functionality, export it intentionally from `packages/state-sync-log/src/index.ts` (and avoid incidental exports).
- For bug fixes, add a regression test under `packages/state-sync-log/test`.
- Prefer small, focused tests that reproduce the behavior and assert the exact outcome.
- When changing `createOps`/draft semantics, add tests for:
	- draft mutations and finalization
	- operation generation (verify the correct ops are produced)
	- validation behavior (valid vs. invalid states)
- If the change affects user-facing behavior, update `README.md` and/or `CHANGELOG.md` at the repo root (the build copies them into the package).
- Prefer workspace commands (`pnpm ...` from root) over running package scripts directly, unless debugging a single package.
- Don't add new dependencies unless necessary; prefer existing utilities already used in the repo.
- Never ever do git commits, change of branch or mess up with the stashed changes.
