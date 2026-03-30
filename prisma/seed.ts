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

  // Stories — lightweight parent references
  await Promise.all([
    prisma.story.create({
      data: {
        id: 90001,
        title: 'Implement user authentication flow',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/90001',
      },
    }),
    prisma.story.create({
      data: {
        id: 90002,
        title: 'Add dashboard analytics widgets',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/90002',
      },
    }),
    prisma.story.create({
      data: {
        id: 90003,
        title: 'Migrate database schema v2',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/90003',
      },
    }),
  ])

  // Tasks across all grid states
  await Promise.all([
    // Profile Assignment — awaiting profile selection
    prisma.task.create({
      data: {
        id: 91001,
        title: 'Create login page component',
        storyId: 90001,
        state: 'PROFILE_ASSIGNMENT',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/91001',
      },
    }),
    prisma.task.create({
      data: {
        id: 91002,
        title: 'Add OAuth2 provider integration',
        storyId: 90001,
        state: 'PROFILE_ASSIGNMENT',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/91002',
      },
    }),

    // Task Execution — Copilot is working (disabled)
    prisma.task.create({
      data: {
        id: 91003,
        title: 'Build analytics chart component',
        storyId: 90002,
        state: 'TASK_EXECUTION',
        profileKey: 'integrate',
        worktreePath: 'C:/repos/web-app-wt1',
        sessionId: 'session-abc-123',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/91003',
        disabled: true,
      },
    }),
    // Task Execution — session finished, ready for next step
    prisma.task.create({
      data: {
        id: 91004,
        title: 'Create data aggregation API endpoint',
        storyId: 90002,
        state: 'TASK_EXECUTION',
        profileKey: 'integrate',
        worktreePath: 'C:/repos/web-app-wt2',
        sessionId: 'session-def-456',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/91004',
        disabled: false,
      },
    }),

    // PR Review — PR created, awaiting human review
    prisma.task.create({
      data: {
        id: 91005,
        title: 'Create migration script for users table',
        storyId: 90003,
        state: 'PR_REVIEW',
        profileKey: 'integrate',
        worktreePath: 'C:/repos/backend-svc-wt3',
        sessionId: 'session-ghi-789',
        prUrl: 'https://github.com/org/backend-svc/pull/101',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/91005',
        disabled: false,
      },
    }),
    prisma.task.create({
      data: {
        id: 91006,
        title: 'Create migration script for orders table',
        storyId: 90003,
        state: 'PR_REVIEW',
        profileKey: 'integrate',
        worktreePath: 'C:/repos/backend-svc-wt4',
        sessionId: 'session-jkl-012',
        prUrl: 'https://github.com/org/backend-svc/pull/102',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/91006',
        disabled: false,
      },
    }),

    // Completed — PR merged
    prisma.task.create({
      data: {
        id: 91007,
        title: 'Update ORM models for new schema',
        storyId: 90003,
        state: 'COMPLETED',
        profileKey: 'integrate',
        prUrl: 'https://github.com/org/backend-svc/pull/100',
        prMerged: true,
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/91007',
        disabled: true,
        completedAt: new Date(),
      },
    }),

    // Blocked
    prisma.task.create({
      data: {
        id: 91008,
        title: 'Implement SSO callback handler',
        storyId: 90001,
        state: 'BLOCKED',
        azureUrl: 'https://dev.azure.com/org/project/_workitems/edit/91008',
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
