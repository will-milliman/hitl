/**
 * State reconciliation — checks all grid items against Azure DevOps
 * and GitHub, and moves them to their correct grids.
 *
 * Called on every cron tick (gated by `syncEnabled`), on app startup,
 * and via the "Sync States" button in Settings.
 *
 * Unlike the regular sync (which only processes items from the sprint query),
 * this checks every active task and story in the local DB:
 *
 * 1. **Azure blocked/unblocked**: Moves tasks to/from BLOCKED grid
 * 2. **Azure Closed/Resolved**: Moves tasks whose Azure state is
 *    Closed or Resolved to COMPLETED
 * 3. **PR draft → ready**: Moves TASK_EXECUTION tasks with a non-draft PR
 *    to PR_REVIEW
 * 4. **PR merged/closed**: Moves PR_REVIEW tasks to COMPLETED or ABANDONED
 * 5. **Story blocked state**: Syncs story blocked flag with Azure
 * 6. **Virtual desktop sync**: Checks actual desktop state against DB
 *    (marks desktops closed if gone, marks open if detected by name)
 *
 * This ensures tasks land on the correct grid every minute, regardless
 * of whether the event-based mechanisms (signal watcher, webhooks) fired.
 */
import { GridState } from '../../shared/constants';
import { getWorkItems, queryWiql } from '../azure';
import { getDb } from '../db';
import { getPullRequestByUrl, isGhAuthenticated } from '../github';
import { createLogger } from '../logger';
import { notifyTaskCompleted } from '../notifications';
import { loadProfiles } from '../settings';
import { listDesktopNames } from '../virtual-desktop';

import { getAzureConfig } from './config';
import { cleanupCompletedTask } from './pr-check';

const logger = createLogger('state-reconciliation');

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
 * Reconciles local grid states with Azure DevOps work item states
 * and GitHub PR states.
 *
 * For each active task in the DB:
 * - Fetches its current Azure state
 * - Moves blocked tasks to BLOCKED grid
 * - Moves unblocked tasks back to PROFILE_ASSIGNMENT
 * - Moves tasks with Azure state Closed/Resolved to COMPLETED
 * - Moves TASK_EXECUTION tasks with a non-draft PR to PR_REVIEW
 * - Moves PR_REVIEW tasks with a merged PR to COMPLETED
 * - Moves PR_REVIEW tasks with a closed PR to ABANDONED
 *
 * For each unplanned story:
 * - Checks Azure state for blocked status
 *
 * Returns a summary of changes made.
 */
export async function reconcileStates(): Promise<{ tasksUpdated: number; storiesUpdated: number }> {
  const config = getAzureConfig();
  if (!config) {
    logger.info('Azure DevOps not configured, skipping state reconciliation');
    return { tasksUpdated: 0, storiesUpdated: 0 };
  }

  const db = getDb();
  let tasksUpdated = 0;
  let storiesUpdated = 0;

  // ─── Reconcile Tasks Against Azure ────────────────────
  // Get all tasks that are in active pipeline states (not COMPLETED/ABANDONED/NON_HITL)
  const activeTasks = await db.task.findMany({
    where: {
      state: { notIn: [GridState.COMPLETED, GridState.ABANDONED, GridState.NON_HITL, GridState.ERROR] },
      removedFromSprint: false,
    },
    select: { id: true, state: true, prUrl: true, prMerged: true, worktreePath: true, profileKey: true },
  });

  if (activeTasks.length > 0) {
    const taskIds = activeTasks.map((t) => t.id);

    // Build a WIQL query to check the current Azure state of these tasks
    const idList = taskIds.join(',');
    const wiql = `
      SELECT [System.Id], [System.State]
      FROM WorkItems
      WHERE [System.Id] IN (${idList})
    `.trim();

    const wiqlResult = await queryWiql(config, wiql);
    const azureTaskIds = wiqlResult.workItems.map((wi) => wi.id);

    if (azureTaskIds.length > 0) {
      const azureTasks = await getWorkItems(config, azureTaskIds, ['System.Id', 'System.State']);

      const azureStateMap = new Map<number, string>();
      for (const wi of azureTasks) {
        azureStateMap.set(wi.fields['System.Id'], wi.fields['System.State']);
      }

      for (const task of activeTasks) {
        const azureState = azureStateMap.get(task.id);
        if (!azureState) continue;

        const isBlocked = azureState === 'Blocked';
        const isClosed = azureState === 'Closed' || azureState === 'Resolved';

        // Azure Closed/Resolved → COMPLETED (takes priority over other checks)
        if (isClosed && task.state !== GridState.COMPLETED) {
          await db.task.update({
            where: { id: task.id },
            data: { state: GridState.COMPLETED, disabled: true, completedAt: new Date() },
          });
          logger.info(`Reconciliation: Task #${task.id} moved to COMPLETED (Azure: ${azureState})`);
          notifyTaskCompleted(task.id, '');
          // Clean up resources
          try {
            await cleanupCompletedTask(task.id, task.worktreePath);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.debug(`Reconciliation: Task #${task.id} cleanup after Azure-close failed: ${msg}`);
          }
          tasksUpdated++;
          continue;
        }

        if (isBlocked && task.state !== GridState.BLOCKED) {
          await db.task.update({
            where: { id: task.id },
            data: { state: GridState.BLOCKED, disabled: false },
          });
          logger.info(`Reconciliation: Task #${task.id} moved to BLOCKED (Azure: ${azureState})`);
          tasksUpdated++;
        } else if (!isBlocked && task.state === GridState.BLOCKED) {
          await db.task.update({
            where: { id: task.id },
            data: { state: GridState.PROFILE_ASSIGNMENT, disabled: false },
          });
          logger.info(`Reconciliation: Task #${task.id} unblocked, moved to PROFILE_ASSIGNMENT`);
          tasksUpdated++;
        }
      }
    }
  }

  // ─── Reconcile Tasks Against GitHub PRs ───────────────
  // Check tasks in TASK_EXECUTION/PR_REVIEW that have PRs and verify
  // they are in the correct grid based on the actual PR state.
  const ghAuthenticated = await isGhAuthenticated();

  if (ghAuthenticated) {
    // Re-fetch active tasks with PR URLs (some may have been updated above)
    const tasksWithPrs = await db.task.findMany({
      where: {
        state: { in: [GridState.TASK_EXECUTION, GridState.PR_REVIEW] },
        prUrl: { not: null },
        removedFromSprint: false,
      },
      select: {
        id: true,
        state: true,
        title: true,
        prUrl: true,
        prMerged: true,
        worktreePath: true,
        profileKey: true,
      },
    });

    for (const task of tasksWithPrs) {
      try {
        const cwd = resolveGhCwd(task);
        if (!cwd) continue;

        const pr = await getPullRequestByUrl(task.prUrl!, cwd);

        // TASK_EXECUTION + non-draft PR → PR_REVIEW
        if (task.state === GridState.TASK_EXECUTION && !pr.isDraft && pr.state === 'OPEN') {
          await db.task.update({
            where: { id: task.id },
            data: { state: GridState.PR_REVIEW },
          });
          logger.info(`Reconciliation: Task #${task.id} PR is no longer a draft — moved to PR_REVIEW`);
          tasksUpdated++;
          continue;
        }

        // PR_REVIEW + merged PR → COMPLETED
        if (task.state === GridState.PR_REVIEW && pr.state === 'MERGED' && !task.prMerged) {
          await db.task.update({
            where: { id: task.id },
            data: {
              state: GridState.COMPLETED,
              prMerged: true,
              disabled: true,
              completedAt: new Date(),
            },
          });
          logger.info(`Reconciliation: Task #${task.id} PR merged — moved to COMPLETED`);
          notifyTaskCompleted(task.id, task.title);
          try {
            await cleanupCompletedTask(task.id, task.worktreePath);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.debug(`Reconciliation: Task #${task.id} cleanup after merge failed: ${msg}`);
          }
          tasksUpdated++;
          continue;
        }

        // PR_REVIEW + closed PR (not merged) → ABANDONED
        if (task.state === GridState.PR_REVIEW && pr.state === 'CLOSED') {
          await db.task.update({
            where: { id: task.id },
            data: { state: GridState.ABANDONED, disabled: true },
          });
          logger.info(`Reconciliation: Task #${task.id} PR closed — moved to ABANDONED`);
          try {
            await cleanupCompletedTask(task.id, task.worktreePath);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.debug(`Reconciliation: Task #${task.id} cleanup after close failed: ${msg}`);
          }
          tasksUpdated++;
          continue;
        }

        // PR_REVIEW + draft PR → back to TASK_EXECUTION
        if (task.state === GridState.PR_REVIEW && pr.isDraft) {
          await db.task.update({
            where: { id: task.id },
            data: { state: GridState.TASK_EXECUTION, disabled: false },
          });
          logger.info(`Reconciliation: Task #${task.id} PR converted to draft — moved to TASK_EXECUTION`);
          tasksUpdated++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Reconciliation: Failed to check PR for task #${task.id}: ${message}`);
      }
    }
  }

  // ─── Reconcile Stories ────────────────────────────────
  const stories = await db.story.findMany({
    select: { id: true, blocked: true },
  });

  if (stories.length > 0) {
    const storyIds = stories.map((s) => s.id);
    const idList = storyIds.join(',');
    const wiql = `
      SELECT [System.Id], [System.State]
      FROM WorkItems
      WHERE [System.Id] IN (${idList})
    `.trim();

    const wiqlResult = await queryWiql(config, wiql);
    const azureStoryIds = wiqlResult.workItems.map((wi) => wi.id);

    if (azureStoryIds.length > 0) {
      const azureStories = await getWorkItems(config, azureStoryIds, ['System.Id', 'System.State']);

      const azureStateMap = new Map<number, string>();
      for (const wi of azureStories) {
        azureStateMap.set(wi.fields['System.Id'], wi.fields['System.State']);
      }

      for (const story of stories) {
        const azureState = azureStateMap.get(story.id);
        if (!azureState) continue;

        const isBlocked = azureState === 'Blocked';

        if (isBlocked !== story.blocked) {
          await db.story.update({
            where: { id: story.id },
            data: { blocked: isBlocked },
          });
          logger.info(`Reconciliation: Story #${story.id} ${isBlocked ? 'moved to BLOCKED' : 'unblocked'}`);
          storiesUpdated++;
        }
      }
    }
  }

  // ─── Sync Virtual Desktop State ────────────────────────
  // Check all open virtual desktop names and reconcile with DB state.
  // Tasks that think their desktop is open but it's gone → mark closed.
  // Tasks that think their desktop is closed but it exists → mark open.
  try {
    const result = await listDesktopNames();

    if (!result.ok) {
      logger.debug('Reconciliation: Virtual desktop list unavailable — skipping desktop sync');
    } else {
      const desktopNames = result.names;
      const desktopNameSet = new Set(desktopNames);

      // Tasks that believe they have an open desktop
      const tasksWithOpenDesktop = await db.task.findMany({
        where: { desktopOpen: true, removedFromSprint: false },
        select: { id: true, desktopName: true },
      });

      for (const task of tasksWithOpenDesktop) {
        if (task.desktopName && !desktopNameSet.has(task.desktopName)) {
          // Desktop no longer exists — mark as closed
          await db.task.update({
            where: { id: task.id },
            data: { desktopOpen: false, desktopName: null },
          });
          logger.info(`Reconciliation: Task #${task.id} desktop "${task.desktopName}" no longer exists — marked closed`);
          tasksUpdated++;
        }
      }

      // Tasks that believe they DON'T have an open desktop but one exists
      // Match by checking if any desktop name ends with -<taskId>
      if (desktopNames.length > 0) {
        const tasksWithClosedDesktop = await db.task.findMany({
          where: {
            desktopOpen: false,
            state: { in: [GridState.TASK_EXECUTION, GridState.PR_REVIEW, GridState.COPILOT_KICKOFF] },
            removedFromSprint: false,
          },
          select: { id: true, desktopName: true },
        });

        for (const task of tasksWithClosedDesktop) {
          // Check if any desktop name contains this task's ID as a suffix (e.g. "feature-12345")
          const taskIdStr = String(task.id);
          const matchingDesktop = desktopNames.find((name) => name === task.desktopName || name.endsWith(`-${taskIdStr}`));

          if (matchingDesktop) {
            await db.task.update({
              where: { id: task.id },
              data: { desktopOpen: true, desktopName: matchingDesktop },
            });
            logger.info(`Reconciliation: Task #${task.id} has open desktop "${matchingDesktop}" — marked open`);
            tasksUpdated++;
          }
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`Reconciliation: Virtual desktop sync failed: ${message}`);
  }

  logger.info(`State reconciliation complete: ${tasksUpdated} tasks updated, ${storiesUpdated} stories updated`);
  return { tasksUpdated, storiesUpdated };
}
