/**
 * Task PR check cron step.
 *
 * Runs on each cron tick (gated by `prCheckEnabled` flag). Handles:
 *
 * 1. **PR Creation**: For tasks in PR_REVIEW that are idle (disabled=false)
 *    and have no PR yet, pushes the task branch and creates a PR targeting
 *    the profile's default branch.
 *
 * 2. **PR Comment Monitoring**: For tasks with a PR and prUpdated=true,
 *    fetches unresolved review comments. If comments are found and the
 *    task session is idle, resumes the copilot session with comment context.
 *
 * 3. **PR Merge Detection**: For tasks with a PR, checks if the PR has been
 *    merged. If merged, moves the task to COMPLETED state.
 *
 * All GitHub operations use the `gh` CLI (authenticated via `gh auth login`).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { getDb } from '../db'
import {
  isGhAuthenticated,
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
  ensureGlobalHooks,
  watchSignals,
  isWatching,
} from '../copilot'
import { getBranchName } from '../worktree'
import { loadProfiles } from '../settings'
import { notifyPrReviewNeeded, notifyTaskCompleted } from '../notifications'
import { GridState } from '../../shared/constants'
import { createLogger } from '../logger'

const logger = createLogger('pr-check')
const execFileAsync = promisify(execFile)

/**
 * Gets the default branch for a task's profile.
 */
function getDefaultBranch(profileKey: string | null): string {
  if (!profileKey) return 'main'
  try {
    const profiles = loadProfiles()
    return profiles[profileKey]?.defaultBranch ?? 'main'
  } catch {
    return 'main'
  }
}

/**
 * Pushes a branch to origin from a worktree.
 */
async function pushBranch(worktreePath: string, branchName: string): Promise<void> {
  logger.info(`Pushing ${branchName} from ${worktreePath}`)
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
 * - Task is in PR_REVIEW state
 * - Task has a worktree and session (agent has worked)
 * - Task is not disabled (agent is idle / done)
 * - Task has no prUrl yet
 * - Task is not already merged
 */
async function createTaskPRs(): Promise<void> {
  const db = getDb()

  const tasks = await db.task.findMany({
    where: {
      state: GridState.PR_REVIEW,
      prUrl: null,
      prMerged: false,
      disabled: false,
      sessionId: { not: null },
      worktreePath: { not: null },
    },
    include: {
      story: {
        select: { id: true, title: true },
      },
    },
  })

  if (tasks.length === 0) return

  logger.info(`Found ${tasks.length} tasks needing PRs`)

  for (const task of tasks) {
    try {
      const worktreePath = task.worktreePath!
      const taskBranch = getBranchName('task', task.id)
      const defaultBranch = getDefaultBranch(task.profileKey)

      // Push the task branch
      await pushBranch(worktreePath, taskBranch)

      // Check if a PR already exists (maybe created manually)
      const existing = await findPullRequest(worktreePath, taskBranch, defaultBranch)

      let prUrl: string
      if (existing) {
        logger.info(`PR already exists for task #${task.id}: ${existing.url}`)
        prUrl = existing.url
      } else {
        // Create the PR targeting the default branch
        const storyContext = task.story
          ? `\n**Story**: #${task.story.id} — ${task.story.title}\n`
          : ''

        const pr = await createPullRequest(worktreePath, {
          title: `Task #${task.id}: ${task.title}`,
          body: [
            `## Task #${task.id}`,
            '',
            `**Task**: ${task.title}`,
            storyContext,
            `This PR implements the changes for Task #${task.id}.`,
            '',
            `---`,
            `*Created by HITL Orchestrator*`,
          ].join('\n'),
          head: taskBranch,
          base: defaultBranch,
        })

        prUrl = pr.url
        logger.info(`Created PR for task #${task.id}: ${prUrl}`)
      }

      // Save PR URL to database
      await db.task.update({
        where: { id: task.id },
        data: { prUrl },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to create PR for task #${task.id}: ${message}`)
    }
  }
}

/**
 * Step 2: Check for unresolved review comments on task PRs.
 *
 * For tasks with a PR that has prUpdated=true,
 * fetches review comments. If there are unresolved comments and
 * the task session is idle, spawns a copilot session to address them.
 */
async function checkTaskPRComments(): Promise<void> {
  const db = getDb()

  const tasks = await db.task.findMany({
    where: {
      state: GridState.PR_REVIEW,
      prUrl: { not: null },
      prMerged: false,
      disabled: false, // Only check when agent is idle
      prUpdated: true, // Only check when flagged as updated
    },
  })

  if (tasks.length === 0) return

  logger.info(`Checking comments on ${tasks.length} task PRs`)

  for (const task of tasks) {
    try {
      const prUrl = task.prUrl!
      const worktreePath = task.worktreePath!
      const repoInfo = extractRepoFromPrUrl(prUrl)
      const prNumber = extractPrNumber(prUrl)

      if (!repoInfo || !prNumber) {
        logger.warn(`Cannot parse PR URL: ${prUrl}`)
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
        logger.info(`No unresolved comments on task #${task.id} PR`)
        continue
      }

      logger.info(
        `Found ${unresolved.length} unresolved comments on task #${task.id}`
      )

      notifyPrReviewNeeded('task', task.id, task.title, unresolved.length)

      // Format comments into a prompt
      const commentText = formatCommentsForPrompt(unresolved)
      const prompt = buildCommentPrompt(task.id, task.title, commentText)

      // Ensure global hooks are configured
      ensureGlobalHooks()

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

      logger.info(
        `Spawned comment-fix session for task #${task.id}: ${sessionId}`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        `Failed to check comments for task #${task.id}: ${message}`
      )
    }
  }
}

/**
 * Step 3: Check for merged task PRs.
 *
 * For tasks with a PR, checks if the PR has been merged.
 * If merged: moves the task to COMPLETED state.
 */
async function checkTaskPRMerges(): Promise<void> {
  const db = getDb()

  const tasks = await db.task.findMany({
    where: {
      state: GridState.PR_REVIEW,
      prUrl: { not: null },
      prMerged: false,
    },
  })

  if (tasks.length === 0) return

  logger.info(`Checking merge status for ${tasks.length} task PRs`)

  for (const task of tasks) {
    try {
      const prUrl = task.prUrl!
      const worktreePath = task.worktreePath!

      // Get the PR state via gh pr view
      const pr = await getPullRequestByUrl(prUrl, worktreePath)

      if (pr.state === 'MERGED') {
        logger.info(`Task #${task.id} PR has been merged — moving to COMPLETED`)

        await db.task.update({
          where: { id: task.id },
          data: {
            state: GridState.COMPLETED,
            prMerged: true,
            disabled: true,
            completedAt: new Date(),
          },
        })

        notifyTaskCompleted(task.id, task.title)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        `Failed to check merge for task #${task.id}: ${message}`
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
    logger.info('gh CLI not authenticated, skipping PR check step')
    return
  }

  await createTaskPRs()
  await checkTaskPRMerges()
  await checkTaskPRComments()
}
