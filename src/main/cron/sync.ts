/**
 * Azure DevOps work item sync.
 *
 * Queries Azure DevOps for tasks in the current sprint assigned to the
 * current user, then upserts them into the local database.
 *
 * Strategy:
 * 1. Query for all tasks in the current sprint (state: New or Active) assigned to @Me
 * 2. Fetch full work item details
 * 3. Fetch parent story info for context (lightweight)
 * 4. Upsert stories as lightweight parent references
 * 5. Upsert tasks into the DB — new tasks start in PROFILE_ASSIGNMENT
 * 6. Handle blocked tasks (Azure state = Blocked)
 */

import {
  type AzureConfig,
  type WorkItem,
  queryWiql,
  getWorkItems,
  workItemUrl,
  buildSprintTasksQuery,
  buildSprintStoriesQuery,
} from '../azure'
import { getDb } from '../db'
import { getAzureConfig } from './config'
import { createLogger } from '../logger'
import { GridState } from '../../shared/constants'

const logger = createLogger('sync')

/** Fields we need from the work items API */
const STORY_FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
]

const TASK_FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.Parent',
]

/**
 * Runs the full Azure DevOps sync cycle.
 * This is called by the cron job when syncEnabled is true.
 */
export async function syncWorkItems(): Promise<void> {
  const config = getAzureConfig()
  if (!config) {
    logger.info('Azure DevOps not configured, skipping sync')
    return
  }

  const db = getDb()

  // 1. Query for tasks in current sprint
  const taskQuery = buildSprintTasksQuery()
  const taskWiqlResult = await queryWiql(config, taskQuery)
  const taskIds = taskWiqlResult.workItems.map((wi) => wi.id)

  logger.info(`Found ${taskIds.length} tasks in current sprint`)

  if (taskIds.length === 0) return

  // 2. Fetch full task details
  const tasks = await getWorkItems(config, taskIds, TASK_FIELDS)

  // 3. Collect parent story IDs from tasks
  const parentStoryIds = new Set<number>()
  for (const task of tasks) {
    const parentId = task.fields['System.Parent']
    if (typeof parentId === 'number') {
      parentStoryIds.add(parentId)
    }
  }

  // 4. Fetch parent stories for context
  let parentStories: WorkItem[] = []
  if (parentStoryIds.size > 0) {
    parentStories = await getWorkItems(config, [...parentStoryIds], STORY_FIELDS)
    logger.info(`Fetched ${parentStories.length} parent stories`)
  }

  // 5. Upsert stories as lightweight references
  for (const story of parentStories) {
    const id = story.fields['System.Id']
    const title = story.fields['System.Title']
    const azureUrl = workItemUrl(config.org, config.project, id)

    await db.story.upsert({
      where: { id },
      create: { id, title, azureUrl },
      update: { title, azureUrl },
    })
  }

  // 6. Upsert tasks
  for (const task of tasks) {
    const id = task.fields['System.Id']
    const title = task.fields['System.Title']
    const parentId = task.fields['System.Parent']
    const azureState = task.fields['System.State']
    const azureUrl = workItemUrl(config.org, config.project, id)
    const isBlocked = azureState === 'Blocked'

    const existing = await db.task.findUnique({ where: { id } })

    if (existing) {
      if (isBlocked && existing.state !== GridState.BLOCKED) {
        // Task became blocked in Azure — move it to BLOCKED grid
        await db.task.update({
          where: { id },
          data: {
            title,
            azureUrl,
            storyId: typeof parentId === 'number' ? parentId : existing.storyId,
            state: GridState.BLOCKED,
            disabled: false,
          },
        })
        logger.info(`Task #${id} moved to BLOCKED (Azure state: ${azureState})`)
      } else if (!isBlocked && existing.state === GridState.BLOCKED) {
        // Task is no longer blocked in Azure — re-enter pipeline
        await db.task.update({
          where: { id },
          data: {
            title,
            azureUrl,
            storyId: typeof parentId === 'number' ? parentId : existing.storyId,
            state: GridState.PROFILE_ASSIGNMENT,
            disabled: false,
          },
        })
        logger.info(`Task #${id} unblocked, moved back to PROFILE_ASSIGNMENT`)
      } else {
        // Only update title and azureUrl — don't overwrite grid state or profile
        await db.task.update({
          where: { id },
          data: {
            title,
            azureUrl,
            storyId: typeof parentId === 'number' ? parentId : existing.storyId,
          },
        })
      }
    } else {
      // New task — starts in BLOCKED if Azure state is Blocked, otherwise PROFILE_ASSIGNMENT
      const initialState = isBlocked ? GridState.BLOCKED : GridState.PROFILE_ASSIGNMENT
      await db.task.create({
        data: {
          id,
          title,
          azureUrl,
          storyId: typeof parentId === 'number' ? parentId : null,
          state: initialState,
        },
      })
      logger.info(`New task: #${id} "${title}" (state: ${initialState})`)
    }
  }

  logger.info(`Synced ${parentStories.length} stories, ${tasks.length} tasks`)
}
