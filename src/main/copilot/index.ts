/**
 * Copilot CLI integration module.
 *
 * Re-exports all copilot-related functionality:
 * - Session management (spawn, resume, track)
 * - Hooks setup (hooks.json, hook scripts)
 * - Signal watching (fs.watch on signal files)
 */

export {
  spawnSession,
  openSessionInTerminal,
  extractSessionId,
  readLatestSignal,
  clearSignals,
  ensureDirs,
  SIGNAL_FILES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from './session'

export {
  setupHooks,
  hasHooks,
  ensureGitignore,
} from './hooks'

export {
  watchSignals,
  unwatchSignals,
  unwatchAll,
  getActiveWatcherCount,
  isWatching,
} from './watcher'
