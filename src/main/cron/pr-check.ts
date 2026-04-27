/**
 * Task PR check cron step.
 *
 * Runs on each cron tick (gated by `prCheckEnabled` flag). Handles:
 *
 * 1. **PR Discovery**: For tasks in TASK_EXECUTION that don't have a prUrl yet,
 *    searches GitHub for a PR matching the task's branch name. If found,
 *    populates prUrl so subsequent steps can track it.
 *
 * 2. **Draft → Ready Detection**: For tasks in TASK_EXECUTION that have
 *    a prUrl, checks if the PR is open and not a draft. If so, moves the
 *    task to PR_REVIEW.
 *
 * 3. **PR Readiness**: For tasks in PR_REVIEW, checks if the PR is ready
 *    to merge (all checks pass, reviews approved).
 *
 * 4. **PR Merge/Close Detection + Cleanup**: For tasks in PR_REVIEW with a PR,
 *    checks if the PR has been merged or closed. If merged, moves the task to
 *    COMPLETED. If closed (without merge), moves the task to ABANDONED.
 *    In both cases, cleans up resources:
 *    - Detaches the git branch so the worktree can be reused
 *    - Parks the worktree (clears DB fields so it can be reused)
 *    - Closes all windows on the task's virtual desktop and removes it
 *
 * HITL never creates PRs — that is done externally by the developer.
 *
 * All GitHub operations use the `gh` CLI (authenticated via `gh auth login`).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { GridState } from '../../shared/constants';
import { getDb } from '../db';
import { findPullRequest, getPullRequestByUrl, isGhAuthenticated, isPrReadyToMerge } from '../github';
import { createLogger } from '../logger';
import { notifyTaskCompleted } from '../notifications';
import { loadProfiles } from '../settings';
import { closeDesktop } from '../virtual-desktop';
import { getCurrentBranch } from '../worktree';

const logger = createLogger('pr-check');
const execFileAsync = promisify(execFile);

/**
 * Resolves a working directory for `gh` CLI calls.
 * Prefers the task's worktree path; falls back to the profile's repoPath.
 */
function resolveGhCwd(task: { worktreePath: string | null; profileKey: string | null }): string | null {
  if (task.worktreePath) return task.worktreePath;
  if (task.profileKey) {
    const profile = loadProfiles()[task.profileKey];
    if (profile?.repoPath) return profile.repoPath;
  }
  return null;
}

/**
 * Discover PRs for tasks that don't have one linked yet.
 *
 * For tasks in TASK_EXECUTION (or COPILOT_KICKOFF) with a worktree but
 * no prUrl, gets the current branch name and searches GitHub for a PR
 * matching that branch. If found, saves the PR URL to the task so that
 * subsequent steps (draft→ready, merge/close) can track it.
 */
async function discoverTaskPRs(): Promise<void> {
  const db = getDb();

  const tasks = await db.task.findMany({
    where: {
      state: { in: [GridState.TASK_EXECUTION, GridState.COPILOT_KICKOFF] },
      prUrl: null,
      worktreePath: { not: null },
      removedFromSprint: false,
    },
  });

  if (tasks.length === 0) return;

  logger.info(`Scanning for PRs on ${tasks.length} tasks without a linked PR`);

  const profiles = loadProfiles();

  for (const task of tasks) {
    try {
      const cwd = resolveGhCwd(task);
      if (!cwd) continue;

      // Get the current branch name in the worktree
      const branch = await getCurrentBranch(task.worktreePath!);
      if (!branch) continue;

      // Determine the base branch from the profile's defaultBranch
      const profile = task.profileKey ? profiles[task.profileKey] : null;
      const baseBranch = profile?.defaultBranch ?? 'main';

      // Search GitHub for a PR from this branch
      const pr = await findPullRequest(cwd, branch, baseBranch);

      if (pr) {
        logger.info(`Task #${task.id}: discovered PR #${pr.number} (${pr.url}) from branch ${branch}`);
        await db.task.update({
          where: { id: task.id },
          data: { prUrl: pr.url },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to discover PR for task #${task.id}: ${message}`);
    }
  }
}

/**
 * Check if tasks with a PR should move to PR_REVIEW.
 *
 * For tasks in TASK_EXECUTION that have a prUrl, checks whether the
 * PR is open and not a draft. If so, moves the task to PR_REVIEW.
 */
async function checkDraftToReady(): Promise<void> {
  const db = getDb();

  const tasks = await db.task.findMany({
    where: {
      state: GridState.TASK_EXECUTION,
      prUrl: { not: null },
      removedFromSprint: false,
    },
  });

  if (tasks.length === 0) return;

  logger.info(`Checking draft status for ${tasks.length} task PRs`);

  for (const task of tasks) {
    try {
      const prUrl = task.prUrl!;
      const cwd = resolveGhCwd(task);

      if (!cwd) {
        logger.warn(`Task #${task.id}: no worktreePath or profileKey — skipping draft check`);
        continue;
      }

      const pr = await getPullRequestByUrl(prUrl, cwd);

      if (!pr.isDraft && pr.state === 'OPEN') {
        logger.info(`Task #${task.id} PR is open and not a draft — moving to PR_REVIEW`);

        await db.task.update({
          where: { id: task.id },
          data: { state: GridState.PR_REVIEW },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to check draft status for task #${task.id}: ${message}`);
    }
  }
}

/**
 * Closes all windows on a task's virtual desktop and removes the desktop.
 *
 * @param desktopName The name of the desktop to close. If null/undefined,
 *                    this is a no-op (no desktop was opened for this task).
 */
async function closeVirtualDesktop(desktopName: string | null | undefined): Promise<void> {
  if (!desktopName) return;

  const result = await closeDesktop(desktopName, { hardFail: false });
  if (!result.success) {
    logger.debug(`Virtual desktop "${desktopName}" close result: ${result.error}`);
  }
}

/**
 * Cleans up resources for a completed task.
 *
 * 1. Detaches the git branch in the worktree (git checkout --detach) so the
 *    old task branch doesn't prevent the worktree from being reused.
 * 2. Parks the worktree by clearing worktreePath and sessionId in the DB.
 *    The worktree directory stays on disk so it can be reused by future tasks
 *    via findIdleWorktree().
 * 3. Closes the virtual desktop (and all windows on it) that was opened
 *    for this task, if one exists.
 *
 * Cleanup failures are logged but never block the COMPLETED transition —
 * the state change has already been committed before this is called.
 */
export async function cleanupCompletedTask(taskId: number, worktreePath: string | null): Promise<void> {
  const db = getDb();

  // Read the desktop name BEFORE clearing DB fields (the close function needs it)
  let desktopName: string | null = null;
  try {
    const task = await db.task.findUnique({ where: { id: taskId }, select: { desktopName: true } });
    desktopName = task?.desktopName ?? null;
  } catch {
    // Best-effort — if we can't read, we'll skip desktop close
  }

  // Detach the git branch so the worktree can be reused with a new branch.
  // Must happen before clearing the DB fields (we need worktreePath).
  if (worktreePath) {
    try {
      await execFileAsync('git', ['checkout', '--detach'], {
        cwd: worktreePath,
        timeout: 15_000,
        windowsHide: true,
      });
      logger.info(`Task #${taskId}: branch detached in worktree`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Task #${taskId}: failed to detach branch: ${message}`);
    }
  }

  // Park the worktree — clear DB fields so it's available for reuse
  try {
    await db.task.update({
      where: { id: taskId },
      data: { worktreePath: null, sessionId: null, desktopOpen: false, desktopName: null },
    });
    logger.info(`Task #${taskId}: worktree parked (detached from task)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Task #${taskId}: failed to park worktree: ${message}`);
  }

  // Close virtual desktop and its windows (using name saved before DB clear)
  try {
    await closeVirtualDesktop(desktopName);
    if (desktopName) {
      logger.info(`Task #${taskId}: virtual desktop closed`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // This is expected when no virtual desktop was opened for the task
    logger.debug(`Task #${taskId}: virtual desktop cleanup skipped: ${message}`);
  }
}

/**
 * Step 3: Update disabled state on PR_REVIEW tasks based on merge readiness.
 *
 * For tasks in PR_REVIEW with a PR, checks whether the PR is ready to
 * merge (all checks pass, reviews approved). Tasks are disabled when
 * the PR is NOT ready to merge yet, and enabled when it IS ready.
 */
async function updatePrReadiness(): Promise<void> {
  const db = getDb();

  const tasks = await db.task.findMany({
    where: {
      state: GridState.PR_REVIEW,
      prUrl: { not: null },
      prMerged: false,
      removedFromSprint: false,
    },
  });

  if (tasks.length === 0) return;

  for (const task of tasks) {
    try {
      const prUrl = task.prUrl!;
      const cwd = resolveGhCwd(task);

      if (!cwd) {
        logger.warn(`Task #${task.id}: no worktreePath or profileKey — skipping PR readiness check`);
        continue;
      }

      const pr = await getPullRequestByUrl(prUrl, cwd);

      // Skip merged/closed PRs (handled by checkTaskPRMerges)
      if (pr.state === 'MERGED' || pr.state === 'CLOSED') continue;

      // If the PR has been converted back to a draft, move the task
      // back to TASK_EXECUTION so the developer can continue iterating.
      if (pr.isDraft) {
        logger.info(`Task #${task.id} PR has been converted back to draft — moving to TASK_EXECUTION`);
        await db.task.update({
          where: { id: task.id },
          data: { state: GridState.TASK_EXECUTION, disabled: false },
        });
        continue;
      }

      const ready = isPrReadyToMerge(pr);
      const shouldBeDisabled = !ready;

      // Only update if the disabled state needs to change
      if (task.disabled !== shouldBeDisabled) {
        logger.info(
          `Task #${task.id} PR ${ready ? 'is ready to merge' : 'is not ready to merge'} — ${shouldBeDisabled ? 'disabling' : 'enabling'}`,
        );
        await db.task.update({
          where: { id: task.id },
          data: { disabled: shouldBeDisabled },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to check PR readiness for task #${task.id}: ${message}`);
    }
  }
}

/**
 * Step 4: Check for merged or closed task PRs.
 *
 * For tasks with a PR, checks if the PR has been merged or closed.
 * If merged: moves the task to COMPLETED state.
 * If closed (without merge): moves the task to ABANDONED state.
 */
async function checkTaskPRMerges(): Promise<void> {
  const db = getDb();

  const tasks = await db.task.findMany({
    where: {
      state: GridState.PR_REVIEW,
      prUrl: { not: null },
      prMerged: false,
      removedFromSprint: false,
    },
  });

  if (tasks.length === 0) return;

  logger.info(`Checking merge status for ${tasks.length} task PRs`);

  for (const task of tasks) {
    try {
      const prUrl = task.prUrl!;
      const cwd = resolveGhCwd(task);

      if (!cwd) {
        logger.warn(`Task #${task.id}: no worktreePath or profileKey — skipping merge check`);
        continue;
      }

      // Get the PR state via gh pr view
      const pr = await getPullRequestByUrl(prUrl, cwd);

      if (pr.state === 'MERGED') {
        logger.info(`Task #${task.id} PR has been merged — moving to COMPLETED`);

        await db.task.update({
          where: { id: task.id },
          data: {
            state: GridState.COMPLETED,
            prMerged: true,
            disabled: true,
            completedAt: new Date(),
          },
        });

        notifyTaskCompleted(task.id, task.title);

        // Clean up resources (detach branch, park worktree, close virtual desktop)
        // Runs after the state transition is committed — failures won't
        // prevent the task from being marked as completed.
        await cleanupCompletedTask(task.id, task.worktreePath);
      } else if (pr.state === 'CLOSED') {
        logger.info(`Task #${task.id} PR has been closed — moving to ABANDONED`);

        await db.task.update({
          where: { id: task.id },
          data: {
            state: GridState.ABANDONED,
            disabled: true,
          },
        });

        // Clean up resources (detach branch, park worktree, close virtual desktop)
        await cleanupCompletedTask(task.id, task.worktreePath);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to check merge for task #${task.id}: ${message}`);
    }
  }
}

/**
 * Main entry point: runs all task PR check sub-steps.
 */
export async function runPrCheckStep(): Promise<void> {
  // Check gh CLI auth before doing anything
  const authenticated = await isGhAuthenticated();
  if (!authenticated) {
    logger.info('gh CLI not authenticated, skipping PR check step');
    return;
  }

  await discoverTaskPRs();
  await checkDraftToReady();
  await updatePrReadiness();
  await checkTaskPRMerges();
}
