/**
 * Plan approval flow.
 *
 * When a human approves a plan in the Plan Approval grid:
 * 1. Reads PLAN.md from the worktree
 * 2. Updates the Azure DevOps story with acceptance criteria
 * 3. Creates tasks in Azure DevOps from the plan
 * 4. Creates task worktrees branched from the story branch
 * 5. Moves the story to TASK_PR_REVIEW state
 *
 * This is triggered by a tRPC mutation from the renderer.
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db'
import { getAzureConfig } from '../cron/config'
import { createTaskWorktree } from '../worktree'
import type { AzureConfig } from '../azure/client'
import type { ProfileMap } from '../../shared/types'

/** Parsed plan from PLAN.md */
export interface ParsedPlan {
  title: string
  acceptanceCriteria: string[]
  tasks: Array<{ title: string; description: string }>
}

/**
 * Reads and parses PLAN.md from a worktree.
 *
 * Expected format:
 * ```
 * # Plan: Story #12345 - Some Title
 *
 * ## Acceptance Criteria
 * - [ ] Criterion 1
 * - [ ] Criterion 2
 *
 * ## Tasks
 * ### Task 1: Title
 * Description...
 *
 * ### Task 2: Title
 * Description...
 * ```
 */
export function parsePlanFile(worktreePath: string): ParsedPlan | null {
  const planPath = join(worktreePath, 'PLAN.md')

  if (!existsSync(planPath)) {
    console.warn(`[plan-approval] PLAN.md not found at ${planPath}`)
    return null
  }

  const content = readFileSync(planPath, 'utf-8')
  const lines = content.split('\n')

  const plan: ParsedPlan = {
    title: '',
    acceptanceCriteria: [],
    tasks: [],
  }

  let section: 'none' | 'criteria' | 'tasks' = 'none'
  let currentTask: { title: string; description: string } | null = null

  for (const line of lines) {
    const trimmed = line.trim()

    // Parse title from H1
    if (trimmed.startsWith('# ') && !plan.title) {
      plan.title = trimmed.substring(2).trim()
      continue
    }

    // Detect section headers
    if (trimmed.toLowerCase().startsWith('## acceptance criteria')) {
      section = 'criteria'
      continue
    }
    if (trimmed.toLowerCase().startsWith('## tasks')) {
      section = 'tasks'
      continue
    }
    if (trimmed.startsWith('## ')) {
      // Unknown section, stop parsing tasks
      if (currentTask) {
        plan.tasks.push(currentTask)
        currentTask = null
      }
      section = 'none'
      continue
    }

    // Parse acceptance criteria
    if (section === 'criteria') {
      // Match "- [ ] text" or "- text" or "* text"
      const match = trimmed.match(/^[-*]\s*(\[.\])?\s*(.+)$/)
      if (match) {
        plan.acceptanceCriteria.push(match[2].trim())
      }
      continue
    }

    // Parse tasks
    if (section === 'tasks') {
      // Task header: ### Task N: Title or ### Title
      const taskMatch = trimmed.match(/^###\s+(?:Task\s+\d+:\s*)?(.+)$/)
      if (taskMatch) {
        if (currentTask) {
          plan.tasks.push(currentTask)
        }
        currentTask = {
          title: taskMatch[1].trim(),
          description: '',
        }
        continue
      }

      // Task description lines
      if (currentTask && trimmed) {
        currentTask.description += (currentTask.description ? '\n' : '') + trimmed
      }
    }
  }

  // Push last task
  if (currentTask) {
    plan.tasks.push(currentTask)
  }

  return plan
}

/**
 * Formats acceptance criteria as HTML for Azure DevOps.
 *
 * Azure DevOps stores the Description/Acceptance Criteria field as HTML.
 */
function formatAcceptanceCriteriaHtml(criteria: string[]): string {
  const items = criteria.map((c) => `<li>${escapeHtml(c)}</li>`).join('\n')
  return `<ul>\n${items}\n</ul>`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Updates a work item in Azure DevOps using the PATCH API.
 *
 * Uses JSON Patch operations to update fields.
 */
async function patchWorkItem(
  config: AzureConfig,
  workItemId: number,
  operations: Array<{ op: string; path: string; value: unknown }>
): Promise<void> {
  const auth = Buffer.from(`:${config.pat}`).toString('base64')
  const url = `https://dev.azure.com/${config.org}/${config.project}/_apis/wit/workitems/${workItemId}?api-version=7.1`

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json-patch+json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(operations),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `[plan-approval] Failed to patch work item ${workItemId} (${response.status}): ${text}`
    )
  }
}

/**
 * Creates a task work item in Azure DevOps under a parent story.
 *
 * Returns the created task's work item ID.
 */
async function createAzureTask(
  config: AzureConfig,
  parentStoryId: number,
  title: string,
  description: string
): Promise<number> {
  const auth = Buffer.from(`:${config.pat}`).toString('base64')
  const url = `https://dev.azure.com/${config.org}/${config.project}/_apis/wit/workitems/$Task?api-version=7.1`

  const operations = [
    { op: 'add', path: '/fields/System.Title', value: title },
    { op: 'add', path: '/fields/System.Description', value: escapeHtml(description) },
    {
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `https://dev.azure.com/${config.org}/${config.project}/_apis/wit/workitems/${parentStoryId}`,
        attributes: { name: 'Parent' },
      },
    },
  ]

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json-patch+json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(operations),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `[plan-approval] Failed to create task (${response.status}): ${text}`
    )
  }

  const result = (await response.json()) as { id: number }
  return result.id
}

/**
 * Loads profile.json from the project root.
 */
function loadProfiles(): ProfileMap {
  try {
    const profilePath = join(__dirname, '../../profile.json')
    const raw = readFileSync(profilePath, 'utf-8')
    return JSON.parse(raw) as ProfileMap
  } catch (err) {
    console.error('[plan-approval] Failed to load profile.json:', err)
    return {}
  }
}

/**
 * Approves a plan and transitions the story to TASK_PR_REVIEW.
 *
 * Steps:
 * 1. Read and parse PLAN.md from the worktree
 * 2. Update Azure story with acceptance criteria
 * 3. Create Azure tasks from the plan
 * 4. Upsert tasks in the local database
 * 5. Create task worktrees
 * 6. Move the story to TASK_PR_REVIEW
 *
 * @param storyId The story work item ID
 * @returns Summary of what was created
 */
export async function approvePlan(
  storyId: number
): Promise<{
  tasksCreated: number
  acceptanceCriteria: number
  plan: ParsedPlan | null
}> {
  const db = getDb()
  const config = getAzureConfig()

  // Load the story
  const story = await db.story.findUnique({ where: { id: storyId } })
  if (!story) throw new Error(`Story #${storyId} not found`)
  if (!story.worktreePath) throw new Error(`Story #${storyId} has no worktree`)
  if (!story.profileKey) throw new Error(`Story #${storyId} has no profile`)

  // Parse PLAN.md
  const plan = parsePlanFile(story.worktreePath)
  if (!plan) {
    throw new Error(`No PLAN.md found in ${story.worktreePath}`)
  }

  if (plan.tasks.length === 0) {
    throw new Error('Plan has no tasks defined')
  }

  console.log(
    `[plan-approval] Approving plan for story #${storyId}: ${plan.acceptanceCriteria.length} criteria, ${plan.tasks.length} tasks`
  )

  // Load profile for worktree creation
  const profiles = loadProfiles()
  const profile = profiles[story.profileKey]
  if (!profile) {
    throw new Error(`Profile "${story.profileKey}" not found in profile.json`)
  }

  // Step 1: Update Azure story with acceptance criteria (if config available)
  if (config && plan.acceptanceCriteria.length > 0) {
    try {
      const criteriaHtml = formatAcceptanceCriteriaHtml(plan.acceptanceCriteria)
      await patchWorkItem(config, storyId, [
        {
          op: 'add',
          path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
          value: criteriaHtml,
        },
      ])
      console.log(`[plan-approval] Updated Azure story #${storyId} with acceptance criteria`)
    } catch (err) {
      console.error(`[plan-approval] Failed to update Azure story:`, err)
      // Non-fatal — continue with task creation
    }
  }

  // Step 2: Create tasks in Azure DevOps and local DB
  const createdTaskIds: number[] = []

  for (const taskDef of plan.tasks) {
    try {
      let taskId: number

      if (config) {
        // Create in Azure DevOps
        taskId = await createAzureTask(
          config,
          storyId,
          taskDef.title,
          taskDef.description
        )
        console.log(`[plan-approval] Created Azure task #${taskId}: ${taskDef.title}`)
      } else {
        // No Azure config — use a placeholder ID
        taskId = Date.now() + Math.floor(Math.random() * 1000)
        console.log(`[plan-approval] Created local task #${taskId}: ${taskDef.title} (no Azure config)`)
      }

      const azureUrl = config
        ? `https://dev.azure.com/${config.org}/${config.project}/_workitems/edit/${taskId}`
        : `#task-${taskId}`

      // Upsert in local database
      await db.task.upsert({
        where: { id: taskId },
        create: {
          id: taskId,
          title: taskDef.title,
          storyId,
          azureUrl,
          disabled: true, // Agent will work on it
        },
        update: {
          title: taskDef.title,
        },
      })

      createdTaskIds.push(taskId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[plan-approval] Failed to create task "${taskDef.title}": ${message}`)
      // Continue with other tasks
    }
  }

  // Step 3: Create task worktrees
  for (const taskId of createdTaskIds) {
    try {
      const worktreePath = await createTaskWorktree(
        profile.repoPath,
        storyId,
        taskId,
        profile.defaultBranch
      )

      await db.task.update({
        where: { id: taskId },
        data: { worktreePath },
      })

      console.log(`[plan-approval] Task #${taskId} worktree ready at ${worktreePath}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[plan-approval] Failed to create worktree for task #${taskId}: ${message}`)
      // Non-fatal — task can still be worked on manually
    }
  }

  // Step 4: Move story to TASK_PR_REVIEW
  await db.story.update({
    where: { id: storyId },
    data: {
      state: 'TASK_PR_REVIEW',
      disabled: true, // Tasks will be worked on by agents
    },
  })

  console.log(`[plan-approval] Story #${storyId} moved to TASK_PR_REVIEW with ${createdTaskIds.length} tasks`)

  return {
    tasksCreated: createdTaskIds.length,
    acceptanceCriteria: plan.acceptanceCriteria.length,
    plan,
  }
}
