/**
 * Integration tests for the PR check cron step.
 *
 * Uses a real SQLite database (via setupTestDb) with mocked external services.
 * Validates that runPrCheckStep() detects draft→ready transitions, detects
 * merges, and persists all state transitions in the DB.
 */
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { GridState } from '../../shared/constants';
import { getPullRequestByUrl, isGhAuthenticated } from '../github';
import { notifyTaskCompleted } from '../notifications';
// ─── Real DB setup ─────────────────────────────────────────

import { resetTestDb, setupTestDb, teardownTestDb } from '../test-utils/db';
import { makePullRequest } from '../test-utils/factories';

// ─── Imports (after mocks) ─────────────────────────────────

import { runPrCheckStep } from './pr-check';

// ─── Module mocks — external services only ─────────────────

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../github', () => ({
  isGhAuthenticated: vi.fn().mockResolvedValue(true),
  getPullRequestByUrl: vi.fn(),
  isPrReadyToMerge: vi.fn().mockReturnValue(false),
}));

vi.mock('../notifications', () => ({
  notifyTaskCompleted: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
      cb(null, { stdout: '', stderr: '' });
    }),
    exec: vi.fn((_cmd: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
      cb(null, { stdout: '', stderr: '' });
    }),
  };
});

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
  // Restore default mock behaviors
  vi.mocked(isGhAuthenticated).mockResolvedValue(true);
});

afterAll(async () => {
  await teardownTestDb();
}, 10_000);

// ─── Tests ─────────────────────────────────────────────────

describe('runPrCheckStep (integration)', () => {
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
      });

      vi.mocked(getPullRequestByUrl).mockResolvedValue(makePullRequest({ isDraft: false }));

      await runPrCheckStep();

      const task = await db.task.findUnique({ where: { id: 9020 } });
      expect(task!.state).toBe(GridState.PR_REVIEW);
    });

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
      });

      vi.mocked(getPullRequestByUrl).mockResolvedValue(makePullRequest({ isDraft: true }));

      await runPrCheckStep();

      const task = await db.task.findUnique({ where: { id: 9021 } });
      expect(task!.state).toBe(GridState.TASK_EXECUTION); // unchanged
    });

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
      });

      vi.mocked(getPullRequestByUrl).mockRejectedValue(new Error('gh CLI timeout'));

      await expect(runPrCheckStep()).resolves.not.toThrow();

      const task = await db.task.findUnique({ where: { id: 9022 } });
      expect(task!.state).toBe(GridState.TASK_EXECUTION);
    });
  });

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
      });

      vi.mocked(getPullRequestByUrl).mockResolvedValue(makePullRequest({ state: 'MERGED' }));

      await runPrCheckStep();

      const task = await db.task.findUnique({ where: { id: 9030 } });
      expect(task!.state).toBe(GridState.COMPLETED);
      expect(task!.prMerged).toBe(true);
      expect(task!.disabled).toBe(true);
      expect(task!.completedAt).not.toBeNull();
      expect(notifyTaskCompleted).toHaveBeenCalledWith(9030, 'Merged PR task');

      // Cleanup: worktree should be parked (DB fields cleared)
      expect(task!.worktreePath).toBeNull();
      expect(task!.sessionId).toBeNull();
    });

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
      });

      vi.mocked(getPullRequestByUrl).mockResolvedValue(makePullRequest({ state: 'OPEN' }));

      await runPrCheckStep();

      const task = await db.task.findUnique({ where: { id: 9031 } });
      expect(task!.state).toBe(GridState.PR_REVIEW); // unchanged
      expect(task!.prMerged).toBe(false);
    });

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
      });

      vi.mocked(getPullRequestByUrl).mockRejectedValue(new Error('gh CLI timeout'));

      await expect(runPrCheckStep()).resolves.not.toThrow();

      const task = await db.task.findUnique({ where: { id: 9032 } });
      expect(task!.state).toBe(GridState.PR_REVIEW);
    });
  });

  describe('full pipeline scenarios', () => {
    it('handles mixed tasks: one draft→ready, one merged', async () => {
      // Task 1: In TASK_EXECUTION with draft PR that's been marked ready
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
      });

      // Task 2: In PR_REVIEW with merged PR
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
      });

      // Mock getPullRequestByUrl — used by both checkDraftToReady and checkTaskPRMerges
      vi.mocked(getPullRequestByUrl).mockImplementation(async (prUrl: string) => {
        if (prUrl === 'https://github.com/org/repo/pull/401') {
          // Task 9041: no longer a draft
          return makePullRequest({ isDraft: false, state: 'OPEN' });
        }
        if (prUrl === 'https://github.com/org/repo/pull/402') {
          // Task 9042: merged
          return makePullRequest({ state: 'MERGED' });
        }
        return makePullRequest({ state: 'OPEN' });
      });

      await runPrCheckStep();

      // Task 9041: should be moved to PR_REVIEW
      const task41 = await db.task.findUnique({ where: { id: 9041 } });
      expect(task41!.state).toBe(GridState.PR_REVIEW);

      // Task 9042: should be COMPLETED with worktree parked
      const task42 = await db.task.findUnique({ where: { id: 9042 } });
      expect(task42!.state).toBe(GridState.COMPLETED);
      expect(task42!.prMerged).toBe(true);
      expect(task42!.worktreePath).toBeNull();
      expect(task42!.sessionId).toBeNull();
    });

    it('skips everything when gh CLI is not authenticated', async () => {
      vi.mocked(isGhAuthenticated).mockResolvedValueOnce(false);

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
      });

      await runPrCheckStep();

      const task = await db.task.findUnique({ where: { id: 9050 } });
      expect(task!.prUrl).toBeNull();
      expect(getPullRequestByUrl).not.toHaveBeenCalled();
    });
  });
});
