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
  startInteractiveSession,
  extractSessionId,
  readLatestSignal,
  clearSignals,
  ensureDirs,
  getLogDir,
  getScreenshotsDir,
  SIGNAL_FILES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from './session';

export { ensureGlobalHooks } from './hooks';

export { watchSignals, unwatchSignals, unwatchAll, getActiveWatcherCount, isWatching } from './watcher';
