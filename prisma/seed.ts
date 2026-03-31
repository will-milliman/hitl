import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function seed() {
  console.log('Resetting database...')

  // Clear all data
  await prisma.task.deleteMany()
  await prisma.story.deleteMany()
  await prisma.cronState.deleteMany()

  // Create CronState singleton
  await prisma.cronState.create({
    data: { id: 1 },
  })

  console.log('Database reset complete.')
}

seed()
  .catch((e) => {
    console.error('Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
