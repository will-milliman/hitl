/**
 * Worktree setup step for the cron job.
 *
 * Finds tasks in COPILOT_KICKOFF state that have a profile assigned
 * but no worktree yet. For each, it first tries to reuse an idle
 * worktree (one that was parked by a completed task), and falls back
 * to creating a new worktree if none are available.
 *
 * If the profile has a setup config, the setup command is spawned
 * in the background (detached) after the worktree is ready.
 *
 * Task PRs target the default branch directly (no story branch hierarchy).
 */
import { spawn } from 'child_process';
import { join } from 'path';

import { GridState } from '../../shared/constants';
import { getDb } from '../db';
import { createLogger } from '../logger';
import { loadProfiles } from '../settings';
import { createWorktree, findIdleWorktree, repurposeWorktree } from '../worktree';

import { recordTaskError } from './index';

const logger = createLogger('worktree-setup');

/**
 * Spawns the profile's setup command in the background (detached + unref).
 * The cwd is resolved relative to the worktree root.
 * Failures are logged but never block the pipeline.
 */
function runSetupCommand(worktreePath: string, setup: { cwd: string; command: string }, taskId: number): void {
  const cwd = join(worktreePath, setup.cwd);
  logger.info(`Task #${taskId}: running setup command in background: "${setup.command}" (cwd: ${cwd})`);

  try {
    // Use `cmd /c start /b` to run the command in the background without
    // opening a visible console window. On Windows, `detached: true` with
    // `shell: true` creates a new console window regardless of windowsHide.
    // The `/b` flag on `start` prevents this.
    const child = spawn('cmd', ['/c', 'start', '/b', 'cmd', '/c', setup.command], {
      cwd,
      detached: false,
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Task #${taskId}: failed to spawn setup command: ${message}`);
  }
}

/**
 * Sets up worktrees for tasks that have been assigned a profile
 * and moved to COPILOT_KICKOFF but don't have a worktree yet.
 *
 * Called by the cron job when taskExecutionEnabled is true.
 */
export async function setupTaskWorktrees(): Promise<void> {
  const db = getDb();

  // Find tasks in COPILOT_KICKOFF with a profile but no worktree.
  // Include both automated (disabled=true) and manual (skipCopilot=true, disabled=false) tasks.
  const tasks = await db.task.findMany({
    where: {
      state: GridState.COPILOT_KICKOFF,
      profileKey: { not: null },
      worktreePath: null,
      OR: [
        { disabled: true }, // Automated tasks (agent will work on them)
        { skipCopilot: true }, // Manual execution tasks (user will work manually)
      ],
    },
  });

  if (tasks.length === 0) return;

  const profiles = loadProfiles();

  // Collect all worktree paths currently assigned to any task/story
  // so findIdleWorktree can skip them.
  const allTasks = await db.task.findMany({
    where: { worktreePath: { not: null } },
    select: { worktreePath: true },
  });
  const assignedPaths = new Set(allTasks.map((t) => t.worktreePath).filter((p): p is string => p !== null));

  for (const task of tasks) {
    const profileKey = task.profileKey!;
    const profile = profiles[profileKey];

    if (!profile) {
      logger.warn(`Task #${task.id}: profile "${profileKey}" not found in profile.json`);
      continue;
    }

    try {
      logger.info(`Setting up worktree for task #${task.id} (profile: ${profileKey})`);

      let worktreePath: string;

      // Try to reuse an idle worktree first
      const idle = await findIdleWorktree(profile.repoPath, assignedPaths);

      if (idle) {
        logger.info(`Task #${task.id}: reusing idle worktree at ${idle.path}`);
        try {
          worktreePath = await repurposeWorktree(idle.path, profile.repoPath, 'task', task.id, profile.defaultBranch, task.title);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Task #${task.id}: failed to repurpose idle worktree, creating new one: ${message}`);
          worktreePath = await createWorktree(profile.repoPath, 'task', task.id, profile.defaultBranch, undefined, task.title);
        }
      } else {
        // No idle worktrees — create a new one
        worktreePath = await createWorktree(profile.repoPath, 'task', task.id, profile.defaultBranch, undefined, task.title);
      }

      // Update the task with the worktree path.
      // For skipCopilot (manual execution) tasks, advance directly to TASK_EXECUTION
      // since no automated Copilot session will be spawned.
      await db.task.update({
        where: { id: task.id },
        data: {
          worktreePath,
          ...(task.skipCopilot ? { state: GridState.TASK_EXECUTION } : {}),
        },
      });

      // Track the newly assigned path so subsequent tasks don't pick the same one
      assignedPaths.add(worktreePath);

      // Run profile setup command in the background if configured
      if (profile.setup) {
        runSetupCommand(worktreePath, profile.setup, task.id);
      }

      logger.info(
        task.skipCopilot
          ? `Task #${task.id} worktree ready at ${worktreePath} (manual execution — moved to TASK_EXECUTION)`
          : `Task #${task.id} worktree ready at ${worktreePath}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to create worktree for task #${task.id}: ${message}`);

      // Move the task to ERROR state so the cron doesn't retry every tick.
      // The user can investigate and retry from the Error grid.
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
