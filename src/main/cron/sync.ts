/**
 * Azure DevOps work item sync.
 *
 * Queries Azure DevOps for stories, tasks and bugs in the current sprint
 * assigned to the current user, then upserts them into the local database.
 *
 * Strategy:
 * 1a. Query for all tasks/bugs in the current sprint (state: New or Active) assigned to @Me
 * 1b. Query for all user stories in the current sprint assigned to @Me (for Story Planning)
 * 2a. Upsert stories from sprint query (unplanned by default → Story Planning grid)
 * 2b. Fetch full task details
 * 3. Collect parent story IDs from tasks
 * 4. Fetch parent stories for context (lightweight)
 * 5. Upsert parent stories as lightweight references
 * 6. Upsert tasks into the DB — new tasks start in PROFILE_ASSIGNMENT
 * 7. Handle blocked tasks (Azure state = Blocked)
 * 8. Remove active tasks that no longer appear in the sprint query
 * 9. Remove completed/abandoned tasks that were deleted from Azure
 * 10. Remove stories no longer in the sprint (unless they have child tasks)
 */
import { GridState } from '../../shared/constants';
import { type WorkItem, buildSprintStoriesQuery, buildSprintTasksQuery, getWorkItems, queryWiql, workItemUrl } from '../azure';
import { getDb } from '../db';
import { createLogger } from '../logger';

import { getAzureConfig } from './config';

const logger = createLogger('sync');

/** Fields we need from the work items API */
const STORY_FIELDS = ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State'];

const TASK_FIELDS = ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.Parent'];

/**
 * Runs the full Azure DevOps sync cycle.
 * This is called by the cron job when syncEnabled is true.
 */
export async function syncWorkItems(): Promise<void> {
  const config = getAzureConfig();
  if (!config) {
    logger.info('Azure DevOps not configured, skipping sync');
    return;
  }

  const db = getDb();

  // 1. Query for tasks/bugs in current sprint
  const taskQuery = buildSprintTasksQuery();
  const taskWiqlResult = await queryWiql(config, taskQuery);
  const taskIds = taskWiqlResult.workItems.map((wi) => wi.id);

  logger.info(`Found ${taskIds.length} tasks/bugs in current sprint`);

  // Build a set of Azure task IDs for deletion detection
  const azureTaskIdSet = new Set(taskIds);

  // 1b. Query for user stories in current sprint (for Story Planning)
  const storyQuery = buildSprintStoriesQuery();
  const storyWiqlResult = await queryWiql(config, storyQuery);
  const storyIds = storyWiqlResult.workItems.map((wi) => wi.id);

  logger.info(`Found ${storyIds.length} user stories in current sprint`);

  // Build a set of Azure story IDs for deletion detection
  const azureStoryIdSet = new Set(storyIds);

  // 2a. Fetch full story details (for Story Planning grid)
  let sprintStories: WorkItem[] = [];
  if (storyIds.length > 0) {
    sprintStories = await getWorkItems(config, storyIds, STORY_FIELDS);
  }

  // 2b. Upsert stories from sprint query (these go into Story Planning grid)
  for (const story of sprintStories) {
    const id = story.fields['System.Id'];
    const title = story.fields['System.Title'];
    const azureState = story.fields['System.State'];
    const azureUrl = workItemUrl(config.org, config.project, id);
    const isBlocked = azureState === 'Blocked';

    const existing = await db.story.findUnique({ where: { id } });

    if (existing) {
      // Update title/azureUrl/blocked — don't overwrite planned flag
      await db.story.upsert({
        where: { id },
        create: { id, title, azureUrl, blocked: isBlocked },
        update: { title, azureUrl, blocked: isBlocked },
      });

      if (isBlocked && !existing.blocked) {
        logger.info(`Story #${id} moved to BLOCKED (Azure state: ${azureState})`);
      } else if (!isBlocked && existing.blocked) {
        logger.info(`Story #${id} unblocked, returning to Story Planning`);
      }
    } else {
      // New story — starts unplanned (shows in Story Planning grid unless blocked)
      await db.story.create({
        data: { id, title, azureUrl, planned: false, blocked: isBlocked },
      });
      logger.info(`New story: #${id} "${title}" (${isBlocked ? 'blocked' : 'unplanned'})`);
    }
  }

  // 2. Fetch full task details (if any)
  let tasks: WorkItem[] = [];
  if (taskIds.length > 0) {
    tasks = await getWorkItems(config, taskIds, TASK_FIELDS);
  }

  // 3. Collect parent story IDs from tasks
  const parentStoryIds = new Set<number>();
  for (const task of tasks) {
    const parentId = task.fields['System.Parent'];
    if (typeof parentId === 'number') {
      parentStoryIds.add(parentId);
    }
  }

  // 4. Fetch parent stories for context
  let parentStories: WorkItem[] = [];
  if (parentStoryIds.size > 0) {
    parentStories = await getWorkItems(config, [...parentStoryIds], STORY_FIELDS);
    logger.info(`Fetched ${parentStories.length} parent stories`);
  }

  // 5. Upsert stories as lightweight references (parent stories of tasks that weren't in sprint query)
  for (const story of parentStories) {
    const id = story.fields['System.Id'];
    const title = story.fields['System.Title'];
    const azureUrl = workItemUrl(config.org, config.project, id);

    await db.story.upsert({
      where: { id },
      create: { id, title, azureUrl, planned: true }, // Parent-only stories default to planned
      update: { title, azureUrl }, // Don't overwrite planned flag
    });
  }

  // 6. Upsert tasks
  for (const task of tasks) {
    const id = task.fields['System.Id'];
    const title = task.fields['System.Title'];
    const workItemType = task.fields['System.WorkItemType'];
    const parentId = task.fields['System.Parent'];
    const azureState = task.fields['System.State'];
    const azureUrl = workItemUrl(config.org, config.project, id);
    const isBlocked = azureState === 'Blocked';

    const existing = await db.task.findUnique({ where: { id } });

    if (existing) {
      if (isBlocked && existing.state !== GridState.BLOCKED) {
        // Task became blocked in Azure — move it to BLOCKED grid
        await db.task.update({
          where: { id },
          data: {
            title,
            workItemType,
            azureUrl,
            storyId: typeof parentId === 'number' ? parentId : existing.storyId,
            state: GridState.BLOCKED,
            disabled: false,
          },
        });
        logger.info(`Task #${id} moved to BLOCKED (Azure state: ${azureState})`);
      } else if (!isBlocked && existing.state === GridState.BLOCKED) {
        // Task is no longer blocked in Azure — re-enter pipeline
        await db.task.update({
          where: { id },
          data: {
            title,
            workItemType,
            azureUrl,
            storyId: typeof parentId === 'number' ? parentId : existing.storyId,
            state: GridState.PROFILE_ASSIGNMENT,
            disabled: false,
          },
        });
        logger.info(`Task #${id} unblocked, moved back to PROFILE_ASSIGNMENT`);
      } else {
        // Only update title, workItemType, and azureUrl — don't overwrite grid state or profile
        await db.task.update({
          where: { id },
          data: {
            title,
            workItemType,
            azureUrl,
            storyId: typeof parentId === 'number' ? parentId : existing.storyId,
          },
        });
      }
    } else {
      // New task — starts in BLOCKED if Azure state is Blocked, otherwise PROFILE_ASSIGNMENT
      const initialState = isBlocked ? GridState.BLOCKED : GridState.PROFILE_ASSIGNMENT;
      await db.task.create({
        data: {
          id,
          title,
          workItemType,
          azureUrl,
          storyId: typeof parentId === 'number' ? parentId : null,
          state: initialState,
        },
      });
      logger.info(`New task: #${id} "${title}" (state: ${initialState})`);
    }
  }

  // 7. Remove active tasks that no longer appear in the sprint query
  // COMPLETED, ABANDONED, and NON_HITL tasks are excluded here because they
  // naturally leave the sprint query when closed — they are checked separately
  // in step 8.
  const localActiveTasks = await db.task.findMany({
    where: {
      state: { notIn: [GridState.COMPLETED, GridState.ABANDONED, GridState.NON_HITL] },
    },
    select: { id: true },
  });

  const removedActiveIds = localActiveTasks.filter((t) => !azureTaskIdSet.has(t.id)).map((t) => t.id);

  if (removedActiveIds.length > 0) {
    await db.task.deleteMany({
      where: { id: { in: removedActiveIds } },
    });
    logger.info(`Removed ${removedActiveIds.length} active tasks no longer in Azure: ${removedActiveIds.join(', ')}`);
  }

  // 8. Remove completed/abandoned/non-hitl tasks that were deleted from Azure
  // These tasks won't appear in the sprint query (which filters by New/Active),
  // so we check Azure directly to see if the work items still exist.
  const localTerminalTasks = await db.task.findMany({
    where: {
      state: { in: [GridState.COMPLETED, GridState.ABANDONED, GridState.NON_HITL] },
    },
    select: { id: true },
  });

  if (localTerminalTasks.length > 0) {
    const terminalIds = localTerminalTasks.map((t) => t.id);
    const idList = terminalIds.join(',');

    // Use a WIQL query to check which of these IDs still exist in Azure
    // (regardless of state/sprint/assignee — just existence)
    const existenceQuery = `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.Id] IN (${idList})
    `.trim();

    const existenceResult = await queryWiql(config, existenceQuery);
    const existingIds = new Set(existenceResult.workItems.map((wi) => wi.id));

    const removedTerminalIds = terminalIds.filter((id) => !existingIds.has(id));

    if (removedTerminalIds.length > 0) {
      await db.task.deleteMany({
        where: { id: { in: removedTerminalIds } },
      });
      logger.info(
        `Removed ${removedTerminalIds.length} completed/abandoned/non-hitl tasks deleted from Azure: ${removedTerminalIds.join(', ')}`,
      );
    }
  }

  logger.info(`Synced ${parentStories.length + sprintStories.length} stories, ${tasks.length} tasks/bugs`);

  // 10. Remove stories that are no longer in the sprint and have no child tasks
  const localStories = await db.story.findMany({
    select: { id: true },
  });

  const removedStoryIds = localStories.filter((s) => !azureStoryIdSet.has(s.id) && !parentStoryIds.has(s.id)).map((s) => s.id);

  if (removedStoryIds.length > 0) {
    // Only remove stories that have no child tasks in the DB
    for (const storyId of removedStoryIds) {
      const childCount = await db.task.count({ where: { storyId } });
      if (childCount === 0) {
        await db.story.delete({ where: { id: storyId } });
        logger.info(`Removed story #${storyId} (no longer in sprint and no child tasks)`);
      }
    }
  }
}
