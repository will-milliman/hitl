/**
 * Copilot CLI session manager.
 *
 * Handles spawning Copilot CLI sessions programmatically,
 * tracking session IDs via log files, and resuming sessions.
 *
 * CLI interface:
 * - `copilot -p "prompt" --log-dir ./logs --no-ask-user --allow-tool=TOOLS`
 * - Session ID is found in the log file created in --log-dir
 * - `copilot --resume SESSION-ID` to resume a session
 *
 * Sessions are spawned detached so they run independently of HITL.
 */

import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { join, basename } from 'path'
import { mkdirSync, readdirSync, readFileSync, existsSync, watch } from 'fs'

const execAsync = promisify(exec)

/** Default tools to allow in copilot sessions */
const DEFAULT_ALLOWED_TOOLS = 'write, shell(git:*), shell(npm:*), shell(npx:*)'

/** Directory name for copilot logs within a worktree */
const LOGS_DIR = '.hitl-logs'

/** Directory name for signal files within a worktree */
const SIGNALS_DIR = '.hitl-signals'

/** Signal file names written by hooks */
export const SIGNAL_FILES = {
  SESSION_IDLE: 'session-idle',
  SESSION_ACTIVE: 'session-active',
  SESSION_END: 'session-end',
} as const

export interface SpawnSessionOptions {
  /** The working directory (worktree path) */
  cwd: string
  /** The prompt to send to copilot */
  prompt: string
  /** Additional tools to allow (merged with defaults) */
  allowTools?: string
  /** Whether to run in silent mode */
  silent?: boolean
}

export interface SpawnSessionResult {
  /** The session ID extracted from the log file */
  sessionId: string
  /** Path to the log directory */
  logDir: string
}

/**
 * Ensures the logs and signals directories exist in a worktree.
 */
export function ensureDirs(worktreePath: string): { logDir: string; signalDir: string } {
  const logDir = join(worktreePath, LOGS_DIR)
  const signalDir = join(worktreePath, SIGNALS_DIR)

  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
  if (!existsSync(signalDir)) mkdirSync(signalDir, { recursive: true })

  return { logDir, signalDir }
}

/**
 * Extracts the session ID from a copilot log directory.
 *
 * After spawning copilot with --log-dir, a new log file is created.
 * The session ID is the filename (without extension) of the newest log file.
 *
 * We poll for the log file since it may take a moment to appear.
 */
export async function extractSessionId(
  logDir: string,
  existingFiles: Set<string>,
  timeoutMs = 30_000,
  pollMs = 500
): Promise<string> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const files = readdirSync(logDir)
      const newFiles = files.filter((f) => !existingFiles.has(f))

      if (newFiles.length > 0) {
        // Sort to get the newest file
        const logFile = newFiles.sort().pop()!
        // Session ID is the filename without extension
        const sessionId = basename(logFile, '.log')
          .replace(/\.json$/, '')
          .replace(/\.[^.]+$/, '')
        if (sessionId) return sessionId
      }
    } catch {
      // Directory might not exist yet, keep polling
    }

    await new Promise((r) => setTimeout(r, pollMs))
  }

  throw new Error(`[copilot] Timed out waiting for session ID in ${logDir}`)
}

/**
 * Gets the set of existing log files in a directory.
 * Used to detect new files after spawning.
 */
export function getExistingLogFiles(logDir: string): Set<string> {
  try {
    return new Set(readdirSync(logDir))
  } catch {
    return new Set()
  }
}

/**
 * Spawns a new Copilot CLI session.
 *
 * The session runs detached so it persists independently.
 * The session ID is extracted from the log file.
 */
export async function spawnSession(
  options: SpawnSessionOptions
): Promise<SpawnSessionResult> {
  const { cwd, prompt, allowTools, silent = true } = options
  const { logDir } = ensureDirs(cwd)

  // Snapshot existing log files so we can detect the new one
  const existingFiles = getExistingLogFiles(logDir)

  // Build the command arguments
  const args: string[] = [
    '-p',
    prompt,
    '--log-dir',
    logDir,
    '--no-ask-user',
    '--allow-tool',
    allowTools ?? DEFAULT_ALLOWED_TOOLS,
  ]

  if (silent) {
    args.push('-s')
  }

  console.log(`[copilot] Spawning session in ${cwd}`)
  console.log(`[copilot] copilot ${args.map((a) => `"${a}"`).join(' ')}`)

  // Spawn detached — the session runs independently
  const child = spawn('copilot', args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    shell: true,
    windowsHide: true,
  })

  // Unref so HITL can exit without waiting for copilot
  child.unref()

  child.on('error', (err) => {
    console.error(`[copilot] Failed to spawn session: ${err.message}`)
  })

  // Wait for the session ID to appear in the log directory
  const sessionId = await extractSessionId(logDir, existingFiles)

  console.log(`[copilot] Session started: ${sessionId}`)

  return { sessionId, logDir }
}

/**
 * Opens a copilot session in Windows Terminal for human interaction.
 *
 * Uses `copilot --resume SESSION-ID` in the worktree directory.
 */
export async function openSessionInTerminal(
  sessionId: string,
  cwd: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await execAsync(
      `wt -d "${cwd}" -- copilot --resume ${sessionId}`,
      { windowsHide: true }
    )
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[copilot] Failed to open session in terminal: ${message}`)
    return { success: false, error: message }
  }
}

/**
 * Reads the latest signal file for a worktree.
 *
 * Returns the signal type and timestamp, or null if no signal exists.
 */
export function readLatestSignal(
  worktreePath: string
): { signal: string; timestamp: number; data?: Record<string, unknown> } | null {
  const signalDir = join(worktreePath, SIGNALS_DIR)

  if (!existsSync(signalDir)) return null

  try {
    const files = readdirSync(signalDir)
    if (files.length === 0) return null

    // Get the most recently modified file
    let latestFile = ''
    let latestMtime = 0

    for (const file of files) {
      try {
        const fullPath = join(signalDir, file)
        const content = readFileSync(fullPath, 'utf-8')
        const parsed = JSON.parse(content)
        const mtime = parsed.timestamp ?? 0

        if (mtime > latestMtime) {
          latestMtime = mtime
          latestFile = file
        }
      } catch {
        // Skip malformed signal files
      }
    }

    if (!latestFile) return null

    const content = readFileSync(join(signalDir, latestFile), 'utf-8')
    const parsed = JSON.parse(content)
    return {
      signal: parsed.signal ?? latestFile,
      timestamp: parsed.timestamp ?? 0,
      data: parsed.data,
    }
  } catch {
    return null
  }
}

/**
 * Clears all signal files for a worktree.
 */
export function clearSignals(worktreePath: string): void {
  const signalDir = join(worktreePath, SIGNALS_DIR)
  if (!existsSync(signalDir)) return

  const { unlinkSync } = require('fs')
  try {
    for (const file of readdirSync(signalDir)) {
      unlinkSync(join(signalDir, file))
    }
  } catch (err) {
    console.error(`[copilot] Failed to clear signals in ${signalDir}:`, err)
  }
}
