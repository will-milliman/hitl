/**
 * Task PR check cron step.
 *
 * Runs on each cron tick (gated by `prCheckEnabled` flag). Handles:
 *
 * 1. **PR Creation**: For tasks in TASK_PR_REVIEW that are idle (disabled=false)
 *    and have no PR yet, pushes the task branch and creates a PR targeting
 *    the story branch.
 *
 * 2. **PR Comment Monitoring**: For tasks with a PR and prUpdated=true (or
 *    on every tick as a fallback), fetches unresolved review comments. If
 *    comments are found and the task session is idle, resumes the copilot
 *    session with the comment context.
 *
 * 3. **PR Merge Detection**: For tasks with a PR, checks if the PR has been
 *    merged. If merged, sets prMerged=true and disabled=true.
 *
 * 4. **All Tasks Merged Check**: If all tasks for a story are merged, moves
 *    the story to STORY_PR_REVIEW state.
 *
 * All GitHub operations use the `gh` CLI (authenticated via `gh auth login`).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { getDb } from '../db'
import {
  isGhAuthenticated,
  getRepoInfo,
  createPullRequest,
  findPullRequest,
  getPullRequestByUrl,
  getPrReviewComments,
  findUnresolvedThreads,
  formatCommentsForPrompt,
  extractPrNumber,
  extractRepoFromPrUrl,
} from '../github'
import {
  spawnSession,
  setupHooks,
  hasHooks,
  ensureGitignore,
  watchSignals,
  isWatching,
} from '../copilot'
import { getBranchName } from '../worktree'
import { notifyAllTasksMerged, notifyPrReviewNeeded } from '../notifications'

const execFileAsync = promisify(execFile)

/**
 * Pushes a branch to origin from a worktree.
 */
async function pushBranch(worktreePath: string, branchName: string): Promise<void> {
  console.log(`[pr-check] Pushing ${branchName} from ${worktreePath}`)
  await execFileAsync('git', ['push', '-u', 'origin', branchName], {
    cwd: worktreePath,
    timeout: 60_000,
    windowsHide: true,
  })
}

/**
 * Builds a prompt for copilot to address PR review comments.
 */
function buildCommentPrompt(
  taskId: number,
  taskTitle: string,
  commentText: string
): string {
  return `You are working on Task #${taskId}: ${taskTitle}

Your pull request has received review comments that need to be addressed.

${commentText}

Please:
1. Read each review comment carefully.
2. Make the requested code changes.
3. Commit your changes with a descriptive message referencing Task #${taskId}.
4. Push your changes to update the PR.

Focus on addressing ALL the review comments.`
}

/**
 * Step 1: Create PRs for tasks that have completed work but no PR yet.
 *
 * Finds tasks where:
 * - Story is in TASK_PR_REVIEW state
 * - Task has a worktree and session (agent has worked)
 * - Task is not disabled (agent is idle / done)
 * - Task has no prUrl yet
 * - Task is not already merged
 */
async function createTaskPRs(): Promise<void> {
  const db = getDb()

  const tasks = await db.task.findMany({
    where: {
      prUrl: null,
      prMerged: false,
      disabled: false,
      sessionId: { not: null },
      worktreePath: { not: null },
    },
    include: {
      story: {
        select: { id: true, title: true, state: true, worktreePath: true, profileKey: true },
      },
    },
  })

  const eligible = tasks.filter((t) => t.story.state === 'TASK_PR_REVIEW')
  if (eligible.length === 0) return

  console.log(`[pr-check] Found ${eligible.length} tasks needing PRs`)

  for (const task of eligible) {
    try {
      const worktreePath = task.worktreePath!
      const taskBranch = getBranchName('task', task.id)
      const storyBranch = getBranchName('story', task.story.id)

      // Push the task branch
      await pushBranch(worktreePath, taskBranch)

      // Check if a PR already exists (maybe created manually)
      const existing = await findPullRequest(worktreePath, taskBranch, storyBranch)

      let prUrl: string
      if (existing) {
        console.log(`[pr-check] PR already exists for task #${task.id}: ${existing.url}`)
        prUrl = existing.url
      } else {
        // Create the PR
        const pr = await createPullRequest(worktreePath, {
          title: `Task #${task.id}: ${task.title}`,
          body: [
            `## Task #${task.id}`,
            '',
            `**Story**: #${task.story.id} — ${task.story.title}`,
            '',
            `**Task**: ${task.title}`,
            '',
            `This PR implements the changes for Task #${task.id}.`,
            '',
            `---`,
            `*Created by HITL Orchestrator*`,
          ].join('\n'),
          head: taskBranch,
          base: storyBranch,
        })

        prUrl = pr.url
        console.log(`[pr-check] Created PR for task #${task.id}: ${prUrl}`)
      }

      // Save PR URL to database
      await db.task.update({
        where: { id: task.id },
        data: { prUrl },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[pr-check] Failed to create PR for task #${task.id}: ${message}`)
    }
  }
}

/**
 * Step 2: Check for unresolved review comments on task PRs.
 *
 * For tasks with a PR that has prUpdated=true (or periodically),
 * fetches review comments. If there are unresolved comments and
 * the task session is idle, spawns/resumes a copilot session to
 * address them.
 */
async function checkTaskPRComments(): Promise<void> {
  const db = getDb()

  // Find tasks with PRs that need comment checking
  const tasks = await db.task.findMany({
    where: {
      prUrl: { not: null },
      prMerged: false,
      disabled: false, // Only check when agent is idle (human can review)
      prUpdated: true, // Only check when flagged as updated
    },
    include: {
      story: {
        select: { id: true, title: true },
      },
    },
  })

  if (tasks.length === 0) return

  console.log(`[pr-check] Checking comments on ${tasks.length} task PRs`)

  for (const task of tasks) {
    try {
      const prUrl = task.prUrl!
      const worktreePath = task.worktreePath!
      const repoInfo = extractRepoFromPrUrl(prUrl)
      const prNumber = extractPrNumber(prUrl)

      if (!repoInfo || !prNumber) {
        console.warn(`[pr-check] Cannot parse PR URL: ${prUrl}`)
        continue
      }

      // Fetch review comments via gh api
      const comments = await getPrReviewComments(
        worktreePath,
        repoInfo.owner,
        repoInfo.repo,
        prNumber
      )

      // Get the PR author login
      const pr = await getPullRequestByUrl(prUrl, worktreePath)
      const authorLogin = pr.author?.login

      // Find unresolved threads (reviewer comments not yet addressed)
      const unresolved = authorLogin
        ? findUnresolvedThreads(comments, authorLogin)
        : []

      // Clear prUpdated flag — we've checked
      await db.task.update({
        where: { id: task.id },
        data: { prUpdated: false },
      })

      if (unresolved.length === 0) {
        console.log(`[pr-check] No unresolved comments on task #${task.id} PR`)
        continue
      }

      console.log(
        `[pr-check] Found ${unresolved.length} unresolved comments on task #${task.id}`
      )

      notifyPrReviewNeeded('task', task.id, task.title, unresolved.length)

      // Format comments into a prompt
      const commentText = formatCommentsForPrompt(unresolved)
      const prompt = buildCommentPrompt(task.id, task.title, commentText)

      // Set up hooks if needed
      if (!hasHooks(worktreePath)) {
        setupHooks(worktreePath)
        ensureGitignore(worktreePath)
      }

      // Spawn a new copilot session to address comments
      const { sessionId } = await spawnSession({
        cwd: worktreePath,
        prompt,
      })

      // Update task with new session and mark as disabled (agent working)
      await db.task.update({
        where: { id: task.id },
        data: {
          sessionId,
          disabled: true,
        },
      })

      // Start watching for signals
      if (!isWatching(worktreePath)) {
        watchSignals(worktreePath, 'task', task.id)
      }

      console.log(
        `[pr-check] Spawned comment-fix session for task #${task.id}: ${sessionId}`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[pr-check] Failed to check comments for task #${task.id}: ${message}`
      )
    }
  }
}

/**
 * Step 3: Check for merged task PRs.
 *
 * For tasks with a PR, checks if the PR has been merged.
 * If merged: sets prMerged=true, disabled=true, stops watching.
 *
 * Also checks if ALL tasks for a story are merged. If so,
 * moves the story to STORY_PR_REVIEW state.
 */
async function checkTaskPRMerges(): Promise<void> {
  const db = getDb()

  // Find tasks with PRs that haven't been marked as merged yet
  const tasks = await db.task.findMany({
    where: {
      prUrl: { not: null },
      prMerged: false,
    },
    include: {
      story: {
        select: { id: true, state: true },
      },
    },
  })

  if (tasks.length === 0) return

  // Only process tasks whose story is in TASK_PR_REVIEW
  const eligible = tasks.filter((t) => t.story.state === 'TASK_PR_REVIEW')
  if (eligible.length === 0) return

  console.log(`[pr-check] Checking merge status for ${eligible.length} task PRs`)

  // Track which stories had tasks merge this tick
  const storiesWithMerges = new Set<number>()

  for (const task of eligible) {
    try {
      const prUrl = task.prUrl!
      const worktreePath = task.worktreePath!

      // Get the PR state via gh pr view
      const pr = await getPullRequestByUrl(prUrl, worktreePath)

      if (pr.state === 'MERGED') {
        console.log(`[pr-check] Task #${task.id} PR has been merged`)

        await db.task.update({
          where: { id: task.id },
          data: {
            prMerged: true,
            disabled: true,
          },
        })

        storiesWithMerges.add(task.storyId)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[pr-check] Failed to check merge for task #${task.id}: ${message}`
      )
    }
  }

  // Check if all tasks for any story are now merged
  for (const storyId of storiesWithMerges) {
    try {
      const allTasks = await db.task.findMany({
        where: { storyId },
      })

      const allMerged = allTasks.length > 0 && allTasks.every((t) => t.prMerged)

      if (allMerged) {
        console.log(
          `[pr-check] All ${allTasks.length} tasks merged for story #${storyId} — moving to STORY_PR_REVIEW`
        )

        const story = await db.story.findUnique({ where: { id: storyId } })

        await db.story.update({
          where: { id: storyId },
          data: {
            state: 'STORY_PR_REVIEW',
            disabled: true, // Will be re-enabled after story PR is created
          },
        })

        if (story) {
          notifyAllTasksMerged(storyId, story.title)
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[pr-check] Failed to check all-merged for story #${storyId}: ${message}`
      )
    }
  }
}

/**
 * Main entry point: runs all task PR check sub-steps.
 */
export async function runPrCheckStep(): Promise<void> {
  // Check gh CLI auth before doing anything
  const authenticated = await isGhAuthenticated()
  if (!authenticated) {
    console.log('[pr-check] gh CLI not authenticated, skipping PR check step')
    return
  }

  await createTaskPRs()
  await checkTaskPRMerges()
  await checkTaskPRComments()
}
