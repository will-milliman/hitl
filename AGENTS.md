# AGENTS.md

## Project Overview

HITL (Human-in-the-Loop) is a **Windows Electron desktop app** that orchestrates AI-driven software development. Azure DevOps work items flow through a stateful pipeline where GitHub Copilot CLI agents automatically plan, implement, and create PRs, pausing at each stage for human review.

## Tech Stack

- **Runtime**: Electron 33 (TypeScript 5.7, ES2022, strict mode)
- **Build**: electron-vite 5 (Vite 6), electron-builder 25 (NSIS installer)
- **Frontend**: React 18, styled-components 6, Catppuccin Mocha theme
- **IPC**: electron-trpc v0.7 (type-safe main <-> renderer)
- **Database**: SQLite via Prisma ORM 6.19
- **External**: Azure DevOps REST API, GitHub `gh` CLI, Copilot CLI
- **Testing**: Vitest 2.x, v8 coverage

## Architecture

Three-process Electron app:

```
src/main/          # Main process - all business logic, DB, APIs, cron
src/preload/       # Thin electron-trpc bridge (5 lines)
src/renderer/      # React UI - no direct Node.js access
src/shared/        # Shared types and constants
prisma/            # Schema, migrations, seed
```

### Main Process Modules (`src/main/`)

| Module | Path | Purpose |
|--------|------|---------|
| DB | `db/index.ts` | Prisma client lifecycle |
| tRPC Router | `trpc/router.ts` | ~50 IPC endpoints (queries + mutations) |
| Cron | `cron/index.ts` | 60s scheduler, 6 pipeline steps |
| Azure | `azure/client.ts` | Work item sync via WIQL + REST |
| GitHub | `github/client.ts` | PR ops via `gh` CLI |
| Copilot | `copilot/` | Session spawning, hooks, signal file watcher |
| Worktree | `worktree/index.ts` | Git worktree lifecycle |
| Settings | `settings/index.ts` | JSON settings with env-var fallbacks |
| Logger | `logger/index.ts` | Structured logging (file + ring buffer) |
| Notifications | `notifications/index.ts` | OS-level notifications |
| Updater | `updater/index.ts` | Auto-update via GitHub Releases |

### Pipeline States (GridState enum in `src/shared/constants.ts`)

```
PROFILE_ASSIGNMENT -> PLAN_APPROVAL -> TASK_PR_REVIEW -> STORY_PR_REVIEW -> COMPLETED
                                                                              |
                                                                   (re-activates if new tasks)
                       BLOCKED (entered/exited based on Azure state)
```

Each state has a grid view in `src/renderer/grids/`.

## Key Patterns

- **Flag-gated cron**: Each cron step has a boolean flag in `CronState` DB table; toggled via Settings UI
- **Step isolation**: Each cron step wrapped in try/catch so failures don't block subsequent steps
- **Signal files**: Copilot sessions write JSON to `.hitl-signals/` dirs; `fs.watch` picks them up
- **Worktree isolation**: Each story/task gets its own worktree (`story/<id>`, `task/<id>` branches)
- **Detached processes**: Copilot CLI spawned with `detached: true` + `unref()` to persist independently
- **Retry with backoff**: `utils/retry.ts` wraps all external API calls with exponential backoff
- **Settings priority**: `settings.json` > `.env` > defaults
- **Scoped loggers**: Every module uses `createLogger('module-name')`

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Electron + Vite dev server (hot reload) |
| `npm run build` | Build all targets to `out/` |
| `npm test` | Run Vitest (54 tests) |
| `npm run typecheck` | TypeScript check all configs |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:seed` | Seed test data |
| `npm run db:reset` | Wipe + re-migrate + seed |
| `npm run dist` | Build NSIS installer |

## Configuration

- `.env` / `.env.example` - Azure DevOps PAT and org/project config, DATABASE_URL
- `profile.json` - Repository profile configs (repoPath, defaultBranch)
- `electron-builder.yml` - Packaging config

## Data Flow

```
Azure DevOps --> [Sync] --> SQLite --> [tRPC/IPC] --> React UI (6 grids)
                              ^                          |
                              |                     human actions
                              |                          |
                        [Signal Watcher] <-- [Copilot CLI sessions]
                              |                          ^
                        [Cron Steps] --> [Worktree Mgr] -+
                              |
                        [GitHub Client] --> GitHub PRs
```
