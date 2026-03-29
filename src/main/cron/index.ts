/**
 * Cron job scheduler.
 *
 * Runs a tick every 60 seconds. On each tick:
 * 1. Checks if the system is idle (powerMonitor)
 * 2. Checks CronState flags to see which steps are enabled
 * 3. Executes the Azure DevOps sync step (if enabled)
 * 4. Sets up worktrees for newly profile-assigned stories (if enabled)
 * 5. Spawns copilot planning sessions (if enabled)
 * 6. Spawns copilot task execution sessions (if enabled)
 * 7. Checks task PRs for comments/merges (if enabled)
 * 8. Checks story PRs for comments/merges (if enabled)
 *
 * Each step is isolated — a failure in one step does not prevent
 * subsequent steps from running. Errors are logged and tracked.
 */

import { powerMonitor } from 'electron'
import { getDb } from '../db'
import { syncWorkItems } from './sync'
import { setupStoryWorktrees } from './worktree-setup'
import { runPlanningStep, resumeStoryWatchers } from './planning'
import { runTaskExecutionStep, resumeTaskWatchers } from './task-execution'
import { runPrCheckStep } from './pr-check'
import { runStoryPrCheckStep } from './story-pr-check'
import { IDLE_THRESHOLD_SECONDS } from '../../shared/constants'
import { createLogger } from '../logger'
import { notifyCronError } from '../notifications'

const logger = createLogger('cron')

const CRON_INTERVAL_MS = 60_000 // 1 minute

let intervalId: ReturnType<typeof setInterval> | null = null
let running = false

export interface CronStatus {
  running: boolean
  idle: boolean
  lastRunAt: Date | null
  lastError: string | null
  /** Per-step error tracking for the last tick */
  stepErrors: Record<string, string>
}

let cronStatus: CronStatus = {
  running: false,
  idle: false,
  lastRunAt: null,
  lastError: null,
  stepErrors: {},
}

/**
 * Returns the current cron job status (for UI display).
 */
export function getCronStatus(): CronStatus {
  return { ...cronStatus, stepErrors: { ...cronStatus.stepErrors } }
}

/**
 * Runs a single cron step with error isolation.
 * Returns the error message if the step failed, or null on success.
 */
async function runStep(
  name: string,
  fn: () => Promise<void>
): Promise<string | null> {
  try {
    logger.info(`Running ${name}...`)
    await fn()
    logger.info(`${name} complete`)
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`${name} failed: ${message}`, {
      step: name,
      error: message,
    })
    return message
  }
}

/**
 * Records an error on a story in the database.
 */
export async function recordStoryError(
  storyId: number,
  errorMessage: string
): Promise<void> {
  try {
    const db = getDb()
    await db.story.update({
      where: { id: storyId },
      data: {
        errorMessage,
        errorAt: new Date(),
      },
    })
  } catch (err) {
    logger.error(`Failed to record error for story #${storyId}`, {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Records an error on a task in the database.
 */
export async function recordTaskError(
  taskId: number,
  errorMessage: string
): Promise<void> {
  try {
    const db = getDb()
    await db.task.update({
      where: { id: taskId },
      data: {
        errorMessage,
        errorAt: new Date(),
      },
    })
  } catch (err) {
    logger.error(`Failed to record error for task #${taskId}`, {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Clears an error on a story in the database.
 */
export async function clearStoryError(storyId: number): Promise<void> {
  try {
    const db = getDb()
    await db.story.update({
      where: { id: storyId },
      data: {
        errorMessage: null,
        errorAt: null,
      },
    })
  } catch {
    // Silently ignore — clearing errors is best-effort
  }
}

/**
 * Clears an error on a task in the database.
 */
export async function clearTaskError(taskId: number): Promise<void> {
  try {
    const db = getDb()
    await db.task.update({
      where: { id: taskId },
      data: {
        errorMessage: null,
        errorAt: null,
      },
    })
  } catch {
    // Silently ignore
  }
}

/**
 * Executes a single cron tick.
 * Each step is isolated — failures don't cascade.
 */
async function tick(): Promise<void> {
  if (running) {
    logger.debug('Previous tick still running, skipping')
    return
  }

  running = true
  cronStatus.running = true
  cronStatus.stepErrors = {}

  try {
    // 1. Check idle state
    const idleState = powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS)
    const isIdle = idleState === 'idle' || idleState === 'locked'
    cronStatus.idle = isIdle

    if (isIdle) {
      logger.info(`System is ${idleState}, skipping tick`)
      return
    }

    // 2. Load cron state flags from DB
    const db = getDb()
    const flags = await db.cronState.findUnique({ where: { id: 1 } })
    if (!flags) {
      logger.error('CronState row not found')
      return
    }

    // 3. Execute steps based on flags — each step is isolated
    // Step 1: Azure DevOps sync
    if (flags.syncEnabled) {
      const err = await runStep('Azure DevOps sync', syncWorkItems)
      if (err) cronStatus.stepErrors['sync'] = err
    }

    // Step 2: Worktree setup for newly profile-assigned stories
    if (flags.planningEnabled) {
      const err = await runStep('Worktree setup', setupStoryWorktrees)
      if (err) cronStatus.stepErrors['worktreeSetup'] = err
    }

    // Step 3: Planning step — spawn copilot sessions for stories ready to plan
    if (flags.planningEnabled) {
      const err = await runStep('Planning', runPlanningStep)
      if (err) cronStatus.stepErrors['planning'] = err
    }

    // Step 4: Task execution step — spawn copilot sessions for tasks ready to implement
    if (flags.taskExecutionEnabled) {
      const err = await runStep('Task execution', runTaskExecutionStep)
      if (err) cronStatus.stepErrors['taskExecution'] = err
    }

    // Step 5: PR check step — create task PRs, check comments/merges
    if (flags.prCheckEnabled) {
      const err = await runStep('PR check', runPrCheckStep)
      if (err) cronStatus.stepErrors['prCheck'] = err
    }

    // Step 6: Story PR check step — create story PRs, check comments/merges
    if (flags.storyPrCheckEnabled) {
      const err = await runStep('Story PR check', runStoryPrCheckStep)
      if (err) cronStatus.stepErrors['storyPrCheck'] = err
    }

    // Update last run timestamp
    const now = new Date()
    await db.cronState.update({
      where: { id: 1 },
      data: { lastRunAt: now },
    })
    cronStatus.lastRunAt = now

    // Set lastError to the first step error (if any)
    const stepErrorKeys = Object.keys(cronStatus.stepErrors)
    cronStatus.lastError = stepErrorKeys.length > 0
      ? `${stepErrorKeys.length} step(s) failed: ${stepErrorKeys.join(', ')}`
      : null

    // Send notifications for step errors
    for (const [step, errorMsg] of Object.entries(cronStatus.stepErrors)) {
      notifyCronError(step, errorMsg)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`Tick failed: ${message}`)
    cronStatus.lastError = message
  } finally {
    running = false
    cronStatus.running = false
  }
}

/**
 * Starts the cron job scheduler.
 * Should be called after database initialization.
 */
export function startCron(): void {
  if (intervalId) {
    logger.warn('Already running')
    return
  }

  logger.info('Starting scheduler (60s interval)')

  // Resume signal watchers from previous session
  resumeStoryWatchers().catch((err) => {
    logger.error('Failed to resume story watchers', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
  resumeTaskWatchers().catch((err) => {
    logger.error('Failed to resume task watchers', {
      error: err instanceof Error ? err.message : String(err),
    })
  })

  // Run immediately on start, then every minute
  tick()
  intervalId = setInterval(tick, CRON_INTERVAL_MS)
}

/**
 * Stops the cron job scheduler.
 */
export function stopCron(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped scheduler')
  }
}
