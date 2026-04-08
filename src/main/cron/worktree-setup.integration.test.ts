/**
 * Integration tests for the worktree setup cron step.
 *
 * Uses a real SQLite database (via setupTestDb) with mocked external services.
 * Validates that setupTaskWorktrees() correctly creates worktrees for eligible
 * tasks and persists the worktreePath in the DB.
 */
import type { PrismaClient } from '@prisma/client';
import { spawn } from 'child_process';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { GridState } from '../../shared/constants';
// ─── Real DB setup ─────────────────────────────────────────

import { resetTestDb, setupTestDb, teardownTestDb } from '../test-utils/db';
import { createWorktree, findIdleWorktree, repurposeWorktree } from '../worktree';

// ─── Imports (after mocks) ─────────────────────────────────

import { setupTaskWorktrees } from './worktree-setup';

// ─── Module mocks — external services only ─────────────────

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
  };
});

vi.mock('../worktree', () => ({
  createWorktree: vi.fn().mockResolvedValue('C:/repos/test-repo-worktrees/test-repo-1'),
  findIdleWorktree: vi.fn().mockResolvedValue(null),
  repurposeWorktree: vi.fn().mockResolvedValue('C:/repos/test-repo-worktrees/test-repo-1'),
}));

const mockLoadProfiles = vi.fn().mockReturnValue({
  integrate: {
    repoPath: 'C:/repos/test-repo',
    defaultBranch: 'main',
    description: 'Test profile',
  },
});

vi.mock('../settings', () => ({
  loadProfiles: (...args: unknown[]) => mockLoadProfiles(...args),
}));

let db: PrismaClient;

vi.mock('../db', () => ({
  getDb: vi.fn(() => db),
}));

// ─── Lifecycle ─────────────────────────────────────────────

beforeAll(async () => {
  db = await setupTestDb();
}, 60_000);

afterEach(async () => {
  await resetTestDb();
  vi.clearAllMocks();
});

afterAll(async () => {
  await teardownTestDb();
}, 10_000);

// ─── Tests ─────────────────────────────────────────────────

describe('setupTaskWorktrees (integration)', () => {
  it('creates worktree and saves path for eligible task', async () => {
    // Seed a task in COPILOT_KICKOFF with profile but no worktree
    await db.task.create({
      data: {
        id: 7001,
        title: 'Eligible task',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7001',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    });

    vi.mocked(createWorktree).mockResolvedValueOnce('C:/repos/test-repo-worktrees/task-7001');

    await setupTaskWorktrees();

    // Verify worktree was created with correct args
    expect(createWorktree).toHaveBeenCalledWith('C:/repos/test-repo', 'task', 7001, 'main', undefined, 'Eligible task');

    // Verify DB was updated with worktree path
    const task = await db.task.findUnique({ where: { id: 7001 } });
    expect(task!.worktreePath).toBe('C:/repos/test-repo-worktrees/task-7001');
  });

  it('skips tasks that already have a worktree path', async () => {
    await db.task.create({
      data: {
        id: 7002,
        title: 'Already has worktree',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7002',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: 'C:/existing/worktree',
        disabled: true,
      },
    });

    await setupTaskWorktrees();

    expect(createWorktree).not.toHaveBeenCalled();
  });

  it('skips tasks without a profile assigned', async () => {
    await db.task.create({
      data: {
        id: 7003,
        title: 'No profile',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7003',
        state: GridState.COPILOT_KICKOFF,
        profileKey: null,
        worktreePath: null,
        disabled: true,
      },
    });

    await setupTaskWorktrees();

    expect(createWorktree).not.toHaveBeenCalled();
  });

  it('skips tasks that are not disabled (not ready for execution)', async () => {
    await db.task.create({
      data: {
        id: 7004,
        title: 'Not disabled',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7004',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: false,
      },
    });

    await setupTaskWorktrees();

    expect(createWorktree).not.toHaveBeenCalled();
  });

  it('skips tasks not in COPILOT_KICKOFF state', async () => {
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
    });

    await setupTaskWorktrees();

    expect(createWorktree).not.toHaveBeenCalled();
  });

  it('skips tasks with unknown profile key', async () => {
    await db.task.create({
      data: {
        id: 7006,
        title: 'Unknown profile',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7006',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'nonexistent',
        worktreePath: null,
        disabled: true,
      },
    });

    await setupTaskWorktrees();

    // createWorktree should NOT be called (profile not found)
    expect(createWorktree).not.toHaveBeenCalled();

    // Task should remain unchanged
    const task = await db.task.findUnique({ where: { id: 7006 } });
    expect(task!.worktreePath).toBeNull();
  });

  it('processes multiple eligible tasks', async () => {
    await db.task.create({
      data: {
        id: 7010,
        title: 'Task A',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7010',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    });
    await db.task.create({
      data: {
        id: 7011,
        title: 'Task B',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7011',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    });

    vi.mocked(createWorktree).mockResolvedValueOnce('C:/repos/wt/task-7010').mockResolvedValueOnce('C:/repos/wt/task-7011');

    await setupTaskWorktrees();

    expect(createWorktree).toHaveBeenCalledTimes(2);

    const taskA = await db.task.findUnique({ where: { id: 7010 } });
    const taskB = await db.task.findUnique({ where: { id: 7011 } });
    expect(taskA!.worktreePath).toBe('C:/repos/wt/task-7010');
    expect(taskB!.worktreePath).toBe('C:/repos/wt/task-7011');
  });

  it('continues processing other tasks when one fails', async () => {
    await db.task.create({
      data: {
        id: 7020,
        title: 'Will fail',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7020',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    });
    await db.task.create({
      data: {
        id: 7021,
        title: 'Will succeed',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7021',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    });

    vi.mocked(createWorktree)
      .mockRejectedValueOnce(new Error('git worktree add failed'))
      .mockResolvedValueOnce('C:/repos/wt/task-7021');

    await setupTaskWorktrees();

    // First task should still have no worktree (failed)
    const failedTask = await db.task.findUnique({ where: { id: 7020 } });
    expect(failedTask!.worktreePath).toBeNull();

    // Second task should succeed
    const successTask = await db.task.findUnique({ where: { id: 7021 } });
    expect(successTask!.worktreePath).toBe('C:/repos/wt/task-7021');
  });

  it('reuses an idle worktree instead of creating a new one', async () => {
    // A completed task that has a parked worktree (worktreePath is null in DB,
    // but the worktree directory still exists on disk and is discoverable by git)
    await db.task.create({
      data: {
        id: 7030,
        title: 'Needs worktree',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7030',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    });

    vi.mocked(findIdleWorktree).mockResolvedValueOnce({
      path: 'C:/repos/test-repo-worktrees/test-repo-1',
      head: 'abc123',
      branch: null, // detached
      bare: false,
    });
    vi.mocked(repurposeWorktree).mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-1');

    await setupTaskWorktrees();

    // Should repurpose, not create
    expect(repurposeWorktree).toHaveBeenCalledWith(
      'C:/repos/test-repo-worktrees/test-repo-1',
      'C:/repos/test-repo',
      'task',
      7030,
      'main',
      'Needs worktree',
    );
    expect(createWorktree).not.toHaveBeenCalled();

    // Verify DB was updated
    const task = await db.task.findUnique({ where: { id: 7030 } });
    expect(task!.worktreePath).toBe('C:/repos/test-repo-worktrees/test-repo-1');
  });

  it('falls back to creating new worktree when repurpose fails', async () => {
    await db.task.create({
      data: {
        id: 7031,
        title: 'Repurpose will fail',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7031',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    });

    vi.mocked(findIdleWorktree).mockResolvedValueOnce({
      path: 'C:/repos/test-repo-worktrees/test-repo-1',
      head: 'abc123',
      branch: null,
      bare: false,
    });
    vi.mocked(repurposeWorktree).mockRejectedValueOnce(new Error('git checkout failed'));
    vi.mocked(createWorktree).mockResolvedValueOnce('C:/repos/test-repo-worktrees/test-repo-2');

    await setupTaskWorktrees();

    // Should have fallen back to createWorktree
    expect(createWorktree).toHaveBeenCalledWith('C:/repos/test-repo', 'task', 7031, 'main', undefined, 'Repurpose will fail');

    const task = await db.task.findUnique({ where: { id: 7031 } });
    expect(task!.worktreePath).toBe('C:/repos/test-repo-worktrees/test-repo-2');
  });

  it('spawns setup command after worktree is created when profile has setup config', async () => {
    mockLoadProfiles.mockReturnValueOnce({
      integrate: {
        repoPath: 'C:/repos/test-repo',
        defaultBranch: 'main',
        description: 'Test profile',
        setup: { cwd: 'src', command: 'npm install' },
      },
    });

    await db.task.create({
      data: {
        id: 7040,
        title: 'Task with setup',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7040',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    });

    vi.mocked(createWorktree).mockResolvedValueOnce('C:/repos/test-repo-worktrees/task-7040');

    await setupTaskWorktrees();

    // Verify worktree was created and DB updated
    const task = await db.task.findUnique({ where: { id: 7040 } });
    expect(task!.worktreePath).toBe('C:/repos/test-repo-worktrees/task-7040');

    // Verify setup command was spawned
    expect(spawn).toHaveBeenCalledWith('npm install', [], {
      cwd: join('C:/repos/test-repo-worktrees/task-7040', 'src'),
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  });

  it('does not spawn setup command when profile has no setup config', async () => {
    await db.task.create({
      data: {
        id: 7041,
        title: 'Task without setup',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/7041',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: null,
        disabled: true,
      },
    });

    vi.mocked(createWorktree).mockResolvedValueOnce('C:/repos/test-repo-worktrees/task-7041');

    await setupTaskWorktrees();

    const task = await db.task.findUnique({ where: { id: 7041 } });
    expect(task!.worktreePath).toBe('C:/repos/test-repo-worktrees/task-7041');

    expect(spawn).not.toHaveBeenCalled();
  });
});
