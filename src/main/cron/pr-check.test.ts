/**
 * Unit tests for the PR check cron step.
 *
 * Tests runPrCheckStep() and its sub-steps: createDraftPRs,
 * checkDraftToReady, checkTaskPRMerges — with mocked DB
 * and external modules.
 */
import { exec, execFile } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GridState } from '../../shared/constants';
import { createPullRequest, findPullRequest, getPullRequestByUrl, isGhAuthenticated } from '../github';
import { notifyTaskCompleted } from '../notifications';
import { makePullRequest, makeTask } from '../test-utils/factories';

// ─── Imports (after mocks) ─────────────────────────────────

import { runPrCheckStep } from './pr-check';

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

vi.mock('../github', () => ({
  isGhAuthenticated: vi.fn().mockResolvedValue(true),
  createPullRequest: vi.fn(),
  findPullRequest: vi.fn().mockResolvedValue(null),
  getPullRequestByUrl: vi.fn(),
  isPrReadyToMerge: vi.fn().mockReturnValue(false),
}));

vi.mock('../worktree', () => ({
  getBranchName: vi.fn((type: string, workItemId: number) => `${type}/${workItemId}`),
  getCurrentBranch: vi.fn().mockResolvedValue('task/1001'),
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

vi.mock('../notifications', () => ({
  notifyTaskCompleted: vi.fn(),
}));

// Mock child_process for pushBranch (execFile) and closeVirtualDesktop (exec)
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
    cb(null, { stdout: '', stderr: '' });
  }),
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
    cb(null, { stdout: '', stderr: '' });
  }),
}));

vi.mock('util', async () => {
  const actual = await vi.importActual('util');
  return {
    ...actual,
    promisify: vi.fn((fn: (...args: unknown[]) => void) => {
      return (...args: unknown[]) => {
        return new Promise((resolve, reject) => {
          fn(...args, (err: Error | null, result: unknown) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
      };
    }),
  };
});

// ─── Tests ─────────────────────────────────────────────────

describe('runPrCheckStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset defaults
    mockDb.task.findMany.mockResolvedValue([]);
    vi.mocked(isGhAuthenticated).mockResolvedValue(true);
  });

  it('skips everything when gh CLI is not authenticated', async () => {
    vi.mocked(isGhAuthenticated).mockResolvedValueOnce(false);

    await runPrCheckStep();

    expect(mockDb.task.findMany).not.toHaveBeenCalled();
  });

  describe('createDraftPRs sub-step', () => {
    it('creates draft PR for task in TASK_EXECUTION with no prUrl', async () => {
      const task = {
        ...makeTask({
          id: 1001,
          state: GridState.TASK_EXECUTION,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt',
          sessionId: 'session-1',
          prUrl: null,
          disabled: false,
        }),
        story: { id: 90001, title: 'Test story' },
      };

      // createDraftPRs query
      mockDb.task.findMany
        .mockResolvedValueOnce([task]) // createDraftPRs
        .mockResolvedValueOnce([]) // checkDraftToReady
        .mockResolvedValueOnce([]) // updatePrReadiness
        .mockResolvedValueOnce([]); // checkTaskPRMerges

      vi.mocked(findPullRequest).mockResolvedValueOnce(null); // no existing PR
      vi.mocked(createPullRequest).mockResolvedValueOnce(
        makePullRequest({ number: 201, url: 'https://github.com/org/repo/pull/201', isDraft: true }),
      );

      await runPrCheckStep();

      expect(createPullRequest).toHaveBeenCalledWith(
        'C:/repos/test-wt',
        expect.objectContaining({
          title: expect.stringContaining('Task #1001'),
          head: 'task/1001',
          base: 'main',
          draft: true,
        }),
      );
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { prUrl: 'https://github.com/org/repo/pull/201' },
      });
    });

    it('uses existing PR URL when PR already exists on GitHub', async () => {
      const task = {
        ...makeTask({
          id: 1001,
          state: GridState.TASK_EXECUTION,
          profileKey: 'integrate',
          worktreePath: 'C:/repos/test-wt',
          sessionId: 'session-1',
          prUrl: null,
          disabled: false,
        }),
        story: null,
      };

      mockDb.task.findMany
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      vi.mocked(findPullRequest).mockResolvedValueOnce(makePullRequest({ url: 'https://github.com/org/repo/pull/99' }));

      await runPrCheckStep();

      // Should NOT create a new PR
      expect(createPullRequest).not.toHaveBeenCalled();
      // Should save the existing PR URL
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { prUrl: 'https://github.com/org/repo/pull/99' },
      });
    });

    it('does nothing when no tasks need draft PRs', async () => {
      mockDb.task.findMany.mockResolvedValue([]);

      await runPrCheckStep();

      expect(createPullRequest).not.toHaveBeenCalled();
    });
  });

  describe('checkDraftToReady sub-step', () => {
    it('moves task to PR_REVIEW when PR is no longer a draft', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.TASK_EXECUTION,
        prUrl: 'https://github.com/org/repo/pull/101',
        worktreePath: 'C:/repos/test-wt',
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([]) // createDraftPRs
        .mockResolvedValueOnce([task]) // checkDraftToReady
        .mockResolvedValueOnce([]) // updatePrReadiness
        .mockResolvedValueOnce([]); // checkTaskPRMerges

      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(makePullRequest({ isDraft: false }));

      await runPrCheckStep();

      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { state: GridState.PR_REVIEW },
      });
    });

    it('does not change state when PR is still a draft', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.TASK_EXECUTION,
        prUrl: 'https://github.com/org/repo/pull/101',
        worktreePath: 'C:/repos/test-wt',
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(makePullRequest({ isDraft: true }));

      await runPrCheckStep();

      expect(mockDb.task.update).not.toHaveBeenCalled();
    });

    it('handles errors gracefully without crashing the step', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.TASK_EXECUTION,
        prUrl: 'https://github.com/org/repo/pull/101',
        worktreePath: 'C:/repos/test-wt',
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      vi.mocked(getPullRequestByUrl).mockRejectedValueOnce(new Error('gh CLI timeout'));

      // Should not throw
      await expect(runPrCheckStep()).resolves.not.toThrow();
    });
  });

  describe('checkTaskPRMerges sub-step', () => {
    it('moves task to COMPLETED and cleans up when PR is merged', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.PR_REVIEW,
        prUrl: 'https://github.com/org/repo/pull/101',
        prMerged: false,
        worktreePath: 'C:/repos/test-wt',
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([]) // createDraftPRs
        .mockResolvedValueOnce([]) // checkDraftToReady
        .mockResolvedValueOnce([]) // updatePrReadiness
        .mockResolvedValueOnce([task]); // checkTaskPRMerges

      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(makePullRequest({ state: 'MERGED' }));

      await runPrCheckStep();

      // Verify COMPLETED state transition
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: expect.objectContaining({
          state: GridState.COMPLETED,
          prMerged: true,
          disabled: true,
          completedAt: expect.any(Date),
        }),
      });
      expect(notifyTaskCompleted).toHaveBeenCalledWith(1001, task.title);

      // Verify worktree was parked (DB fields cleared)
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { worktreePath: null, sessionId: null },
      });

      // Verify branch was detached before parking
      expect(execFile).toHaveBeenCalledWith(
        'git',
        ['checkout', '--detach'],
        expect.objectContaining({ cwd: 'C:/repos/test-wt' }),
        expect.any(Function),
      );

      // Verify virtual desktop close was attempted (PowerShell exec)
      expect(exec).toHaveBeenCalledWith(expect.stringContaining('Task #1001'), expect.any(Object), expect.any(Function));
    });

    it('does not change state when PR is still open', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.PR_REVIEW,
        prUrl: 'https://github.com/org/repo/pull/101',
        prMerged: false,
        worktreePath: 'C:/repos/test-wt',
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([task]);

      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(makePullRequest({ state: 'OPEN' }));

      await runPrCheckStep();

      // Should NOT update the task state
      expect(mockDb.task.update).not.toHaveBeenCalled();
    });

    it('moves task to ABANDONED and cleans up when PR is closed', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.PR_REVIEW,
        prUrl: 'https://github.com/org/repo/pull/101',
        prMerged: false,
        worktreePath: 'C:/repos/test-wt',
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([]) // createDraftPRs
        .mockResolvedValueOnce([]) // checkDraftToReady
        .mockResolvedValueOnce([]) // updatePrReadiness
        .mockResolvedValueOnce([task]); // checkTaskPRMerges

      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(makePullRequest({ state: 'CLOSED' }));

      await runPrCheckStep();

      // Verify ABANDONED state transition
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: expect.objectContaining({
          state: GridState.ABANDONED,
          disabled: true,
        }),
      });

      // Should NOT notify (not a completion)
      expect(notifyTaskCompleted).not.toHaveBeenCalled();

      // Verify worktree was parked (DB fields cleared)
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { worktreePath: null, sessionId: null },
      });

      // Verify branch was detached before parking
      expect(execFile).toHaveBeenCalledWith(
        'git',
        ['checkout', '--detach'],
        expect.objectContaining({ cwd: 'C:/repos/test-wt' }),
        expect.any(Function),
      );
    });

    it('handles errors gracefully without crashing the step', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.PR_REVIEW,
        prUrl: 'https://github.com/org/repo/pull/101',
        worktreePath: 'C:/repos/test-wt',
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([task]);

      vi.mocked(getPullRequestByUrl).mockRejectedValueOnce(new Error('gh CLI timeout'));

      // Should not throw
      await expect(runPrCheckStep()).resolves.not.toThrow();
    });

    it('completes task even when cleanup fails', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.PR_REVIEW,
        prUrl: 'https://github.com/org/repo/pull/101',
        prMerged: false,
        worktreePath: 'C:/repos/test-wt',
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([task]);

      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(makePullRequest({ state: 'MERGED' }));

      // First update succeeds (COMPLETED), second fails (park worktree)
      mockDb.task.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('DB error'));

      // Virtual desktop close also fails
      vi.mocked(exec).mockImplementationOnce(((_cmd: unknown, _opts: unknown, cb: unknown) => {
        (cb as (...args: unknown[]) => void)(new Error('PowerShell not found'));
        return {} as any;
      }) as any);

      // Should not throw — cleanup failures are non-fatal
      await expect(runPrCheckStep()).resolves.not.toThrow();

      // Verify COMPLETED transition still happened
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: expect.objectContaining({
          state: GridState.COMPLETED,
        }),
      });
    });
  });
});
