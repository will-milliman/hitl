/**
 * Task execution step for the cron job.
 *
 * Finds tasks in COPILOT_KICKOFF state that have a worktree set up
 * but no copilot session yet. For each, it:
 * 1. Sets up hooks in the worktree
 * 2. Spawns a copilot CLI session with a task implementation prompt
 * 3. Saves the session ID to the database
 * 4. Starts watching for signal files (idle detection)
 *
 * Also handles recovery of interrupted flows:
 * - Worktree path points to a non-existent directory -> reset to null
 * - Session ended while app was off -> detect via signal, move to TASK_EXECUTION
 * - Session died without signaling -> detect stale sessions, reset sessionId
 *
 * This step is gated by the `taskExecutionEnabled` flag in CronState.
 */
import { existsSync } from 'fs';

import { GridState } from '../../shared/constants';
import { SIGNAL_FILES, ensureGlobalHooks, getLogDir, isWatching, readLatestSignal, spawnSession, watchSignals } from '../copilot';
import { getDb } from '../db';
import { createLogger } from '../logger';

import { recordTaskError } from './index';

const logger = createLogger('task-exec');

/**
 * The task execution prompt sent to Copilot CLI.
 *
 * Instructs the agent to implement the task as described.
 */
function buildTaskPrompt(taskId: number, taskTitle: string, storyTitle?: string): string {
  const storyContext = storyTitle ? `\nParent Story: ${storyTitle}\n` : '';
  const prompt = `You are implementing a development task.
${storyContext}
Task #${taskId}: ${taskTitle}

Your goal is to implement this task completely. Please:

1. Analyze the codebase to understand existing patterns and conventions.
2. Implement the changes described in this task.
3. Ensure your changes follow the existing code style and patterns.
4. Write or update tests if the project has a test suite.

IMPORTANT: Do NOT stage, commit, or push any changes. Do NOT create a pull request.
Leave all your changes as unstaged modifications in the working tree.
A human reviewer will validate your work before anything is committed.

Focus on quality and correctness. Ask for clarification if the task description is ambiguous.`;

  return prompt;
}

/**
 * Recovers tasks in COPILOT_KICKOFF that are stuck due to interrupted flows.
 *
 * Handles these scenarios:
 * 1. Worktree path set but directory doesn't exist -> reset worktreePath to null
 * 2. Session ended while app was off -> session-end signal exists, move to TASK_EXECUTION
 * 3. Session idle while app was off -> move to TASK_EXECUTION
 * 4. Session died without signaling -> no log directory, reset sessionId
 */
async function recoverInterruptedTasks(): Promise<void> {
  const db = getDb();

  // Scenario 1: Worktree path points to a non-existent directory
  const tasksWithWorktrees = await db.task.findMany({
    where: {
      state: GridState.COPILOT_KICKOFF,
      worktreePath: { not: null },
      disabled: true,
      removedFromSprint: false,
    },
  });

  for (const task of tasksWithWorktrees) {
    if (!existsSync(task.worktreePath!)) {
      logger.info(`Task #${task.id}: worktree at ${task.worktreePath} no longer exists, resetting`);
      await db.task.update({
        where: { id: task.id },
        data: { worktreePath: null, sessionId: null },
      });
    }
  }

  // Scenario 2 & 3: Tasks with a session that may have ended or died
  const tasksWithSessions = await db.task.findMany({
    where: {
      state: GridState.COPILOT_KICKOFF,
      sessionId: { not: null },
      worktreePath: { not: null },
      disabled: true,
      removedFromSprint: false,
    },
  });

  for (const task of tasksWithSessions) {
    const worktreePath = task.worktreePath!;

    const signal = readLatestSignal(worktreePath);

    if (signal?.signal === SIGNAL_FILES.SESSION_END) {
      logger.info(`Task #${task.id}: session ended while app was off, moving to TASK_EXECUTION`);
      await db.task.update({
        where: { id: task.id },
        data: { state: GridState.TASK_EXECUTION, disabled: false },
      });
      continue;
    }

    if (signal?.signal === SIGNAL_FILES.SESSION_IDLE) {
      logger.info(`Task #${task.id}: session idle while app was off, moving to TASK_EXECUTION`);
      await db.task.update({
        where: { id: task.id },
        data: { state: GridState.TASK_EXECUTION, disabled: false },
      });
      continue;
    }

    // Check if log directory exists
    const logDir = getLogDir(worktreePath);
    if (!existsSync(logDir)) {
      logger.info(`Task #${task.id}: no log directory found, resetting session`);
      await db.task.update({
        where: { id: task.id },
        data: { sessionId: null },
      });
      continue;
    }

    // If we have a session with an active signal, make sure the watcher is running
    if (!isWatching(worktreePath)) {
      watchSignals(worktreePath, 'task', task.id);
      logger.info(`Task #${task.id}: re-established watcher for active session`);
    }
  }
}

/**
 * Runs the task execution step: spawns copilot sessions for tasks
 * that are ready for implementation.
 */
export async function runTaskExecutionStep(): Promise<void> {
  const db = getDb();

  // First, recover any interrupted flows from previous app sessions
  await recoverInterruptedTasks();

  // Find tasks in COPILOT_KICKOFF with a worktree but no session
  const tasks = await db.task.findMany({
    where: {
      state: GridState.COPILOT_KICKOFF,
      worktreePath: { not: null },
      sessionId: null,
      disabled: true, // Should be disabled (agent will be working)
      skipCopilot: false, // Don't spawn copilot for tasks that opted out
      removedFromSprint: false,
    },
    include: {
      story: {
        select: { title: true },
      },
    },
  });

  if (tasks.length === 0) return;

  logger.info(`Found ${tasks.length} tasks ready for execution`);

  for (const task of tasks) {
    const worktreePath = task.worktreePath!;

    try {
      // Ensure global hooks are configured
      ensureGlobalHooks();

      // Spawn a copilot session
      logger.info(`Spawning execution session for task #${task.id} (model: ${task.model ?? 'default'})`);
      const { sessionId } = await spawnSession({
        cwd: worktreePath,
        prompt: buildTaskPrompt(task.id, task.title, task.story?.title),
        model: task.model ?? undefined,
      });

      // Save session ID to database
      await db.task.update({
        where: { id: task.id },
        data: { sessionId },
      });

      // Start watching for signal files
      if (!isWatching(worktreePath)) {
        watchSignals(worktreePath, 'task', task.id);
      }

      logger.info(`Task #${task.id} execution session: ${sessionId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to start execution for task #${task.id}: ${message}`);

      // Move the task to ERROR state so the cron doesn't retry every tick
      try {
        await db.task.update({
          where: { id: task.id },
          data: {
            state: GridState.ERROR,
            previousState: GridState.COPILOT_KICKOFF,
            disabled: false,
          },
        });
        await recordTaskError(task.id, message);
        logger.info(`Task #${task.id} moved to ERROR state`);
      } catch (updateErr) {
        logger.error(`Failed to move task #${task.id} to ERROR state`, {
          error: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      }
    }
  }
}

/**
 * Re-establishes watchers for tasks that have active sessions.
 *
 * Called on app startup to resume watching for signal files
 * from sessions that were spawned in a previous app session.
 */
export async function resumeTaskWatchers(): Promise<void> {
  const db = getDb();

  const tasksWithSessions = await db.task.findMany({
    where: {
      state: { in: [GridState.COPILOT_KICKOFF, GridState.TASK_EXECUTION] },
      sessionId: { not: null },
      worktreePath: { not: null },
      disabled: true,
      removedFromSprint: false,
    },
  });

  for (const task of tasksWithSessions) {
    if (!isWatching(task.worktreePath!)) {
      watchSignals(task.worktreePath!, 'task', task.id);
      logger.info(`Resumed watcher for task #${task.id}`);
    }
  }
}
