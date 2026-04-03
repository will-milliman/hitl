/**
 * Unit tests for the task execution cron step.
 *
 * Tests runTaskExecutionStep() and resumeTaskWatchers() orchestration logic
 * with mocked DB, copilot, and fs modules.
 */
import { existsSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GridState } from '../../shared/constants';
import { ensureGlobalHooks, isWatching, readLatestSignal, spawnSession, watchSignals } from '../copilot';
import { makeTask } from '../test-utils/factories';

// ─── Imports (after mocks) ─────────────────────────────────

import { resumeTaskWatchers, runTaskExecutionStep } from './task-execution';

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

vi.mock('../copilot', () => ({
  spawnSession: vi.fn().mockResolvedValue({
    sessionId: 'test-session-id',
    logDir: '/tmp/test-logs',
  }),
  ensureGlobalHooks: vi.fn(),
  watchSignals: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
  readLatestSignal: vi.fn().mockReturnValue(null),
  SIGNAL_FILES: {
    SESSION_IDLE: 'session-idle.json',
    SESSION_ACTIVE: 'session-active.json',
    SESSION_END: 'session-end.json',
  },
  getLogDir: vi.fn().mockReturnValue('/tmp/test-logs'),
  getPrSummaryPath: vi.fn().mockReturnValue('/tmp/.hitl-data/test-wt/PR.md'),
  getScreenshotsDir: vi.fn().mockReturnValue('/tmp/.hitl-data/test-wt/screenshots'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

// ─── Tests ─────────────────────────────────────────────────

describe('runTaskExecutionStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mocks
    mockDb.task.findMany.mockResolvedValue([]);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readLatestSignal).mockReturnValue(null);
    vi.mocked(isWatching).mockReturnValue(false);
  });

  it('returns early when no tasks are ready for execution', async () => {
    // Recovery phase returns no tasks, execution phase returns no tasks
    mockDb.task.findMany.mockResolvedValue([]);

    await runTaskExecutionStep();

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('spawns copilot session for task with worktree but no session', async () => {
    const recoveryTasks: unknown[] = [];
    const recoveryTasks2: unknown[] = [];
    const executionTasks = [
      {
        ...makeTask({
          id: 1001,
          title: 'Implement feature',
          state: GridState.TASK_EXECUTION,
          worktreePath: 'C:/repos/test-wt',
          sessionId: null,
          disabled: true,
        }),
        story: { title: 'Parent story' },
      },
    ];

    // recoverInterruptedTasks: findMany for worktree check, findMany for session check
    // runTaskExecutionStep: findMany for execution
    mockDb.task.findMany
      .mockResolvedValueOnce(recoveryTasks) // recovery: worktrees
      .mockResolvedValueOnce(recoveryTasks2) // recovery: sessions
      .mockResolvedValueOnce(executionTasks); // execution

    await runTaskExecutionStep();

    expect(ensureGlobalHooks).toHaveBeenCalled();
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'C:/repos/test-wt',
        prompt: expect.stringContaining('Task #1001'),
      }),
    );
    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: { sessionId: 'test-session-id' },
    });
    expect(watchSignals).toHaveBeenCalledWith('C:/repos/test-wt', 'task', 1001);
  });

  it('skips watch when already watching the worktree', async () => {
    const executionTasks = [
      {
        ...makeTask({
          id: 1001,
          state: GridState.TASK_EXECUTION,
          worktreePath: 'C:/repos/test-wt',
          sessionId: null,
          disabled: true,
        }),
        story: null,
      },
    ];

    mockDb.task.findMany
      .mockResolvedValueOnce([]) // recovery: worktrees
      .mockResolvedValueOnce([]) // recovery: sessions
      .mockResolvedValueOnce(executionTasks);

    vi.mocked(isWatching).mockReturnValue(true);

    await runTaskExecutionStep();

    expect(watchSignals).not.toHaveBeenCalled();
  });

  it('continues with other tasks when spawnSession fails', async () => {
    const task1 = {
      ...makeTask({
        id: 1001,
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/wt1',
        sessionId: null,
        disabled: true,
      }),
      story: null,
    };
    const task2 = {
      ...makeTask({
        id: 1002,
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/wt2',
        sessionId: null,
        disabled: true,
      }),
      story: null,
    };

    mockDb.task.findMany
      .mockResolvedValueOnce([]) // recovery: worktrees
      .mockResolvedValueOnce([]) // recovery: sessions
      .mockResolvedValueOnce([task1, task2]);

    vi.mocked(spawnSession)
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce({ sessionId: 'session-2', logDir: '/tmp/logs-2' });

    await runTaskExecutionStep();

    // First task failed, second should succeed
    expect(mockDb.task.update).toHaveBeenCalledTimes(1);
    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1002 },
      data: { sessionId: 'session-2' },
    });
  });

  describe('recovery - interrupted tasks', () => {
    it('resets worktreePath when directory no longer exists', async () => {
      const staleTask = makeTask({
        id: 1001,
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/deleted-wt',
        disabled: true,
      });

      vi.mocked(existsSync).mockReturnValue(false);

      mockDb.task.findMany
        .mockResolvedValueOnce([staleTask]) // recovery: worktrees
        .mockResolvedValueOnce([]) // recovery: sessions
        .mockResolvedValueOnce([]); // execution

      await runTaskExecutionStep();

      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { worktreePath: null, sessionId: null },
      });
    });

    it('enables task when session-end signal found (stays in TASK_EXECUTION)', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/test-wt',
        sessionId: 'old-session',
        disabled: true,
      });

      vi.mocked(readLatestSignal).mockReturnValue({
        signal: 'session-end.json',
        timestamp: Date.now(),
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([]) // recovery: worktrees (no stale worktrees)
        .mockResolvedValueOnce([task]) // recovery: sessions
        .mockResolvedValueOnce([]); // execution

      await runTaskExecutionStep();

      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { disabled: false },
      });
    });

    it('marks task as enabled when session-idle signal found', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/test-wt',
        sessionId: 'old-session',
        disabled: true,
      });

      vi.mocked(readLatestSignal).mockReturnValue({
        signal: 'session-idle.json',
        timestamp: Date.now(),
      });

      mockDb.task.findMany
        .mockResolvedValueOnce([]) // recovery: worktrees
        .mockResolvedValueOnce([task]) // recovery: sessions
        .mockResolvedValueOnce([]); // execution

      await runTaskExecutionStep();

      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { disabled: false },
      });
    });

    it('resets sessionId when log directory does not exist', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/test-wt',
        sessionId: 'dead-session',
        disabled: true,
      });

      vi.mocked(readLatestSignal).mockReturnValue(null);
      // existsSync returns true for worktree path, false for log dir
      vi.mocked(existsSync)
        .mockReturnValueOnce(true) // worktree exists (recovery phase 1)
        .mockReturnValueOnce(false); // log dir doesn't exist

      // Need the recovery worktree task to pass the existsSync check
      mockDb.task.findMany
        .mockResolvedValueOnce([task]) // recovery: worktrees (exists, so not reset)
        .mockResolvedValueOnce([task]) // recovery: sessions
        .mockResolvedValueOnce([]); // execution

      await runTaskExecutionStep();

      // Should have been called to reset sessionId (not worktreePath since it exists)
      expect(mockDb.task.update).toHaveBeenCalledWith({
        where: { id: 1001 },
        data: { sessionId: null },
      });
    });

    it('re-establishes watcher for active sessions without one', async () => {
      const task = makeTask({
        id: 1001,
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/test-wt',
        sessionId: 'active-session',
        disabled: true,
      });

      vi.mocked(readLatestSignal).mockReturnValue({
        signal: 'session-active.json',
        timestamp: Date.now(),
      });
      vi.mocked(isWatching).mockReturnValue(false);

      mockDb.task.findMany
        .mockResolvedValueOnce([]) // recovery: worktrees
        .mockResolvedValueOnce([task]) // recovery: sessions
        .mockResolvedValueOnce([]); // execution

      await runTaskExecutionStep();

      expect(watchSignals).toHaveBeenCalledWith('C:/repos/test-wt', 'task', 1001);
    });
  });
});

describe('resumeTaskWatchers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isWatching).mockReturnValue(false);
  });

  it('resumes watchers for tasks with active sessions', async () => {
    const tasks = [
      makeTask({
        id: 1001,
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/wt1',
        sessionId: 'session-1',
        disabled: true,
      }),
      makeTask({
        id: 1002,
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/wt2',
        sessionId: 'session-2',
        disabled: true,
      }),
    ];

    mockDb.task.findMany.mockResolvedValueOnce(tasks);

    await resumeTaskWatchers();

    expect(watchSignals).toHaveBeenCalledTimes(2);
    expect(watchSignals).toHaveBeenCalledWith('C:/repos/wt1', 'task', 1001);
    expect(watchSignals).toHaveBeenCalledWith('C:/repos/wt2', 'task', 1002);
  });

  it('skips tasks already being watched', async () => {
    const task = makeTask({
      id: 1001,
      state: GridState.TASK_EXECUTION,
      worktreePath: 'C:/repos/wt1',
      sessionId: 'session-1',
      disabled: true,
    });

    mockDb.task.findMany.mockResolvedValueOnce([task]);
    vi.mocked(isWatching).mockReturnValue(true);

    await resumeTaskWatchers();

    expect(watchSignals).not.toHaveBeenCalled();
  });

  it('does nothing when no tasks have active sessions', async () => {
    mockDb.task.findMany.mockResolvedValueOnce([]);

    await resumeTaskWatchers();

    expect(watchSignals).not.toHaveBeenCalled();
  });
});
