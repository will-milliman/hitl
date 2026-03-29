/**
 * Story PR check cron step.
 *
 * Runs on each cron tick (gated by `storyPrCheckEnabled` flag). Handles:
 *
 * 1. **Story PR Creation**: When a story moves to STORY_PR_REVIEW and has no
 *    PR yet, pushes the story branch and creates a PR targeting the repo's
 *    default branch.
 *
 * 2. **PR Comment Monitoring**: For stories with a PR and prUpdated=true,
 *    fetches unresolved review comments. If comments are found and the
 *    story session is idle, spawns a copilot session with comment context.
 *
 * 3. **PR Merge Detection**: For stories with a PR, checks if the PR has
 *    been merged. If merged, moves the story to COMPLETED state.
 *
 * All GitHub operations use the `gh` CLI (authenticated via `gh auth login`).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync } from 'fs'
import { join } from 'path'
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
  setupHooks,
  hasHooks,
  ensureGitignore,
  watchSignals,
  isWatching,
} from '../copilot'
import { getBranchName } from '../worktree'
import type { ProfileMap } from '../../shared/types'
import { notifyStoryCompleted, notifyPrReviewNeeded } from '../notifications'

const execFileAsync = promisify(execFile)

/**
 * Reads profile.json to get the default branch for a profile.
 */
function getDefaultBranch(profileKey: string): string {
  try {
    const profilePath = join(__dirname, '../../profile.json')
    const raw = readFileSync(profilePath, 'utf-8')
    const profiles = JSON.parse(raw) as ProfileMap
    return profiles[profileKey]?.defaultBranch ?? 'main'
  } catch {
    return 'main'
  }
}

/**
 * Pushes a branch to origin from a worktree.
 */
async function pushBranch(worktreePath: string, branchName: string): Promise<void> {
  console.log(`[story-pr] Pushing ${branchName} from ${worktreePath}`)
  await execFileAsync('git', ['push', '-u', 'origin', branchName], {
    cwd: worktreePath,
    timeout: 60_000,
    windowsHide: true,
  })
}

/**
 * Builds a prompt for copilot to address story PR review comments.
 */
function buildCommentPrompt(
  storyId: number,
  storyTitle: string,
  commentText: string
): string {
  return `You are working on Story #${storyId}: ${storyTitle}

Your story pull request has received review comments that need to be addressed.

${commentText}

Please:
1. Read each review comment carefully.
2. Make the requested code changes on the story branch.
3. Commit your changes with a descriptive message referencing Story #${storyId}.
4. Push your changes to update the PR.

Focus on addressing ALL the review comments.`
}

/**
 * Step 1: Create story PRs for stories that have all tasks merged
 * and are now in STORY_PR_REVIEW state with no PR.
 */
async function createStoryPRs(): Promise<void> {
  const db = getDb()

  const stories = await db.story.findMany({
    where: {
      state: 'STORY_PR_REVIEW',
      prUrl: null,
      worktreePath: { not: null },
      profileKey: { not: null },
    },
  })

  if (stories.length === 0) return

  console.log(`[story-pr] Found ${stories.length} stories needing PRs`)

  for (const story of stories) {
    try {
      const worktreePath = story.worktreePath!
      const storyBranch = getBranchName('story', story.id)
      const defaultBranch = getDefaultBranch(story.profileKey!)

      // Push the story branch
      await pushBranch(worktreePath, storyBranch)

      // Check if a PR already exists
      const existing = await findPullRequest(worktreePath, storyBranch, defaultBranch)

      let prUrl: string
      if (existing) {
        console.log(`[story-pr] PR already exists for story #${story.id}: ${existing.url}`)
        prUrl = existing.url
      } else {
        // Collect task info for the PR body
        const tasks = await db.task.findMany({
          where: { storyId: story.id },
          orderBy: { id: 'asc' },
        })

        const taskList = tasks
          .map((t) => {
            const prLink = t.prUrl ? ` ([PR](${t.prUrl}))` : ''
            return `- [x] Task #${t.id}: ${t.title}${prLink}`
          })
          .join('\n')

        const pr = await createPullRequest(worktreePath, {
          title: `Story #${story.id}: ${story.title}`,
          body: [
            `## Story #${story.id}`,
            '',
            `**Title**: ${story.title}`,
            '',
            `### Completed Tasks`,
            '',
            taskList,
            '',
            `---`,
            `*Created by HITL Orchestrator*`,
          ].join('\n'),
          head: storyBranch,
          base: defaultBranch,
        })

        prUrl = pr.url
        console.log(`[story-pr] Created PR for story #${story.id}: ${prUrl}`)
      }

      // Save PR URL and enable for human review
      await db.story.update({
        where: { id: story.id },
        data: {
          prUrl,
          disabled: false,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[story-pr] Failed to create PR for story #${story.id}: ${message}`)
    }
  }
}

/**
 * Step 2: Check for unresolved review comments on story PRs.
 */
async function checkStoryPRComments(): Promise<void> {
  const db = getDb()

  const stories = await db.story.findMany({
    where: {
      state: 'STORY_PR_REVIEW',
      prUrl: { not: null },
      disabled: false,
      prUpdated: true,
      worktreePath: { not: null },
    },
  })

  if (stories.length === 0) return

  console.log(`[story-pr] Checking comments on ${stories.length} story PRs`)

  for (const story of stories) {
    try {
      const prUrl = story.prUrl!
      const worktreePath = story.worktreePath!
      const repoInfo = extractRepoFromPrUrl(prUrl)
      const prNumber = extractPrNumber(prUrl)

      if (!repoInfo || !prNumber) {
        console.warn(`[story-pr] Cannot parse PR URL: ${prUrl}`)
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

      // Find unresolved threads
      const unresolved = authorLogin
        ? findUnresolvedThreads(comments, authorLogin)
        : []

      // Clear prUpdated flag
      await db.story.update({
        where: { id: story.id },
        data: { prUpdated: false },
      })

      if (unresolved.length === 0) {
        console.log(`[story-pr] No unresolved comments on story #${story.id} PR`)
        continue
      }

      console.log(
        `[story-pr] Found ${unresolved.length} unresolved comments on story #${story.id}`
      )

      notifyPrReviewNeeded('story', story.id, story.title, unresolved.length)

      const commentText = formatCommentsForPrompt(unresolved)
      const prompt = buildCommentPrompt(story.id, story.title, commentText)

      // Set up hooks if needed
      if (!hasHooks(worktreePath)) {
        setupHooks(worktreePath)
        ensureGitignore(worktreePath)
      }

      // Spawn a copilot session
      const { sessionId } = await spawnSession({
        cwd: worktreePath,
        prompt,
      })

      // Update story with new session and mark as disabled
      await db.story.update({
        where: { id: story.id },
        data: {
          sessionId,
          disabled: true,
        },
      })

      // Start watching for signals
      if (!isWatching(worktreePath)) {
        watchSignals(worktreePath, 'story', story.id)
      }

      console.log(
        `[story-pr] Spawned comment-fix session for story #${story.id}: ${sessionId}`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[story-pr] Failed to check comments for story #${story.id}: ${message}`
      )
    }
  }
}

/**
 * Step 3: Check for merged story PRs.
 *
 * If a story PR is merged, move the story to COMPLETED state.
 */
async function checkStoryPRMerges(): Promise<void> {
  const db = getDb()

  const stories = await db.story.findMany({
    where: {
      state: 'STORY_PR_REVIEW',
      prUrl: { not: null },
    },
  })

  if (stories.length === 0) return

  console.log(`[story-pr] Checking merge status for ${stories.length} story PRs`)

  for (const story of stories) {
    try {
      const prUrl = story.prUrl!
      const worktreePath = story.worktreePath!

      const pr = await getPullRequestByUrl(prUrl, worktreePath)

      if (pr.state === 'MERGED') {
        console.log(`[story-pr] Story #${story.id} PR has been merged — moving to COMPLETED`)

        await db.story.update({
          where: { id: story.id },
          data: {
            state: 'COMPLETED',
            disabled: true,
            completedAt: new Date(),
          },
        })

        notifyStoryCompleted(story.id, story.title)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[story-pr] Failed to check merge for story #${story.id}: ${message}`
      )
    }
  }
}

/**
 * Main entry point: runs all story PR check sub-steps.
 */
export async function runStoryPrCheckStep(): Promise<void> {
  // Check gh CLI auth before doing anything
  const authenticated = await isGhAuthenticated()
  if (!authenticated) {
    console.log('[story-pr] gh CLI not authenticated, skipping story PR check step')
    return
  }

  await createStoryPRs()
  await checkStoryPRMerges()
  await checkStoryPRComments()
}
