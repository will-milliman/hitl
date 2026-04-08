/**
 * Task PR check cron step.
 *
 * Runs on each cron tick (gated by `prCheckEnabled` flag). Handles:
 *
 * 1. **Draft PR Creation**: For tasks in TASK_EXECUTION that are done
 *    (disabled=false, sessionId set) with no PR yet, pushes the task
 *    branch and creates a **draft** PR. The task stays in TASK_EXECUTION
 *    so the human can review and iterate via the copilot session.
 *
 * 2. **Draft → Ready Detection**: For tasks in TASK_EXECUTION that have
 *    a draft PR, checks if the PR has been marked as ready for review.
 *    If no longer a draft, moves the task to PR_REVIEW.
 *
 * 3. **PR Merge/Close Detection + Cleanup**: For tasks in PR_REVIEW with a PR,
 *    checks if the PR has been merged or closed. If merged, moves the task to
 *    COMPLETED. If closed (without merge), moves the task to ABANDONED.
 *    In both cases, cleans up resources:
 *    - Detaches the git branch so the worktree can be reused
 *    - Parks the worktree (clears DB fields so it can be reused)
 *    - Closes all windows on the task's virtual desktop and removes it
 *
 * All GitHub operations use the `gh` CLI (authenticated via `gh auth login`).
 */
import { exec, execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { promisify } from 'util';

import { GridState } from '../../shared/constants';
import { getPrSummaryPath } from '../copilot';
import { getDb } from '../db';
import { createPullRequest, findPullRequest, getPullRequestByUrl, isGhAuthenticated, isPrReadyToMerge } from '../github';
import { createLogger } from '../logger';
import { notifyTaskCompleted } from '../notifications';
import { loadProfiles } from '../settings';
import { getCurrentBranch } from '../worktree';

const logger = createLogger('pr-check');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ─── PR summary helpers ─────────────────────────────────

interface PrSummary {
  /** Title extracted from the first `# ` heading */
  title: string;
  /** Everything after the heading */
  body: string;
}

/**
 * Reads the PR.md file that Copilot writes at the end of its session.
 *
 * Expected format:
 * ```
 * # <PR title>
 *
 * <markdown body>
 * ```
 *
 * Returns null if the file doesn't exist or can't be parsed.
 */
function readPrSummary(worktreePath: string): PrSummary | null {
  const summaryPath = getPrSummaryPath(worktreePath);

  if (!existsSync(summaryPath)) {
    logger.info('No PR.md found — Copilot did not write a PR summary');
    return null;
  }

  try {
    const content = readFileSync(summaryPath, 'utf-8').trim();
    if (!content) return null;

    // Extract title from first `# ` heading
    const match = content.match(/^#\s+(.+)/m);
    if (!match) {
      logger.warn('PR.md has no heading — using entire content as body');
      return null;
    }

    const title = match[1].trim();
    // Body is everything after the heading line
    const headingEnd = content.indexOf('\n', content.indexOf(match[0]));
    const body = headingEnd >= 0 ? content.slice(headingEnd + 1).trim() : '';

    return { title, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to read PR.md: ${message}`);
    return null;
  }
}

/**
 * Gets the default branch for a task's profile.
 */
function getDefaultBranch(profileKey: string | null): string {
  if (!profileKey) return 'main';
  try {
    const profiles = loadProfiles();
    return profiles[profileKey]?.defaultBranch ?? 'main';
  } catch {
    return 'main';
  }
}

/**
 * Pushes a branch to origin from a worktree.
 */
async function pushBranch(worktreePath: string, branchName: string): Promise<void> {
  logger.info(`Pushing ${branchName} from ${worktreePath}`);
  await execFileAsync('git', ['push', '-u', 'origin', branchName], {
    cwd: worktreePath,
    timeout: 60_000,
    windowsHide: true,
  });
}

/**
 * Step 1: Create draft PRs for tasks that have completed execution.
 *
 * Finds tasks where:
 * - Task is in TASK_EXECUTION state
 * - Task has a worktree and session (agent has worked)
 * - Task is not disabled (agent is done)
 * - Task has no prUrl yet
 */
async function createDraftPRs(): Promise<void> {
  const db = getDb();

  const tasks = await db.task.findMany({
    where: {
      state: GridState.TASK_EXECUTION,
      prUrl: null,
      disabled: false,
      sessionId: { not: null },
      worktreePath: { not: null },
    },
    include: {
      story: {
        select: { id: true, title: true },
      },
    },
  });

  if (tasks.length === 0) return;

  logger.info(`Found ${tasks.length} tasks needing draft PRs`);

  for (const task of tasks) {
    try {
      const worktreePath = task.worktreePath!;
      const defaultBranch = getDefaultBranch(task.profileKey);

      // Get the actual branch name from the worktree (may include keywords)
      const taskBranch = await getCurrentBranch(worktreePath);
      if (!taskBranch) {
        logger.warn(`Task #${task.id}: worktree has no branch (detached HEAD), skipping PR`);
        continue;
      }

      // Push the task branch
      await pushBranch(worktreePath, taskBranch);

      // Check if a PR already exists (maybe created by copilot or manually)
      const existing = await findPullRequest(worktreePath, taskBranch, defaultBranch);

      let prUrl: string;
      if (existing) {
        logger.info(`PR already exists for task #${task.id}: ${existing.url}`);
        prUrl = existing.url;
      } else {
        // Read the PR summary written by Copilot (PR.md)
        const summary = readPrSummary(worktreePath);

        const prTitle = summary?.title ?? `Task #${task.id}: ${task.title}`;
        const storyContext = task.story ? `\n**Story**: #${task.story.id} — ${task.story.title}\n` : '';

        const bodyParts: string[] = [];

        if (summary?.body) {
          bodyParts.push(summary.body, '');
        } else {
          bodyParts.push(`Implements changes for Task #${task.id}.`, '');
        }

        if (storyContext) bodyParts.push(storyContext);

        bodyParts.push('---', `AB#${task.id}`);

        const pr = await createPullRequest(worktreePath, {
          title: prTitle,
          body: bodyParts.filter(Boolean).join('\n'),
          head: taskBranch,
          base: defaultBranch,
          draft: true,
        });

        prUrl = pr.url;
        logger.info(`Created draft PR for task #${task.id}: ${prUrl}`);
      }

      // Save PR URL to database and close virtual desktop
      await db.task.update({
        where: { id: task.id },
        data: { prUrl },
      });

      // Auto-close virtual desktop when PR is detected (step 15 of flow)
      try {
        await closeVirtualDesktop(task.id);
        await db.task.update({
          where: { id: task.id },
          data: { desktopOpen: false, desktopName: null },
        });
        logger.info(`Task #${task.id}: virtual desktop closed after PR creation`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug(`Task #${task.id}: virtual desktop cleanup after PR: ${message}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to create draft PR for task #${task.id}: ${message}`);
    }
  }
}

/**
 * Step 2: Check if draft PRs have been marked as ready for review.
 *
 * For tasks in TASK_EXECUTION that have a prUrl, checks whether the
 * PR is still a draft. If the user has marked it as ready (no longer
 * a draft), moves the task to PR_REVIEW.
 */
async function checkDraftToReady(): Promise<void> {
  const db = getDb();

  const tasks = await db.task.findMany({
    where: {
      state: GridState.TASK_EXECUTION,
      prUrl: { not: null },
    },
  });

  if (tasks.length === 0) return;

  logger.info(`Checking draft status for ${tasks.length} task PRs`);

  for (const task of tasks) {
    try {
      const prUrl = task.prUrl!;
      const worktreePath = task.worktreePath!;

      const pr = await getPullRequestByUrl(prUrl, worktreePath);

      if (!pr.isDraft) {
        logger.info(`Task #${task.id} PR is no longer a draft — moving to PR_REVIEW`);

        await db.task.update({
          where: { id: task.id },
          data: { state: GridState.PR_REVIEW },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to check draft status for task #${task.id}: ${message}`);
    }
  }
}

/**
 * Closes all windows on a task's virtual desktop and removes the desktop.
 *
 * Virtual desktops are created with the name "Task #<id>" when the user
 * opens the task workspace. This function:
 * 1. Finds the desktop by name
 * 2. Gets all window handles on that desktop
 * 3. Sends WM_CLOSE to each window to close it gracefully
 * 4. Removes the virtual desktop
 *
 * Uses the PowerShell VirtualDesktop module. Failures are logged but
 * do not prevent the task from completing.
 */
async function closeVirtualDesktop(taskId: number): Promise<void> {
  // Look up the stored desktop name; fall back to legacy format
  const db = getDb();
  const task = await db.task.findUnique({ where: { id: taskId }, select: { desktopName: true } });
  const desktopName = task?.desktopName ?? `Task #${taskId}`;
  const safeName = desktopName.replace(/'/g, "''");

  // PowerShell script passed via execFile (bypasses cmd.exe, no double-quote issues).
  // 1. Defines Win32 helpers to close windows and look up their processes
  // 2. Finds the desktop by name
  // 3. Sends WM_CLOSE to all windows, waits, then force-kills remaining processes
  // 4. Removes the desktop
  const ps1 = [
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32Close { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, int wParam, int lParam); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }'`,
    `Import-Module VirtualDesktop`,
    `$desktop = Get-Desktop | Where-Object { $_.Name -eq '${safeName}' }`,
    `if ($desktop) {`,
    `  $handles = @($desktop | Get-DesktopWindow)`,
    `  $pids = @()`,
    `  foreach ($h in $handles) {`,
    `    try {`,
    `      $pid = 0`,
    `      [Win32Close]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null`,
    `      if ($pid -gt 0) { $pids += $pid }`,
    `      [Win32Close]::PostMessage($h, 0x0010, 0, 0) | Out-Null`,
    `    } catch { }`,
    `  }`,
    `  Start-Sleep -Milliseconds 2000`,
    `  $pids = $pids | Sort-Object -Unique`,
    `  foreach ($p in $pids) {`,
    `    try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch { }`,
    `  }`,
    `  Start-Sleep -Milliseconds 500`,
    `  try { $desktop | Remove-Desktop -ErrorAction SilentlyContinue } catch { }`,
    `}`,
  ].join('; ');

  logger.info(`Closing virtual desktop "${desktopName}"`);

  await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps1], {
    windowsHide: true,
    timeout: 15_000,
  });
}

/**
 * Cleans up resources for a completed task.
 *
 * 1. Detaches the git branch in the worktree (git checkout --detach) so the
 *    old task branch doesn't prevent the worktree from being reused.
 * 2. Parks the worktree by clearing worktreePath and sessionId in the DB.
 *    The worktree directory stays on disk so it can be reused by future tasks
 *    via findIdleWorktree().
 * 3. Closes the virtual desktop (and all windows on it) that was opened
 *    for this task, if one exists.
 *
 * Cleanup failures are logged but never block the COMPLETED transition —
 * the state change has already been committed before this is called.
 */
export async function cleanupCompletedTask(taskId: number, worktreePath: string | null): Promise<void> {
  const db = getDb();

  // Detach the git branch so the worktree can be reused with a new branch.
  // Must happen before clearing the DB fields (we need worktreePath).
  if (worktreePath) {
    try {
      await execFileAsync('git', ['checkout', '--detach'], {
        cwd: worktreePath,
        timeout: 15_000,
        windowsHide: true,
      });
      logger.info(`Task #${taskId}: branch detached in worktree`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Task #${taskId}: failed to detach branch: ${message}`);
    }
  }

  // Park the worktree — clear DB fields so it's available for reuse
  try {
    await db.task.update({
      where: { id: taskId },
      data: { worktreePath: null, sessionId: null, desktopOpen: false, desktopName: null },
    });
    logger.info(`Task #${taskId}: worktree parked (detached from task)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Task #${taskId}: failed to park worktree: ${message}`);
  }

  // Close virtual desktop and its windows
  try {
    await closeVirtualDesktop(taskId);
    logger.info(`Task #${taskId}: virtual desktop closed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // This is expected when no virtual desktop was opened for the task
    logger.debug(`Task #${taskId}: virtual desktop cleanup skipped: ${message}`);
  }
}

/**
 * Step 3: Update disabled state on PR_REVIEW tasks based on merge readiness.
 *
 * For tasks in PR_REVIEW with a PR, checks whether the PR is ready to
 * merge (all checks pass, reviews approved). Tasks are disabled when
 * the PR is NOT ready to merge yet, and enabled when it IS ready.
 */
async function updatePrReadiness(): Promise<void> {
  const db = getDb();

  const tasks = await db.task.findMany({
    where: {
      state: GridState.PR_REVIEW,
      prUrl: { not: null },
      prMerged: false,
    },
  });

  if (tasks.length === 0) return;

  for (const task of tasks) {
    try {
      const prUrl = task.prUrl!;
      const worktreePath = task.worktreePath!;

      const pr = await getPullRequestByUrl(prUrl, worktreePath);

      // Skip merged/closed PRs (handled by checkTaskPRMerges)
      if (pr.state === 'MERGED' || pr.state === 'CLOSED') continue;

      // If the PR has been converted back to a draft, move the task
      // back to TASK_EXECUTION so the developer can continue iterating.
      if (pr.isDraft) {
        logger.info(`Task #${task.id} PR has been converted back to draft — moving to TASK_EXECUTION`);
        await db.task.update({
          where: { id: task.id },
          data: { state: GridState.TASK_EXECUTION, disabled: false },
        });
        continue;
      }

      const ready = isPrReadyToMerge(pr);
      const shouldBeDisabled = !ready;

      // Only update if the disabled state needs to change
      if (task.disabled !== shouldBeDisabled) {
        logger.info(
          `Task #${task.id} PR ${ready ? 'is ready to merge' : 'is not ready to merge'} — ${shouldBeDisabled ? 'disabling' : 'enabling'}`,
        );
        await db.task.update({
          where: { id: task.id },
          data: { disabled: shouldBeDisabled },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to check PR readiness for task #${task.id}: ${message}`);
    }
  }
}

/**
 * Step 4: Check for merged or closed task PRs.
 *
 * For tasks with a PR, checks if the PR has been merged or closed.
 * If merged: moves the task to COMPLETED state.
 * If closed (without merge): moves the task to ABANDONED state.
 */
async function checkTaskPRMerges(): Promise<void> {
  const db = getDb();

  const tasks = await db.task.findMany({
    where: {
      state: GridState.PR_REVIEW,
      prUrl: { not: null },
      prMerged: false,
    },
  });

  if (tasks.length === 0) return;

  logger.info(`Checking merge status for ${tasks.length} task PRs`);

  for (const task of tasks) {
    try {
      const prUrl = task.prUrl!;
      const worktreePath = task.worktreePath!;

      // Get the PR state via gh pr view
      const pr = await getPullRequestByUrl(prUrl, worktreePath);

      if (pr.state === 'MERGED') {
        logger.info(`Task #${task.id} PR has been merged — moving to COMPLETED`);

        await db.task.update({
          where: { id: task.id },
          data: {
            state: GridState.COMPLETED,
            prMerged: true,
            disabled: true,
            completedAt: new Date(),
          },
        });

        notifyTaskCompleted(task.id, task.title);

        // Clean up resources (detach branch, park worktree, close virtual desktop)
        // Runs after the state transition is committed — failures won't
        // prevent the task from being marked as completed.
        await cleanupCompletedTask(task.id, task.worktreePath);
      } else if (pr.state === 'CLOSED') {
        logger.info(`Task #${task.id} PR has been closed — moving to ABANDONED`);

        await db.task.update({
          where: { id: task.id },
          data: {
            state: GridState.ABANDONED,
            disabled: true,
          },
        });

        // Clean up resources (detach branch, park worktree, close virtual desktop)
        await cleanupCompletedTask(task.id, task.worktreePath);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to check merge for task #${task.id}: ${message}`);
    }
  }
}

/**
 * Main entry point: runs all task PR check sub-steps.
 */
export async function runPrCheckStep(): Promise<void> {
  // Check gh CLI auth before doing anything
  const authenticated = await isGhAuthenticated();
  if (!authenticated) {
    logger.info('gh CLI not authenticated, skipping PR check step');
    return;
  }

  await createDraftPRs();
  await checkDraftToReady();
  await updatePrReadiness();
  await checkTaskPRMerges();
}
