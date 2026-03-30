/**
 * Unit tests for the worktree setup cron step.
 *
 * Tests the setupTaskWorktrees() orchestration logic with mocked DB,
 * worktree, and settings modules.
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

vi.mock('../worktree', () => ({
  createWorktree: vi.fn().mockResolvedValue('/tmp/test-worktree'),
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

// ─── Imports (after mocks) ─────────────────────────────────

import { setupTaskWorktrees } from './worktree-setup'
import { createWorktree } from '../worktree'
import { loadProfiles } from '../settings'
import { makeTask } from '../test-utils/factories'
import { GridState } from '../../shared/constants'

// ─── Tests ─────────────────────────────────────────────────

describe('setupTaskWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns early when no tasks need worktrees', async () => {
    mockDb.task.findMany.mockResolvedValueOnce([])

    await setupTaskWorktrees()

    expect(createWorktree).not.toHaveBeenCalled()
    expect(mockDb.task.update).not.toHaveBeenCalled()
  })

  it('creates worktree and saves path for eligible tasks', async () => {
    const task = makeTask({
      id: 1001,
      state: GridState.TASK_EXECUTION,
      profileKey: 'integrate',
      worktreePath: null,
      disabled: true,
    })
    mockDb.task.findMany.mockResolvedValueOnce([task])
    vi.mocked(createWorktree).mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-1')

    await setupTaskWorktrees()

    expect(createWorktree).toHaveBeenCalledWith(
      'C:/repos/test-repo',
      'task',
      1001,
      'main'
    )
    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: { worktreePath: 'C:/repos/test-repo-worktrees/test-repo-1' },
    })
  })

  it('skips tasks with unknown profile keys', async () => {
    const task = makeTask({
      id: 1001,
      state: GridState.TASK_EXECUTION,
      profileKey: 'nonexistent',
      worktreePath: null,
      disabled: true,
    })
    mockDb.task.findMany.mockResolvedValueOnce([task])

    await setupTaskWorktrees()

    expect(createWorktree).not.toHaveBeenCalled()
    expect(mockDb.task.update).not.toHaveBeenCalled()
  })

  it('continues with other tasks when createWorktree fails', async () => {
    const task1 = makeTask({
      id: 1001,
      state: GridState.TASK_EXECUTION,
      profileKey: 'integrate',
      worktreePath: null,
      disabled: true,
    })
    const task2 = makeTask({
      id: 1002,
      state: GridState.TASK_EXECUTION,
      profileKey: 'integrate',
      worktreePath: null,
      disabled: true,
    })
    mockDb.task.findMany.mockResolvedValueOnce([task1, task2])
    vi.mocked(createWorktree)
      .mockRejectedValueOnce(new Error('git fetch failed'))
      .mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-2')

    await setupTaskWorktrees()

    // First task failed, second should still succeed
    expect(createWorktree).toHaveBeenCalledTimes(2)
    expect(mockDb.task.update).toHaveBeenCalledTimes(1)
    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1002 },
      data: { worktreePath: 'C:/repos/test-repo-worktrees/test-repo-2' },
    })
  })

  it('processes multiple tasks with the same profile', async () => {
    const tasks = [
      makeTask({ id: 1001, profileKey: 'integrate', worktreePath: null, disabled: true, state: GridState.TASK_EXECUTION }),
      makeTask({ id: 1002, profileKey: 'integrate', worktreePath: null, disabled: true, state: GridState.TASK_EXECUTION }),
    ]
    mockDb.task.findMany.mockResolvedValueOnce(tasks)
    vi.mocked(createWorktree)
      .mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-1')
      .mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-2')

    await setupTaskWorktrees()

    expect(createWorktree).toHaveBeenCalledTimes(2)
    expect(mockDb.task.update).toHaveBeenCalledTimes(2)
  })

  it('queries only tasks in TASK_EXECUTION with profileKey and no worktreePath', async () => {
    mockDb.task.findMany.mockResolvedValueOnce([])

    await setupTaskWorktrees()

    expect(mockDb.task.findMany).toHaveBeenCalledWith({
      where: {
        state: GridState.TASK_EXECUTION,
        profileKey: { not: null },
        worktreePath: null,
        disabled: true,
      },
    })
  })
})
