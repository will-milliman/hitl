/**
 * Integration tests for the PR check cron step.
 *
 * Uses a real SQLite database (via setupTestDb) with mocked external services.
 * Validates that runPrCheckStep() correctly creates PRs, detects merges,
 * handles review comments, and persists all state transitions in the DB.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'

// ─── Module mocks — external services only ─────────────────

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../github', () => ({
  isGhAuthenticated: vi.fn().mockResolvedValue(true),
  createPullRequest: vi.fn(),
  findPullRequest: vi.fn().mockResolvedValue(null),
  getPullRequestByUrl: vi.fn(),
  getPrReviewComments: vi.fn().mockResolvedValue([]),
  findUnresolvedThreads: vi.fn().mockReturnValue([]),
  formatCommentsForPrompt: vi.fn().mockReturnValue(''),
  extractPrNumber: vi.fn(),
  extractRepoFromPrUrl: vi.fn(),
}))

vi.mock('../copilot', () => ({
  spawnSession: vi.fn().mockResolvedValue({
    sessionId: 'comment-fix-session',
    logDir: '/tmp/test-logs',
  }),
  ensureGlobalHooks: vi.fn(),
  watchSignals: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
}))

vi.mock('../worktree', () => ({
  getBranchName: vi.fn(
    (type: string, workItemId: number) => `${type}/${workItemId}`
  ),
}))

vi.mock('../settings', () => ({
  loadProfiles: vi.fn().mockReturnValue({
    integrate: {
      repoPath: 'C:/repos/test-repo',
      defaultBranch: 'main',
      description: 'Test profile',
    },
  }),
}))

vi.mock('../notifications', () => ({
  notifyPrReviewNeeded: vi.fn(),
  notifyTaskCompleted: vi.fn(),
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: '', stderr: '' })
    }),
  }
})

vi.mock('util', async () => {
  const actual = await vi.importActual('util')
  return {
    ...actual,
    promisify: vi.fn((fn: Function) => {
      return (...args: unknown[]) => {
        return new Promise((resolve, reject) => {
          fn(...args, (err: Error | null, result: unknown) => {
            if (err) reject(err)
            else resolve(result)
          })
        })
      }
    }),
  }
})

// ─── Real DB setup ─────────────────────────────────────────

import { setupTestDb, resetTestDb, teardownTestDb } from '../test-utils/db'
import type { PrismaClient } from '@prisma/client'

let db: PrismaClient

vi.mock('../db', () => ({
  getDb: vi.fn(() => db),
}))

// ─── Imports (after mocks) ─────────────────────────────────

import { runPrCheckStep } from './pr-check'
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
import { spawnSession, watchSignals, isWatching } from '../copilot'
import { notifyPrReviewNeeded, notifyTaskCompleted } from '../notifications'
import { makePullRequest, makeReviewComment } from '../test-utils/factories'
import { GridState } from '../../shared/constants'

// ─── Lifecycle ─────────────────────────────────────────────

beforeAll(async () => {
  db = await setupTestDb()
}, 30_000)

afterEach(async () => {
  await resetTestDb()
  vi.clearAllMocks()
  // Restore default mock behaviors
  vi.mocked(isGhAuthenticated).mockResolvedValue(true)
  vi.mocked(findPullRequest).mockResolvedValue(null)
  vi.mocked(isWatching).mockReturnValue(false)
})

afterAll(async () => {
  await teardownTestDb()
}, 10_000)

// ─── Tests ─────────────────────────────────────────────────

describe('runPrCheckStep (integration)', () => {
  describe('PR creation', () => {
    it('creates PR and saves URL in DB for task with no PR', async () => {
      await db.story.create({
        data: { id: 9001, title: 'Test story', azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9001' },
      })
      await db.task.create({
        data: {
          id: 9010,
          title: 'Needs PR',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9010',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt',
          sessionId: 'session-9010',
          prUrl: null,
          prMerged: false,
          disabled: false,
          storyId: 9001,
        },
      })

      vi.mocked(createPullRequest).mockResolvedValueOnce(
        makePullRequest({ url: 'https://github.com/org/repo/pull/301' })
      )

      await runPrCheckStep()

      const task = await db.task.findUnique({ where: { id: 9010 } })
      expect(task!.prUrl).toBe('https://github.com/org/repo/pull/301')
    })

    it('uses existing PR URL when one already exists on GitHub', async () => {
      await db.task.create({
        data: {
          id: 9011,
          title: 'Has existing PR',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9011',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-2',
          sessionId: 'session-9011',
          prUrl: null,
          prMerged: false,
          disabled: false,
        },
      })

      vi.mocked(findPullRequest).mockResolvedValueOnce(
        makePullRequest({ url: 'https://github.com/org/repo/pull/existing' })
      )

      await runPrCheckStep()

      expect(createPullRequest).not.toHaveBeenCalled()
      const task = await db.task.findUnique({ where: { id: 9011 } })
      expect(task!.prUrl).toBe('https://github.com/org/repo/pull/existing')
    })

    it('does not create PR for tasks that already have prUrl', async () => {
      await db.task.create({
        data: {
          id: 9012,
          title: 'Already has PR',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9012',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-3',
          sessionId: 'session-9012',
          prUrl: 'https://github.com/org/repo/pull/42',
          prMerged: false,
          disabled: false,
        },
      })

      await runPrCheckStep()

      // Task already had prUrl, so createTaskPRs won't pick it up
      expect(createPullRequest).not.toHaveBeenCalled()
      expect(findPullRequest).not.toHaveBeenCalled()
    })
  })

  describe('PR merge detection', () => {
    it('moves task to COMPLETED when PR is merged', async () => {
      await db.task.create({
        data: {
          id: 9020,
          title: 'Merged PR task',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9020',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-merged',
          sessionId: 'session-9020',
          prUrl: 'https://github.com/org/repo/pull/200',
          prMerged: false,
          disabled: false,
        },
      })

      vi.mocked(getPullRequestByUrl).mockResolvedValue(
        makePullRequest({ state: 'MERGED' })
      )

      await runPrCheckStep()

      const task = await db.task.findUnique({ where: { id: 9020 } })
      expect(task!.state).toBe(GridState.COMPLETED)
      expect(task!.prMerged).toBe(true)
      expect(task!.disabled).toBe(true)
      expect(task!.completedAt).not.toBeNull()
      expect(notifyTaskCompleted).toHaveBeenCalledWith(9020, 'Merged PR task')
    })

    it('does not change state when PR is still open', async () => {
      await db.task.create({
        data: {
          id: 9021,
          title: 'Open PR task',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9021',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-open',
          sessionId: 'session-9021',
          prUrl: 'https://github.com/org/repo/pull/201',
          prMerged: false,
          disabled: false,
        },
      })

      vi.mocked(getPullRequestByUrl).mockResolvedValue(
        makePullRequest({ state: 'OPEN' })
      )

      await runPrCheckStep()

      const task = await db.task.findUnique({ where: { id: 9021 } })
      expect(task!.state).toBe(GridState.PR_REVIEW) // unchanged
      expect(task!.prMerged).toBe(false)
    })

    it('handles merge check errors gracefully', async () => {
      await db.task.create({
        data: {
          id: 9022,
          title: 'Error PR task',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9022',
          state: GridState.PR_REVIEW,
          worktreePath: 'C:/repos/test-wt-err',
          prUrl: 'https://github.com/org/repo/pull/202',
          prMerged: false,
        },
      })

      vi.mocked(getPullRequestByUrl).mockRejectedValue(new Error('gh CLI timeout'))

      // Should not throw
      await expect(runPrCheckStep()).resolves.not.toThrow()

      // Task should remain unchanged
      const task = await db.task.findUnique({ where: { id: 9022 } })
      expect(task!.state).toBe(GridState.PR_REVIEW)
    })
  })

  describe('PR comment handling', () => {
    it('spawns copilot session and updates DB when unresolved comments found', async () => {
      await db.task.create({
        data: {
          id: 9030,
          title: 'Has comments',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9030',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-comments',
          sessionId: 'old-session',
          prUrl: 'https://github.com/org/repo/pull/300',
          prMerged: false,
          disabled: false,
          prUpdated: true,
        },
      })

      vi.mocked(extractRepoFromPrUrl).mockReturnValue({ owner: 'org', repo: 'repo' })
      vi.mocked(extractPrNumber).mockReturnValue(300)
      vi.mocked(getPrReviewComments).mockResolvedValueOnce([
        makeReviewComment({ body: 'Please fix the error handling' }),
      ])
      vi.mocked(getPullRequestByUrl).mockResolvedValue(
        makePullRequest({ author: { login: 'bot-author' } })
      )
      vi.mocked(findUnresolvedThreads).mockReturnValueOnce([
        makeReviewComment({ body: 'Please fix the error handling' }),
      ])
      vi.mocked(formatCommentsForPrompt).mockReturnValueOnce('Fix error handling')
      vi.mocked(spawnSession).mockResolvedValueOnce({
        sessionId: 'comment-fix-session-9030',
        logDir: '/tmp/logs-9030',
      })

      await runPrCheckStep()

      // Verify DB state
      const task = await db.task.findUnique({ where: { id: 9030 } })
      expect(task!.prUpdated).toBe(false)  // cleared
      expect(task!.sessionId).toBe('comment-fix-session-9030')  // new session
      expect(task!.disabled).toBe(true)  // agent is working

      // Verify copilot was invoked
      expect(spawnSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: 'C:/repos/test-wt-comments',
          prompt: expect.stringContaining('Task #9030'),
        })
      )

      // Verify notifications
      expect(notifyPrReviewNeeded).toHaveBeenCalledWith('task', 9030, 'Has comments', 1)
    })

    it('clears prUpdated flag without spawning session when no unresolved comments', async () => {
      await db.task.create({
        data: {
          id: 9031,
          title: 'No comments',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9031',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-nocomments',
          sessionId: 'existing-session',
          prUrl: 'https://github.com/org/repo/pull/301',
          prMerged: false,
          disabled: false,
          prUpdated: true,
        },
      })

      vi.mocked(extractRepoFromPrUrl).mockReturnValue({ owner: 'org', repo: 'repo' })
      vi.mocked(extractPrNumber).mockReturnValue(301)
      vi.mocked(getPrReviewComments).mockResolvedValueOnce([])
      vi.mocked(getPullRequestByUrl).mockResolvedValue(
        makePullRequest({ author: { login: 'bot-author' } })
      )
      vi.mocked(findUnresolvedThreads).mockReturnValueOnce([])

      await runPrCheckStep()

      const task = await db.task.findUnique({ where: { id: 9031 } })
      expect(task!.prUpdated).toBe(false)  // cleared
      expect(task!.sessionId).toBe('existing-session')  // unchanged
      expect(task!.disabled).toBe(false)  // unchanged
      expect(spawnSession).not.toHaveBeenCalled()
    })

    it('does not check comments for tasks without prUpdated flag', async () => {
      await db.task.create({
        data: {
          id: 9032,
          title: 'Not flagged',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9032',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-noflag',
          prUrl: 'https://github.com/org/repo/pull/302',
          prMerged: false,
          disabled: false,
          prUpdated: false,
        },
      })

      // Mock merge check to return OPEN so it doesn't transition
      vi.mocked(getPullRequestByUrl).mockResolvedValue(
        makePullRequest({ state: 'OPEN' })
      )

      await runPrCheckStep()

      // Comment-related functions should not be called
      expect(getPrReviewComments).not.toHaveBeenCalled()
      expect(spawnSession).not.toHaveBeenCalled()
    })
  })

  describe('full pipeline scenarios', () => {
    it('handles mixed tasks: one needs PR, one is merged, one has comments', async () => {
      // Task 1: Needs PR creation
      await db.task.create({
        data: {
          id: 9040,
          title: 'Needs PR',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9040',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/wt-40',
          sessionId: 'session-40',
          prUrl: null,
          prMerged: false,
          disabled: false,
        },
      })

      // Task 2: Has merged PR
      await db.task.create({
        data: {
          id: 9041,
          title: 'Merged',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9041',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/wt-41',
          sessionId: 'session-41',
          prUrl: 'https://github.com/org/repo/pull/401',
          prMerged: false,
          disabled: false,
        },
      })

      // Task 3: Has comments to address
      await db.task.create({
        data: {
          id: 9042,
          title: 'Has comments',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9042',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/wt-42',
          sessionId: 'session-42',
          prUrl: 'https://github.com/org/repo/pull/402',
          prMerged: false,
          disabled: false,
          prUpdated: true,
        },
      })

      // Mock PR creation for task 9040
      vi.mocked(createPullRequest).mockResolvedValueOnce(
        makePullRequest({ url: 'https://github.com/org/repo/pull/400' })
      )

      // Mock merge check — after createTaskPRs, all 3 tasks have prUrls,
      // so checkTaskPRMerges picks up all 3. Order depends on DB query order.
      // We need to handle: 9040 (just got PR), 9041 (merged), 9042 (open).
      // Since DB order may vary, use a dynamic mock that checks the URL.
      vi.mocked(getPullRequestByUrl).mockImplementation(async (prUrl: string) => {
        if (prUrl === 'https://github.com/org/repo/pull/401') {
          return makePullRequest({ state: 'MERGED' })
        }
        // Default: OPEN with author for comment checks
        return makePullRequest({ state: 'OPEN', author: { login: 'bot' } })
      })

      // Mock comment handling for task 9042
      vi.mocked(extractRepoFromPrUrl).mockReturnValue({ owner: 'org', repo: 'repo' })
      vi.mocked(extractPrNumber).mockReturnValue(402)
      vi.mocked(getPrReviewComments).mockResolvedValueOnce([
        makeReviewComment({ body: 'Fix this' }),
      ])
      vi.mocked(findUnresolvedThreads).mockReturnValueOnce([
        makeReviewComment({ body: 'Fix this' }),
      ])
      vi.mocked(formatCommentsForPrompt).mockReturnValueOnce('Fix this')
      vi.mocked(spawnSession).mockResolvedValueOnce({
        sessionId: 'comment-session-42',
        logDir: '/tmp/logs',
      })

      await runPrCheckStep()

      // Task 9040: should have PR URL
      const task40 = await db.task.findUnique({ where: { id: 9040 } })
      expect(task40!.prUrl).toBe('https://github.com/org/repo/pull/400')

      // Task 9041: should be COMPLETED
      const task41 = await db.task.findUnique({ where: { id: 9041 } })
      expect(task41!.state).toBe(GridState.COMPLETED)
      expect(task41!.prMerged).toBe(true)

      // Task 9042: should have new session, prUpdated cleared
      const task42 = await db.task.findUnique({ where: { id: 9042 } })
      expect(task42!.prUpdated).toBe(false)
      expect(task42!.sessionId).toBe('comment-session-42')
      expect(task42!.disabled).toBe(true)
    })

    it('skips everything when gh CLI is not authenticated', async () => {
      vi.mocked(isGhAuthenticated).mockResolvedValueOnce(false)

      await db.task.create({
        data: {
          id: 9050,
          title: 'Should be skipped',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9050',
          state: GridState.PR_REVIEW,
          worktreePath: 'C:/repos/wt-skip',
          prUrl: null,
          prMerged: false,
          disabled: false,
        },
      })

      await runPrCheckStep()

      // Nothing should have changed
      const task = await db.task.findUnique({ where: { id: 9050 } })
      expect(task!.prUrl).toBeNull()
      expect(createPullRequest).not.toHaveBeenCalled()
      expect(getPullRequestByUrl).not.toHaveBeenCalled()
    })
  })
})
