/**
 * Copilot CLI hooks setup.
 *
 * Configures `.github/hooks/hooks.json` in worktree directories
 * so that Copilot CLI fires hook scripts on key events.
 *
 * Hook events we care about:
 * - sessionEnd: Session completed or was terminated
 * - postToolUse: After a tool runs (used to detect idle → active transitions)
 *
 * Hook scripts write JSON signal files to `.hitl-signals/` that the
 * session watcher monitors via fs.watch.
 */

import { join, resolve } from 'path'
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { SIGNAL_FILES } from './session'

/** The hooks.json structure expected by Copilot CLI */
interface HooksConfig {
  hooks: HookEntry[]
}

interface HookEntry {
  type: string
  command: string
}

/**
 * Gets the path to the hooks directory for a worktree.
 */
function getHooksDir(worktreePath: string): string {
  return join(worktreePath, '.github', 'hooks')
}

/**
 * Gets the path to the signal directory for a worktree.
 */
function getSignalDir(worktreePath: string): string {
  return join(worktreePath, '.hitl-signals')
}

/**
 * Creates the PowerShell hook script that writes signal files.
 *
 * The script reads JSON from stdin, extracts event info,
 * and writes a signal file that HITL can watch.
 */
function createHookScript(worktreePath: string, signalName: string): string {
  const signalDir = getSignalDir(worktreePath).replace(/\\/g, '\\\\')

  // PowerShell script that reads stdin JSON and writes a signal file
  return `#!/usr/bin/env pwsh
# HITL Hook Script — writes signal files for session state tracking
# Signal: ${signalName}

$input_data = [Console]::In.ReadToEnd()
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$signal = @{
  signal = "${signalName}"
  timestamp = $timestamp
  data = $null
}

try {
  $parsed = $input_data | ConvertFrom-Json
  $signal.data = $parsed
} catch {
  # stdin wasn't valid JSON, that's OK
}

$signalJson = $signal | ConvertTo-Json -Depth 10 -Compress

$signalDir = "${signalDir}"
if (-not (Test-Path $signalDir)) {
  New-Item -ItemType Directory -Path $signalDir -Force | Out-Null
}

$signalFile = Join-Path $signalDir "${signalName}.json"
$signalJson | Out-File -FilePath $signalFile -Encoding utf8 -Force
`
}

/**
 * Sets up Copilot CLI hooks in a worktree directory.
 *
 * Creates:
 * - .github/hooks/hooks.json — hook configuration
 * - .github/hooks/hitl-session-end.ps1 — sessionEnd hook script
 * - .github/hooks/hitl-post-tool.ps1 — postToolUse hook script
 * - .hitl-signals/ — directory for signal files
 *
 * @param worktreePath Absolute path to the worktree
 */
export function setupHooks(worktreePath: string): void {
  const hooksDir = getHooksDir(worktreePath)
  const signalDir = getSignalDir(worktreePath)

  // Ensure directories exist
  mkdirSync(hooksDir, { recursive: true })
  mkdirSync(signalDir, { recursive: true })

  // Create hook scripts
  const sessionEndScript = createHookScript(worktreePath, SIGNAL_FILES.SESSION_END)
  const postToolScript = createHookScript(worktreePath, SIGNAL_FILES.SESSION_ACTIVE)

  const sessionEndPath = join(hooksDir, 'hitl-session-end.ps1')
  const postToolPath = join(hooksDir, 'hitl-post-tool.ps1')

  writeFileSync(sessionEndPath, sessionEndScript, 'utf-8')
  writeFileSync(postToolPath, postToolScript, 'utf-8')

  // Create hooks.json
  const hooksConfig: HooksConfig = {
    hooks: [
      {
        type: 'sessionEnd',
        command: `pwsh -File "${sessionEndPath.replace(/\\/g, '/')}"`,
      },
      {
        type: 'postToolUse',
        command: `pwsh -File "${postToolPath.replace(/\\/g, '/')}"`,
      },
    ],
  }

  const hooksJsonPath = join(hooksDir, 'hooks.json')
  writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2), 'utf-8')

  console.log(`[hooks] Set up hooks in ${hooksDir}`)
}

/**
 * Checks if hooks are already set up in a worktree.
 */
export function hasHooks(worktreePath: string): boolean {
  const hooksJsonPath = join(getHooksDir(worktreePath), 'hooks.json')
  return existsSync(hooksJsonPath)
}

/**
 * Adds hook-generated files to .gitignore if not already there.
 *
 * We don't want to commit signal files or HITL logs.
 */
export function ensureGitignore(worktreePath: string): void {
  const gitignorePath = join(worktreePath, '.gitignore')
  const entriesToAdd = ['.hitl-signals/', '.hitl-logs/', '.github/hooks/hitl-*.ps1']

  let content = ''
  if (existsSync(gitignorePath)) {
    const { readFileSync } = require('fs')
    content = readFileSync(gitignorePath, 'utf-8')
  }

  const lines = content.split('\n')
  let modified = false

  for (const entry of entriesToAdd) {
    if (!lines.some((l: string) => l.trim() === entry)) {
      lines.push(entry)
      modified = true
    }
  }

  if (modified) {
    writeFileSync(gitignorePath, lines.join('\n'), 'utf-8')
    console.log(`[hooks] Updated .gitignore in ${worktreePath}`)
  }
}
