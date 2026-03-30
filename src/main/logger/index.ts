/**
 * Structured logging module for the HITL orchestrator.
 *
 * Provides:
 * - Leveled logging (debug, info, warn, error)
 * - JSON-structured log entries with timestamps
 * - File-based log output (rotating daily logs)
 * - In-memory ring buffer for recent logs (UI log viewer)
 * - Session log aggregation from copilot --log-dir outputs
 */

import { mkdirSync, appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve, basename } from 'path'
import { app } from 'electron'
import { tmpdir } from 'os'

// ─── Types ───────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  timestamp: string
  level: LogLevel
  source: string
  message: string
  data?: Record<string, unknown>
}

// ─── Configuration ───────────────────────────────────────

/** Log directory (inside app's user data folder) */
let logDir: string = ''

/** Minimum level to log to file (debug logs everything) */
let minLevel: LogLevel = 'info'

/** In-memory ring buffer of recent log entries */
const LOG_BUFFER_SIZE = 500
const logBuffer: LogEntry[] = []

/** Level ordering for filtering */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

// ─── Initialization ──────────────────────────────────────

/**
 * Initializes the logging system.
 * Must be called after Electron's `app.whenReady()`.
 *
 * @param level Minimum log level to write to file
 */
export function initLogger(level: LogLevel = 'info'): void {
  minLevel = level

  // Use app.getPath('userData') in production, or project root/.hitl-logs in dev
  try {
    logDir = join(app.getPath('userData'), 'logs')
  } catch {
    // Fallback for when app is not ready (shouldn't happen in normal flow)
    logDir = resolve(__dirname, '../../../.hitl-logs')
  }

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }

  log('info', 'logger', `Logger initialized (level=${level}, dir=${logDir})`)
}

// ─── Core Logging ────────────────────────────────────────

/**
 * Generates the log file path for today's date.
 */
function todayLogFile(): string {
  const now = new Date()
  const date = now.toISOString().split('T')[0] // YYYY-MM-DD
  return join(logDir, `hitl-${date}.log`)
}

/**
 * Logs a structured entry.
 *
 * @param level Log level
 * @param source Module/source identifier (e.g. 'cron', 'sync', 'github')
 * @param message Human-readable message
 * @param data Optional structured data
 */
export function log(
  level: LogLevel,
  source: string,
  message: string,
  data?: Record<string, unknown>
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    ...(data ? { data } : {}),
  }

  // Add to ring buffer
  logBuffer.push(entry)
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.shift()
  }

  // Console output (always)
  const prefix = `[${source}]`
  const consoleMsg = data
    ? `${prefix} ${message} ${JSON.stringify(data)}`
    : `${prefix} ${message}`

  switch (level) {
    case 'debug':
      console.debug(consoleMsg)
      break
    case 'info':
      console.log(consoleMsg)
      break
    case 'warn':
      console.warn(consoleMsg)
      break
    case 'error':
      console.error(consoleMsg)
      break
  }

  // File output (if level meets threshold)
  if (logDir && LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel]) {
    try {
      const line = JSON.stringify(entry) + '\n'
      appendFileSync(todayLogFile(), line, 'utf-8')
    } catch {
      // Silently fail file writes — don't recurse into logging
    }
  }
}

// ─── Convenience Methods ─────────────────────────────────

/** Creates a scoped logger for a specific module */
export function createLogger(source: string) {
  return {
    debug: (message: string, data?: Record<string, unknown>) =>
      log('debug', source, message, data),
    info: (message: string, data?: Record<string, unknown>) =>
      log('info', source, message, data),
    warn: (message: string, data?: Record<string, unknown>) =>
      log('warn', source, message, data),
    error: (message: string, data?: Record<string, unknown>) =>
      log('error', source, message, data),
  }
}

// ─── Log Access (for UI) ─────────────────────────────────

/**
 * Returns the in-memory log buffer (most recent entries).
 *
 * @param level Optional minimum level filter
 * @param source Optional source filter
 * @param limit Max entries to return (default: all)
 */
export function getRecentLogs(
  level?: LogLevel,
  source?: string,
  limit?: number
): LogEntry[] {
  let filtered = [...logBuffer]

  if (level) {
    const minOrder = LEVEL_ORDER[level]
    filtered = filtered.filter((e) => LEVEL_ORDER[e.level] >= minOrder)
  }

  if (source) {
    filtered = filtered.filter((e) => e.source === source)
  }

  if (limit && limit < filtered.length) {
    filtered = filtered.slice(-limit)
  }

  return filtered
}

/**
 * Reads log entries from a specific log file (for export / history).
 *
 * @param date Date string in YYYY-MM-DD format
 * @returns Parsed log entries
 */
export function readLogFile(date: string): LogEntry[] {
  const filePath = join(logDir, `hitl-${date}.log`)
  if (!existsSync(filePath)) return []

  try {
    const content = readFileSync(filePath, 'utf-8')
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as LogEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is LogEntry => entry !== null)
  } catch {
    return []
  }
}

/**
 * Lists available log files (dates).
 */
export function listLogFiles(): string[] {
  if (!logDir || !existsSync(logDir)) return []

  try {
    return readdirSync(logDir)
      .filter((f) => f.startsWith('hitl-') && f.endsWith('.log'))
      .map((f) => f.replace('hitl-', '').replace('.log', ''))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/**
 * Returns the log directory path.
 */
export function getLogDir(): string {
  return logDir
}

// ─── Session Log Aggregation ─────────────────────────────

/**
 * Reads copilot session logs from the external data directory for a worktree.
 *
 * Logs are stored outside the worktree in `<temp>/.hitl-data/<worktree-name>/logs/`.
 *
 * @param worktreePath Path to the worktree
 * @returns Array of { sessionId, logContent, size, modifiedAt }
 */
export function getSessionLogs(
  worktreePath: string
): Array<{ sessionId: string; logContent: string; size: number; modifiedAt: Date }> {
  const worktreeName = basename(worktreePath)
  const sessionLogDir = join(tmpdir(), '.hitl-data', worktreeName, 'logs')
  if (!existsSync(sessionLogDir)) return []

  try {
    const files = readdirSync(sessionLogDir)
    return files
      .filter((f) => f.endsWith('.log') || f.endsWith('.json'))
      .map((f) => {
        const fullPath = join(sessionLogDir, f)
        const stat = statSync(fullPath)
        const content = readFileSync(fullPath, 'utf-8')
        const sessionId = f.replace(/\.(log|json)$/, '')

        return {
          sessionId,
          logContent: content,
          size: stat.size,
          modifiedAt: stat.mtime,
        }
      })
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())
  } catch {
    return []
  }
}
