/**
 * Worktree setup step for the cron job.
 *
 * Finds tasks in TASK_EXECUTION state that have a profile assigned
 * but no worktree yet. For each, it creates a git worktree with
 * a new branch `task/<workItemId>` based on the profile's default branch.
 *
 * Task PRs target the default branch directly (no story branch hierarchy).
 */

import { getDb } from '../db'
import { createWorktree } from '../worktree'
import { loadProfiles } from '../settings'
import { createLogger } from '../logger'
import { GridState } from '../../shared/constants'

const logger = createLogger('worktree-setup')

/**
 * Sets up worktrees for tasks that have been assigned a profile
 * and moved to TASK_EXECUTION but don't have a worktree yet.
 *
 * Called by the cron job when taskExecutionEnabled is true.
 */
export async function setupTaskWorktrees(): Promise<void> {
  const db = getDb()

  // Find tasks in TASK_EXECUTION with a profile but no worktree
  const tasks = await db.task.findMany({
    where: {
      state: GridState.TASK_EXECUTION,
      profileKey: { not: null },
      worktreePath: null,
      disabled: true, // Should be disabled (agent is going to work on it)
    },
  })

  if (tasks.length === 0) return

  const profiles = loadProfiles()

  for (const task of tasks) {
    const profileKey = task.profileKey!
    const profile = profiles[profileKey]

    if (!profile) {
      logger.warn(
        `Task #${task.id}: profile "${profileKey}" not found in profile.json`
      )
      continue
    }

    try {
      logger.info(
        `Setting up worktree for task #${task.id} (profile: ${profileKey})`
      )

      // Tasks branch directly from the default branch (no story branch hierarchy)
      const worktreePath = await createWorktree(
        profile.repoPath,
        'task',
        task.id,
        profile.defaultBranch
      )

      // Update the task with the worktree path
      await db.task.update({
        where: { id: task.id },
        data: { worktreePath },
      })

      logger.info(
        `Task #${task.id} worktree ready at ${worktreePath}`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        `Failed to create worktree for task #${task.id}: ${message}`
      )
      // Don't fail the whole step — continue with other tasks
    }
  }
}
