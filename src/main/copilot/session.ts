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
 *
 * Log and signal directories are stored outside the worktree to avoid
 * polluting the repo with HITL-specific files. They are placed in
 * the app's temp directory under `.hitl-data/<worktree-name>/`.
 */
import { exec, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync as unlinkFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { promisify } from 'util';

import { loadSettings } from '../settings';

const execAsync = promisify(exec);

/** Default tools to allow in copilot sessions */
const DEFAULT_ALLOWED_TOOLS = 'write, shell(git:*), shell(npm:*), shell(npx:*)';

/** Base directory for HITL worktree data (logs, signals) outside worktrees */
const HITL_DATA_BASE = join(tmpdir(), '.hitl-data');

/** Subdirectory name for copilot logs */
const LOGS_SUBDIR = 'logs';

/** Subdirectory name for signal files */
const SIGNALS_SUBDIR = 'signals';

/** Subdirectory name for FE validation screenshots */
const SCREENSHOTS_SUBDIR = 'screenshots';

/** File name for the PR summary written by Copilot at end of session */
const PR_SUMMARY_FILE = 'PR.md';

/**
 * Gets the external data directory for a worktree.
 *
 * Maps a worktree path to a directory outside the worktree for storing
 * HITL-specific data (logs, signals) that should not be committed.
 *
 * Uses the worktree folder name as the subdirectory (e.g., `rainier-1`).
 */
export function getWorktreeDataDir(worktreePath: string): string {
  const worktreeName = basename(worktreePath);
  return join(HITL_DATA_BASE, worktreeName);
}

/**
 * Gets the log directory path for a worktree (outside the worktree).
 */
export function getLogDir(worktreePath: string): string {
  return join(getWorktreeDataDir(worktreePath), LOGS_SUBDIR);
}

/**
 * Gets the signal directory path for a worktree (outside the worktree).
 */
export function getSignalDir(worktreePath: string): string {
  return join(getWorktreeDataDir(worktreePath), SIGNALS_SUBDIR);
}

/**
 * Gets the screenshots directory path for a worktree (outside the worktree).
 * Used for FE validation — Copilot saves screenshots here.
 */
export function getScreenshotsDir(worktreePath: string): string {
  return join(getWorktreeDataDir(worktreePath), SCREENSHOTS_SUBDIR);
}

/**
 * Gets the path where Copilot should write its PR summary (PR.md).
 * Lives alongside logs/signals/screenshots in the worktree data dir.
 */
export function getPrSummaryPath(worktreePath: string): string {
  return join(getWorktreeDataDir(worktreePath), PR_SUMMARY_FILE);
}

/** Signal file names written by hooks */
export const SIGNAL_FILES = {
  SESSION_IDLE: 'session-idle',
  SESSION_ACTIVE: 'session-active',
  SESSION_END: 'session-end',
} as const;

export interface SpawnSessionOptions {
  /** The working directory (worktree path) */
  cwd: string;
  /** The prompt to send to copilot */
  prompt: string;
  /** Additional tools to allow (merged with defaults) */
  allowTools?: string;
  /** Whether to run in silent mode */
  silent?: boolean;
  /** Model to use for the session (e.g. 'claude-opus-4.6') */
  model?: string;
}

export interface SpawnSessionResult {
  /** The session ID extracted from the log file */
  sessionId: string;
  /** Path to the log directory */
  logDir: string;
}

/**
 * Ensures the logs, signals, and screenshots directories exist for a worktree.
 * These are stored outside the worktree in a temp directory.
 */
export function ensureDirs(worktreePath: string): { logDir: string; signalDir: string; screenshotsDir: string } {
  const logDir = getLogDir(worktreePath);
  const signalDir = getSignalDir(worktreePath);
  const screenshotsDir = getScreenshotsDir(worktreePath);

  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  if (!existsSync(signalDir)) mkdirSync(signalDir, { recursive: true });
  if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true });

  return { logDir, signalDir, screenshotsDir };
}

/**
 * Extracts the session ID from a copilot log directory.
 *
 * After spawning copilot with --log-dir, a new log file is created.
 * The session ID (a UUID) is found on the first line of the log file
 * in the format: `... Workspace initialized: <uuid> ...`
 *
 * We poll for the log file since it may take a moment to appear,
 * then read the first line to extract the UUID.
 */
export async function extractSessionId(
  logDir: string,
  existingFiles: Set<string>,
  timeoutMs = 30_000,
  pollMs = 500,
): Promise<string> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const files = readdirSync(logDir);
      const newFiles = files.filter((f) => !existingFiles.has(f));

      if (newFiles.length > 0) {
        // Sort to get the newest file
        const logFile = newFiles.sort().pop()!;
        const logPath = join(logDir, logFile);

        // Read the log file and look for the session ID (UUID) on the first line
        // Format: "... Workspace initialized: <uuid> ..."
        try {
          const content = readFileSync(logPath, 'utf-8');
          const uuidMatch = content.match(
            /Workspace initialized:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
          );
          if (uuidMatch) {
            return uuidMatch[1];
          }
        } catch {
          // File might still be written to, keep polling
        }
      }
    } catch {
      // Directory might not exist yet, keep polling
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(`[copilot] Timed out waiting for session ID in ${logDir}`);
}

/**
 * Gets the set of existing log files in a directory.
 * Used to detect new files after spawning.
 */
export function getExistingLogFiles(logDir: string): Set<string> {
  try {
    return new Set(readdirSync(logDir));
  } catch {
    return new Set();
  }
}

/** Cached absolute path to the copilot CLI script */
let copilotPath: string | null = null;

/**
 * Resolves the absolute path to the copilot CLI.
 *
 * The copilot CLI is a .ps1 script installed by VS Code's Copilot extension.
 * We resolve it once and cache the result so detached child processes
 * don't depend on PATH resolution.
 */
async function resolveCopilotPath(): Promise<string> {
  if (copilotPath) return copilotPath;

  try {
    const { stdout } = await execAsync('powershell -NoProfile -Command "(Get-Command copilot -ErrorAction Stop).Source"', {
      windowsHide: true,
    });
    copilotPath = stdout.trim();
    console.log(`[copilot] Resolved copilot CLI path: ${copilotPath}`);
    return copilotPath;
  } catch (err) {
    throw new Error(`[copilot] Could not resolve copilot CLI path. Is it installed? ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Spawns a new Copilot CLI session.
 *
 * The session runs detached so it persists independently.
 * The session ID is extracted from the log file.
 */
export async function spawnSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
  const { cwd, prompt, allowTools, silent = true, model } = options;
  const { logDir } = ensureDirs(cwd);

  // Resolve the absolute path to the copilot CLI
  const copilotBin = await resolveCopilotPath();

  // Snapshot existing log files so we can detect the new one
  const existingFiles = getExistingLogFiles(logDir);

  // Write the prompt to a temporary file to avoid shell escaping issues
  // with multiline strings on Windows (cmd.exe breaks on newlines)
  const promptFile = join(tmpdir(), `hitl-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(promptFile, prompt, 'utf-8');

  console.log(`[copilot] Spawning session in ${cwd}`);
  console.log(`[copilot] Prompt written to ${promptFile}`);

  // Write a wrapper script that reads the prompt file and invokes copilot.
  // Key details:
  // - Uses the absolute path to copilot CLI (avoids PATH resolution issues)
  // - Wraps $prompt in double-quotes to preserve the full multiline string
  // - Runs copilot via & operator for .ps1 script execution
  const wrapperScript = join(tmpdir(), `hitl-copilot-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  const copilotPathEscaped = copilotBin.replace(/'/g, "''");
  const logDirEscaped = logDir.replace(/'/g, "''");
  const toolsEscaped = (allowTools ?? DEFAULT_ALLOWED_TOOLS).replace(/'/g, "''");
  const promptFileEscaped = promptFile.replace(/'/g, "''");

  // Build optional CLI flags
  const modelFlag = model ? ` --model '${model.replace(/'/g, "''")}'` : '';

  const scriptContent = `$ErrorActionPreference = 'Continue'
$prompt = Get-Content -Raw '${promptFileEscaped}'
$prompt = $prompt.Trim()
try {
  & '${copilotPathEscaped}' -p "$prompt" --log-dir '${logDirEscaped}' --no-ask-user --allow-tool '${toolsEscaped}'${silent ? ' -s' : ''}${modelFlag}
} catch {
  $_ | Out-File -FilePath '${logDirEscaped}\\hitl-spawn-error.log' -Encoding utf8
}
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  "Exit code: $LASTEXITCODE" | Out-File -FilePath '${logDirEscaped}\\hitl-spawn-error.log' -Encoding utf8 -Append
}
`;
  writeFileSync(wrapperScript, scriptContent, 'utf-8');

  console.log(`[copilot] Wrapper script written to ${wrapperScript}`);

  // Spawn the copilot session as an independent background process.
  //
  // On Windows, Node.js `spawn` with `detached: true` causes PowerShell
  // scripts to exit immediately without executing. Instead, we use
  // `cmd /c start /b` which properly starts the process in the background.
  // The /b flag prevents opening a new window while allowing the process
  // to outlive the parent (Electron).
  const child = spawn(
    'cmd',
    ['/c', 'start', '/b', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperScript],
    {
      cwd,
      detached: false,
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    },
  );

  // Unref so HITL can exit without waiting for cmd (which returns immediately)
  child.unref();

  child.on('error', (err) => {
    console.error(`[copilot] Failed to spawn session: ${err.message}`);
    // Clean up temp files on error
    try {
      unlinkFileSync(promptFile);
    } catch {
      // Best-effort cleanup — file may already be gone
    }
    try {
      unlinkFileSync(wrapperScript);
    } catch {
      // Best-effort cleanup — file may already be gone
    }
  });

  // Wait for the session ID to appear in the log directory
  let sessionId: string;
  try {
    sessionId = await extractSessionId(logDir, existingFiles);
  } catch (err) {
    // Clean up temp files on timeout/failure
    // The prompt file is safe to delete (already read by wrapper script)
    try {
      unlinkFileSync(promptFile);
    } catch {
      // Best-effort cleanup — file may already be gone
    }
    // Don't delete the wrapper script — it may still be running
    throw err;
  }

  // Clean up temp files after session starts successfully
  // The prompt file has been read, and the wrapper script has started copilot
  try {
    unlinkFileSync(promptFile);
  } catch {
    // Best-effort cleanup — file may already be gone
  }

  console.log(`[copilot] Session started: ${sessionId}`);

  return { sessionId, logDir };
}

/**
 * Starts an interactive copilot session in Windows Terminal.
 *
 * Unlike `spawnSession`, this opens copilot in a visible terminal
 * window (no prompt, no automated flags) for manual human use.
 * The session ID is captured from the log directory.
 *
 * Used when the user has opted out of automatic copilot execution
 * but still wants to work with copilot in the worktree.
 */
export async function startInteractiveSession(cwd: string): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  try {
    const { logDir } = ensureDirs(cwd);
    const copilotBin = await resolveCopilotPath();
    const { terminal } = loadSettings();
    const shell = terminal.shell;

    // Snapshot existing log files so we can detect the new one
    const existingFiles = getExistingLogFiles(logDir);

    const logDirEscaped = logDir.replace(/"/g, '\\"');

    let cmd: string;
    if (shell === 'cmd') {
      cmd = `wt new-tab -d "${cwd}" -- cmd /k "copilot --log-dir "${logDirEscaped}""`;
    } else {
      // pwsh or powershell — copilot CLI is a .ps1 script, needs & invocation
      cmd = `wt new-tab -d "${cwd}" -- ${shell} -ExecutionPolicy Bypass -NoExit -Command "& '${copilotBin}' --log-dir '${logDir}'"`;
    }

    await execAsync(cmd, { windowsHide: true });

    // Wait for the session ID to appear in the log directory
    const sessionId = await extractSessionId(logDir, existingFiles);

    return { success: true, sessionId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[copilot] Failed to start interactive session: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Opens a copilot session in Windows Terminal for human interaction.
 *
 * Uses `copilot --resume SESSION-ID` in the worktree directory.
 * The shell used depends on the `terminal.shell` setting:
 * - pwsh/powershell: runs copilot via `& 'path'` invocation (required for .ps1 scripts)
 * - cmd: runs copilot directly (relies on PATH / .cmd shim)
 */
export async function openSessionInTerminal(sessionId: string, cwd: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { terminal } = loadSettings();
    const shell = terminal.shell;

    let cmd: string;
    if (shell === 'cmd') {
      cmd = `wt new-tab -d "${cwd}" -- cmd /k "copilot --resume ${sessionId}"`;
    } else {
      // pwsh or powershell — copilot CLI is a .ps1 script, needs & invocation
      const copilotBin = await resolveCopilotPath();
      cmd = `wt new-tab -d "${cwd}" -- ${shell} -ExecutionPolicy Bypass -NoExit -Command "& '${copilotBin}' --resume ${sessionId}"`;
    }

    await execAsync(cmd, { windowsHide: true });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[copilot] Failed to open session in terminal: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Reads the latest signal file for a worktree.
 *
 * Returns the signal type and timestamp, or null if no signal exists.
 */
export function readLatestSignal(
  worktreePath: string,
): { signal: string; timestamp: number; data?: Record<string, unknown> } | null {
  const signalDir = getSignalDir(worktreePath);

  if (!existsSync(signalDir)) return null;

  try {
    const files = readdirSync(signalDir);
    if (files.length === 0) return null;

    // Get the most recently modified file
    let latestFile = '';
    let latestMtime = 0;

    for (const file of files) {
      try {
        const fullPath = join(signalDir, file);
        const content = readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(content);
        const mtime = parsed.timestamp ?? 0;

        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestFile = file;
        }
      } catch {
        // Skip malformed signal files
      }
    }

    if (!latestFile) return null;

    const content = readFileSync(join(signalDir, latestFile), 'utf-8');
    const parsed = JSON.parse(content);
    return {
      signal: parsed.signal ?? latestFile,
      timestamp: parsed.timestamp ?? 0,
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

/**
 * Clears all signal files for a worktree.
 */
export function clearSignals(worktreePath: string): void {
  const signalDir = getSignalDir(worktreePath);
  if (!existsSync(signalDir)) return;

  const { unlinkSync } = require('fs');
  try {
    for (const file of readdirSync(signalDir)) {
      unlinkSync(join(signalDir, file));
    }
  } catch (err) {
    console.error(`[copilot] Failed to clear signals in ${signalDir}:`, err);
  }
}
