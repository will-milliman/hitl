/**
 * Task execution step for the cron job.
 *
 * Finds tasks in TASK_EXECUTION state that have a worktree set up
 * but no copilot session yet. For each, it:
 * 1. Sets up hooks in the worktree
 * 2. Spawns a copilot CLI session with a task implementation prompt
 * 3. Saves the session ID to the database
 * 4. Starts watching for signal files (idle detection)
 *
 * Also handles recovery of interrupted flows:
 * - Worktree path points to a non-existent directory -> reset to null
 * - Session ended while app was off -> detect via signal files, mark disabled=false
 * - Session died without signaling -> detect stale sessions, reset sessionId
 *
 * This step is gated by the `taskExecutionEnabled` flag in CronState.
 */

import { getDb } from '../db'
import { existsSync } from 'fs'
import {
  spawnSession,
  ensureGlobalHooks,
  watchSignals,
  isWatching,
  readLatestSignal,
  SIGNAL_FILES,
  getLogDir,
} from '../copilot'
import { GridState } from '../../shared/constants'
import { createLogger } from '../logger'

const logger = createLogger('task-exec')

/**
 * The task execution prompt sent to Copilot CLI.
 *
 * Instructs the agent to implement the task as described.
 */
function buildTaskPrompt(
  taskId: number,
  taskTitle: string,
  storyTitle?: string
): string {
  const storyContext = storyTitle ? `\nParent Story: ${storyTitle}\n` : ''
  return `You are implementing a development task.
${storyContext}
Task #${taskId}: ${taskTitle}

Your goal is to implement this task completely. Please:

1. Analyze the codebase to understand existing patterns and conventions.
2. Implement the changes described in this task.
3. Ensure your changes follow the existing code style and patterns.
4. Write or update tests if the project has a test suite.
5. Commit your changes with a clear, descriptive commit message referencing Task #${taskId}.

After implementing, create a pull request targeting the default branch (e.g., main).

Focus on quality and correctness. Ask for clarification if the task description is ambiguous.`
}

/**
 * Recovers tasks in TASK_EXECUTION that are stuck due to interrupted flows.
 *
 * Handles these scenarios:
 * 1. Worktree path set but directory doesn't exist -> reset worktreePath to null
 * 2. Session ended while app was off -> session-end signal exists, mark disabled=false
 * 3. Session idle while app was off -> mark disabled=false
 * 4. Session died without signaling -> no log directory, reset sessionId
 */
async function recoverInterruptedTasks(): Promise<void> {
  const db = getDb()

  // Scenario 1: Worktree path points to a non-existent directory
  const tasksWithWorktrees = await db.task.findMany({
    where: {
      state: GridState.TASK_EXECUTION,
      worktreePath: { not: null },
      disabled: true,
    },
  })

  for (const task of tasksWithWorktrees) {
    if (!existsSync(task.worktreePath!)) {
      logger.info(
        `Task #${task.id}: worktree at ${task.worktreePath} no longer exists, resetting`
      )
      await db.task.update({
        where: { id: task.id },
        data: { worktreePath: null, sessionId: null },
      })
    }
  }

  // Scenario 2 & 3: Tasks with a session that may have ended or died
  const tasksWithSessions = await db.task.findMany({
    where: {
      state: GridState.TASK_EXECUTION,
      sessionId: { not: null },
      worktreePath: { not: null },
      disabled: true,
    },
  })

  for (const task of tasksWithSessions) {
    const worktreePath = task.worktreePath!

    const signal = readLatestSignal(worktreePath)

    if (signal?.signal === SIGNAL_FILES.SESSION_END) {
      logger.info(
        `Task #${task.id}: session ended while app was off, enabling for review`
      )
      await db.task.update({
        where: { id: task.id },
        data: { disabled: false },
      })
      continue
    }

    if (signal?.signal === SIGNAL_FILES.SESSION_IDLE) {
      logger.info(
        `Task #${task.id}: session idle while app was off, enabling`
      )
      await db.task.update({
        where: { id: task.id },
        data: { disabled: false },
      })
      continue
    }

    // Check if log directory exists
    const logDir = getLogDir(worktreePath)
    if (!existsSync(logDir)) {
      logger.info(
        `Task #${task.id}: no log directory found, resetting session`
      )
      await db.task.update({
        where: { id: task.id },
        data: { sessionId: null },
      })
      continue
    }

    // If we have a session with an active signal, make sure the watcher is running
    if (!isWatching(worktreePath)) {
      watchSignals(worktreePath, 'task', task.id)
      logger.info(`Task #${task.id}: re-established watcher for active session`)
    }
  }
}

/**
 * Runs the task execution step: spawns copilot sessions for tasks
 * that are ready for implementation.
 */
export async function runTaskExecutionStep(): Promise<void> {
  const db = getDb()

  // First, recover any interrupted flows from previous app sessions
  await recoverInterruptedTasks()

  // Find tasks in TASK_EXECUTION with a worktree but no session
  const tasks = await db.task.findMany({
    where: {
      state: GridState.TASK_EXECUTION,
      worktreePath: { not: null },
      sessionId: null,
      disabled: true, // Should be disabled (agent will be working)
    },
    include: {
      story: {
        select: { title: true },
      },
    },
  })

  if (tasks.length === 0) return

  logger.info(`Found ${tasks.length} tasks ready for execution`)

  for (const task of tasks) {
    const worktreePath = task.worktreePath!

    try {
      // Ensure global hooks are configured
      ensureGlobalHooks()

      // Spawn a copilot session
      logger.info(`Spawning execution session for task #${task.id}`)
      const { sessionId } = await spawnSession({
        cwd: worktreePath,
        prompt: buildTaskPrompt(task.id, task.title, task.story?.title),
      })

      // Save session ID to database
      await db.task.update({
        where: { id: task.id },
        data: { sessionId },
      })

      // Start watching for signal files
      if (!isWatching(worktreePath)) {
        watchSignals(worktreePath, 'task', task.id)
      }

      logger.info(`Task #${task.id} execution session: ${sessionId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        `Failed to start execution for task #${task.id}: ${message}`
      )
      // Don't fail the whole step — continue with other tasks
    }
  }
}

/**
 * Re-establishes watchers for tasks that have active sessions.
 *
 * Called on app startup to resume watching for signal files
 * from sessions that were spawned in a previous app session.
 */
export async function resumeTaskWatchers(): Promise<void> {
  const db = getDb()

  const tasksWithSessions = await db.task.findMany({
    where: {
      state: GridState.TASK_EXECUTION,
      sessionId: { not: null },
      worktreePath: { not: null },
      disabled: true,
    },
  })

  for (const task of tasksWithSessions) {
    if (!isWatching(task.worktreePath!)) {
      watchSignals(task.worktreePath!, 'task', task.id)
      logger.info(`Resumed watcher for task #${task.id}`)
    }
  }
}
