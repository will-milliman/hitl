/**
 * State reconciliation — checks all grid items against Azure DevOps
 * and moves them to their correct grids.
 *
 * Called on app startup and via the "Sync States" button in Settings.
 * Unlike the regular sync (which only processes items from the sprint query),
 * this checks every active task and story in the local DB.
 */
import { GridState } from '../../shared/constants';
import { getWorkItems, queryWiql } from '../azure';
import { getDb } from '../db';
import { createLogger } from '../logger';

import { getAzureConfig } from './config';

const logger = createLogger('state-reconciliation');

/**
 * Reconciles local grid states with Azure DevOps work item states.
 *
 * For each active task in the DB:
 * - Fetches its current Azure state
 * - Moves blocked tasks to BLOCKED grid
 * - Moves unblocked tasks back to PROFILE_ASSIGNMENT
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

  // ─── Reconcile Tasks ──────────────────────────────────
  // Get all tasks that are in active pipeline states (not COMPLETED/ABANDONED/NON_HITL)
  const activeTasks = await db.task.findMany({
    where: {
      state: { notIn: [GridState.COMPLETED, GridState.ABANDONED, GridState.NON_HITL, GridState.ERROR] },
      removedFromSprint: false,
    },
    select: { id: true, state: true },
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

  logger.info(`State reconciliation complete: ${tasksUpdated} tasks updated, ${storiesUpdated} stories updated`);
  return { tasksUpdated, storiesUpdated };
}
