/**
 * Session signal watcher.
 *
 * Watches `.hitl-signals/` directories in worktrees for changes
 * written by Copilot CLI hook scripts. When a signal file changes,
 * updates the database (disabled state) accordingly.
 *
 * Signal flow:
 * 1. Copilot CLI fires a hook event (sessionEnd, postToolUse)
 * 2. Hook script writes a signal file to .hitl-signals/
 * 3. This watcher detects the file change
 * 4. Updates the Story/Task disabled state in the database
 *
 * - SESSION_ACTIVE (postToolUse) → agent is working → disabled = true
 * - SESSION_END (sessionEnd) → session finished → disabled = false (awaiting human)
 */

import { watch, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db'
import { readLatestSignal, SIGNAL_FILES } from './session'
import { notifyPlanReady } from '../notifications'

/** Map of watched paths to their fs.watch handles */
const watchers = new Map<string, ReturnType<typeof watch>>()

/** Debounce timers for signal processing */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Debounce interval for processing signals (ms) */
const DEBOUNCE_MS = 1_000

/**
 * Starts watching a worktree's signal directory for changes.
 *
 * @param worktreePath Absolute path to the worktree
 * @param entityType 'story' or 'task'
 * @param entityId The work item ID (story or task)
 */
export function watchSignals(
  worktreePath: string,
  entityType: 'story' | 'task',
  entityId: number
): void {
  const signalDir = join(worktreePath, '.hitl-signals')

  // Don't double-watch
  if (watchers.has(worktreePath)) return

  // Ensure signal directory exists
  if (!existsSync(signalDir)) {
    mkdirSync(signalDir, { recursive: true })
  }

  console.log(`[watcher] Watching signals for ${entityType} #${entityId} in ${signalDir}`)

  const watcher = watch(signalDir, { persistent: false }, (eventType, filename) => {
    if (!filename) return

    // Debounce rapid changes
    const key = `${worktreePath}:${filename}`
    const existing = debounceTimers.get(key)
    if (existing) clearTimeout(existing)

    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key)
        processSignal(worktreePath, entityType, entityId).catch((err) => {
          console.error(`[watcher] Error processing signal for ${entityType} #${entityId}:`, err)
        })
      }, DEBOUNCE_MS)
    )
  })

  watcher.on('error', (err) => {
    console.error(`[watcher] Error watching ${signalDir}:`, err)
    unwatchSignals(worktreePath)
  })

  watchers.set(worktreePath, watcher)
}

/**
 * Stops watching a worktree's signal directory.
 */
export function unwatchSignals(worktreePath: string): void {
  const watcher = watchers.get(worktreePath)
  if (watcher) {
    watcher.close()
    watchers.delete(worktreePath)
    console.log(`[watcher] Stopped watching ${worktreePath}`)
  }

  // Clear any pending debounce timers
  for (const [key, timer] of debounceTimers) {
    if (key.startsWith(worktreePath)) {
      clearTimeout(timer)
      debounceTimers.delete(key)
    }
  }
}

/**
 * Stops all watchers. Called on app shutdown.
 */
export function unwatchAll(): void {
  for (const [path] of watchers) {
    unwatchSignals(path)
  }
}

/**
 * Processes the latest signal for a worktree and updates the database.
 */
async function processSignal(
  worktreePath: string,
  entityType: 'story' | 'task',
  entityId: number
): Promise<void> {
  const signal = readLatestSignal(worktreePath)
  if (!signal) return

  const db = getDb()

  console.log(`[watcher] Signal for ${entityType} #${entityId}: ${signal.signal}`)

  switch (signal.signal) {
    case SIGNAL_FILES.SESSION_ACTIVE:
      // Agent is actively working — keep disabled
      if (entityType === 'story') {
        await db.story.update({
          where: { id: entityId },
          data: { disabled: true },
        })
      } else {
        await db.task.update({
          where: { id: entityId },
          data: { disabled: true },
        })
      }
      break

    case SIGNAL_FILES.SESSION_END:
      // Session ended — agent is done, enable for human review
      if (entityType === 'story') {
        const story = await db.story.findUnique({ where: { id: entityId } })
        await db.story.update({
          where: { id: entityId },
          data: { disabled: false },
        })
        // Notify if plan is ready for approval
        if (story && story.state === 'PLAN_APPROVAL') {
          notifyPlanReady(entityId, story.title)
        }
      } else {
        await db.task.update({
          where: { id: entityId },
          data: { disabled: false },
        })
      }
      // Stop watching — session is over
      unwatchSignals(worktreePath)
      break

    case SIGNAL_FILES.SESSION_IDLE:
      // Session is idle — waiting for human input, enable row
      if (entityType === 'story') {
        await db.story.update({
          where: { id: entityId },
          data: { disabled: false },
        })
      } else {
        await db.task.update({
          where: { id: entityId },
          data: { disabled: false },
        })
      }
      break

    default:
      console.log(`[watcher] Unknown signal: ${signal.signal}`)
  }
}

/**
 * Returns the count of active watchers (for status display).
 */
export function getActiveWatcherCount(): number {
  return watchers.size
}

/**
 * Checks if a specific worktree is being watched.
 */
export function isWatching(worktreePath: string): boolean {
  return watchers.has(worktreePath)
}
