/**
 * Azure DevOps work item sync.
 *
 * Queries Azure DevOps for stories and tasks in the current sprint
 * assigned to the current user, then upserts them into the local database.
 *
 * Strategy:
 * 1. Query for all tasks in the current sprint (state: New or Active) assigned to @Me
 * 2. Query for all user stories in the current sprint assigned to @Me
 * 3. Fetch full work item details for both sets
 * 4. Upsert stories into the DB (only if not already in a later grid state)
 * 5. Upsert tasks into the DB, linked to their parent stories
 * 6. Re-activation: detect new tasks on COMPLETED stories and re-enter pipeline
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

  // 2. Query for stories in current sprint
  const storyQuery = buildSprintStoriesQuery()
  const storyWiqlResult = await queryWiql(config, storyQuery)
  const storyIds = storyWiqlResult.workItems.map((wi) => wi.id)

  logger.info(`Found ${storyIds.length} stories, ${taskIds.length} tasks in current sprint`)

  // 3. Fetch full details
  const [stories, tasks] = await Promise.all([
    storyIds.length > 0
      ? getWorkItems(config, storyIds, STORY_FIELDS)
      : ([] as WorkItem[]),
    taskIds.length > 0
      ? getWorkItems(config, taskIds, TASK_FIELDS)
      : ([] as WorkItem[]),
  ])

  // 4. Collect parent story IDs from tasks (stories with active tasks, even if story is closed)
  const parentStoryIds = new Set<number>()
  for (const task of tasks) {
    const parentId = task.fields['System.Parent']
    if (typeof parentId === 'number') {
      parentStoryIds.add(parentId)
    }
  }

  // Fetch any parent stories not already in our story list
  const missingParentIds = [...parentStoryIds].filter(
    (id) => !storyIds.includes(id)
  )
  let parentStories: WorkItem[] = []
  if (missingParentIds.length > 0) {
    parentStories = await getWorkItems(config, missingParentIds, STORY_FIELDS)
    logger.info(`Fetched ${parentStories.length} additional parent stories`)
  }

  const allStories = [...stories, ...parentStories]

  // 5. Upsert stories
  for (const story of allStories) {
    const id = story.fields['System.Id']
    const title = story.fields['System.Title']
    const azureUrl = workItemUrl(config.org, config.project, id)

    // Check if this story already exists in the DB
    const existing = await db.story.findUnique({ where: { id } })

    if (existing) {
      // Only update title and azureUrl — don't overwrite grid state or profile
      await db.story.update({
        where: { id },
        data: { title, azureUrl },
      })
    } else {
      // New story — starts in PROFILE_ASSIGNMENT
      await db.story.create({
        data: {
          id,
          title,
          azureUrl,
          state: 'PROFILE_ASSIGNMENT',
        },
      })
      logger.info(`New story: #${id} "${title}"`)
    }
  }

  // 6. Upsert tasks
  // Track which completed stories get new tasks (for re-activation)
  const completedStoriesWithNewTasks = new Set<number>()

  for (const task of tasks) {
    const id = task.fields['System.Id']
    const title = task.fields['System.Title']
    const parentId = task.fields['System.Parent']
    const azureUrl = workItemUrl(config.org, config.project, id)

    if (typeof parentId !== 'number') {
      logger.warn(`Task #${id} has no parent, skipping`)
      continue
    }

    // Ensure parent story exists in DB (it should after step 5)
    const parentStory = await db.story.findUnique({ where: { id: parentId } })
    if (!parentStory) {
      logger.warn(`Task #${id} parent story #${parentId} not in DB, skipping`)
      continue
    }

    const existing = await db.task.findUnique({ where: { id } })

    if (existing) {
      // Only update title — don't overwrite PR status, worktree, etc.
      await db.task.update({
        where: { id },
        data: { title, azureUrl },
      })
    } else {
      // New task
      await db.task.create({
        data: {
          id,
          title,
          storyId: parentId,
          azureUrl,
        },
      })
      logger.info(`New task: #${id} "${title}" (story #${parentId})`)

      // If the parent story is COMPLETED, this new task triggers re-activation
      if (parentStory.state === 'COMPLETED') {
        completedStoriesWithNewTasks.add(parentId)
      }
    }
  }

  // 7. Re-activation: completed stories with new active tasks re-enter the pipeline
  for (const storyId of completedStoriesWithNewTasks) {
    logger.info(
      `Re-activating completed story #${storyId} — new tasks detected`
    )

    await db.story.update({
      where: { id: storyId },
      data: {
        state: 'TASK_PR_REVIEW',
        disabled: false,
        completedAt: null,
        errorMessage: null,
        errorAt: null,
      },
    })

    // Reset the new tasks' state so they can be worked on
    // (They were just created above, so they should already be in
    // default state, but let's be explicit)
    const newTasks = await db.task.findMany({
      where: {
        storyId,
        prMerged: false,
        sessionId: null,
      },
    })

    logger.info(
      `Story #${storyId} re-entered pipeline with ${newTasks.length} new task(s)`
    )
  }

  logger.info(`Synced ${allStories.length} stories, ${tasks.length} tasks`)
}
