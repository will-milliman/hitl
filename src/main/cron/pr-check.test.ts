/**
 * Unit tests for the PR check cron step.
 *
 * Tests runPrCheckStep() and its sub-steps: createTaskPRs,
 * checkTaskPRComments, checkTaskPRMerges — with mocked DB
 * and external modules.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Module mocks (must be before imports) ─────────────────

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

const mockDb = {
  task: {
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
  },
}

vi.mock('../db', () => ({
  getDb: vi.fn(() => mockDb),
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
    sessionId: 'new-session-id',
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

// Mock child_process for pushBranch
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout: '', stderr: '' })
  }),
}))

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
import { spawnSession, watchSignals, isWatching, ensureGlobalHooks } from '../copilot'
import { notifyPrReviewNeeded, notifyTaskCompleted } from '../notifications'
import { makeTask, makePullRequest, makeReviewComment } from '../test-utils/factories'
import { GridState } from '../../shared/constants'

// ─── Tests ─────────────────────────────────────────────────

describe('runPrCheckStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset defaults
    mockDb.task.findMany.mockResolvedValue([])
    vi.mocked(isGhAuthenticated).mockResolvedValue(true)
  })

  it('skips everything when gh CLI is not authenticated', async () => {
    vi.mocked(isGhAuthenticated).mockResolvedValueOnce(false)

    await runPrCheckStep()

    expect(mockDb.task.findMany).not.toHaveBeenCalled()
  })

  describe('createTaskPRs sub-step', () => {
    it('creates PR for task in PR_REVIEW with no prUrl', async () => {
      const task = {
        ...makeTask({
          id: 1001,
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt',
          sessionId: 'session-1',
          prUrl: null,
          prMerged: false,
          disabled: false,
        }),
        story: { id: 90001, title: 'Test story' },
      }

      // createTaskPRs query
      mockDb.task.findMany
        .mockResolvedValueOnce([task])  // createTaskPRs
        .mockResolvedValueOnce([])       // checkTaskPRMerges
        .mockResolvedValueOnce([])       // checkTaskPRComments

      vi.mocked(findPullRequest).mockResolvedValueOnce(null) // no existing PR
      vi.mocked(createPullRequest).mockResolvedValueOnce(
        makePullRequest({ number: 201, url: 'https://github.com/org/repo/pull/201' })
      )

      await runPrCheckStep()

      expect(createPullRequest).toHaveBeenCalledWith(
        'C:/repos/test-wt',
        expect.objectContaining({
          title: expect.stringContaining('Task #1001'),
          head: 'task/1001',
          base: 'main',
        })
      )
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { prUrl: 'https://github.com/org/repo/pull/201' },
      })
    })

    it('uses existing PR URL when PR already exists on GitHub', async () => {
      const task = {
        ...makeTask({
          id: 1001,
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt',
          sessionId: 'session-1',
          prUrl: null,
          prMerged: false,
          disabled: false,
        }),
        story: null,
      }

      mockDb.task.findMany
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])

      vi.mocked(findPullRequest).mockResolvedValueOnce(
        makePullRequest({ url: 'https://github.com/org/repo/pull/99' })
      )

      await runPrCheckStep()

      // Should NOT create a new PR
      expect(createPullRequest).not.toHaveBeenCalled()
      // Should save the existing PR URL
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { prUrl: 'https://github.com/org/repo/pull/99' },
      })
    })

    it('does nothing when no tasks need PRs', async () => {
      mockDb.task.findMany.mockResolvedValue([])

      await runPrCheckStep()

      expect(createPullRequest).not.toHaveBeenCalled()
    })
  })

  describe('checkTaskPRMerges sub-step', () => {
    it('moves task to COMPLETED when PR is merged', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.PR_REVIEW,
        prUrl: 'https://github.com/org/repo/pull/101',
        prMerged: false,
        worktreePath: 'C:/repos/test-wt',
      })

      mockDb.task.findMany
        .mockResolvedValueOnce([])      // createTaskPRs
        .mockResolvedValueOnce([task])   // checkTaskPRMerges
        .mockResolvedValueOnce([])       // checkTaskPRComments

      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(
        makePullRequest({ state: 'MERGED' })
      )

      await runPrCheckStep()

      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: expect.objectContaining({
          state: GridState.COMPLETED,
          prMerged: true,
          disabled: true,
          completedAt: expect.any(Date),
        }),
      })
      expect(notifyTaskCompleted).toHaveBeenCalledWith(1001, task.title)
    })

    it('does not change state when PR is still open', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.PR_REVIEW,
        prUrl: 'https://github.com/org/repo/pull/101',
        prMerged: false,
        worktreePath: 'C:/repos/test-wt',
      })

      mockDb.task.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([])

      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(
        makePullRequest({ state: 'OPEN' })
      )

      await runPrCheckStep()

      // Should NOT update the task state
      expect(mockDb.task.update).not.toHaveBeenCalled()
    })

    it('handles errors gracefully without crashing the step', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.PR_REVIEW,
        prUrl: 'https://github.com/org/repo/pull/101',
        worktreePath: 'C:/repos/test-wt',
      })

      mockDb.task.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([])

      vi.mocked(getPullRequestByUrl).mockRejectedValueOnce(
        new Error('gh CLI timeout')
      )

      // Should not throw
      await expect(runPrCheckStep()).resolves.not.toThrow()
    })
  })

  describe('checkTaskPRComments sub-step', () => {
    it('spawns copilot session when unresolved comments found', async () => {
      const task = makeTask({
        id: 1001,
        title: 'Fix bug',
        state: GridState.PR_REVIEW,
        prUrl: 'https://github.com/org/repo/pull/101',
        prMerged: false,
        worktreePath: 'C:/repos/test-wt',
        disabled: false,
        prUpdated: true,
      })

      mockDb.task.findMany
        .mockResolvedValueOnce([])      // createTaskPRs
        .mockResolvedValueOnce([])       // checkTaskPRMerges
        .mockResolvedValueOnce([task])   // checkTaskPRComments

      vi.mocked(extractRepoFromPrUrl).mockReturnValue({ owner: 'org', repo: 'repo' })
      vi.mocked(extractPrNumber).mockReturnValue(101)
      vi.mocked(getPrReviewComments).mockResolvedValueOnce([
        makeReviewComment({ body: 'Please fix this' }),
      ])
      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(
        makePullRequest({ author: { login: 'bot-author' } })
      )
      vi.mocked(findUnresolvedThreads).mockReturnValueOnce([
        makeReviewComment({ body: 'Please fix this' }),
      ])
      vi.mocked(formatCommentsForPrompt).mockReturnValueOnce('Formatted comments')

      await runPrCheckStep()

      // Should clear prUpdated flag
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { prUpdated: false },
      })

      // Should spawn copilot session
      expect(ensureGlobalHooks).toHaveBeenCalled()
      expect(spawnSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: 'C:/repos/test-wt',
          prompt: expect.stringContaining('Task #1001'),
        })
      )

      // Should update task with new session
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: {
          sessionId: 'new-session-id',
          disabled: true,
        },
      })

      // Should start watching
      expect(watchSignals).toHaveBeenCalledWith('C:/repos/test-wt', 'task', 1001)

      // Should notify
      expect(notifyPrReviewNeeded).toHaveBeenCalledWith('task', 1001, 'Fix bug', 1)
    })

    it('clears prUpdated without spawning session when no unresolved comments', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.PR_REVIEW,
        prUrl: 'https://github.com/org/repo/pull/101',
        prMerged: false,
        worktreePath: 'C:/repos/test-wt',
        disabled: false,
        prUpdated: true,
      })

      mockDb.task.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([task])

      vi.mocked(extractRepoFromPrUrl).mockReturnValue({ owner: 'org', repo: 'repo' })
      vi.mocked(extractPrNumber).mockReturnValue(101)
      vi.mocked(getPrReviewComments).mockResolvedValueOnce([])
      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(
        makePullRequest({ author: { login: 'bot-author' } })
      )
      vi.mocked(findUnresolvedThreads).mockReturnValueOnce([])

      await runPrCheckStep()

      // Should clear prUpdated
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { prUpdated: false },
      })

      // Should NOT spawn session
      expect(spawnSession).not.toHaveBeenCalled()
    })

    it('skips task when PR URL cannot be parsed', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.PR_REVIEW,
        prUrl: 'invalid-url',
        prMerged: false,
        worktreePath: 'C:/repos/test-wt',
        disabled: false,
        prUpdated: true,
      })

      mockDb.task.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([task])

      vi.mocked(extractRepoFromPrUrl).mockReturnValue(null)
      vi.mocked(extractPrNumber).mockReturnValue(null)

      await runPrCheckStep()

      // Should not try to fetch comments
      expect(getPrReviewComments).not.toHaveBeenCalled()
      expect(spawnSession).not.toHaveBeenCalled()
    })

    it('does not spawn session when already watching the worktree', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.PR_REVIEW,
        prUrl: 'https://github.com/org/repo/pull/101',
        prMerged: false,
        worktreePath: 'C:/repos/test-wt',
        disabled: false,
        prUpdated: true,
      })

      mockDb.task.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([task])

      vi.mocked(extractRepoFromPrUrl).mockReturnValue({ owner: 'org', repo: 'repo' })
      vi.mocked(extractPrNumber).mockReturnValue(101)
      vi.mocked(getPrReviewComments).mockResolvedValueOnce([
        makeReviewComment({}),
      ])
      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(
        makePullRequest({ author: { login: 'bot-author' } })
      )
      vi.mocked(findUnresolvedThreads).mockReturnValueOnce([
        makeReviewComment({}),
      ])
      vi.mocked(formatCommentsForPrompt).mockReturnValueOnce('Comments')
      vi.mocked(isWatching).mockReturnValue(true)

      await runPrCheckStep()

      // Should still spawn session
      expect(spawnSession).toHaveBeenCalled()
      // But should NOT call watchSignals (already watching)
      expect(watchSignals).not.toHaveBeenCalled()
    })
  })
})
