/**
 * Cron job scheduler.
 *
 * Runs a tick every 60 seconds. On each tick:
 * 1. Checks if the system is idle (powerMonitor)
 * 2. Checks CronState flags to see which steps are enabled
 * 3. Executes the Azure DevOps sync step (if enabled)
 * 4. Sets up worktrees for newly profile-assigned tasks (if enabled)
 * 5. Spawns copilot task execution sessions (if enabled)
 * 6. Checks task PRs for draft status/readiness/merges (if pr-check enabled)
 *
 * Each step is isolated — a failure in one step does not prevent
 * subsequent steps from running. Errors are logged and tracked.
 */
import { powerMonitor } from 'electron';

import { IDLE_THRESHOLD_SECONDS } from '../../shared/constants';
import { getDb } from '../db';
import { createLogger } from '../logger';
import { notifyCronError } from '../notifications';

import { runPrCheckStep } from './pr-check';
import { reconcileStates } from './state-reconciliation';
import { syncWorkItems } from './sync';
import { resumeTaskWatchers, runTaskExecutionStep } from './task-execution';
import { setupTaskWorktrees } from './worktree-setup';

const logger = createLogger('cron');

const CRON_INTERVAL_MS = 60_000; // 1 minute

let intervalId: ReturnType<typeof setInterval> | null = null;
let running = false;

export interface CronStatus {
  running: boolean;
  idle: boolean;
  lastRunAt: Date | null;
  lastError: string | null;
  /** Per-step error tracking for the last tick */
  stepErrors: Record<string, string>;
}

const cronStatus: CronStatus = {
  running: false,
  idle: false,
  lastRunAt: null,
  lastError: null,
  stepErrors: {},
};

/**
 * Returns the current cron job status (for UI display).
 */
export function getCronStatus(): CronStatus {
  return { ...cronStatus, stepErrors: { ...cronStatus.stepErrors } };
}

/**
 * Runs a single cron step with error isolation.
 * Returns the error message if the step failed, or null on success.
 */
async function runStep(name: string, fn: () => Promise<void>): Promise<string | null> {
  try {
    logger.info(`Running ${name}...`);
    await fn();
    logger.info(`${name} complete`);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`${name} failed: ${message}`, {
      step: name,
      error: message,
    });
    return message;
  }
}

/**
 * Records an error on a task in the database.
 */
export async function recordTaskError(taskId: number, errorMessage: string): Promise<void> {
  try {
    const db = getDb();
    await db.task.update({
      where: { id: taskId },
      data: {
        errorMessage,
        errorAt: new Date(),
      },
    });
  } catch (err) {
    logger.error(`Failed to record error for task #${taskId}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Clears an error on a task in the database.
 */
export async function clearTaskError(taskId: number): Promise<void> {
  try {
    const db = getDb();
    await db.task.update({
      where: { id: taskId },
      data: {
        errorMessage: null,
        errorAt: null,
      },
    });
  } catch {
    // Silently ignore — clearing errors is best-effort
  }
}

/**
 * Executes a single cron tick.
 * Each step is isolated — failures don't cascade.
 */
async function tick(): Promise<void> {
  if (running) {
    logger.debug('Previous tick still running, skipping');
    return;
  }

  running = true;
  cronStatus.running = true;
  cronStatus.stepErrors = {};

  try {
    // 1. Check idle state
    const idleState = powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS);
    const isIdle = idleState === 'idle' || idleState === 'locked';
    cronStatus.idle = isIdle;

    if (isIdle) {
      logger.info(`System is ${idleState}, skipping tick`);
      return;
    }

    // 2. Load cron state flags from DB
    const db = getDb();
    const flags = await db.cronState.findUnique({ where: { id: 1 } });
    if (!flags) {
      logger.error('CronState row not found');
      return;
    }

    // 3. Execute steps based on flags — each step is isolated

    // Step 1: Azure DevOps sync
    if (flags.syncEnabled) {
      const err = await runStep('Azure DevOps sync', syncWorkItems);
      if (err) cronStatus.stepErrors['sync'] = err;
    }

    // Step 2: Worktree setup for newly profile-assigned tasks
    if (flags.taskExecutionEnabled) {
      const err = await runStep('Worktree setup', setupTaskWorktrees);
      if (err) cronStatus.stepErrors['worktreeSetup'] = err;
    }

    // Step 3: Task execution step — spawn copilot sessions for tasks ready to implement
    if (flags.taskExecutionEnabled) {
      const err = await runStep('Task execution', runTaskExecutionStep);
      if (err) cronStatus.stepErrors['taskExecution'] = err;
    }

    // Step 4: PR check step — check draft status, readiness, comments/merges
    if (flags.prCheckEnabled) {
      const err = await runStep('PR check', runPrCheckStep);
      if (err) cronStatus.stepErrors['prCheck'] = err;
    }

    // Update last run timestamp
    const now = new Date();
    await db.cronState.update({
      where: { id: 1 },
      data: { lastRunAt: now },
    });
    cronStatus.lastRunAt = now;

    // Set lastError to the first step error (if any)
    const stepErrorKeys = Object.keys(cronStatus.stepErrors);
    cronStatus.lastError =
      stepErrorKeys.length > 0 ? `${stepErrorKeys.length} step(s) failed: ${stepErrorKeys.join(', ')}` : null;

    // Send notifications for step errors
    for (const [step, errorMsg] of Object.entries(cronStatus.stepErrors)) {
      notifyCronError(step, errorMsg);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Tick failed: ${message}`);
    cronStatus.lastError = message;
  } finally {
    running = false;
    cronStatus.running = false;
  }
}

/**
 * Starts the cron job scheduler.
 * Should be called after database initialization.
 */
export function startCron(): void {
  if (intervalId) {
    logger.warn('Already running');
    return;
  }

  logger.info('Starting scheduler (60s interval)');

  // Resume signal watchers from previous session
  resumeTaskWatchers().catch((err) => {
    logger.error('Failed to resume task watchers', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Run state reconciliation on startup to fix any out-of-sync items
  reconcileStates().catch((err) => {
    logger.error('Failed to reconcile states on startup', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Run immediately on start, then every minute
  tick();
  intervalId = setInterval(tick, CRON_INTERVAL_MS);
}

/**
 * Stops the cron job scheduler.
 */
export function stopCron(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Stopped scheduler');
  }
}
