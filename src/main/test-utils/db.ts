/**
 * Test database utilities.
 *
 * Provides a real SQLite Prisma client for integration tests.
 * Uses a temp file-based SQLite database with the schema applied
 * via `prisma db push`.
 *
 * Usage:
 *   import { setupTestDb, teardownTestDb, getTestDb } from '../test-utils/db'
 *
 *   beforeAll(async () => { await setupTestDb() })
 *   afterAll(async () => { await teardownTestDb() })
 *   afterEach(async () => { await resetTestDb() })
 *
 * For unit tests that don't need a real DB, mock `../db` instead:
 *   vi.mock('../db', () => ({ getDb: vi.fn() }))
 */

import { PrismaClient } from '@prisma/client'
import { execSync } from 'child_process'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

let testPrisma: PrismaClient | null = null
let tempDir: string | null = null

/**
 * Creates a fresh test database with the schema applied.
 * Returns the PrismaClient instance.
 */
export async function setupTestDb(): Promise<PrismaClient> {
  // Create a temp directory for the test database
  tempDir = mkdtempSync(join(tmpdir(), 'hitl-test-'))
  const dbPath = join(tempDir, 'test.db')
  const databaseUrl = `file:${dbPath}`

  // Apply the schema using prisma db push (no migrations needed)
  const schemaPath = join(__dirname, '../../../prisma/schema.prisma')
  execSync(`npx prisma db push --schema="${schemaPath}" --skip-generate --accept-data-loss`, {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
    cwd: join(__dirname, '../../..'),
  })

  // Create the Prisma client for this test database
  testPrisma = new PrismaClient({
    datasources: {
      db: { url: databaseUrl },
    },
    log: [],
  })

  await testPrisma.$connect()

  // Ensure CronState singleton exists (matches initDatabase behavior)
  await testPrisma.cronState.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  })

  return testPrisma
}

/**
 * Returns the current test database client.
 * Throws if setupTestDb() hasn't been called.
 */
export function getTestDb(): PrismaClient {
  if (!testPrisma) {
    throw new Error('Test database not initialized. Call setupTestDb() first.')
  }
  return testPrisma
}

/**
 * Resets all data in the test database (for use in afterEach).
 * Re-creates the CronState singleton.
 */
export async function resetTestDb(): Promise<void> {
  if (!testPrisma) return

  // Delete in order to respect foreign key constraints
  await testPrisma.task.deleteMany()
  await testPrisma.story.deleteMany()
  await testPrisma.cronState.deleteMany()

  // Re-create CronState singleton
  await testPrisma.cronState.create({ data: { id: 1 } })
}

/**
 * Disconnects the test database and cleans up the temp directory.
 */
export async function teardownTestDb(): Promise<void> {
  if (testPrisma) {
    await testPrisma.$disconnect()
    testPrisma = null
  }

  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup — Windows may hold file locks briefly
    }
    tempDir = null
  }
}
