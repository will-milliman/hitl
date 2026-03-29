import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { readFileSync } from 'fs'
import { join } from 'path'
import { shell } from 'electron'
import { exec } from 'child_process'
import { getDb } from '../db'
import { getCronStatus } from '../cron'
import { getAzureConfig } from '../cron/config'
import { listWorktrees, pruneWorktrees } from '../worktree'
import { openSessionInTerminal, getActiveWatcherCount } from '../copilot'
import { approvePlan, parsePlanFile } from '../cron/plan-approval'
import { isGhAuthenticated } from '../github'
import { getRecentLogs, listLogFiles, readLogFile, getLogDir, getSessionLogs } from '../logger'
import { getUpdateStatus, checkForUpdates, installUpdate } from '../updater'
import { loadSettings, updateSettings } from '../settings'
import { GRID_LABELS } from '../../shared/constants'
import type { ProfileMap } from '../../shared/types'
import type { LogLevel } from '../logger'

const t = initTRPC.create()

/**
 * Reads profile.json from the project root.
 * Returns the parsed ProfileMap or an empty object on failure.
 */
function loadProfiles(): ProfileMap {
  try {
    const profilePath = join(__dirname, '../../profile.json')
    const raw = readFileSync(profilePath, 'utf-8')
    return JSON.parse(raw) as ProfileMap
  } catch (err) {
    console.error('[router] Failed to load profile.json:', err)
    return {}
  }
}

export const appRouter = t.router({
  // ─── Queries ──────────────────────────────────────────

  /** Health check */
  health: t.procedure.query(() => {
    return { status: 'ok', timestamp: Date.now() }
  }),

  /** Get all stories */
  stories: t.procedure.query(async () => {
    const db = getDb()
    return db.story.findMany({
      orderBy: { updatedAt: 'desc' },
    })
  }),

  /** Get all tasks (optionally filtered by storyId) */
  tasks: t.procedure
    .input(z.object({ storyId: z.number().optional() }).optional())
    .query(async ({ input }) => {
      const db = getDb()
      return db.task.findMany({
        where: input?.storyId ? { storyId: input.storyId } : undefined,
        orderBy: { storyId: 'asc' },
      })
    }),

  /** Get available profiles from profile.json */
  profiles: t.procedure.query(() => {
    return loadProfiles()
  }),

  /** Get grid labels */
  gridLabels: t.procedure.query(() => {
    return GRID_LABELS
  }),

  /** Get cron state flags */
  cronState: t.procedure.query(async () => {
    const db = getDb()
    return db.cronState.findUnique({ where: { id: 1 } })
  }),

  /** Get live cron job status (running, idle, last run, errors) */
  cronStatus: t.procedure.query(async () => {
    const status = getCronStatus()
    const azureConfigured = getAzureConfig() !== null
    const githubConfigured = await isGhAuthenticated()
    const activeWatchers = getActiveWatcherCount()
    return { ...status, azureConfigured, githubConfigured, activeWatchers }
  }),

  // ─── Mutations ────────────────────────────────────────

  /** Assign a profile to a story and advance it to PLAN_APPROVAL */
  assignProfile: t.procedure
    .input(
      z.object({
        storyId: z.number(),
        profileKey: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb()
      return db.story.update({
        where: { id: input.storyId },
        data: {
          profileKey: input.profileKey,
          state: 'PLAN_APPROVAL',
          disabled: true, // Agent will begin planning
        },
      })
    }),

  /** Update a story's grid state */
  updateStoryState: t.procedure
    .input(
      z.object({
        storyId: z.number(),
        state: z.string(),
        disabled: z.boolean().optional(),
        worktreePath: z.string().nullish(),
        sessionId: z.string().nullish(),
        prUrl: z.string().nullish(),
      })
    )
    .mutation(async ({ input }) => {
      const { storyId, ...data } = input
      const db = getDb()
      return db.story.update({
        where: { id: storyId },
        data,
      })
    }),

  /** Update a story's disabled state */
  updateStoryDisabled: t.procedure
    .input(
      z.object({
        storyId: z.number(),
        disabled: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb()
      return db.story.update({
        where: { id: input.storyId },
        data: { disabled: input.disabled },
      })
    }),

  /** Update a task's PR status (merged or updated) */
  updateTaskPrStatus: t.procedure
    .input(
      z.object({
        taskId: z.number(),
        prMerged: z.boolean().optional(),
        prUrl: z.string().nullish(),
        prUpdated: z.boolean().optional(),
        disabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { taskId, ...data } = input
      const db = getDb()
      return db.task.update({
        where: { id: taskId },
        data,
      })
    }),

  /** Flag a task's PR as updated (triggers comment check on next cron tick) */
  markTaskPrUpdated: t.procedure
    .input(z.object({ taskId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb()
      return db.task.update({
        where: { id: input.taskId },
        data: { prUpdated: true },
      })
    }),

  /** Flag a story's PR as updated (triggers comment check on next cron tick) */
  markStoryPrUpdated: t.procedure
    .input(z.object({ storyId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb()
      return db.story.update({
        where: { id: input.storyId },
        data: { prUpdated: true },
      })
    }),

  /** Upsert a story (used by Azure DevOps sync in cron job) */
  upsertStory: t.procedure
    .input(
      z.object({
        id: z.number(),
        title: z.string(),
        azureUrl: z.string(),
        state: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb()
      return db.story.upsert({
        where: { id: input.id },
        create: {
          id: input.id,
          title: input.title,
          azureUrl: input.azureUrl,
          state: input.state ?? 'PROFILE_ASSIGNMENT',
        },
        update: {
          title: input.title,
          azureUrl: input.azureUrl,
        },
      })
    }),

  /** Upsert a task (used by Azure DevOps sync in cron job) */
  upsertTask: t.procedure
    .input(
      z.object({
        id: z.number(),
        title: z.string(),
        storyId: z.number(),
        azureUrl: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb()
      return db.task.upsert({
        where: { id: input.id },
        create: {
          id: input.id,
          title: input.title,
          storyId: input.storyId,
          azureUrl: input.azureUrl,
        },
        update: {
          title: input.title,
        },
      })
    }),

  /** Update cron state flags */
  updateCronState: t.procedure
    .input(
      z.object({
        syncEnabled: z.boolean().optional(),
        planningEnabled: z.boolean().optional(),
        taskExecutionEnabled: z.boolean().optional(),
        prCheckEnabled: z.boolean().optional(),
        storyPrCheckEnabled: z.boolean().optional(),
        lastRunAt: z.date().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb()
      return db.cronState.update({
        where: { id: 1 },
        data: input,
      })
    }),

  /** Open a path in VS Code */
  openInVSCode: t.procedure
    .input(z.object({ path: z.string() }))
    .mutation(async ({ input }) => {
      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        exec(`code "${input.path}"`, { windowsHide: true }, (err) => {
          if (err) {
            console.error('[router] Failed to open VS Code:', err.message)
            resolve({ success: false, error: err.message })
          } else {
            resolve({ success: true })
          }
        })
      })
    }),

  /** Open a path in Windows Terminal */
  openInTerminal: t.procedure
    .input(z.object({ path: z.string() }))
    .mutation(async ({ input }) => {
      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        exec(`wt -d "${input.path}"`, { windowsHide: true }, (err) => {
          if (err) {
            console.error('[router] Failed to open terminal:', err.message)
            resolve({ success: false, error: err.message })
          } else {
            resolve({ success: true })
          }
        })
      })
    }),

  /** Open a URL in the default browser */
  openExternal: t.procedure
    .input(z.object({ url: z.string() }))
    .mutation(async ({ input }) => {
      await shell.openExternal(input.url)
      return { success: true }
    }),

  /** Open a copilot session in Windows Terminal */
  openSession: t.procedure
    .input(
      z.object({
        sessionId: z.string(),
        cwd: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      return openSessionInTerminal(input.sessionId, input.cwd)
    }),

  /** Approve a plan — creates tasks, worktrees, and moves story to TASK_PR_REVIEW */
  approvePlan: t.procedure
    .input(z.object({ storyId: z.number() }))
    .mutation(async ({ input }) => {
      return approvePlan(input.storyId)
    }),

  /** Read a plan file from a story's worktree (for preview) */
  readPlan: t.procedure
    .input(z.object({ storyId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb()
      const story = await db.story.findUnique({ where: { id: input.storyId } })
      if (!story?.worktreePath) return null

      const plan = parsePlanFile(story.worktreePath)
      return plan
    }),

  /** List all worktrees for a given profile */
  listWorktrees: t.procedure
    .input(z.object({ profileKey: z.string() }))
    .query(async ({ input }) => {
      const profiles = loadProfiles()
      const profile = profiles[input.profileKey]
      if (!profile) return []

      try {
        await pruneWorktrees(profile.repoPath)
        return listWorktrees(profile.repoPath)
      } catch (err) {
        console.error('[router] Failed to list worktrees:', err)
        return []
      }
    }),

  // ─── Logging ──────────────────────────────────────────

  /** Get recent log entries from the in-memory ring buffer */
  recentLogs: t.procedure
    .input(
      z.object({
        level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
        source: z.string().optional(),
        limit: z.number().optional(),
      }).optional()
    )
    .query(({ input }) => {
      return getRecentLogs(
        input?.level as LogLevel | undefined,
        input?.source,
        input?.limit
      )
    }),

  /** List available log file dates */
  logDates: t.procedure.query(() => {
    return listLogFiles()
  }),

  /** Read log entries from a specific date */
  logsByDate: t.procedure
    .input(z.object({ date: z.string() }))
    .query(({ input }) => {
      return readLogFile(input.date)
    }),

  /** Get the log directory path */
  logDir: t.procedure.query(() => {
    return getLogDir()
  }),

  /** Get copilot session logs for a worktree */
  sessionLogs: t.procedure
    .input(z.object({ worktreePath: z.string() }))
    .query(({ input }) => {
      return getSessionLogs(input.worktreePath)
    }),

  // ─── Error Management ────────────────────────────────

  /** Clear error state on a story */
  clearStoryError: t.procedure
    .input(z.object({ storyId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb()
      return db.story.update({
        where: { id: input.storyId },
        data: {
          errorMessage: null,
          errorAt: null,
        },
      })
    }),

  /** Clear error state on a task */
  clearTaskError: t.procedure
    .input(z.object({ taskId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb()
      return db.task.update({
        where: { id: input.taskId },
        data: {
          errorMessage: null,
          errorAt: null,
        },
      })
    }),

  // ─── Auto-Update ─────────────────────────────────────

  /** Get app settings */
  getSettings: t.procedure.query(() => {
    const settings = loadSettings()
    // Mask the PAT for security (only show last 4 chars)
    return {
      ...settings,
      azure: {
        ...settings.azure,
        pat: settings.azure.pat
          ? '•'.repeat(Math.max(0, settings.azure.pat.length - 4)) + settings.azure.pat.slice(-4)
          : '',
      },
    }
  }),

  /** Update app settings */
  saveSettings: t.procedure
    .input(
      z.object({
        azure: z.object({
          org: z.string(),
          project: z.string(),
          pat: z.string(), // Full PAT — only sent when user changes it
          team: z.string(),
        }).optional(),
        cron: z.object({
          intervalSeconds: z.number().min(10).max(3600),
          idleThresholdSeconds: z.number().min(60).max(7200),
        }).optional(),
        profiles: z.record(
          z.object({
            repoPath: z.string(),
            defaultBranch: z.string(),
            description: z.string().optional(),
          })
        ).optional(),
        notifications: z.object({
          enabled: z.boolean(),
          planApprovalReady: z.boolean(),
          prReviewNeeded: z.boolean(),
          cronErrors: z.boolean(),
        }).optional(),
      })
    )
    .mutation(({ input }) => {
      // If PAT is masked (starts with dots), don't overwrite the real PAT
      if (input.azure?.pat && input.azure.pat.startsWith('•')) {
        const current = loadSettings()
        input.azure.pat = current.azure.pat
      }
      return updateSettings(input)
    }),

  /** Get auto-update status */
  updateStatus: t.procedure.query(() => {
    return getUpdateStatus()
  }),

  /** Check for updates manually */
  checkForUpdates: t.procedure.mutation(async () => {
    await checkForUpdates()
    return { success: true }
  }),

  /** Install downloaded update (quits and restarts) */
  installUpdate: t.procedure.mutation(() => {
    installUpdate()
    return { success: true }
  }),
})

export type AppRouter = typeof appRouter
