/**
 * Integration tests for the Azure DevOps sync cron step.
 *
 * Uses a real SQLite database (via setupTestDb) with mocked external services.
 * Validates end-to-end DB state transitions: task creation, blocked handling,
 * story upserts, and title updates — all against a real Prisma client.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'

// ─── Module mocks — external services only ─────────────────

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../azure', () => ({
  queryWiql: vi.fn().mockResolvedValue({ workItems: [] }),
  getWorkItems: vi.fn().mockResolvedValue([]),
  workItemUrl: vi.fn(
    (_org: string, _project: string, id: number) =>
      `https://dev.azure.com/test-org/test-project/_workitems/edit/${id}`
  ),
  buildSprintTasksQuery: vi.fn().mockReturnValue('SELECT [System.Id] FROM WorkItems'),
  buildSprintStoriesQuery: vi.fn().mockReturnValue('SELECT [System.Id] FROM WorkItems'),
}))

vi.mock('./config', () => ({
  getAzureConfig: vi.fn().mockReturnValue({
    org: 'test-org',
    project: 'test-project',
    pat: 'test-pat',
    teamId: 'test-team',
  }),
  clearConfigCache: vi.fn(),
}))

// ─── Real DB setup ─────────────────────────────────────────

import { setupTestDb, resetTestDb, teardownTestDb, getTestDb } from '../test-utils/db'
import type { PrismaClient } from '@prisma/client'

let db: PrismaClient

// Mock ../db to return the real test DB
vi.mock('../db', () => ({
  getDb: vi.fn(() => db),
}))

// ─── Imports (after mocks) ─────────────────────────────────

import { syncWorkItems } from './sync'
import { queryWiql, getWorkItems } from '../azure'
import { getAzureConfig } from './config'
import { makeWorkItem } from '../test-utils/factories'
import { GridState } from '../../shared/constants'

// ─── Lifecycle ─────────────────────────────────────────────

beforeAll(async () => {
  db = await setupTestDb()
}, 30_000)

afterEach(async () => {
  await resetTestDb()
})

afterAll(async () => {
  await teardownTestDb()
}, 10_000)

// ─── Tests ─────────────────────────────────────────────────

describe('syncWorkItems (integration)', () => {
  it('creates a new task and parent story in the real DB', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 5001, url: '' }],
    })
    vi.mocked(getWorkItems)
      .mockResolvedValueOnce([
        makeWorkItem({ id: 5001, title: 'Implement login', state: 'Active', parentId: 6001 }),
      ])
      .mockResolvedValueOnce([
        makeWorkItem({ id: 6001, title: 'Authentication feature', type: 'User Story' }),
      ])

    await syncWorkItems()

    // Verify task was created in real DB
    const task = await db.task.findUnique({ where: { id: 5001 } })
    expect(task).not.toBeNull()
    expect(task!.title).toBe('Implement login')
    expect(task!.state).toBe(GridState.PROFILE_ASSIGNMENT)
    expect(task!.storyId).toBe(6001)
    expect(task!.azureUrl).toContain('5001')

    // Verify story was created
    const story = await db.story.findUnique({ where: { id: 6001 } })
    expect(story).not.toBeNull()
    expect(story!.title).toBe('Authentication feature')
  })

  it('creates a blocked task when Azure state is Blocked', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 5002, url: '' }],
    })
    vi.mocked(getWorkItems).mockResolvedValueOnce([
      makeWorkItem({ id: 5002, title: 'Blocked task', state: 'Blocked' }),
    ])

    await syncWorkItems()

    const task = await db.task.findUnique({ where: { id: 5002 } })
    expect(task).not.toBeNull()
    expect(task!.state).toBe(GridState.BLOCKED)
  })

  it('transitions existing task to BLOCKED and back to PROFILE_ASSIGNMENT', async () => {
    // Seed a task in PROFILE_ASSIGNMENT
    await db.task.create({
      data: {
        id: 5003,
        title: 'Toggle task',
        azureUrl: 'https://dev.azure.com/test-org/test-project/_workitems/edit/5003',
        state: GridState.PROFILE_ASSIGNMENT,
      },
    })

    // First sync: Azure says Blocked
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 5003, url: '' }],
    })
    vi.mocked(getWorkItems).mockResolvedValueOnce([
      makeWorkItem({ id: 5003, title: 'Toggle task', state: 'Blocked' }),
    ])

    await syncWorkItems()

    let task = await db.task.findUnique({ where: { id: 5003 } })
    expect(task!.state).toBe(GridState.BLOCKED)

    // Second sync: Azure says Active again
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 5003, url: '' }],
    })
    vi.mocked(getWorkItems).mockResolvedValueOnce([
      makeWorkItem({ id: 5003, title: 'Toggle task', state: 'Active' }),
    ])

    await syncWorkItems()

    task = await db.task.findUnique({ where: { id: 5003 } })
    expect(task!.state).toBe(GridState.PROFILE_ASSIGNMENT)
  })

  it('updates title without changing state for existing tasks', async () => {
    // Seed a task in PR_REVIEW state
    await db.task.create({
      data: {
        id: 5004,
        title: 'Original title',
        azureUrl: 'https://dev.azure.com/test-org/test-project/_workitems/edit/5004',
        state: GridState.PR_REVIEW,
        profileKey: 'integrate',
        prUrl: 'https://github.com/org/repo/pull/42',
      },
    })

    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 5004, url: '' }],
    })
    vi.mocked(getWorkItems).mockResolvedValueOnce([
      makeWorkItem({ id: 5004, title: 'Updated title', state: 'Active' }),
    ])

    await syncWorkItems()

    const task = await db.task.findUnique({ where: { id: 5004 } })
    expect(task!.title).toBe('Updated title')
    expect(task!.state).toBe(GridState.PR_REVIEW) // state unchanged
    expect(task!.profileKey).toBe('integrate') // profile unchanged
    expect(task!.prUrl).toBe('https://github.com/org/repo/pull/42') // prUrl unchanged
  })

  it('handles multiple tasks with a shared parent story', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [
        { id: 5010, url: '' },
        { id: 5011, url: '' },
        { id: 5012, url: '' },
      ],
    })
    vi.mocked(getWorkItems)
      .mockResolvedValueOnce([
        makeWorkItem({ id: 5010, title: 'Task A', state: 'Active', parentId: 6010 }),
        makeWorkItem({ id: 5011, title: 'Task B', state: 'Active', parentId: 6010 }),
        makeWorkItem({ id: 5012, title: 'Task C', state: 'Blocked', parentId: 6010 }),
      ])
      .mockResolvedValueOnce([
        makeWorkItem({ id: 6010, title: 'Epic story', type: 'User Story' }),
      ])

    await syncWorkItems()

    // All 3 tasks created
    const tasks = await db.task.findMany({ orderBy: { id: 'asc' } })
    expect(tasks).toHaveLength(3)
    expect(tasks[0]!.id).toBe(5010)
    expect(tasks[0]!.state).toBe(GridState.PROFILE_ASSIGNMENT)
    expect(tasks[0]!.storyId).toBe(6010)
    expect(tasks[1]!.id).toBe(5011)
    expect(tasks[1]!.state).toBe(GridState.PROFILE_ASSIGNMENT)
    expect(tasks[2]!.id).toBe(5012)
    expect(tasks[2]!.state).toBe(GridState.BLOCKED) // blocked one

    // Story created once
    const story = await db.story.findUnique({ where: { id: 6010 } })
    expect(story).not.toBeNull()
    expect(story!.title).toBe('Epic story')
  })

  it('skips sync when Azure config is not configured', async () => {
    vi.mocked(getAzureConfig).mockReturnValueOnce(null)

    await syncWorkItems()

    // No tasks should have been created
    const tasks = await db.task.findMany()
    expect(tasks).toHaveLength(0)
  })

  it('skips sync when WIQL returns empty results', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({ workItems: [] })

    await syncWorkItems()

    const tasks = await db.task.findMany()
    expect(tasks).toHaveLength(0)
  })

  it('preserves storyId when parent is not in current WIQL result', async () => {
    // Seed a task that already has a storyId from a previous sync
    await db.story.create({
      data: { id: 6020, title: 'Old story', azureUrl: 'https://dev.azure.com/test-org/test-project/_workitems/edit/6020' },
    })
    await db.task.create({
      data: {
        id: 5020,
        title: 'Existing task',
        azureUrl: 'https://dev.azure.com/test-org/test-project/_workitems/edit/5020',
        state: GridState.TASK_EXECUTION,
        storyId: 6020,
        profileKey: 'integrate',
      },
    })

    // Sync returns the task WITHOUT a parent this time
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 5020, url: '' }],
    })
    vi.mocked(getWorkItems).mockResolvedValueOnce([
      makeWorkItem({ id: 5020, title: 'Existing task updated', state: 'Active' }),
    ])

    await syncWorkItems()

    const task = await db.task.findUnique({ where: { id: 5020 } })
    expect(task!.title).toBe('Existing task updated')
    expect(task!.storyId).toBe(6020) // preserved from previous sync
    expect(task!.state).toBe(GridState.TASK_EXECUTION) // unchanged
  })
})
