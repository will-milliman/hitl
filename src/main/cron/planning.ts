/**
 * Planning step for the cron job.
 *
 * Finds stories in PLAN_APPROVAL state that have a worktree set up
 * but no copilot session yet. For each, it:
 * 1. Sets up hooks in the worktree
 * 2. Spawns a copilot CLI session with a planning prompt
 * 3. Saves the session ID to the database
 * 4. Starts watching for signal files (idle detection)
 *
 * This step is gated by the `planningEnabled` flag in CronState.
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
 * The planning prompt sent to Copilot CLI.
 *
 * Instructs the agent to:
 * 1. Read the story/requirements
 * 2. Plan acceptance criteria
 * 3. Plan individual tasks needed to complete the story
 * 4. Write the plan to a PLAN.md file for human review
 */
function buildPlanningPrompt(storyId: number, storyTitle: string): string {
  return `You are planning a development story.

Story #${storyId}: ${storyTitle}

Your goal is to create a detailed plan for implementing this story. Please:

1. Analyze the story requirements and the codebase in this worktree.
2. Write detailed acceptance criteria for the story.
3. Break the story down into individual development tasks. Each task should be:
   - Small and focused (ideally completable in 1-2 hours)
   - Independent where possible
   - Clearly described with what needs to be done
4. Write the complete plan to a file called PLAN.md in the root of this worktree.

The PLAN.md file should have this structure:
\`\`\`markdown
# Plan: Story #${storyId} - ${storyTitle}

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
...

## Tasks
### Task 1: <title>
<description of what needs to be done>

### Task 2: <title>
<description of what needs to be done>
...
\`\`\`

Focus on understanding the existing codebase patterns and conventions before planning.
Do not start implementing — only plan.`
}

/**
 * Runs the planning step: spawns copilot sessions for stories
 * that are ready for planning.
 */
export async function runPlanningStep(): Promise<void> {
  const db = getDb()

  // Find stories in PLAN_APPROVAL with a worktree but no session
  const stories = await db.story.findMany({
    where: {
      state: 'PLAN_APPROVAL',
      worktreePath: { not: null },
      sessionId: null,
      disabled: true, // Should be disabled (agent will be working)
    },
  })

  if (stories.length === 0) return

  console.log(`[planning] Found ${stories.length} stories ready for planning`)

  for (const story of stories) {
    const worktreePath = story.worktreePath!

    try {
      // Set up hooks if not already present
      if (!hasHooks(worktreePath)) {
        console.log(`[planning] Setting up hooks for story #${story.id}`)
        setupHooks(worktreePath)
        ensureGitignore(worktreePath)
      }

      // Spawn a copilot session
      console.log(`[planning] Spawning planning session for story #${story.id}`)
      const { sessionId } = await spawnSession({
        cwd: worktreePath,
        prompt: buildPlanningPrompt(story.id, story.title),
      })

      // Save session ID to database
      await db.story.update({
        where: { id: story.id },
        data: { sessionId },
      })

      // Start watching for signal files
      if (!isWatching(worktreePath)) {
        watchSignals(worktreePath, 'story', story.id)
      }

      console.log(`[planning] Story #${story.id} planning session: ${sessionId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[planning] Failed to start planning for story #${story.id}: ${message}`
      )
      // Don't fail the whole step — continue with other stories
    }
  }
}

/**
 * Re-establishes watchers for stories that have active sessions.
 *
 * Called on app startup to resume watching for signal files
 * from sessions that were spawned in a previous app session.
 */
export async function resumeStoryWatchers(): Promise<void> {
  const db = getDb()

  const storiesWithSessions = await db.story.findMany({
    where: {
      state: 'PLAN_APPROVAL',
      sessionId: { not: null },
      worktreePath: { not: null },
      disabled: true, // Still waiting for agent to finish
    },
  })

  for (const story of storiesWithSessions) {
    if (!isWatching(story.worktreePath!)) {
      watchSignals(story.worktreePath!, 'story', story.id)
      console.log(`[planning] Resumed watcher for story #${story.id}`)
    }
  }
}
