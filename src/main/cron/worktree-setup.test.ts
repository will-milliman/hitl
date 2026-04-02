/**
 * Unit tests for the worktree setup cron step.
 *
 * Tests the setupTaskWorktrees() orchestration logic with mocked DB,
 * worktree, and settings modules.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GridState } from '../../shared/constants';
import { makeTask } from '../test-utils/factories';
import { createWorktree, findIdleWorktree, repurposeWorktree } from '../worktree';

// ─── Imports (after mocks) ─────────────────────────────────

import { setupTaskWorktrees } from './worktree-setup';

// ─── Module mocks (must be before imports) ─────────────────

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockDb = {
  task: {
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
  },
};

vi.mock('../db', () => ({
  getDb: vi.fn(() => mockDb),
}));

vi.mock('../worktree', () => ({
  createWorktree: vi.fn().mockResolvedValue('/tmp/test-worktree'),
  findIdleWorktree: vi.fn().mockResolvedValue(null),
  repurposeWorktree: vi.fn().mockResolvedValue('/tmp/test-worktree'),
}));

vi.mock('../settings', () => ({
  loadProfiles: vi.fn().mockReturnValue({
    integrate: {
      repoPath: 'C:/repos/test-repo',
      defaultBranch: 'main',
      description: 'Test profile',
    },
  }),
}));

// ─── Tests ─────────────────────────────────────────────────

describe('setupTaskWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early when no tasks need worktrees', async () => {
    mockDb.task.findMany.mockResolvedValueOnce([]);

    await setupTaskWorktrees();

    expect(createWorktree).not.toHaveBeenCalled();
    expect(mockDb.task.update).not.toHaveBeenCalled();
  });

  it('creates worktree and saves path for eligible tasks', async () => {
    const task = makeTask({
      id: 1001,
      state: GridState.TASK_EXECUTION,
      profileKey: 'integrate',
      worktreePath: null,
      disabled: true,
    });
    mockDb.task.findMany
      .mockResolvedValueOnce([task]) // eligible tasks
      .mockResolvedValueOnce([]); // assigned paths
    vi.mocked(createWorktree).mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-1');

    await setupTaskWorktrees();

    expect(createWorktree).toHaveBeenCalledWith('C:/repos/test-repo', 'task', 1001, 'main', undefined, 'Test task');
    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: { worktreePath: 'C:/repos/test-repo-worktrees/test-repo-1' },
    });
  });

  it('skips tasks with unknown profile keys', async () => {
    const task = makeTask({
      id: 1001,
      state: GridState.TASK_EXECUTION,
      profileKey: 'nonexistent',
      worktreePath: null,
      disabled: true,
    });
    mockDb.task.findMany
      .mockResolvedValueOnce([task]) // eligible tasks
      .mockResolvedValueOnce([]); // assigned paths

    await setupTaskWorktrees();

    expect(createWorktree).not.toHaveBeenCalled();
    expect(mockDb.task.update).not.toHaveBeenCalled();
  });

  it('continues with other tasks when createWorktree fails', async () => {
    const task1 = makeTask({
      id: 1001,
      state: GridState.TASK_EXECUTION,
      profileKey: 'integrate',
      worktreePath: null,
      disabled: true,
    });
    const task2 = makeTask({
      id: 1002,
      state: GridState.TASK_EXECUTION,
      profileKey: 'integrate',
      worktreePath: null,
      disabled: true,
    });
    mockDb.task.findMany
      .mockResolvedValueOnce([task1, task2]) // eligible tasks
      .mockResolvedValueOnce([]); // assigned paths
    vi.mocked(createWorktree)
      .mockRejectedValueOnce(new Error('git fetch failed'))
      .mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-2');

    await setupTaskWorktrees();

    // First task failed, second should still succeed
    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(mockDb.task.update).toHaveBeenCalledTimes(1);
    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1002 },
      data: { worktreePath: 'C:/repos/test-repo-worktrees/test-repo-2' },
    });
  });

  it('processes multiple tasks with the same profile', async () => {
    const tasks = [
      makeTask({ id: 1001, profileKey: 'integrate', worktreePath: null, disabled: true, state: GridState.TASK_EXECUTION }),
      makeTask({ id: 1002, profileKey: 'integrate', worktreePath: null, disabled: true, state: GridState.TASK_EXECUTION }),
    ];
    mockDb.task.findMany
      .mockResolvedValueOnce(tasks) // eligible tasks
      .mockResolvedValueOnce([]); // assigned paths
    vi.mocked(createWorktree)
      .mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-1')
      .mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-2');

    await setupTaskWorktrees();

    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(mockDb.task.update).toHaveBeenCalledTimes(2);
  });

  it('queries only tasks in TASK_EXECUTION with profileKey and no worktreePath', async () => {
    mockDb.task.findMany.mockResolvedValueOnce([]);

    await setupTaskWorktrees();

    expect(mockDb.task.findMany).toHaveBeenCalledWith({
      where: {
        state: GridState.TASK_EXECUTION,
        profileKey: { not: null },
        worktreePath: null,
        disabled: true,
      },
    });
  });

  it('reuses an idle worktree when one is available', async () => {
    const task = makeTask({
      id: 1001,
      state: GridState.TASK_EXECUTION,
      profileKey: 'integrate',
      worktreePath: null,
      disabled: true,
    });
    mockDb.task.findMany
      .mockResolvedValueOnce([task]) // eligible tasks
      .mockResolvedValueOnce([]); // assigned paths (none)

    vi.mocked(findIdleWorktree).mockResolvedValueOnce({
      path: 'C:/repos/test-repo-worktrees/test-repo-1',
      head: 'abc123',
      branch: null, // detached
      bare: false,
    });
    vi.mocked(repurposeWorktree).mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-1');

    await setupTaskWorktrees();

    // Should repurpose the idle worktree, not create a new one
    expect(repurposeWorktree).toHaveBeenCalledWith(
      'C:/repos/test-repo-worktrees/test-repo-1',
      'C:/repos/test-repo',
      'task',
      1001,
      'main',
      'Test task',
    );
    expect(createWorktree).not.toHaveBeenCalled();
    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: { worktreePath: 'C:/repos/test-repo-worktrees/test-repo-1' },
    });
  });

  it('falls back to creating new worktree when repurpose fails', async () => {
    const task = makeTask({
      id: 1001,
      state: GridState.TASK_EXECUTION,
      profileKey: 'integrate',
      worktreePath: null,
      disabled: true,
    });
    mockDb.task.findMany.mockResolvedValueOnce([task]).mockResolvedValueOnce([]);

    vi.mocked(findIdleWorktree).mockResolvedValueOnce({
      path: 'C:/repos/test-repo-worktrees/test-repo-1',
      head: 'abc123',
      branch: null,
      bare: false,
    });
    vi.mocked(repurposeWorktree).mockRejectedValueOnce(new Error('git checkout failed'));
    vi.mocked(createWorktree).mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-2');

    await setupTaskWorktrees();

    // repurpose failed — should NOT have saved that path
    // createWorktree fallback should have been called
    expect(createWorktree).toHaveBeenCalledWith('C:/repos/test-repo', 'task', 1001, 'main', undefined, 'Test task');
    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: { worktreePath: 'C:/repos/test-repo-worktrees/test-repo-2' },
    });
  });
});
