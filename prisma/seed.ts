import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function seed() {
  console.log('Seeding database...')

  // Clear existing data
  await prisma.task.deleteMany()
  await prisma.story.deleteMany()
  await prisma.cronState.deleteMany()

  // Create CronState singleton
  await prisma.cronState.create({
    data: { id: 1 },
  })

  // Stories across all grid states
  const stories = await Promise.all([
    // Profile Assignment — awaiting profile selection
    prisma.story.create({
      data: {
        id: 12345,
        title: 'Implement user authentication flow',
        state: 'PROFILE_ASSIGNMENT',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/12345',
      },
    }),
    prisma.story.create({
      data: {
        id: 12346,
        title: 'Add dashboard analytics widgets',
        state: 'PROFILE_ASSIGNMENT',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/12346',
      },
    }),

    // Plan Approval — agent is planning (disabled)
    prisma.story.create({
      data: {
        id: 12340,
        title: 'Refactor API middleware layer',
        state: 'PLAN_APPROVAL',
        profileKey: 'web-app',
        worktreePath: 'C:/repos/web-app-wt1',
        sessionId: 'session-abc-123',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/12340',
        disabled: true,
      },
    }),
    // Plan Approval — awaiting human approval (enabled)
    prisma.story.create({
      data: {
        id: 12341,
        title: 'Update notification system',
        state: 'PLAN_APPROVAL',
        profileKey: 'backend-svc',
        worktreePath: 'C:/repos/backend-svc-wt1',
        sessionId: 'session-def-456',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/12341',
        disabled: false,
      },
    }),

    // Task PR Review — tasks being worked on
    prisma.story.create({
      data: {
        id: 12330,
        title: 'Migrate database schema v2',
        state: 'TASK_PR_REVIEW',
        profileKey: 'backend-svc',
        worktreePath: 'C:/repos/backend-svc-wt2',
        sessionId: 'session-ghi-789',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/12330',
        disabled: false,
      },
    }),

    // Story PR Review — story PR awaiting merge
    prisma.story.create({
      data: {
        id: 12320,
        title: 'Implement search indexing',
        state: 'STORY_PR_REVIEW',
        profileKey: 'web-app',
        worktreePath: 'C:/repos/web-app-wt3',
        sessionId: 'session-jkl-012',
        prUrl: 'https://github.com/org/web-app/pull/42',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/12320',
        disabled: false,
      },
    }),

    // Completed
    prisma.story.create({
      data: {
        id: 12310,
        title: 'Add CSV export feature',
        state: 'COMPLETED',
        profileKey: 'web-app',
        sessionId: 'session-mno-345',
        prUrl: 'https://github.com/org/web-app/pull/38',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/12310',
        disabled: true,
      },
    }),
  ])

  // Tasks for story 12330 (Task PR Review)
  await Promise.all([
    prisma.task.create({
      data: {
        id: 12331,
        title: 'Create migration script for users table',
        storyId: 12330,
        worktreePath: 'C:/repos/backend-svc-wt3',
        sessionId: 'session-task-001',
        prUrl: 'https://github.com/org/backend-svc/pull/101',
        prMerged: true,
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/12331',
        disabled: true,
      },
    }),
    prisma.task.create({
      data: {
        id: 12332,
        title: 'Create migration script for orders table',
        storyId: 12330,
        worktreePath: 'C:/repos/backend-svc-wt4',
        sessionId: 'session-task-002',
        prUrl: 'https://github.com/org/backend-svc/pull/102',
        prMerged: false,
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/12332',
        disabled: false,
      },
    }),
    prisma.task.create({
      data: {
        id: 12333,
        title: 'Update ORM models for new schema',
        storyId: 12330,
        worktreePath: 'C:/repos/backend-svc-wt5',
        sessionId: 'session-task-003',
        prMerged: false,
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/12333',
        disabled: true,
      },
    }),
  ])

  const storyCount = await prisma.story.count()
  const taskCount = await prisma.task.count()
  console.log(`Seeded ${storyCount} stories and ${taskCount} tasks`)
}

seed()
  .catch((e) => {
    console.error('Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
