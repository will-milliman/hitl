/**
 * Session signal watcher.
 *
 * Watches signal directories for changes written by Copilot CLI hook scripts.
 * When a signal file changes, updates the database (disabled state) accordingly.
 *
 * Signal flow:
 * 1. Copilot CLI fires a hook event (sessionEnd, postToolUse)
 * 2. Hook script writes a signal file to the signal directory
 * 3. This watcher detects the file change
 * 4. Updates the Task disabled state in the database
 *
 * - SESSION_ACTIVE (postToolUse) → agent is working → disabled = true
 * - SESSION_END (sessionEnd) → session finished → disabled = false (awaiting human)
 *
 * Idle detection:
 * When a SESSION_ACTIVE signal is received, an idle timer starts. If no new
 * SESSION_ACTIVE signal arrives within IDLE_TIMEOUT_MS, the session is presumed
 * idle (copilot is waiting for user input) and disabled is set to false.
 */
import { existsSync, mkdirSync, watch } from 'fs';

import { getDb } from '../db';

import { SIGNAL_FILES, getSignalDir, readLatestSignal } from './session';

/** Map of watched paths to their fs.watch handles */
const watchers = new Map<string, ReturnType<typeof watch>>();

/** Debounce timers for signal processing */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Idle timers — fire when no SESSION_ACTIVE signal arrives within the timeout */
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounce interval for processing signals (ms) */
const DEBOUNCE_MS = 1_000;

/**
 * How long to wait after the last SESSION_ACTIVE signal before marking
 * the session as idle. Copilot typically fires postToolUse every few
 * seconds while actively working, so 90s of silence is a strong signal
 * that it's waiting for user input.
 */
const IDLE_TIMEOUT_MS = 90_000;

/**
 * Starts watching a worktree's signal directory for changes.
 *
 * @param worktreePath Absolute path to the worktree
 * @param taskId The task work item ID
 */
export function watchSignals(worktreePath: string, entityType: 'task', entityId: number): void {
  const signalDir = getSignalDir(worktreePath);

  // Don't double-watch
  if (watchers.has(worktreePath)) return;

  // Ensure signal directory exists
  if (!existsSync(signalDir)) {
    mkdirSync(signalDir, { recursive: true });
  }

  console.log(`[watcher] Watching signals for task #${entityId} in ${signalDir}`);

  const watcher = watch(signalDir, { persistent: false }, (eventType, filename) => {
    if (!filename) return;

    // Debounce rapid changes
    const key = `${worktreePath}:${filename}`;
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key);
        processSignal(worktreePath, entityId).catch((err) => {
          console.error(`[watcher] Error processing signal for task #${entityId}:`, err);
        });
      }, DEBOUNCE_MS),
    );
  });

  watcher.on('error', (err) => {
    console.error(`[watcher] Error watching ${signalDir}:`, err);
    unwatchSignals(worktreePath);
  });

  watchers.set(worktreePath, watcher);
}

/**
 * Stops watching a worktree's signal directory.
 */
export function unwatchSignals(worktreePath: string): void {
  const watcher = watchers.get(worktreePath);
  if (watcher) {
    watcher.close();
    watchers.delete(worktreePath);
    console.log(`[watcher] Stopped watching ${worktreePath}`);
  }

  // Clear any pending debounce timers
  for (const [key, timer] of debounceTimers) {
    if (key.startsWith(worktreePath)) {
      clearTimeout(timer);
      debounceTimers.delete(key);
    }
  }

  // Clear idle timer
  const idleTimer = idleTimers.get(worktreePath);
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimers.delete(worktreePath);
  }
}

/**
 * Stops all watchers. Called on app shutdown.
 */
export function unwatchAll(): void {
  for (const [path] of watchers) {
    unwatchSignals(path);
  }
}

/**
 * Processes the latest signal for a worktree and updates the database.
 */
async function processSignal(worktreePath: string, taskId: number): Promise<void> {
  const signal = readLatestSignal(worktreePath);
  if (!signal) return;

  const db = getDb();

  console.log(`[watcher] Signal for task #${taskId}: ${signal.signal}`);

  switch (signal.signal) {
    case SIGNAL_FILES.SESSION_ACTIVE:
      // Agent is actively working — keep disabled
      await db.task.update({
        where: { id: taskId },
        data: { disabled: true },
      });
      // Reset idle timer — if no further activity within the timeout,
      // mark the session as idle (copilot is waiting for user input)
      resetIdleTimer(worktreePath, taskId);
      break;

    case SIGNAL_FILES.SESSION_END:
      // Session ended — agent is done, enable for human review.
      // Task stays in its current state (TASK_EXECUTION or PR_REVIEW).
      // The cron step handles state transitions (draft PR creation, etc.).
      await db.task.update({
        where: { id: taskId },
        data: { disabled: false },
      });
      // Stop watching — session is over
      unwatchSignals(worktreePath);
      break;

    case SIGNAL_FILES.SESSION_IDLE:
      // Session is idle — waiting for human input, enable row
      await db.task.update({
        where: { id: taskId },
        data: { disabled: false },
      });
      break;

    default:
      console.log(`[watcher] Unknown signal: ${signal.signal}`);
  }
}

/**
 * Resets the idle timer for a worktree. Called each time a SESSION_ACTIVE
 * signal is received. When the timer fires (no new activity within the
 * timeout), the task is marked as not-disabled (idle).
 */
function resetIdleTimer(worktreePath: string, taskId: number): void {
  // Clear existing timer
  const existing = idleTimers.get(worktreePath);
  if (existing) clearTimeout(existing);

  idleTimers.set(
    worktreePath,
    setTimeout(async () => {
      idleTimers.delete(worktreePath);
      // Only mark idle if we're still watching (session hasn't ended)
      if (!watchers.has(worktreePath)) return;

      console.log(`[watcher] Idle timeout for task #${taskId} — marking as idle`);
      try {
        const db = getDb();
        await db.task.update({
          where: { id: taskId },
          data: { disabled: false },
        });
      } catch (err) {
        console.error(`[watcher] Failed to mark task #${taskId} as idle:`, err);
      }
    }, IDLE_TIMEOUT_MS),
  );
}

/**
 * Returns the count of active watchers (for status display).
 */
export function getActiveWatcherCount(): number {
  return watchers.size;
}

/**
 * Checks if a specific worktree is being watched.
 */
export function isWatching(worktreePath: string): boolean {
  return watchers.has(worktreePath);
}
