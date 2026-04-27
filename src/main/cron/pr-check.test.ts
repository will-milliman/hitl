/**
 * Unit tests for the PR check cron step.
 *
 * Tests runPrCheckStep() and its sub-steps: checkDraftToReady,
 * updatePrReadiness, checkTaskPRMerges — with mocked DB
 * and external modules.
 */
import { execFile } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GridState } from '../../shared/constants';
import { getPullRequestByUrl, isGhAuthenticated } from '../github';
import { notifyTaskCompleted } from '../notifications';
import { makePullRequest, makeTask } from '../test-utils/factories';
import { closeDesktop } from '../virtual-desktop';

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
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
  },
};

vi.mock('../db', () => ({
  getDb: vi.fn(() => mockDb),
}));

vi.mock('../github', () => ({
  isGhAuthenticated: vi.fn().mockResolvedValue(true),
  findPullRequest: vi.fn().mockResolvedValue(null),
  getPullRequestByUrl: vi.fn(),
  isPrReadyToMerge: vi.fn().mockReturnValue(false),
}));

vi.mock('../notifications', () => ({
  notifyTaskCompleted: vi.fn(),
}));

// Mock child_process for cleanupCompletedTask (git checkout --detach)
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

// Mock the virtual-desktop module
vi.mock('../virtual-desktop', () => ({
  closeDesktop: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock the worktree module (for discoverTaskPRs)
vi.mock('../worktree', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue(null),
}));

// Mock the settings module (for discoverTaskPRs profile lookup)
vi.mock('../settings', () => ({
  loadProfiles: vi.fn().mockReturnValue({}),
}));

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

  describe('checkDraftToReady sub-step', () => {
    it('moves task to PR_REVIEW when PR is no longer a draft', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.TASK_EXECUTION,
        prUrl: 'https://github.com/org/repo/pull/101',
        worktreePath: 'C:/repos/test-wt',
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([]) // discoverTaskPRs
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
        .mockResolvedValueOnce([]) // discoverTaskPRs
        .mockResolvedValueOnce([task]) // checkDraftToReady
        .mockResolvedValueOnce([]) // updatePrReadiness
        .mockResolvedValueOnce([]); // checkTaskPRMerges

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
        .mockResolvedValueOnce([]) // discoverTaskPRs
        .mockResolvedValueOnce([task]) // checkDraftToReady
        .mockResolvedValueOnce([]) // updatePrReadiness
        .mockResolvedValueOnce([]); // checkTaskPRMerges

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
        desktopName: 'feature-branch-1001',
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([]) // discoverTaskPRs
        .mockResolvedValueOnce([]) // checkDraftToReady
        .mockResolvedValueOnce([]) // updatePrReadiness
        .mockResolvedValueOnce([task]); // checkTaskPRMerges

      // cleanupCompletedTask reads desktopName before clearing DB
      mockDb.task.findUnique.mockResolvedValueOnce({ desktopName: 'feature-branch-1001' });

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
        data: { worktreePath: null, sessionId: null, desktopOpen: false, desktopName: null },
      });

      // Verify branch was detached before parking
      expect(execFile).toHaveBeenCalledWith(
        'git',
        ['checkout', '--detach'],
        expect.objectContaining({ cwd: 'C:/repos/test-wt' }),
        expect.any(Function),
      );

      // Verify virtual desktop close was attempted via shared module
      expect(closeDesktop).toHaveBeenCalledWith('feature-branch-1001', { hardFail: false });
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
        .mockResolvedValueOnce([]) // discoverTaskPRs
        .mockResolvedValueOnce([]) // checkDraftToReady
        .mockResolvedValueOnce([]) // updatePrReadiness
        .mockResolvedValueOnce([task]); // checkTaskPRMerges

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
        .mockResolvedValueOnce([]) // discoverTaskPRs
        .mockResolvedValueOnce([]) // checkDraftToReady
        .mockResolvedValueOnce([]) // updatePrReadiness
        .mockResolvedValueOnce([task]); // checkTaskPRMerges

      // cleanupCompletedTask reads desktopName before clearing DB
      mockDb.task.findUnique.mockResolvedValueOnce({ desktopName: null });

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
        data: { worktreePath: null, sessionId: null, desktopOpen: false, desktopName: null },
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
        .mockResolvedValueOnce([]) // discoverTaskPRs
        .mockResolvedValueOnce([]) // checkDraftToReady
        .mockResolvedValueOnce([]) // updatePrReadiness
        .mockResolvedValueOnce([task]); // checkTaskPRMerges

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
        .mockResolvedValueOnce([]) // discoverTaskPRs
        .mockResolvedValueOnce([]) // checkDraftToReady
        .mockResolvedValueOnce([]) // updatePrReadiness
        .mockResolvedValueOnce([task]); // checkTaskPRMerges

      vi.mocked(getPullRequestByUrl).mockResolvedValueOnce(makePullRequest({ state: 'MERGED' }));

      // cleanupCompletedTask reads desktopName before clearing DB
      mockDb.task.findUnique.mockResolvedValueOnce({ desktopName: null });

      // First update succeeds (COMPLETED), second fails (park worktree)
      mockDb.task.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('DB error'));

      // Virtual desktop close also fails
      vi.mocked(closeDesktop).mockResolvedValueOnce({ success: false, error: 'PowerShell not found' });

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
