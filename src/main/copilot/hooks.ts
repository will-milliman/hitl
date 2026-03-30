/**
 * Copilot CLI hooks setup — global config approach.
 *
 * Instead of writing `.github/hooks/hooks.json` inside each worktree,
 * hooks are defined inline in the global Copilot config at
 * `~/.copilot/config.json`. This keeps hook config entirely out of repos.
 *
 * Hook scripts are stored in `<tmpdir>/.hitl-data/hook-scripts/` and
 * dynamically resolve the signal directory from the session's `cwd`
 * (passed via stdin JSON from Copilot CLI).
 *
 * Hook events we care about:
 * - sessionEnd: Session completed or was terminated
 * - postToolUse: After a tool runs (used to detect idle → active transitions)
 *
 * Copilot CLI hooks schema (in config.json):
 * {
 *   ...existing config...,
 *   "hooks": {
 *     "sessionEnd": [{ "type": "command", "powershell": "..." }],
 *     "postToolUse": [{ "type": "command", "powershell": "..." }]
 *   }
 * }
 */

import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { SIGNAL_FILES } from './session'

/** Base directory for HITL data outside worktrees */
const HITL_DATA_BASE = join(tmpdir(), '.hitl-data')

/** Directory for global hook scripts (shared across all worktrees) */
const HOOK_SCRIPTS_DIR = join(HITL_DATA_BASE, 'hook-scripts')

/** Path to the global Copilot CLI config */
const COPILOT_CONFIG_PATH = join(homedir(), '.copilot', 'config.json')

/** Hook command entry — uses the `powershell` field for Windows */
interface HookCommandEntry {
  type: 'command'
  powershell: string
}

/** Subset of Copilot config.json that we manage */
interface CopilotConfig {
  [key: string]: unknown
  hooks?: {
    sessionEnd?: HookCommandEntry[]
    postToolUse?: HookCommandEntry[]
    [key: string]: unknown
  }
}

/** Whether global hooks have been set up this session */
let globalHooksReady = false

/**
 * Creates a PowerShell hook script that dynamically resolves the signal
 * directory from the session's cwd.
 *
 * The script:
 * 1. Reads JSON from stdin (piped by Copilot CLI)
 * 2. Extracts the `cwd` field to identify the worktree
 * 3. Computes the signal dir: <tmpdir>/.hitl-data/<basename(cwd)>/signals/
 * 4. Writes a signal file with event data
 */
function createGlobalHookScript(signalName: string): string {
  const hitlDataBase = HITL_DATA_BASE.replace(/\\/g, '\\\\')

  return `# HITL Global Hook Script — writes signal files for session state tracking
# Signal: ${signalName}
# This script is invoked by Copilot CLI for ALL sessions.
# It dynamically resolves the signal directory from the session's cwd.

$input_data = [Console]::In.ReadToEnd()
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$signal = @{
  signal = "${signalName}"
  timestamp = $timestamp
  data = $null
}

$cwd = $null

try {
  $parsed = $input_data | ConvertFrom-Json
  $signal.data = $parsed
  $cwd = $parsed.cwd
} catch {
  # stdin wasn't valid JSON — cannot determine worktree, exit
  exit 0
}

if (-not $cwd) {
  # No cwd in event data — cannot determine signal directory
  exit 0
}

# Resolve signal directory: <tmpdir>/.hitl-data/<worktree-folder-name>/signals/
$worktreeName = Split-Path $cwd -Leaf
$signalDir = Join-Path "${hitlDataBase}" "$worktreeName" "signals"

if (-not (Test-Path $signalDir)) {
  # Signal dir doesn't exist — this is not a HITL-managed worktree, skip
  exit 0
}

$signalJson = $signal | ConvertTo-Json -Depth 10 -Compress
$signalFile = Join-Path $signalDir "${signalName}.json"
$signalJson | Out-File -FilePath $signalFile -Encoding utf8 -Force
`
}

/**
 * Sets up global Copilot CLI hooks in `~/.copilot/config.json`.
 *
 * This is called once per app session (idempotent). It:
 * 1. Writes hook scripts to `<tmpdir>/.hitl-data/hook-scripts/`
 * 2. Reads the existing `~/.copilot/config.json`
 * 3. Merges the HITL hooks into the `hooks` key
 * 4. Writes the updated config back
 *
 * Since Copilot merges hooks from all sources additively, our hooks
 * coexist with any user-defined hooks.
 */
export function setupGlobalHooks(): void {
  // Ensure hook scripts directory exists
  mkdirSync(HOOK_SCRIPTS_DIR, { recursive: true })

  // Write the global hook scripts
  const sessionEndScript = createGlobalHookScript(SIGNAL_FILES.SESSION_END)
  const postToolScript = createGlobalHookScript(SIGNAL_FILES.SESSION_ACTIVE)

  const sessionEndPath = join(HOOK_SCRIPTS_DIR, 'hitl-session-end.ps1')
  const postToolPath = join(HOOK_SCRIPTS_DIR, 'hitl-post-tool.ps1')

  writeFileSync(sessionEndPath, sessionEndScript, 'utf-8')
  writeFileSync(postToolPath, postToolScript, 'utf-8')

  // Read existing config
  let config: CopilotConfig = {}
  if (existsSync(COPILOT_CONFIG_PATH)) {
    try {
      const raw = readFileSync(COPILOT_CONFIG_PATH, 'utf-8')
      config = JSON.parse(raw) as CopilotConfig
    } catch {
      console.error('[hooks] Failed to parse existing copilot config, will overwrite hooks section')
    }
  }

  // Build our hook entries
  const hitlSessionEnd: HookCommandEntry = {
    type: 'command',
    powershell: `& '${sessionEndPath.replace(/'/g, "''")}'`,
  }

  const hitlPostTool: HookCommandEntry = {
    type: 'command',
    powershell: `& '${postToolPath.replace(/'/g, "''")}'`,
  }

  // Merge hooks: preserve any non-HITL hooks, replace HITL hooks.
  // We identify HITL hooks by checking if the powershell command references
  // our hook scripts directory.
  const existingHooks = config.hooks ?? {}
  const isHitlHook = (entry: HookCommandEntry): boolean =>
    entry.powershell?.includes('hitl-session-end.ps1') ||
    entry.powershell?.includes('hitl-post-tool.ps1')

  // Filter out old HITL hooks from existing entries
  const existingSessionEnd = (existingHooks.sessionEnd ?? []).filter(
    (e) => !isHitlHook(e as HookCommandEntry)
  ) as HookCommandEntry[]
  const existingPostTool = (existingHooks.postToolUse ?? []).filter(
    (e) => !isHitlHook(e as HookCommandEntry)
  ) as HookCommandEntry[]

  // Preserve any other hook events the user may have defined
  const { sessionEnd: _se, postToolUse: _pt, ...otherHookEvents } = existingHooks

  config.hooks = {
    ...otherHookEvents,
    sessionEnd: [...existingSessionEnd, hitlSessionEnd],
    postToolUse: [...existingPostTool, hitlPostTool],
  }

  // Write the updated config
  writeFileSync(COPILOT_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')

  globalHooksReady = true
  console.log(`[hooks] Global hooks configured in ${COPILOT_CONFIG_PATH}`)
  console.log(`[hooks] Hook scripts in ${HOOK_SCRIPTS_DIR}`)
}

/**
 * Ensures global hooks are set up. Idempotent — only runs once per session.
 *
 * Call this before spawning any copilot session. It replaces the old
 * per-worktree `hasHooks()`/`setupHooks()`/`ensureGitignore()` pattern.
 */
export function ensureGlobalHooks(): void {
  if (globalHooksReady) return
  setupGlobalHooks()
}
