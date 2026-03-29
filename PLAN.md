# HITL — Phased Delivery Plan

## Tech Stack

Electron, React 18, TypeScript, TanStack Table, Styled Components, SQLite via Prisma, electron-trpc, Vite + electron-builder, Catppuccin Mocha theme.

---

## Phase 1 — Scaffolding & UI Shell

**Status: Complete**

### Deliverables

- Electron + Vite + React + TypeScript project scaffolding (electron-vite v5)
- electron-trpc IPC pipeline (main -> preload -> renderer)
- Catppuccin Mocha themed UI with styled-components
- Reusable Grid component wrapping TanStack Table (sortable, collapsible, disabled rows, accent colors, badges)
- All 5 grid views with correct columns per PRD spec:
  - Profile Assignment (Story Id, Story Title, Profile dropdown)
  - Plan Approval (Story Id, Story Title, Worktree, Session, Workspace)
  - Task PR Review (Story Id, Task Completed, Task Id, Task Title, Worktree, Session, Workspace, Pull Request)
  - Story PR Review (Story Id, Story Title, Worktree, Session, Workspace, Pull Request)
  - Completed (Id, Title, Session, Pull Request)
- Common components: ExternalLink, ActionLink, ProfileSelect, CheckboxCell, Placeholder
- Layout shell with title bar and status bar area

### Key Files

- `electron.vite.config.ts` — electron-vite config
- `src/main/index.ts` — Electron entry point
- `src/preload/index.ts` — exposeElectronTRPC bridge
- `src/renderer/App.tsx` — Root with tRPC/QueryClient/Theme providers
- `src/renderer/components/Grid/Grid.tsx` — Reusable TanStack Table grid
- `src/renderer/components/Layout/Layout.tsx` — App shell with status bar
- `src/renderer/components/common/index.tsx` — Shared UI components
- `src/renderer/grids/*.tsx` — All 5 grid views
- `src/renderer/styles/theme.ts` — Catppuccin Mocha tokens
- `src/shared/constants.ts` — GridState enum, labels, thresholds
- `src/shared/types.ts` — Story, Task, Profile, ProfileMap interfaces

### Discoveries

- electron-trpc v0.7.1 requires `@trpc/server` v10 (not v11) and `@tanstack/react-query` v4 (not v5).
- electron-vite v5 is needed for Vite v6 compatibility.
- Critical preload fix: `externalizeDepsPlugin({ exclude: ['electron-trpc'] })` in the preload config.
- LSP errors about "Cannot find module" in the IDE are expected and don't affect Vite builds.

---

## Phase 2 — Database & Real Data

**Status: Complete**

### Deliverables

- Prisma schema with SQLite:
  - `Story` — id (ADO work item ID), title, state, profileKey, worktreePath, sessionId, prUrl, azureUrl, disabled, prUpdated, timestamps, has many Tasks
  - `Task` — id, title, storyId (FK), worktreePath, sessionId, prUrl, prMerged, azureUrl, disabled, prUpdated, timestamps
  - `CronState` — singleton row with boolean flags for each cron step + lastRunAt
- Database service module (`initDatabase()`, `getDb()`, `closeDatabase()`)
- tRPC router with real Prisma queries and mutations
- Seed script with test data across all 5 grid states

### Key Files

- `prisma/schema.prisma` — Story, Task, CronState models
- `prisma/seed.ts` — Seed script
- `src/main/db/index.ts` — Prisma client init/get/close
- `src/main/trpc/router.ts` — All tRPC queries + mutations

---

## Phase 3 — Azure DevOps Integration

**Status: Complete**

### Deliverables

- Azure DevOps REST API client:
  - WIQL queries using `@CurrentIteration` and `@Me`
  - Batch work item fetch (max 200 per request)
  - Basic auth with PAT
- Cron job scheduler:
  - 60-second interval
  - System idle detection via `powerMonitor.getSystemIdleState(900)`
  - CronState flag gating for each step
- Sync step: queries Azure DevOps, upserts stories/tasks to DB without overwriting grid state, profile, or worktree fields
- `cronStatus` tRPC query + Layout status bar with 4 indicators (Azure, Idle, Sync, DB)

### Key Files

- `src/main/azure/client.ts` — Azure DevOps REST API (WIQL, work items, team URL fix)
- `src/main/cron/index.ts` — Cron scheduler
- `src/main/cron/sync.ts` — Azure DevOps work item sync
- `src/main/cron/config.ts` — Env var loader for Azure config

### Discoveries

- Prisma SSL cert issues workaround: `$env:NODE_TLS_REJECT_UNAUTHORIZED="0"`.
- `electron-vite dev` does NOT auto-load `.env` for the main process. Fixed by adding `dotenv` as a direct dependency and calling `dotenv.config()` at the top of `src/main/index.ts`.
- Azure DevOps URL structure: team name must go BEFORE `_apis` in the path (`/{project}/{team}/_apis/...`), not after. Must be URL-encoded for spaces.

---

## Phase 4 — Profile System & Worktree Management

**Status: Complete**

### Deliverables

- Git worktree management module:
  - `listWorktrees()` — parses `git worktree list --porcelain`
  - `createWorktree()` — fetches origin, creates branch + worktree (or reuses existing)
  - `createTaskWorktree()` — branches task from story branch
  - `findIdleWorktree()` — finds unassigned worktrees
  - `removeWorktree()`, `pruneWorktrees()`
- Worktree naming convention: `<repoPath>-worktrees/story-<id>` or `task-<id>`, branches: `story/<id>` or `task/<id>`
- Cron worktree setup step: finds PLAN_APPROVAL stories with profile but no worktree, creates worktrees
- New tRPC procedures: `openInVSCode`, `openInTerminal`, `openExternal`, `listWorktrees`
- Updated grids: Plan Approval, Task PR Review, Story PR Review use ActionLink for worktree/workspace links

### Key Files

- `src/main/worktree/index.ts` — Git worktree management
- `src/main/cron/worktree-setup.ts` — Worktree provisioning for profile-assigned stories
- `profile.json` — Repo profile config (web-app, backend-svc, shared-lib)

---

## Phase 5 — Copilot CLI Integration & Plan Approval

**Status: Complete**

### Deliverables

- **Copilot CLI session manager** (`src/main/copilot/session.ts`):
  - Spawns sessions via `copilot -p "prompt" --log-dir ./logs --no-ask-user --allow-tool=TOOLS`
  - Extracts session IDs from log files (polls for new file in `--log-dir`)
  - Opens sessions in Windows Terminal via `copilot --resume SESSION-ID`
  - Reads/clears signal files from `.hitl-signals/`

- **Hooks system** (`src/main/copilot/hooks.ts`):
  - Sets up `.github/hooks/hooks.json` in worktree directories
  - Creates PowerShell hook scripts for `sessionEnd` and `postToolUse` events
  - Hook scripts write JSON signal files to `.hitl-signals/` directory
  - Updates `.gitignore` to exclude signal files, logs, and hook scripts

- **Session signal watcher** (`src/main/copilot/watcher.ts`):
  - `fs.watch` on `.hitl-signals/` directories
  - Debounced signal processing
  - Updates DB disabled state: `SESSION_ACTIVE` -> disabled=true, `SESSION_END`/`SESSION_IDLE` -> disabled=false
  - Tracks active watchers, cleans up on shutdown

- **Planning cron step** (`src/main/cron/planning.ts`):
  - Finds PLAN_APPROVAL stories with worktree but no session
  - Sets up hooks, spawns copilot with planning prompt
  - Planning prompt instructs agent to create PLAN.md with acceptance criteria and task breakdown
  - Starts signal watchers for idle detection
  - Resumes watchers on app restart

- **Task execution cron step** (`src/main/cron/task-execution.ts`):
  - Finds tasks with worktree but no session
  - Spawns copilot with implementation prompt per task
  - Starts signal watchers for idle detection
  - Resumes watchers on app restart

- **Plan approval flow** (`src/main/cron/plan-approval.ts`):
  - Parses PLAN.md from worktree (acceptance criteria + tasks)
  - Updates Azure DevOps story with acceptance criteria (HTML format)
  - Creates Azure DevOps tasks under parent story
  - Upserts tasks in local database
  - Creates task worktrees branched from story branch
  - Moves story to TASK_PR_REVIEW state

- **New tRPC procedures**: `openSession`, `approvePlan`, `readPlan`
- **Updated cronStatus**: includes `activeWatchers` count
- **Updated grids**: All session links wired to `openSession` mutation, Plan Approval grid has "Approve Plan" action column
- **Status bar**: Shows active session watcher count

### Key Files

- `src/main/copilot/session.ts` — Session spawn/track/resume
- `src/main/copilot/hooks.ts` — hooks.json + PowerShell hook scripts
- `src/main/copilot/watcher.ts` — Signal file watcher
- `src/main/copilot/index.ts` — Barrel export
- `src/main/cron/planning.ts` — Planning cron step
- `src/main/cron/task-execution.ts` — Task execution cron step
- `src/main/cron/plan-approval.ts` — Plan approval flow

---

## Phase 6 — GitHub Integration & PR Review Workflows

**Status: Complete**

### Deliverables

- **GitHub client** (`src/main/github/client.ts`):
  - Uses `gh` CLI for all GitHub operations (no GITHUB_TOKEN env var, no Octokit)
  - `isGhAuthenticated()` — checks `gh auth status`
  - `getRepoInfo()` — extracts owner/repo from git remote URL (HTTPS and SSH)
  - `createPullRequest()` — creates PRs via `gh pr create`
  - `findPullRequest()` — finds existing PR for a head→base branch pair via `gh pr list`
  - `getPullRequest()` — gets PR by number via `gh pr view --json`
  - `isPrMerged()` — checks merge status
  - `extractPrNumber()` / `extractRepoFromPrUrl()` — parses PR URLs
  - `getPrReviewComments()` / `getPrIssueComments()` — fetches comments via `gh api`
  - `findUnresolvedThreads()` — groups comments into threads, identifies unanswered reviewer comments
  - `formatCommentsForPrompt()` — formats unresolved comments into a copilot prompt

- **Task PR check cron step** (`src/main/cron/pr-check.ts`, gated by `prCheckEnabled`):
  - Creates task PRs: pushes `task/<id>` branch, creates PR targeting `story/<id>` branch
  - Checks for existing PRs before creating duplicates
  - Monitors review comments: when `prUpdated=true` and task is idle, fetches unresolved comments
  - Spawns copilot session with comment-fix prompt when unresolved comments found
  - Detects merged task PRs: sets `prMerged=true`, `disabled=true`
  - All-tasks-merged check: when all tasks for a story are merged, moves story to STORY_PR_REVIEW

- **Story PR check cron step** (`src/main/cron/story-pr-check.ts`, gated by `storyPrCheckEnabled`):
  - Creates story PRs: pushes `story/<id>` branch, creates PR targeting default branch (from profile.json)
  - PR body includes checklist of all completed tasks with links to their PRs
  - Monitors review comments: same pattern as task PR comments
  - Detects merged story PRs: moves story to COMPLETED state

- **Cron scheduler updated**: Steps 5 (PR check) and 6 (story PR check) wired into tick cycle

- **New tRPC procedures**:
  - `markTaskPrUpdated` — flags a task's PR for comment checking on next tick
  - `markStoryPrUpdated` — flags a story's PR for comment checking on next tick

- **Updated `cronStatus`**: includes `githubConfigured` boolean

- **Updated Layout status bar**: GitHub connection indicator (green/orange dot)

### Key Files

- `src/main/github/client.ts` — GitHub REST API client
- `src/main/github/index.ts` — Barrel export
- `src/main/cron/pr-check.ts` — Task PR review cron step
- `src/main/cron/story-pr-check.ts` — Story PR review cron step
- `src/main/cron/index.ts` — Updated scheduler with PR steps wired in
- `src/main/trpc/router.ts` — New mutations + githubConfigured status
- `src/renderer/components/Layout/Layout.tsx` — GitHub status indicator

### Design Decisions

- **Polling over webhooks**: Since this is a desktop app, we poll GitHub on each cron tick rather than setting up webhook listeners. The `prUpdated` flag serves as a manual trigger mechanism (can be set via tRPC mutation or future webhook integration).
- **No Octokit dependency**: Uses `gh` CLI for all GitHub operations. Authentication is handled by `gh auth login` — no GITHUB_TOKEN env var needed.
- **Unresolved thread heuristic**: GitHub REST API doesn't expose resolved/unresolved state for review threads directly. We approximate by checking if the last comment in a thread is NOT from the PR author (the agent).
- **PR creation timing**: Task PRs are created when the agent finishes (disabled=false, sessionId set, no prUrl). Story PRs are created when the story moves to STORY_PR_REVIEW (all tasks merged).

---

## Phase 7 — Completed Grid, Re-activation & Error Handling

**Status: Complete**

### Deliverables

- **Schema updates**: Added `completedAt`, `errorMessage`, `errorAt` to Story; `errorMessage`, `errorAt` to Task. Migration applied.

- **Structured logging module** (`src/main/logger/index.ts`):
  - Leveled logging: `debug`, `info`, `warn`, `error`
  - JSON-structured entries written to daily log files (`hitl-YYYY-MM-DD.log`) in userData/logs
  - In-memory ring buffer (500 entries) for UI log viewer
  - `createLogger(source)` factory for scoped loggers
  - `getRecentLogs()`, `readLogFile()`, `listLogFiles()`, `getLogDir()` for log access
  - `getSessionLogs()` for copilot session log aggregation from worktree `.hitl-logs/` dirs

- **Error handling & retry** (`src/main/utils/retry.ts`):
  - `withRetry()` — exponential backoff with configurable attempts, delays, and `shouldRetry` predicate
  - `isRetryableHttpError()` — classifies HTTP errors (retry 429/5xx, skip 401/403/404)
  - Azure DevOps API calls wrapped with retry (3 attempts)
  - GitHub `gh` CLI calls wrapped with retry (3 attempts, 2s initial delay)
  - `isRetryableGhError()` — skips retry for auth/not-found/already-exists errors

- **Cron error isolation** (`src/main/cron/index.ts` rewrite):
  - Each cron step wrapped in `runStep()` — failure in one step doesn't block others
  - `CronStatus.stepErrors: Record<string, string>` for per-step error tracking
  - `recordStoryError()` / `recordTaskError()` / `clearStoryError()` / `clearTaskError()` helpers
  - `lastError` summarizes failures: "2 step(s) failed: sync, planning"
  - All console.log replaced with structured logger

- **Re-activation flow** (`src/main/cron/sync.ts`):
  - When a new task is synced and parent story is in COMPLETED state, story is re-activated
  - Re-activated stories move to TASK_PR_REVIEW with `disabled=false`, `completedAt=null`, cleared errors

- **Completed grid finalization** (`src/renderer/grids/CompletedGrid.tsx`):
  - Displays child tasks per story with checkmarks
  - Shows `completedAt` timestamp formatted as "Mon DD, YYYY, HH:MM"
  - Error status column with red "Error" badge (hover for message)

- **Error indicators in grids**:
  - `ErrorIndicator` component added to common components
  - Error status columns added to TaskPRReviewGrid and StoryPRReviewGrid
  - Layout status bar shows step error details on hover

- **Log viewer** (`src/renderer/components/LogViewer/LogViewer.tsx`):
  - Collapsible bottom panel in Layout
  - Level filtering (All, Info+, Warn+, Errors)
  - Color-coded log lines with timestamps, source, and message
  - Auto-refreshes every 5s when expanded, 30s when collapsed

- **tRPC procedures added**:
  - `recentLogs` — filtered in-memory log entries
  - `logDates` — available log file dates
  - `logsByDate` — read log entries from a specific date
  - `logDir` — returns log directory path
  - `sessionLogs` — copilot session logs for a worktree
  - `clearStoryError` / `clearTaskError` — mutations to clear error state

### Key Files

- `src/main/logger/index.ts` — Structured logging module
- `src/main/utils/retry.ts` — Retry utility with exponential backoff
- `src/main/cron/index.ts` — Rewritten with step isolation and error tracking
- `src/main/cron/sync.ts` — Re-activation flow + structured logging
- `src/main/cron/story-pr-check.ts` — Sets completedAt on merge
- `src/main/trpc/router.ts` — Log/error tRPC procedures
- `src/main/azure/client.ts` — Retry-wrapped API calls
- `src/main/github/client.ts` — Retry-wrapped gh CLI calls
- `src/renderer/components/LogViewer/LogViewer.tsx` — Log viewer panel
- `src/renderer/grids/CompletedGrid.tsx` — Finalized completed grid
- `src/renderer/components/common/index.tsx` — ErrorIndicator component
- `prisma/migrations/20260328230023_phase7_error_tracking_completed_at/` — Migration

### Discoveries

- `npx prisma generate` fails when Electron processes are running because the `query_engine-windows.dll.node` file is locked. Must close the app before regenerating.
- GitHub `gh pr view --json` returns PR state as uppercase strings: `OPEN`, `CLOSED`, `MERGED`.
- GitHub auth is via `gh` CLI (not GITHUB_TOKEN env var) — `gh auth status` checks authentication.

---

## Phase 8 — Packaging, Settings & Polish

**Status: Complete**

### Deliverables

- **Packaging** (`electron-builder.yml`, `src/main/updater/index.ts`):
  - electron-builder config for Windows NSIS installer (x64)
  - `extraResources` to bundle Prisma query engine, schema, and migrations
  - `asar: true` with `asarUnpack: ["**/*.node"]` for native modules
  - Auto-update via electron-updater + GitHub Releases (owner: `will-milliman`, repo: `hitl`)
  - Desktop + Start Menu shortcuts, artifact naming: `${productName}-Setup-${version}.${ext}`
  - Generated app icon (`build/icon.ico`) — 64x64 Catppuccin Mocha mauve "H" icon
  - Updater checks on startup (10s delay) and every 4 hours, dialog prompt on download complete

- **Settings page** (`src/main/settings/index.ts`, `src/renderer/components/Settings/SettingsPage.tsx`):
  - JSON-based settings store persisted to `settings.json` (userData in prod, project root in dev)
  - Env var fallback: reads Azure config from `.env` if settings.json doesn't have it
  - Profile fallback: loads from `profile.json` if settings.profiles is empty
  - Modal overlay with 5 tabs: Azure DevOps, Cron Jobs, Profiles, Notifications, About
  - Azure tab: org, project, team, PAT (password field with masking: `•••xxxx`)
  - Cron tab: interval seconds, idle threshold, 5 cron step flag toggles (synced to CronState DB)
  - Profiles tab: editable profile cards with add/remove, repo path, default branch, description
  - Notifications tab: master enable + per-type toggles
  - About tab: version display, auto-update status, "Check for Updates" / "Install & Restart" buttons
  - Dirty state tracking with save/cancel, PAT preservation on save when unchanged
  - tRPC procedures: `getSettings` (PAT masked), `saveSettings` (PAT preserved)

- **Notifications** (`src/main/notifications/index.ts`):
  - OS-level notifications via Electron's `Notification` API
  - Respects user preferences (master enable + per-type toggles from settings)
  - Click handler brings main window to focus
  - `notifyPlanReady()` — fired when copilot planning session ends (SESSION_END for PLAN_APPROVAL stories)
  - `notifyPrReviewNeeded()` — fired when unresolved PR comments detected
  - `notifyAllTasksMerged()` — fired when all tasks for a story are merged
  - `notifyStoryCompleted()` — fired when story PR merges
  - `notifyCronError()` — fired on cron step errors

- **Testing** (`vitest.config.ts`, 3 test suites, 54 tests):
  - Vitest 2.x with node environment and v8 coverage on `src/main/**/*.ts`
  - `npm test`, `npm run test:watch`, `npm run test:coverage` scripts
  - `src/main/utils/retry.test.ts` — 14 tests: `withRetry()` (success, retry, exhaustion, shouldRetry, backoff, non-Error values), `isRetryableHttpError()` (429, 5xx, network, client errors, non-Error)
  - `src/main/logger/logger.test.ts` — 14 tests: ring buffer (add, cap at 500), `getRecentLogs()` (level filter, source filter, limit, combined), `createLogger()` (scoped source, data passthrough), console output
  - `src/main/github/github.test.ts` — 26 tests: `extractPrNumber()`, `extractRepoFromPrUrl()`, `parseRemoteUrl()` (HTTPS, SSH, hyphens, errors), `findUnresolvedThreads()` (unresolved, resolved, re-opened, multiple threads), `formatCommentsForPrompt()` (empty, single, multiple, null line)

- **UI Polish**:
  - `ErrorBoundary` class component wrapping the app — catches render errors, shows stack trace + "Try Again" button
  - `Spinner` component with configurable size and label — used for initial data loading
  - `ExternalLink` fixed to use `shell.openExternal` via the `openExternal` tRPC mutation (was `window.open`)
  - Keyboard shortcut: `Ctrl+,` to toggle settings, `Escape` to close
  - `formatRelativeTime()` utility exported from common components (used in CompletedGrid `completedAt` column)
  - Loading state: `<Spinner label="Loading work items..." />` shown while stories/tasks queries are loading

### Key Files

- `electron-builder.yml` — Full packaging config
- `build/icon.ico` — App icon
- `scripts/generate-icon.ts` — Icon generation script
- `vitest.config.ts` — Vitest configuration
- `src/main/updater/index.ts` — Auto-update via electron-updater
- `src/main/settings/index.ts` — JSON settings store
- `src/main/notifications/index.ts` — OS notification system
- `src/main/utils/retry.test.ts` — Retry utility tests
- `src/main/logger/logger.test.ts` — Logger tests
- `src/main/github/github.test.ts` — GitHub client helper tests
- `src/renderer/components/Settings/SettingsPage.tsx` — Settings modal
- `src/renderer/components/common/index.tsx` — ErrorBoundary, Spinner, formatRelativeTime, fixed ExternalLink
- `src/renderer/App.tsx` — ErrorBoundary wrapper + loading state
- `src/renderer/components/Layout/Layout.tsx` — Keyboard shortcuts (Ctrl+, / Escape)

### Discoveries

- Vitest 4.x has ESM compatibility issues with electron-vite's CJS setup (`ERR_REQUIRE_ESM` for `std-env`). Vitest 2.x works fine.
- `electron-updater` must be a runtime dependency (not devDependency) for packaged builds.

---

## Architecture Overview

```
src/
  main/                          # Electron main process
    index.ts                     # Entry point: dotenv, DB, window, IPC, cron, updater
    db/index.ts                  # Prisma client lifecycle
    trpc/router.ts               # All tRPC queries + mutations
    azure/client.ts              # Azure DevOps REST API
    github/                      # GitHub integration
      client.ts                  # GitHub REST API via gh CLI (PRs, comments, merge detection)
    worktree/index.ts            # Git worktree management
    copilot/                     # Copilot CLI integration
      session.ts                 # Spawn, track, resume sessions
      hooks.ts                   # hooks.json + hook scripts
      watcher.ts                 # Signal file watcher
    logger/index.ts              # Structured logging (file + ring buffer)
    utils/retry.ts               # Retry with exponential backoff
    settings/index.ts            # JSON settings store (AppSettings)
    updater/index.ts             # Auto-update via electron-updater
    notifications/index.ts       # OS notification system
    cron/                        # Cron job steps
      index.ts                   # Scheduler (60s tick, step isolation)
      config.ts                  # Azure config from env
      sync.ts                    # Azure DevOps work item sync + re-activation
      worktree-setup.ts          # Worktree provisioning
      planning.ts                # Copilot planning sessions
      task-execution.ts          # Copilot task implementation
      plan-approval.ts           # Plan approval flow
      pr-check.ts                # Task PR check (create, comments, merge)
      story-pr-check.ts          # Story PR check (create, comments, merge)
  preload/index.ts               # electron-trpc bridge
  renderer/                      # React UI
    App.tsx                      # Root with providers, ErrorBoundary, loading states
    components/Grid/             # Reusable TanStack Table grid
    components/Layout/           # App shell + status bar + keyboard shortcuts
    components/LogViewer/        # Collapsible log viewer panel
    components/Settings/         # Settings modal (5 tabs)
    components/common/           # Shared UI: ErrorBoundary, Spinner, ExternalLink, etc.
    grids/                       # 5 grid views
    styles/                      # Theme + global styles
    trpc/client.ts               # tRPC React client
  shared/                        # Shared types + constants
    constants.ts                 # GridState enum, thresholds
    types.ts                     # Story, Task, Profile interfaces
prisma/
  schema.prisma                  # SQLite schema
  seed.ts                        # Test data seed script
```

## Configuration

- `.env` — Azure DevOps credentials, DATABASE_URL (GitHub auth via `gh` CLI, not env var)
- `profile.json` — Repository profiles (repoPath, defaultBranch, description)
- `prisma/schema.prisma` — CronState flags control which cron steps execute

## Key Design Decisions

1. **Every cron step is flag-gated** via CronState boolean fields in the database
2. **System idle detection** via `powerMonitor.getSystemIdleState(900)` pauses all cron work
3. **Signal files** (not direct IPC) communicate between copilot hooks and HITL app
4. **Worktrees** isolate concurrent work — stories and tasks each get their own worktree
5. **Detached copilot processes** — sessions run independently of HITL via `child.unref()`
6. **Disabled row state** tracks whether an agent is actively working (disabled=true) or waiting for human input (disabled=false)
