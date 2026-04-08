/**
 * Unit tests for the Azure DevOps sync cron step.
 *
 * Tests the syncWorkItems() orchestration logic with mocked DB and Azure API.
 * Validates: task creation, state transitions, story upserts, blocked handling.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GridState } from '../../shared/constants';
import { getWorkItems, queryWiql } from '../azure';
import { makeTask, makeWorkItem } from '../test-utils/factories';

import { getAzureConfig } from './config';
// ─── Imports (after mocks) ─────────────────────────────────

import { syncWorkItems } from './sync';

// ─── Module mocks (must be before imports) ─────────────────

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockDb = {
  story: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
  },
  task: {
    findUnique: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
  },
};

vi.mock('../db', () => ({
  getDb: vi.fn(() => mockDb),
}));

vi.mock('../azure', () => ({
  queryWiql: vi.fn().mockResolvedValue({ workItems: [] }),
  getWorkItems: vi.fn().mockResolvedValue([]),
  workItemUrl: vi.fn(
    (_org: string, _project: string, id: number) => `https://dev.azure.com/test-org/test-project/_workitems/edit/${id}`,
  ),
  buildSprintTasksQuery: vi.fn().mockReturnValue('SELECT [System.Id] FROM WorkItems'),
  buildSprintStoriesQuery: vi.fn().mockReturnValue('SELECT [System.Id] FROM WorkItems'),
}));

vi.mock('./config', () => ({
  getAzureConfig: vi.fn().mockReturnValue({
    org: 'test-org',
    project: 'test-project',
    pat: 'test-pat',
    teamId: 'test-team',
  }),
  clearConfigCache: vi.fn(),
}));

// ─── Tests ─────────────────────────────────────────────────

describe('syncWorkItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early when Azure is not configured', async () => {
    vi.mocked(getAzureConfig).mockReturnValueOnce(null);

    await syncWorkItems();

    expect(queryWiql).not.toHaveBeenCalled();
    expect(mockDb.task.create).not.toHaveBeenCalled();
  });

  it('does not fetch work items when WIQL returns no tasks', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({ workItems: [] });

    await syncWorkItems();

    expect(getWorkItems).not.toHaveBeenCalled();
    expect(mockDb.task.create).not.toHaveBeenCalled();
    // Deletion step should still run to clean up stale tasks
    expect(mockDb.task.findMany).toHaveBeenCalled();
  });

  it('creates new tasks in PROFILE_ASSIGNMENT state', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 1001, url: '' }],
    });
    vi.mocked(getWorkItems)
      // First call: task details
      .mockResolvedValueOnce([makeWorkItem({ id: 1001, title: 'New task', state: 'Active', parentId: 2001 })])
      // Second call: parent story details
      .mockResolvedValueOnce([makeWorkItem({ id: 2001, title: 'Parent story', type: 'User Story' })]);

    mockDb.task.findUnique.mockResolvedValueOnce(null); // task doesn't exist

    await syncWorkItems();

    // Story should be upserted
    expect(mockDb.story.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 2001 },
        create: expect.objectContaining({ id: 2001, title: 'Parent story' }),
        update: expect.objectContaining({ title: 'Parent story' }),
      }),
    );

    // Task should be created with initial state
    expect(mockDb.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 1001,
        title: 'New task',
        state: GridState.PROFILE_ASSIGNMENT,
        storyId: 2001,
      }),
    });
  });

  it('creates blocked tasks in BLOCKED state', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 1001, url: '' }],
    });
    vi.mocked(getWorkItems).mockResolvedValueOnce([makeWorkItem({ id: 1001, title: 'Blocked task', state: 'Blocked' })]);

    mockDb.task.findUnique.mockResolvedValueOnce(null); // task doesn't exist

    await syncWorkItems();

    expect(mockDb.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 1001,
        state: GridState.BLOCKED,
      }),
    });
  });

  it('transitions existing task to BLOCKED when Azure state is Blocked', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 1001, url: '' }],
    });
    vi.mocked(getWorkItems).mockResolvedValueOnce([makeWorkItem({ id: 1001, title: 'Task', state: 'Blocked' })]);

    // Task exists in PROFILE_ASSIGNMENT
    mockDb.task.findUnique.mockResolvedValueOnce(makeTask({ id: 1001, state: GridState.PROFILE_ASSIGNMENT }));

    await syncWorkItems();

    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: expect.objectContaining({
        state: GridState.BLOCKED,
        disabled: false,
      }),
    });
    expect(mockDb.task.create).not.toHaveBeenCalled();
  });

  it('transitions BLOCKED task back to PROFILE_ASSIGNMENT when unblocked', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 1001, url: '' }],
    });
    vi.mocked(getWorkItems).mockResolvedValueOnce([makeWorkItem({ id: 1001, title: 'Task', state: 'Active' })]);

    // Task exists in BLOCKED state
    mockDb.task.findUnique.mockResolvedValueOnce(makeTask({ id: 1001, state: GridState.BLOCKED }));

    await syncWorkItems();

    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: expect.objectContaining({
        state: GridState.PROFILE_ASSIGNMENT,
        disabled: false,
      }),
    });
  });

  it('updates title/azureUrl without changing state for existing non-blocked tasks', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 1001, url: '' }],
    });
    vi.mocked(getWorkItems).mockResolvedValueOnce([makeWorkItem({ id: 1001, title: 'Updated title', state: 'Active' })]);

    // Task exists in PR_REVIEW state
    mockDb.task.findUnique.mockResolvedValueOnce(makeTask({ id: 1001, state: GridState.PR_REVIEW, title: 'Old title' }));

    await syncWorkItems();

    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: expect.objectContaining({
        title: 'Updated title',
      }),
    });
    // Should NOT include state in the update data
    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: expect.not.objectContaining({
        state: expect.anything(),
      }),
    });
  });

  it('handles tasks without a parent story', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [{ id: 1001, url: '' }],
    });
    vi.mocked(getWorkItems).mockResolvedValueOnce([makeWorkItem({ id: 1001, title: 'Orphan task', state: 'Active' })]);

    mockDb.task.findUnique.mockResolvedValueOnce(null);

    await syncWorkItems();

    // No story should be fetched or upserted
    expect(mockDb.story.upsert).not.toHaveBeenCalled();

    // Task should be created with null storyId
    expect(mockDb.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 1001,
        storyId: null,
      }),
    });
  });

  it('processes multiple tasks in a single sync', async () => {
    vi.mocked(queryWiql).mockResolvedValueOnce({
      workItems: [
        { id: 1001, url: '' },
        { id: 1002, url: '' },
      ],
    });
    vi.mocked(getWorkItems)
      .mockResolvedValueOnce([
        makeWorkItem({ id: 1001, title: 'Task 1', state: 'Active', parentId: 2001 }),
        makeWorkItem({ id: 1002, title: 'Task 2', state: 'Active', parentId: 2001 }),
      ])
      .mockResolvedValueOnce([makeWorkItem({ id: 2001, title: 'Shared story', type: 'User Story' })]);

    mockDb.task.findUnique.mockResolvedValue(null); // neither exists

    await syncWorkItems();

    expect(mockDb.task.create).toHaveBeenCalledTimes(2);
    expect(mockDb.story.upsert).toHaveBeenCalledTimes(1); // deduped
  });
});
