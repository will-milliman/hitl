import { PrismaClient } from '@prisma/client'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

let prisma: PrismaClient | null = null

/**
 * Returns the path to the SQLite database file.
 * In development: uses `prisma/dev.db` in the project root.
 * In production: uses `hitl.db` in Electron's userData directory.
 */
function getDatabasePath(): string {
  if (!app.isPackaged) {
    // Development — use project-root prisma/dev.db
    return join(__dirname, '../../prisma/dev.db')
  }

  // Production — use userData directory
  const userDataPath = app.getPath('userData')
  if (!existsSync(userDataPath)) {
    mkdirSync(userDataPath, { recursive: true })
  }
  return join(userDataPath, 'hitl.db')
}

/**
 * Initializes the Prisma client with the correct database URL.
 * Must be called after `app.whenReady()`.
 */
export async function initDatabase(): Promise<PrismaClient> {
  if (prisma) return prisma

  const dbPath = getDatabasePath()
  const databaseUrl = `file:${dbPath}`

  prisma = new PrismaClient({
    datasources: {
      db: { url: databaseUrl },
    },
    log: app.isPackaged ? ['error'] : ['error', 'warn'],
  })

  // Connect and ensure CronState singleton exists
  await prisma.$connect()
  await prisma.cronState.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  })

  console.log(`[db] Connected to SQLite at ${dbPath}`)
  return prisma
}

/**
 * Returns the Prisma client instance.
 * Throws if initDatabase() hasn't been called yet.
 */
export function getDb(): PrismaClient {
  if (!prisma) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return prisma
}

/**
 * Gracefully disconnects the Prisma client.
 */
export async function closeDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect()
    prisma = null
    console.log('[db] Disconnected')
  }
}
