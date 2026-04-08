/**
 * Integration tests for the task execution cron step.
 *
 * Uses a real SQLite database (via setupTestDb) with mocked external services.
 * Validates that runTaskExecutionStep() and resumeTaskWatchers() correctly
 * spawn sessions, recover interrupted tasks, and persist state in the DB.
 */
import type { PrismaClient } from '@prisma/client';
import { existsSync } from 'fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { GridState } from '../../shared/constants';
import { SIGNAL_FILES, ensureGlobalHooks, isWatching, readLatestSignal, spawnSession, watchSignals } from '../copilot';
// ─── Real DB setup ─────────────────────────────────────────

import { resetTestDb, setupTestDb, teardownTestDb } from '../test-utils/db';

// ─── Imports (after mocks) ─────────────────────────────────

import { resumeTaskWatchers, runTaskExecutionStep } from './task-execution';

// ─── Module mocks — external services only ─────────────────

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
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
  getScreenshotsDir: vi.fn().mockReturnValue('/tmp/.hitl-data/test-wt/screenshots'),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
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
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readLatestSignal).mockReturnValue(null);
  vi.mocked(isWatching).mockReturnValue(false);
  vi.mocked(spawnSession).mockResolvedValue({
    sessionId: 'test-session-id',
    logDir: '/tmp/test-logs',
  });
});

afterAll(async () => {
  await teardownTestDb();
}, 10_000);

// ─── Tests ─────────────────────────────────────────────────

describe('runTaskExecutionStep (integration)', () => {
  it('spawns session for task with worktree but no session', async () => {
    await db.story.create({
      data: { id: 8001, title: 'Parent story', azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8001' },
    });
    await db.task.create({
      data: {
        id: 8010,
        title: 'Ready for execution',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8010',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: 'C:/repos/test-wt',
        sessionId: null,
        disabled: true,
        storyId: 8001,
      },
    });

    vi.mocked(spawnSession).mockResolvedValueOnce({
      sessionId: 'session-8010',
      logDir: '/tmp/logs-8010',
    });

    await runTaskExecutionStep();

    // Verify session was spawned
    expect(ensureGlobalHooks).toHaveBeenCalled();
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'C:/repos/test-wt',
        prompt: expect.stringContaining('Task #8010'),
      }),
    );

    // Verify DB was updated with session ID
    const task = await db.task.findUnique({ where: { id: 8010 } });
    expect(task!.sessionId).toBe('session-8010');

    // Verify watcher was started
    expect(watchSignals).toHaveBeenCalledWith('C:/repos/test-wt', 'task', 8010);
  });

  it('skips tasks without a worktree', async () => {
    await db.task.create({
      data: {
        id: 8011,
        title: 'No worktree',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8011',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: null,
        sessionId: null,
        disabled: true,
      },
    });

    await runTaskExecutionStep();

    expect(spawnSession).not.toHaveBeenCalled();
    const task = await db.task.findUnique({ where: { id: 8011 } });
    expect(task!.sessionId).toBeNull();
  });

  it('skips tasks that already have a session', async () => {
    await db.task.create({
      data: {
        id: 8012,
        title: 'Has session',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8012',
        state: GridState.COPILOT_KICKOFF,
        profileKey: 'integrate',
        worktreePath: 'C:/repos/test-wt',
        sessionId: 'existing-session',
        disabled: true,
      },
    });

    await runTaskExecutionStep();

    // spawnSession should not be called for main execution (might be called for recovery)
    // The task already has a session, so the main execution loop skips it
    const task = await db.task.findUnique({ where: { id: 8012 } });
    expect(task!.sessionId).toBe('existing-session');
  });

  it('recovers task with stale worktree (directory does not exist)', async () => {
    await db.task.create({
      data: {
        id: 8020,
        title: 'Stale worktree',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8020',
        state: GridState.COPILOT_KICKOFF,
        worktreePath: 'C:/nonexistent/path',
        sessionId: 'stale-session',
        disabled: true,
      },
    });

    vi.mocked(existsSync).mockReturnValue(false);

    await runTaskExecutionStep();

    // worktreePath and sessionId should be reset
    const task = await db.task.findUnique({ where: { id: 8020 } });
    expect(task!.worktreePath).toBeNull();
    expect(task!.sessionId).toBeNull();
  });

  it('recovers task when session-end signal is found', async () => {
    await db.task.create({
      data: {
        id: 8021,
        title: 'Session ended',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8021',
        state: GridState.COPILOT_KICKOFF,
        worktreePath: 'C:/repos/test-wt-ended',
        sessionId: 'ended-session',
        disabled: true,
      },
    });

    vi.mocked(readLatestSignal).mockReturnValue({
      signal: SIGNAL_FILES.SESSION_END,
      timestamp: Date.now(),
    } as any);

    await runTaskExecutionStep();

    // disabled should be set to false (ready for review) and state moved to TASK_EXECUTION
    const task = await db.task.findUnique({ where: { id: 8021 } });
    expect(task!.disabled).toBe(false);
    expect(task!.state).toBe(GridState.TASK_EXECUTION);
    expect(task!.sessionId).toBe('ended-session'); // session ID preserved
  });

  it('recovers task when session-idle signal is found', async () => {
    await db.task.create({
      data: {
        id: 8022,
        title: 'Session idle',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8022',
        state: GridState.COPILOT_KICKOFF,
        worktreePath: 'C:/repos/test-wt-idle',
        sessionId: 'idle-session',
        disabled: true,
      },
    });

    vi.mocked(readLatestSignal).mockReturnValue({
      signal: SIGNAL_FILES.SESSION_IDLE,
      timestamp: Date.now(),
    } as any);

    await runTaskExecutionStep();

    const task = await db.task.findUnique({ where: { id: 8022 } });
    expect(task!.disabled).toBe(false);
    expect(task!.state).toBe(GridState.TASK_EXECUTION);
  });

  it('resets sessionId when log directory does not exist, then re-spawns', async () => {
    await db.task.create({
      data: {
        id: 8023,
        title: 'No log dir',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8023',
        state: GridState.COPILOT_KICKOFF,
        worktreePath: 'C:/repos/test-wt-nologs',
        sessionId: 'dead-session',
        disabled: true,
      },
    });

    // existsSync: true for worktree, false for log dir
    vi.mocked(existsSync)
      .mockReturnValueOnce(true) // worktree exists (recovery step 1)
      .mockReturnValueOnce(false); // log dir doesn't exist (recovery step 2)

    vi.mocked(spawnSession).mockResolvedValueOnce({
      sessionId: 'respawned-session',
      logDir: '/tmp/respawned',
    });

    await runTaskExecutionStep();

    // After recovery clears sessionId, the main loop picks up the task
    // and spawns a new session (worktreePath still set, sessionId null, disabled true)
    const task = await db.task.findUnique({ where: { id: 8023 } });
    expect(task!.sessionId).toBe('respawned-session');
    expect(task!.worktreePath).toBe('C:/repos/test-wt-nologs'); // worktree preserved
  });

  it('processes multiple tasks — spawns sessions for each', async () => {
    await db.task.create({
      data: {
        id: 8030,
        title: 'Task A',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8030',
        state: GridState.COPILOT_KICKOFF,
        worktreePath: 'C:/repos/wt-a',
        sessionId: null,
        disabled: true,
      },
    });
    await db.task.create({
      data: {
        id: 8031,
        title: 'Task B',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8031',
        state: GridState.COPILOT_KICKOFF,
        worktreePath: 'C:/repos/wt-b',
        sessionId: null,
        disabled: true,
      },
    });

    vi.mocked(spawnSession)
      .mockResolvedValueOnce({ sessionId: 'session-a', logDir: '/tmp/a' })
      .mockResolvedValueOnce({ sessionId: 'session-b', logDir: '/tmp/b' });

    await runTaskExecutionStep();

    expect(spawnSession).toHaveBeenCalledTimes(2);

    const taskA = await db.task.findUnique({ where: { id: 8030 } });
    const taskB = await db.task.findUnique({ where: { id: 8031 } });
    expect(taskA!.sessionId).toBe('session-a');
    expect(taskB!.sessionId).toBe('session-b');
  });

  it('continues with other tasks when one spawn fails', async () => {
    await db.task.create({
      data: {
        id: 8040,
        title: 'Will fail',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8040',
        state: GridState.COPILOT_KICKOFF,
        worktreePath: 'C:/repos/wt-fail',
        sessionId: null,
        disabled: true,
      },
    });
    await db.task.create({
      data: {
        id: 8041,
        title: 'Will succeed',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8041',
        state: GridState.COPILOT_KICKOFF,
        worktreePath: 'C:/repos/wt-ok',
        sessionId: null,
        disabled: true,
      },
    });

    vi.mocked(spawnSession)
      .mockRejectedValueOnce(new Error('Copilot CLI not found'))
      .mockResolvedValueOnce({ sessionId: 'session-ok', logDir: '/tmp/ok' });

    await runTaskExecutionStep();

    const failedTask = await db.task.findUnique({ where: { id: 8040 } });
    const okTask = await db.task.findUnique({ where: { id: 8041 } });
    expect(failedTask!.sessionId).toBeNull();
    expect(okTask!.sessionId).toBe('session-ok');
  });
});

describe('resumeTaskWatchers (integration)', () => {
  it('resumes watchers for tasks with active sessions', async () => {
    await db.task.create({
      data: {
        id: 8050,
        title: 'Active session',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8050',
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/wt-active',
        sessionId: 'active-session',
        disabled: true,
      },
    });

    vi.mocked(isWatching).mockReturnValue(false);

    await resumeTaskWatchers();

    expect(watchSignals).toHaveBeenCalledWith('C:/repos/wt-active', 'task', 8050);
  });

  it('does not resume watcher if already watching', async () => {
    await db.task.create({
      data: {
        id: 8051,
        title: 'Already watching',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8051',
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/wt-watched',
        sessionId: 'watched-session',
        disabled: true,
      },
    });

    vi.mocked(isWatching).mockReturnValue(true);

    await resumeTaskWatchers();

    expect(watchSignals).not.toHaveBeenCalled();
  });

  it('skips tasks without a session', async () => {
    await db.task.create({
      data: {
        id: 8052,
        title: 'No session',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/8052',
        state: GridState.TASK_EXECUTION,
        worktreePath: 'C:/repos/wt-nosession',
        sessionId: null,
        disabled: true,
      },
    });

    await resumeTaskWatchers();

    expect(watchSignals).not.toHaveBeenCalled();
  });
});
