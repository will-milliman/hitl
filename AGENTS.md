# AGENTS.md

> **Keep this file concise and meaningful.** Every addition should earn its place -- avoid verbose explanations, redundant details, or information easily discoverable from code. Prefer terse tables and bullet points over prose.

## Overview

HITL -- Windows Electron app orchestrating AI-driven dev. Azure DevOps work items flow through a pipeline where Copilot CLI agents plan, implement, and PR, pausing for human review.

## Tech Stack

Electron 33, TypeScript 5.7 (strict), React 19, styled-components 6, Catppuccin Mocha | electron-vite 5 (Vite 6), electron-builder 25 (NSIS) | electron-trpc 0.7 | SQLite + Prisma 6 | Vitest 2, v8 coverage | Azure DevOps REST, GitHub `gh` CLI, Copilot CLI

## Architecture

```
src/main/       # Main process -- business logic, DB, APIs, cron
src/preload/    # electron-trpc bridge
src/renderer/   # React UI
src/shared/     # Shared types/constants
prisma/         # Schema, migrations, seed
```

### Main Modules (`src/main/`)

| Module        | Path                     | Purpose                                 |
| ------------- | ------------------------ | --------------------------------------- |
| DB            | `db/index.ts`            | Prisma client lifecycle                 |
| tRPC          | `trpc/router.ts`         | IPC endpoints (queries + mutations)     |
| Cron          | `cron/index.ts`          | 60s scheduler, pipeline steps           |
| Azure         | `azure/client.ts`        | Work item sync (WIQL + REST)            |
| GitHub        | `github/client.ts`       | PR ops via `gh` CLI                     |
| Copilot       | `copilot/`               | Session spawning, hooks, signal watcher |
| Worktree      | `worktree/index.ts`      | Git worktree lifecycle                  |
| Settings      | `settings/index.ts`      | JSON settings, env-var fallbacks        |
| Logger        | `logger/index.ts`        | Structured logging (file + ring buffer) |
| Notifications | `notifications/index.ts` | OS-level notifications                  |
| Updater       | `updater/index.ts`       | Auto-update via GitHub Releases         |

### Pipeline (`GridState` in `src/shared/constants.ts`)

```
PROFILE_ASSIGNMENT -> TASK_EXECUTION -> PR_REVIEW -> COMPLETED
Side states: BLOCKED, ABANDONED
```

6 grid views in `src/renderer/grids/` (one per state).

## Key Patterns

- **Flag-gated cron**: Each step has a boolean in `CronState` DB table; toggled via Settings
- **Step isolation**: Each cron step try/caught independently
- **Signal files**: Copilot writes JSON to `.hitl-signals/`; `fs.watch` picks them up
- **Worktree isolation**: Each story/task gets own worktree (`story/<id>`, `task/<id>` branches)
- **Detached processes**: Copilot CLI spawned `detached: true` + `unref()`
- **Retry**: `utils/retry.ts` -- exponential backoff on external API calls
- **Settings priority**: `settings.json` > `.env` > defaults
- **Scoped loggers**: `createLogger('module-name')` everywhere

## Commands

| Command              | Purpose                 |
| -------------------- | ----------------------- |
| `npm run dev`        | Dev server (hot reload) |
| `npm run build`      | Build to `out/`         |
| `npm test`           | Vitest                  |
| `npm run typecheck`  | TS check all configs    |
| `npm run db:migrate` | Prisma migrations       |
| `npm run db:seed`    | Seed test data          |
| `npm run db:reset`   | Wipe + migrate + seed   |
| `npm run dist`       | NSIS installer          |

## Config

- `.env` / `.env.example` -- Azure DevOps PAT, org/project, DATABASE_URL
- `profile.json` -- Repo profile configs (repoPath, defaultBranch)
- `electron-builder.yml` -- Packaging

---

## Self-Maintenance

**After completing any task, consider whether this file needs updating.** If you added, removed, or significantly changed a module, pattern, command, pipeline state, or architectural decision, update this file. Keep edits terse -- a line or two at most.
