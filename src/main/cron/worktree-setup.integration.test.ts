/**
 * Integration tests for the worktree setup cron step.
 *
 * Uses a real SQLite database (via setupTestDb) with mocked external services.
 * Validates that setupTaskWorktrees() correctly creates worktrees for eligible
 * tasks and persists the worktreePath in the DB.
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

vi.mock('../worktree', () => ({
  createWorktree: vi.fn().mockResolvedValue('C:/repos/test-repo-worktrees/test-repo-1'),
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

// ─── Real DB setup ─────────────────────────────────────────

import { setupTestDb, resetTestDb, teardownTestDb, getTestDb } from '../test-utils/db'
import type { PrismaClient } from '@prisma/client'

let db: PrismaClient

vi.mock('../db', () => ({
  getDb: vi.fn(() => db),
}))

// ─── Imports (after mocks) ─────────────────────────────────

import { setupTaskWorktrees } from './worktree-setup'
import { createWorktree } from '../worktree'
import { loadProfiles } from '../settings'
import { GridState } from '../../shared/constants'

// ─── Lifecycle ─────────────────────────────────────────────

beforeAll(async () => {
  db = await setupTestDb()
}, 30_000)

afterEach(async () => {
  await resetTestDb()
  vi.clearAllMocks()
})

afterAll(async () => {
  await teardownTestDb()
}, 10_000)

// ─── Tests ─────────────────────────────────────────────────

describe('setupTaskWorktrees (integration)', () => {
  it('creates worktree and saves path for eligible task', async () => {
    // Seed a task in TASK_EXECUTION with profile but no worktree
    await db.task.create({
      data: {
        id: 7001,
        title: 'Eligible task',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7001',
        state: GridState.TASK_EXECUTION,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    })

    vi.mocked(createWorktree).mockResolvedValueOnce('C:/repos/test-repo-worktrees/task-7001')

    await setupTaskWorktrees()

    // Verify worktree was created with correct args
    expect(createWorktree).toHaveBeenCalledWith(
      'C:/repos/test-repo',
      'task',
      7001,
      'main'
    )

    // Verify DB was updated with worktree path
    const task = await db.task.findUnique({ where: { id: 7001 } })
    expect(task!.worktreePath).toBe('C:/repos/test-repo-worktrees/task-7001')
  })

  it('skips tasks that already have a worktree path', async () => {
    await db.task.create({
      data: {
        id: 7002,
        title: 'Already has worktree',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7002',
        state: GridState.TASK_EXECUTION,
        profileKey: 'integrate',
        worktreePath: 'C:/existing/worktree',
        disabled: true,
      },
    })

    await setupTaskWorktrees()

    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('skips tasks without a profile assigned', async () => {
    await db.task.create({
      data: {
        id: 7003,
        title: 'No profile',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7003',
        state: GridState.TASK_EXECUTION,
        profileKey: null,
        worktreePath: null,
        disabled: true,
      },
    })

    await setupTaskWorktrees()

    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('skips tasks that are not disabled (not ready for execution)', async () => {
    await db.task.create({
      data: {
        id: 7004,
        title: 'Not disabled',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7004',
        state: GridState.TASK_EXECUTION,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: false,
      },
    })

    await setupTaskWorktrees()

    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('skips tasks not in TASK_EXECUTION state', async () => {
    await db.task.create({
      data: {
        id: 7005,
        title: 'Wrong state',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7005',
        state: GridState.PROFILE_ASSIGNMENT,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    })

    await setupTaskWorktrees()

    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('skips tasks with unknown profile key', async () => {
    await db.task.create({
      data: {
        id: 7006,
        title: 'Unknown profile',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7006',
        state: GridState.TASK_EXECUTION,
        profileKey: 'nonexistent',
        worktreePath: null,
        disabled: true,
      },
    })

    await setupTaskWorktrees()

    // createWorktree should NOT be called (profile not found)
    expect(createWorktree).not.toHaveBeenCalled()

    // Task should remain unchanged
    const task = await db.task.findUnique({ where: { id: 7006 } })
    expect(task!.worktreePath).toBeNull()
  })

  it('processes multiple eligible tasks', async () => {
    await db.task.create({
      data: {
        id: 7010,
        title: 'Task A',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7010',
        state: GridState.TASK_EXECUTION,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    })
    await db.task.create({
      data: {
        id: 7011,
        title: 'Task B',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7011',
        state: GridState.TASK_EXECUTION,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    })

    vi.mocked(createWorktree)
      .mockResolvedValueOnce('C:/repos/wt/task-7010')
      .mockResolvedValueOnce('C:/repos/wt/task-7011')

    await setupTaskWorktrees()

    expect(createWorktree).toHaveBeenCalledTimes(2)

    const taskA = await db.task.findUnique({ where: { id: 7010 } })
    const taskB = await db.task.findUnique({ where: { id: 7011 } })
    expect(taskA!.worktreePath).toBe('C:/repos/wt/task-7010')
    expect(taskB!.worktreePath).toBe('C:/repos/wt/task-7011')
  })

  it('continues processing other tasks when one fails', async () => {
    await db.task.create({
      data: {
        id: 7020,
        title: 'Will fail',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7020',
        state: GridState.TASK_EXECUTION,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    })
    await db.task.create({
      data: {
        id: 7021,
        title: 'Will succeed',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7021',
        state: GridState.TASK_EXECUTION,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    })

    vi.mocked(createWorktree)
      .mockRejectedValueOnce(new Error('git worktree add failed'))
      .mockResolvedValueOnce('C:/repos/wt/task-7021')

    await setupTaskWorktrees()

    // First task should still have no worktree (failed)
    const failedTask = await db.task.findUnique({ where: { id: 7020 } })
    expect(failedTask!.worktreePath).toBeNull()

    // Second task should succeed
    const successTask = await db.task.findUnique({ where: { id: 7021 } })
    expect(successTask!.worktreePath).toBe('C:/repos/wt/task-7021')
  })
})
