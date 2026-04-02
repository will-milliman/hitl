/**
 * Test data factories.
 *
 * Provides factory functions for creating test data with sensible defaults.
 * All factories accept a partial override object, so tests only specify
 * the fields they care about.
 *
 * Usage:
 *   const task = makeTask({ state: GridState.PR_REVIEW, prUrl: '...' })
 *   const story = makeStory({ id: 100, title: 'Test story' })
 */
import { GridState } from '../../shared/constants';
import type { AzureConfig, WorkItem, WorkItemFields } from '../azure/client';
import type { PullRequest, ReviewComment } from '../github/client';

// ─── Database Record Factories ─────────────────────────────

/** Default values for a Story record. */
const STORY_DEFAULTS = {
  id: 90001,
  title: 'Test story',
  azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/90001',
};

/** Creates a Story record object with sensible defaults. */
export function makeStory(overrides: Partial<typeof STORY_DEFAULTS> = {}) {
  return { ...STORY_DEFAULTS, ...overrides };
}

/** Shape of a Task record (matches Prisma Task model). */
export interface TaskRecord {
  id: number;
  title: string;
  storyId: number | null;
  state: string;
  profileKey: string | null;
  worktreePath: string | null;
  sessionId: string | null;
  prUrl: string | null;
  prMerged: boolean;
  azureUrl: string;
  disabled: boolean;
  prUpdated: boolean;
  completedAt: Date | null;
  errorMessage: string | null;
  errorAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Default values for a Task record. */
const TASK_DEFAULTS: TaskRecord = {
  id: 91001,
  title: 'Test task',
  storyId: null,
  state: GridState.PROFILE_ASSIGNMENT,
  profileKey: null,
  worktreePath: null,
  sessionId: null,
  prUrl: null,
  prMerged: false,
  azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/91001',
  disabled: false,
  prUpdated: false,
  completedAt: null,
  errorMessage: null,
  errorAt: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
};

/** Creates a Task record object with sensible defaults. */
export function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...TASK_DEFAULTS, ...overrides };
}

/**
 * Creates a Task record in a specific pipeline state with appropriate
 * field values for that state.
 */
export function makeTaskInState(state: GridState, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const stateDefaults: Partial<TaskRecord> = {};

  switch (state) {
    case GridState.PROFILE_ASSIGNMENT:
      break; // no additional fields needed
    case GridState.TASK_EXECUTION:
      stateDefaults.profileKey = 'integrate';
      stateDefaults.worktreePath = 'C:/repos/test-repo-worktrees/test-repo-1';
      stateDefaults.disabled = true;
      break;
    case GridState.PR_REVIEW:
      stateDefaults.profileKey = 'integrate';
      stateDefaults.worktreePath = 'C:/repos/test-repo-worktrees/test-repo-1';
      stateDefaults.sessionId = 'session-test-123';
      stateDefaults.prUrl = 'https://github.com/org/repo/pull/101';
      break;
    case GridState.COMPLETED:
      stateDefaults.profileKey = 'integrate';
      stateDefaults.prUrl = 'https://github.com/org/repo/pull/100';
      stateDefaults.prMerged = true;
      stateDefaults.disabled = true;
      stateDefaults.completedAt = new Date('2025-01-15T00:00:00Z');
      break;
    case GridState.BLOCKED:
      stateDefaults.disabled = false;
      break;
  }

  return makeTask({ state, ...stateDefaults, ...overrides });
}

/** Default values for a CronState record. */
const CRON_STATE_DEFAULTS = {
  id: 1,
  syncEnabled: true,
  taskExecutionEnabled: true,
  prCheckEnabled: true,
  lastRunAt: null as Date | null,
};

/** Creates a CronState record object with sensible defaults. */
export function makeCronState(overrides: Partial<typeof CRON_STATE_DEFAULTS> = {}) {
  return { ...CRON_STATE_DEFAULTS, ...overrides };
}

// ─── Azure DevOps Response Factories ───────────────────────

/** Creates an AzureConfig object with sensible defaults. */
export function makeAzureConfig(overrides: Partial<AzureConfig> = {}): AzureConfig {
  return {
    org: 'test-org',
    project: 'test-project',
    pat: 'test-pat',
    teamId: 'test-team',
    ...overrides,
  };
}

/** Creates an Azure DevOps WorkItem response with sensible defaults. */
export function makeWorkItem(
  overrides: {
    id?: number;
    title?: string;
    type?: string;
    state?: string;
    parentId?: number | null;
  } = {},
): WorkItem {
  const id = overrides.id ?? 91001;
  const fields: WorkItemFields = {
    'System.Id': id,
    'System.Title': overrides.title ?? `Work Item #${id}`,
    'System.WorkItemType': overrides.type ?? 'Task',
    'System.State': overrides.state ?? 'Active',
  };

  if (overrides.parentId !== undefined && overrides.parentId !== null) {
    fields['System.Parent'] = overrides.parentId;
  }

  return {
    id,
    fields,
    url: `https://dev.azure.com/test-org/test-project/_apis/wit/workItems/${id}`,
  };
}

// ─── GitHub Response Factories ─────────────────────────────

/** Creates a GitHub PullRequest response with sensible defaults. */
export function makePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 101,
    url: 'https://github.com/org/repo/pull/101',
    state: 'OPEN',
    isDraft: false,
    title: 'Test PR',
    headRefName: 'task/91001',
    baseRefName: 'main',
    author: { login: 'bot-author' },
    ...overrides,
  };
}

/** Creates a GitHub ReviewComment with sensible defaults. */
export function makeReviewComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 1,
    body: 'Please fix this',
    path: 'src/index.ts',
    line: 42,
    position: 1,
    user: { login: 'reviewer' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: 'https://github.com/org/repo/pull/101#discussion_r1',
    ...overrides,
  };
}

// ─── Seed Helpers for Integration Tests ────────────────────

/**
 * Seeds a story and its tasks into the database.
 * For use with the real test DB in integration tests.
 *
 * @param db PrismaClient instance
 * @param story Story data (uses makeStory defaults if not provided)
 * @param tasks Array of task data (uses makeTask defaults if not provided)
 */
export async function seedStoryWithTasks(
  db: { story: { create: Function }; task: { create: Function } },
  story: ReturnType<typeof makeStory>,
  tasks: Partial<TaskRecord>[] = [],
) {
  await db.story.create({ data: story });

  for (const taskOverrides of tasks) {
    const task = makeTask({ storyId: story.id, ...taskOverrides });
    // Only pass Prisma-compatible fields (exclude generated fields for create)
    const { createdAt, updatedAt, ...createData } = task;
    await db.task.create({ data: createData });
  }
}
