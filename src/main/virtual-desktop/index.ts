/**
 * Virtual desktop management.
 *
 * Provides shared functions for listing and closing Windows virtual desktops.
 * Used by both the tRPC router (user-initiated close) and the
 * cron pr-check step (automatic cleanup on task completion).
 *
 * Uses the PSVirtualDesktop PowerShell module (MScholtes/PSVirtualDesktop):
 * - Get-DesktopCount, Get-DesktopName — enumerate desktops by integer index
 * - Remove-Desktop, Switch-Desktop    — accept index, name string, or desktop object
 *
 * IMPORTANT: `Get-Desktop` returns only the *current* desktop (a single
 * VirtualDesktop.Desktop object without a `.Name` property). To enumerate
 * all desktops, iterate `0 .. (Get-DesktopCount - 1)` with `Get-DesktopName`.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { createLogger } from '../logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('virtual-desktop');

/**
 * Runs a PowerShell command with the VirtualDesktop module loaded.
 * Returns stdout on success, or null on failure.
 */
async function runPs(command: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Import-Module VirtualDesktop; ${command}`],
      { windowsHide: true, timeout: timeoutMs },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Lists all virtual desktop names currently open on this machine.
 *
 * Iterates by integer index using `Get-DesktopName -Desktop $i` for each
 * desktop from 0 to `Get-DesktopCount - 1`. This is the only reliable
 * way to enumerate names — `Get-Desktop` returns a single Desktop object
 * without a Name property.
 *
 * Returns `{ ok: true, names: [...] }` on success, or `{ ok: false, names: [] }`
 * if PowerShell failed (module not installed, timeout, etc.).
 *
 * Callers must check `ok` before acting on an empty `names` array —
 * an empty array with `ok: false` means "we don't know" (not "no desktops").
 */
export async function listDesktopNames(): Promise<{ ok: boolean; names: string[] }> {
  const ps1 = ['$c = Get-DesktopCount', 'for ($i = 0; $i -lt $c; $i++) { Get-DesktopName -Desktop $i }'].join('; ');

  const stdout = await runPs(ps1);
  if (stdout === null) return { ok: false, names: [] };

  const names = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: true, names };
}

/**
 * Builds the PowerShell script to remove a virtual desktop by name.
 *
 * By default, `Remove-Desktop` moves any windows on the removed desktop to
 * an adjacent one. To prevent that, we first enumerate all windows on the
 * desktop (via `Get-DesktopWindow`) and send each top-level owner window a
 * `WM_CLOSE` message (0x0010), giving apps a chance to exit gracefully.
 * After a short settle delay, any remaining windows' processes are killed
 * to guarantee nothing survives to be migrated to another desktop.
 *
 * @param desktopName  The display name of the virtual desktop to remove.
 * @param hardFail     If true, exit with code 1 when the desktop is not found.
 *                     If false, silently skip when the desktop is not found.
 */
function buildCloseScript(desktopName: string, hardFail: boolean): string {
  const safeName = desktopName.replace(/'/g, "''");
  const notFoundBranch = hardFail ? `Write-Error "Desktop '${safeName}' not found"; exit 1` : `exit 0`;

  // Find the desktop index by name (exact match).
  // We iterate all desktops because Remove-Desktop's string parameter does
  // a partial match which could hit the wrong desktop.
  //
  // Strategy to guarantee no windows get migrated to an adjacent desktop:
  //   1. Enumerate windows on the target desktop, collect their owning PIDs.
  //   2. Send WM_CLOSE to every window so apps can exit gracefully.
  //   3. Wait for graceful shutdown.
  //   4. Force-kill any surviving PIDs from pass 1.
  //   5. Re-enumerate (new windows may have appeared, e.g. child dialogs) and
  //      force-kill their owning PIDs too.
  //   6. Only once the desktop is confirmed empty, call Remove-Desktop.
  return [
    `Import-Module VirtualDesktop`,
    `$count = Get-DesktopCount`,
    `$idx = -1`,
    `for ($i = 0; $i -lt $count; $i++) { if ((Get-DesktopName -Desktop $i) -eq '${safeName}') { $idx = $i; break } }`,
    `if ($idx -lt 0) { ${notFoundBranch} }`,
    // Switch away first so the user isn't left on a dead desktop
    `try { Switch-Desktop -Desktop 0 } catch { }`,
    // Define a P/Invoke helper for PostMessage so we can send WM_CLOSE to each window.
    // Wrapped in try/Add-Type so re-invocations in the same session don't error.
    `try { Add-Type -Namespace Win32 -Name Native -MemberDefinition '[DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, System.IntPtr lParam); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);' -ErrorAction SilentlyContinue } catch { }`,
    `$selfPid = $PID`,
    // Helper: collect PIDs of all windows currently on the target desktop.
    `function Get-DesktopPids($desktopIdx) {`,
    `  $ids = @{}`,
    `  try {`,
    `    $wins = Get-DesktopWindow -Desktop $desktopIdx`,
    `    foreach ($h in $wins) {`,
    `      try { $pid2 = 0; [void][Win32.Native]::GetWindowThreadProcessId($h, [ref]$pid2); if ($pid2 -gt 0) { $ids[$pid2] = $true } } catch { }`,
    `    }`,
    `  } catch { }`,
    `  return $ids`,
    `}`,
    // Pass 1: collect PIDs, send WM_CLOSE to each window for graceful shutdown.
    `$procIds = Get-DesktopPids $idx`,
    `try {`,
    `  $wins = Get-DesktopWindow -Desktop $idx`,
    `  foreach ($h in $wins) {`,
    `    try { [void][Win32.Native]::PostMessage($h, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero) } catch { }`,
    `  }`,
    `} catch { }`,
    // Give apps time to close gracefully in response to WM_CLOSE.
    `Start-Sleep -Milliseconds 2000`,
    // Pass 2: force-kill any of the originally-collected PIDs that are still alive.
    `foreach ($killPid in $procIds.Keys) {`,
    `  if ($killPid -eq $selfPid) { continue }`,
    `  try { Stop-Process -Id $killPid -Force -ErrorAction SilentlyContinue } catch { }`,
    `}`,
    `Start-Sleep -Milliseconds 500`,
    // Pass 3: re-enumerate — any windows still on the desktop get their owning
    // processes killed. This catches child dialogs / secondary windows that
    // appeared after pass 1, and anything that ignored WM_CLOSE.
    `$remaining = Get-DesktopPids $idx`,
    `foreach ($killPid in $remaining.Keys) {`,
    `  if ($killPid -eq $selfPid) { continue }`,
    `  try { Stop-Process -Id $killPid -Force -ErrorAction SilentlyContinue } catch { }`,
    `}`,
    `Start-Sleep -Milliseconds 300`,
    // Finally, remove the (now empty) desktop.
    `try { Remove-Desktop -Desktop $idx } catch { }`,
  ].join('; ');
}

/**
 * Closes a virtual desktop by name.
 *
 * Finds the desktop by exact name match, switches to desktop 0,
 * then removes the desktop. Windows on the removed desktop are
 * automatically moved to an adjacent desktop by Windows.
 *
 * @param desktopName  The name of the desktop to close.
 * @param options.hardFail  If true, returns failure when the desktop is not found.
 *                          If false (default), silently succeeds when not found.
 */
export async function closeDesktop(
  desktopName: string,
  options: { hardFail?: boolean } = {},
): Promise<{ success: boolean; error?: string }> {
  const hardFail = options.hardFail ?? false;
  const ps1 = buildCloseScript(desktopName, hardFail);

  logger.info(`Closing virtual desktop "${desktopName}"`);

  try {
    await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps1], {
      windowsHide: true,
      timeout: 30_000,
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
