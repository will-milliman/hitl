/**
 * Integration tests for the PR check cron step.
 *
 * Uses a real SQLite database (via setupTestDb) with mocked external services.
 * Validates that runPrCheckStep() correctly creates draft PRs for tasks in
 * TASK_EXECUTION, detects draft→ready transitions, detects merges, and
 * persists all state transitions in the DB.
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
  notifyTaskCompleted: vi.fn(),
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: '', stderr: '' })
    }),
    exec: vi.fn((_cmd: string, _opts: unknown, cb: Function) => {
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
} from '../github'
import { notifyTaskCompleted } from '../notifications'
import { makePullRequest } from '../test-utils/factories'
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
})

afterAll(async () => {
  await teardownTestDb()
}, 10_000)

// ─── Tests ─────────────────────────────────────────────────

describe('runPrCheckStep (integration)', () => {
  describe('Draft PR creation', () => {
    it('creates draft PR and saves URL for task in TASK_EXECUTION', async () => {
      await db.story.create({
        data: { id: 9001, title: 'Test story', azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9001' },
      })
      await db.task.create({
        data: {
          id: 9010,
          title: 'Needs draft PR',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9010',
          state: GridState.TASK_EXECUTION,
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
        makePullRequest({ url: 'https://github.com/org/repo/pull/301', isDraft: true })
      )

      await runPrCheckStep()

      const task = await db.task.findUnique({ where: { id: 9010 } })
      expect(task!.prUrl).toBe('https://github.com/org/repo/pull/301')
      expect(task!.state).toBe(GridState.TASK_EXECUTION) // stays in TASK_EXECUTION
      expect(createPullRequest).toHaveBeenCalledWith(
        'C:/repos/test-wt',
        expect.objectContaining({ draft: true })
      )
    })

    it('uses existing PR URL when one already exists on GitHub', async () => {
      await db.task.create({
        data: {
          id: 9011,
          title: 'Has existing PR',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9011',
          state: GridState.TASK_EXECUTION,
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
          state: GridState.TASK_EXECUTION,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-3',
          sessionId: 'session-9012',
          prUrl: 'https://github.com/org/repo/pull/42',
          prMerged: false,
          disabled: false,
        },
      })

      await runPrCheckStep()

      expect(createPullRequest).not.toHaveBeenCalled()
      expect(findPullRequest).not.toHaveBeenCalled()
    })

    it('skips tasks still running (disabled=true)', async () => {
      await db.task.create({
        data: {
          id: 9013,
          title: 'Still running',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9013',
          state: GridState.TASK_EXECUTION,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-4',
          sessionId: 'session-9013',
          prUrl: null,
          prMerged: false,
          disabled: true, // agent still working
        },
      })

      await runPrCheckStep()

      expect(createPullRequest).not.toHaveBeenCalled()
    })

    it('skips tasks without a session', async () => {
      await db.task.create({
        data: {
          id: 9014,
          title: 'No session',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9014',
          state: GridState.TASK_EXECUTION,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-5',
          sessionId: null,
          prUrl: null,
          prMerged: false,
          disabled: false,
        },
      })

      await runPrCheckStep()

      expect(createPullRequest).not.toHaveBeenCalled()
    })
  })

  describe('Draft → Ready detection', () => {
    it('moves task to PR_REVIEW when draft PR is marked as ready', async () => {
      await db.task.create({
        data: {
          id: 9020,
          title: 'Draft PR ready',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9020',
          state: GridState.TASK_EXECUTION,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-ready',
          sessionId: 'session-9020',
          prUrl: 'https://github.com/org/repo/pull/200',
          prMerged: false,
          disabled: false,
        },
      })

      vi.mocked(getPullRequestByUrl).mockResolvedValue(
        makePullRequest({ isDraft: false })
      )

      await runPrCheckStep()

      const task = await db.task.findUnique({ where: { id: 9020 } })
      expect(task!.state).toBe(GridState.PR_REVIEW)
    })

    it('keeps task in TASK_EXECUTION when PR is still a draft', async () => {
      await db.task.create({
        data: {
          id: 9021,
          title: 'Still draft',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9021',
          state: GridState.TASK_EXECUTION,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-draft',
          sessionId: 'session-9021',
          prUrl: 'https://github.com/org/repo/pull/201',
          prMerged: false,
          disabled: false,
        },
      })

      vi.mocked(getPullRequestByUrl).mockResolvedValue(
        makePullRequest({ isDraft: true })
      )

      await runPrCheckStep()

      const task = await db.task.findUnique({ where: { id: 9021 } })
      expect(task!.state).toBe(GridState.TASK_EXECUTION) // unchanged
    })

    it('handles draft check errors gracefully', async () => {
      await db.task.create({
        data: {
          id: 9022,
          title: 'Error draft check',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9022',
          state: GridState.TASK_EXECUTION,
          worktreePath: 'C:/repos/test-wt-err',
          prUrl: 'https://github.com/org/repo/pull/202',
          prMerged: false,
        },
      })

      vi.mocked(getPullRequestByUrl).mockRejectedValue(new Error('gh CLI timeout'))

      await expect(runPrCheckStep()).resolves.not.toThrow()

      const task = await db.task.findUnique({ where: { id: 9022 } })
      expect(task!.state).toBe(GridState.TASK_EXECUTION)
    })
  })

  describe('PR merge detection', () => {
    it('moves task to COMPLETED when PR is merged', async () => {
      await db.task.create({
        data: {
          id: 9030,
          title: 'Merged PR task',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9030',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-merged',
          sessionId: 'session-9030',
          prUrl: 'https://github.com/org/repo/pull/300',
          prMerged: false,
          disabled: false,
        },
      })

      vi.mocked(getPullRequestByUrl).mockResolvedValue(
        makePullRequest({ state: 'MERGED' })
      )

      await runPrCheckStep()

      const task = await db.task.findUnique({ where: { id: 9030 } })
      expect(task!.state).toBe(GridState.COMPLETED)
      expect(task!.prMerged).toBe(true)
      expect(task!.disabled).toBe(true)
      expect(task!.completedAt).not.toBeNull()
      expect(notifyTaskCompleted).toHaveBeenCalledWith(9030, 'Merged PR task')

      // Cleanup: worktree should be parked (DB fields cleared)
      expect(task!.worktreePath).toBeNull()
      expect(task!.sessionId).toBeNull()
    })

    it('does not change state when PR is still open', async () => {
      await db.task.create({
        data: {
          id: 9031,
          title: 'Open PR task',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9031',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt-open',
          sessionId: 'session-9031',
          prUrl: 'https://github.com/org/repo/pull/301',
          prMerged: false,
          disabled: false,
        },
      })

      vi.mocked(getPullRequestByUrl).mockResolvedValue(
        makePullRequest({ state: 'OPEN' })
      )

      await runPrCheckStep()

      const task = await db.task.findUnique({ where: { id: 9031 } })
      expect(task!.state).toBe(GridState.PR_REVIEW) // unchanged
      expect(task!.prMerged).toBe(false)
    })

    it('handles merge check errors gracefully', async () => {
      await db.task.create({
        data: {
          id: 9032,
          title: 'Error PR task',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9032',
          state: GridState.PR_REVIEW,
          worktreePath: 'C:/repos/test-wt-err',
          prUrl: 'https://github.com/org/repo/pull/302',
          prMerged: false,
        },
      })

      vi.mocked(getPullRequestByUrl).mockRejectedValue(new Error('gh CLI timeout'))

      await expect(runPrCheckStep()).resolves.not.toThrow()

      const task = await db.task.findUnique({ where: { id: 9032 } })
      expect(task!.state).toBe(GridState.PR_REVIEW)
    })
  })

  describe('full pipeline scenarios', () => {
    it('handles mixed tasks: one needs draft PR, one draft→ready, one merged', async () => {
      // Task 1: In TASK_EXECUTION, needs a draft PR created
      await db.task.create({
        data: {
          id: 9040,
          title: 'Needs draft PR',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9040',
          state: GridState.TASK_EXECUTION,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/wt-40',
          sessionId: 'session-40',
          prUrl: null,
          prMerged: false,
          disabled: false,
        },
      })

      // Task 2: In TASK_EXECUTION with draft PR that's been marked ready
      await db.task.create({
        data: {
          id: 9041,
          title: 'Draft marked ready',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9041',
          state: GridState.TASK_EXECUTION,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/wt-41',
          sessionId: 'session-41',
          prUrl: 'https://github.com/org/repo/pull/401',
          prMerged: false,
          disabled: false,
        },
      })

      // Task 3: In PR_REVIEW with merged PR
      await db.task.create({
        data: {
          id: 9042,
          title: 'Merged',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9042',
          state: GridState.PR_REVIEW,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/wt-42',
          sessionId: 'session-42',
          prUrl: 'https://github.com/org/repo/pull/402',
          prMerged: false,
          disabled: false,
        },
      })

      // Mock PR creation for task 9040
      vi.mocked(createPullRequest).mockResolvedValueOnce(
        makePullRequest({ url: 'https://github.com/org/repo/pull/400', isDraft: true })
      )

      // Mock getPullRequestByUrl — used by both checkDraftToReady and checkTaskPRMerges
      vi.mocked(getPullRequestByUrl).mockImplementation(async (prUrl: string) => {
        if (prUrl === 'https://github.com/org/repo/pull/401') {
          // Task 9041: no longer a draft
          return makePullRequest({ isDraft: false, state: 'OPEN' })
        }
        if (prUrl === 'https://github.com/org/repo/pull/400') {
          // Task 9040: just created, still a draft (checkDraftToReady sees it)
          return makePullRequest({ isDraft: true, state: 'OPEN' })
        }
        if (prUrl === 'https://github.com/org/repo/pull/402') {
          // Task 9042: merged
          return makePullRequest({ state: 'MERGED' })
        }
        return makePullRequest({ state: 'OPEN' })
      })

      await runPrCheckStep()

      // Task 9040: should have draft PR URL, still in TASK_EXECUTION
      const task40 = await db.task.findUnique({ where: { id: 9040 } })
      expect(task40!.prUrl).toBe('https://github.com/org/repo/pull/400')
      expect(task40!.state).toBe(GridState.TASK_EXECUTION)

      // Task 9041: should be moved to PR_REVIEW
      const task41 = await db.task.findUnique({ where: { id: 9041 } })
      expect(task41!.state).toBe(GridState.PR_REVIEW)

      // Task 9042: should be COMPLETED with worktree parked
      const task42 = await db.task.findUnique({ where: { id: 9042 } })
      expect(task42!.state).toBe(GridState.COMPLETED)
      expect(task42!.prMerged).toBe(true)
      expect(task42!.worktreePath).toBeNull()
      expect(task42!.sessionId).toBeNull()
    })

    it('skips everything when gh CLI is not authenticated', async () => {
      vi.mocked(isGhAuthenticated).mockResolvedValueOnce(false)

      await db.task.create({
        data: {
          id: 9050,
          title: 'Should be skipped',
          azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/9050',
          state: GridState.TASK_EXECUTION,
          worktreePath: 'C:/repos/wt-skip',
          sessionId: 'session-50',
          prUrl: null,
          prMerged: false,
          disabled: false,
        },
      })

      await runPrCheckStep()

      const task = await db.task.findUnique({ where: { id: 9050 } })
      expect(task!.prUrl).toBeNull()
      expect(createPullRequest).not.toHaveBeenCalled()
      expect(getPullRequestByUrl).not.toHaveBeenCalled()
    })
  })
})
