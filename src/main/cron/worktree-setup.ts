/**
 * Worktree setup step for the cron job.
 *
 * Finds stories in PLAN_APPROVAL state that have a profile assigned
 * but no worktree yet. For each, it creates a git worktree with
 * a new branch `story/<workItemId>` based on the profile's default branch.
 *
 * This step is gated by the `planningEnabled` flag in CronState.
 */

import { getDb } from '../db'
import { createWorktree } from '../worktree'
import type { ProfileMap } from '../../shared/types'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Loads profile.json from the project root.
 */
function loadProfiles(): ProfileMap {
  try {
    const profilePath = join(__dirname, '../../profile.json')
    const raw = readFileSync(profilePath, 'utf-8')
    return JSON.parse(raw) as ProfileMap
  } catch (err) {
    console.error('[worktree-setup] Failed to load profile.json:', err)
    return {}
  }
}

/**
 * Sets up worktrees for stories that have been assigned a profile
 * but don't have a worktree yet.
 *
 * Called by the cron job when planningEnabled is true.
 */
export async function setupStoryWorktrees(): Promise<void> {
  const db = getDb()

  // Find stories in PLAN_APPROVAL with a profile but no worktree
  const stories = await db.story.findMany({
    where: {
      state: 'PLAN_APPROVAL',
      profileKey: { not: null },
      worktreePath: null,
      disabled: true, // Should be disabled (agent is going to work on it)
    },
  })

  if (stories.length === 0) return

  const profiles = loadProfiles()

  for (const story of stories) {
    const profileKey = story.profileKey!
    const profile = profiles[profileKey]

    if (!profile) {
      console.warn(
        `[worktree-setup] Story #${story.id}: profile "${profileKey}" not found in profile.json`
      )
      continue
    }

    try {
      console.log(
        `[worktree-setup] Setting up worktree for story #${story.id} (profile: ${profileKey})`
      )

      const worktreePath = await createWorktree(
        profile.repoPath,
        'story',
        story.id,
        profile.defaultBranch
      )

      // Update the story with the worktree path
      await db.story.update({
        where: { id: story.id },
        data: { worktreePath },
      })

      console.log(
        `[worktree-setup] Story #${story.id} worktree ready at ${worktreePath}`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[worktree-setup] Failed to create worktree for story #${story.id}: ${message}`
      )
      // Don't fail the whole step — continue with other stories
    }
  }
}
