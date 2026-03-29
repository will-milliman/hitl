/**
 * Task execution step for the cron job.
 *
 * Finds tasks in TASK_PR_REVIEW state that have a worktree set up
 * but no copilot session yet. For each, it:
 * 1. Sets up hooks in the worktree
 * 2. Spawns a copilot CLI session with a task implementation prompt
 * 3. Saves the session ID to the database
 * 4. Starts watching for signal files (idle detection)
 *
 * This step is gated by the `taskExecutionEnabled` flag in CronState.
 */

import { getDb } from '../db'
import {
  spawnSession,
  setupHooks,
  hasHooks,
  ensureGitignore,
  watchSignals,
  isWatching,
} from '../copilot'

/**
 * The task execution prompt sent to Copilot CLI.
 *
 * Instructs the agent to implement the task as described.
 */
function buildTaskPrompt(
  taskId: number,
  taskTitle: string,
  storyId: number,
  storyTitle: string
): string {
  return `You are implementing a development task.

Story #${storyId}: ${storyTitle}
Task #${taskId}: ${taskTitle}

Your goal is to implement this task completely. Please:

1. Read the PLAN.md file (if it exists) to understand the overall story plan.
2. Analyze the codebase to understand existing patterns and conventions.
3. Implement the changes described in this task.
4. Ensure your changes follow the existing code style and patterns.
5. Write or update tests if the project has a test suite.
6. Commit your changes with a clear, descriptive commit message referencing Task #${taskId}.

After implementing, create a pull request if you have the necessary tools.
The PR should target the story branch (story/${storyId}).

Focus on quality and correctness. Ask for clarification if the task description is ambiguous.`
}

/**
 * Runs the task execution step: spawns copilot sessions for tasks
 * that are ready for implementation.
 */
export async function runTaskExecutionStep(): Promise<void> {
  const db = getDb()

  // Find tasks that have a worktree but no session
  const tasks = await db.task.findMany({
    where: {
      worktreePath: { not: null },
      sessionId: null,
      prMerged: false,
      disabled: true, // Should be disabled (agent will be working)
    },
    include: {
      story: {
        select: { id: true, title: true, state: true },
      },
    },
  })

  // Only process tasks whose story is in TASK_PR_REVIEW state
  const eligibleTasks = tasks.filter((t) => t.story.state === 'TASK_PR_REVIEW')

  if (eligibleTasks.length === 0) return

  console.log(`[task-exec] Found ${eligibleTasks.length} tasks ready for execution`)

  for (const task of eligibleTasks) {
    const worktreePath = task.worktreePath!

    try {
      // Set up hooks if not already present
      if (!hasHooks(worktreePath)) {
        console.log(`[task-exec] Setting up hooks for task #${task.id}`)
        setupHooks(worktreePath)
        ensureGitignore(worktreePath)
      }

      // Spawn a copilot session
      console.log(`[task-exec] Spawning execution session for task #${task.id}`)
      const { sessionId } = await spawnSession({
        cwd: worktreePath,
        prompt: buildTaskPrompt(task.id, task.title, task.story.id, task.story.title),
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

      console.log(`[task-exec] Task #${task.id} execution session: ${sessionId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[task-exec] Failed to start execution for task #${task.id}: ${message}`
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
      sessionId: { not: null },
      worktreePath: { not: null },
      disabled: true,
      prMerged: false,
    },
  })

  for (const task of tasksWithSessions) {
    if (!isWatching(task.worktreePath!)) {
      watchSignals(task.worktreePath!, 'task', task.id)
      console.log(`[task-exec] Resumed watcher for task #${task.id}`)
    }
  }
}
