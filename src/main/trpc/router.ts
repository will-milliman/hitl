import { initTRPC } from '@trpc/server';
import { exec, execFile } from 'child_process';
import { BrowserWindow } from 'electron';
import { join } from 'path';
import { z } from 'zod';

import { GRID_LABELS, GridState } from '../../shared/constants';
import { updateWorkItemState } from '../azure';
import {
  clearSignals,
  ensureGlobalHooks,
  getActiveWatcherCount,
  isWatching,
  openSessionInTerminal,
  spawnSession,
  startInteractiveSession,
  watchSignals,
} from '../copilot';
import { getCronStatus } from '../cron';
import { getAzureConfig } from '../cron/config';
import { cleanupCompletedTask } from '../cron/pr-check';
import { reconcileStates } from '../cron/state-reconciliation';
import { getDb } from '../db';
import {
  extractPrNumber,
  extractRepoFromPrUrl,
  findUnresolvedThreads,
  formatCommentsForPrompt,
  getPrReviewComments,
  getPullRequestByUrl,
  isGhAuthenticated,
} from '../github';
import { getLogDir, getRecentLogs, getSessionLogs, listLogFiles, readLogFile } from '../logger';
import type { LogLevel } from '../logger';
import { loadProfiles, loadSettings, updateSettings } from '../settings';
import { checkForUpdates, getUpdateStatus, installUpdate } from '../updater';
import { getCurrentBranch, listWorktrees, pruneWorktrees } from '../worktree';

const t = initTRPC.create();

export const appRouter = t.router({
  // ─── Queries ──────────────────────────────────────────

  /** Health check */
  health: t.procedure.query(() => {
    return { status: 'ok', timestamp: Date.now() };
  }),

  /** Get all stories (optionally filtered by planned status) */
  stories: t.procedure
    .input(
      z
        .object({
          planned: z.boolean().optional(),
          blocked: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const where: Record<string, unknown> = {};
      if (input?.planned !== undefined) where.planned = input.planned;
      if (input?.blocked !== undefined) where.blocked = input.blocked;
      return db.story.findMany({ where });
    }),

  /** Get all tasks (optionally filtered by state or storyId) */
  tasks: t.procedure
    .input(
      z
        .object({
          state: z.string().optional(),
          storyId: z.number().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const where: Record<string, unknown> = { removedFromSprint: false };
      if (input?.state) where.state = input.state;
      if (input?.storyId) where.storyId = input.storyId;
      return db.task.findMany({
        where,
        include: { story: true },
        orderBy: { createdAt: 'desc' },
      });
    }),

  /** Get available profiles */
  profiles: t.procedure.query(() => {
    return loadProfiles();
  }),

  /** Get grid labels */
  gridLabels: t.procedure.query(() => {
    return GRID_LABELS;
  }),

  /** Get cron state flags */
  cronState: t.procedure.query(async () => {
    const db = getDb();
    return db.cronState.findUnique({ where: { id: 1 } });
  }),

  /** Get live cron job status (running, idle, last run, errors) */
  cronStatus: t.procedure.query(async () => {
    const status = getCronStatus();
    const azureConfigured = getAzureConfig() !== null;
    const githubConfigured = await isGhAuthenticated();
    const activeWatchers = getActiveWatcherCount();
    return { ...status, azureConfigured, githubConfigured, activeWatchers };
  }),

  // ─── Mutations ────────────────────────────────────────

  /** Assign a profile to a task and advance it to COPILOT_KICKOFF */
  assignTaskProfile: t.procedure
    .input(
      z.object({
        taskId: z.number(),
        profileKey: z.string(),
        skipCopilot: z.boolean().optional(),
        model: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      // No longer push Azure Active state here — that happens on first Virtual Desktop open

      return db.task.update({
        where: { id: input.taskId },
        data: {
          profileKey: input.profileKey,
          state: GridState.COPILOT_KICKOFF,
          disabled: input.skipCopilot ? false : true, // If skipping copilot, don't disable (user acts manually)
          skipCopilot: input.skipCopilot ?? false,
          model: input.model ?? null,
        },
      });
    }),

  /** Mark a task as Non-HITL (doesn't need a PR or task execution) */
  markNonHitl: t.procedure.input(z.object({ taskId: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    return db.task.update({
      where: { id: input.taskId },
      data: { state: 'NON_HITL' },
    });
  }),

  /**
   * Complete story planning — validates that child tasks exist, then hides
   * the story from the Story Planning grid by setting planned = true.
   */
  completeStoryPlanning: t.procedure.input(z.object({ storyId: z.number() })).mutation(async ({ input }) => {
    const db = getDb();

    // Validate that child tasks exist for this story
    const childCount = await db.task.count({ where: { storyId: input.storyId } });
    if (childCount === 0) {
      throw new Error(
        `No tasks found for story #${input.storyId}. Create tasks in Azure DevOps before marking planning as complete.`,
      );
    }

    return db.story.update({
      where: { id: input.storyId },
      data: { planned: true },
    });
  }),

  /**
   * Reset a task back to Profile Assignment.
   *
   * Performs the same cleanup as task completion (detaches branch, parks
   * worktree, closes virtual desktop) but moves the task back to
   * PROFILE_ASSIGNMENT instead of COMPLETED, clearing all execution state.
   */
  resetTask: t.procedure.input(z.object({ taskId: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const task = await db.task.findUniqueOrThrow({ where: { id: input.taskId } });

    // Clean up resources (detach branch, park worktree, close virtual desktop)
    await cleanupCompletedTask(task.id, task.worktreePath);

    // Reset the task back to Profile Assignment with all execution state cleared
    return db.task.update({
      where: { id: input.taskId },
      data: {
        state: GridState.PROFILE_ASSIGNMENT,
        disabled: false,
        desktopOpen: false,
        profileKey: null,
        worktreePath: null,
        sessionId: null,
        model: null,
        prUrl: null,
        prMerged: false,
        prUpdated: false,
        skipCopilot: false,
        lastAgentResponse: null,
        completedAt: null,
        errorMessage: null,
        errorAt: null,
        previousState: null,
      },
    });
  }),

  /** Update a task's state and optional fields */
  updateTaskState: t.procedure
    .input(
      z.object({
        taskId: z.number(),
        state: z.string(),
        disabled: z.boolean().optional(),
        worktreePath: z.string().nullish(),
        sessionId: z.string().nullish(),
        prUrl: z.string().nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      const { taskId, ...data } = input;
      const db = getDb();
      return db.task.update({
        where: { id: taskId },
        data,
      });
    }),

  /** Update a task's disabled state */
  updateTaskDisabled: t.procedure
    .input(
      z.object({
        taskId: z.number(),
        disabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      return db.task.update({
        where: { id: input.taskId },
        data: { disabled: input.disabled },
      });
    }),

  /** Update a task's PR status (merged or updated) */
  updateTaskPrStatus: t.procedure
    .input(
      z.object({
        taskId: z.number(),
        prMerged: z.boolean().optional(),
        prUrl: z.string().nullish(),
        prUpdated: z.boolean().optional(),
        disabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { taskId, ...data } = input;
      const db = getDb();
      return db.task.update({
        where: { id: taskId },
        data,
      });
    }),

  /** Flag a task's PR as updated (triggers comment check on next cron tick) */
  markTaskPrUpdated: t.procedure.input(z.object({ taskId: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    return db.task.update({
      where: { id: input.taskId },
      data: { prUpdated: true },
    });
  }),

  /** Upsert a story (lightweight parent reference) */
  upsertStory: t.procedure
    .input(
      z.object({
        id: z.number(),
        title: z.string(),
        azureUrl: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      return db.story.upsert({
        where: { id: input.id },
        create: {
          id: input.id,
          title: input.title,
          azureUrl: input.azureUrl,
        },
        update: {
          title: input.title,
          azureUrl: input.azureUrl,
        },
      });
    }),

  /** Upsert a task */
  upsertTask: t.procedure
    .input(
      z.object({
        id: z.number(),
        title: z.string(),
        storyId: z.number().nullish(),
        azureUrl: z.string(),
        state: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      return db.task.upsert({
        where: { id: input.id },
        create: {
          id: input.id,
          title: input.title,
          storyId: input.storyId ?? undefined,
          azureUrl: input.azureUrl,
          state: input.state ?? 'PROFILE_ASSIGNMENT',
        },
        update: {
          title: input.title,
        },
      });
    }),

  /** Update cron state flags */
  updateCronState: t.procedure
    .input(
      z.object({
        syncEnabled: z.boolean().optional(),
        taskExecutionEnabled: z.boolean().optional(),
        prCheckEnabled: z.boolean().optional(),
        lastRunAt: z.date().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      return db.cronState.update({
        where: { id: 1 },
        data: input,
      });
    }),

  /** Reconcile all grid item states against Azure DevOps */
  syncStates: t.procedure.mutation(async () => {
    const result = await reconcileStates();
    return result;
  }),

  /** Open a path in VS Code (optionally opening a workspace file) */
  openInVSCode: t.procedure.input(z.object({ path: z.string(), workspace: z.string().nullish() })).mutation(async ({ input }) => {
    // If a workspace file is specified, open it instead of the folder
    const target = input.workspace ? join(input.path, input.workspace) : input.path;
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      exec(`code "${target}"`, { windowsHide: true }, (err) => {
        if (err) {
          console.error('[router] Failed to open VS Code:', err.message);
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  }),

  /** Open a path in Windows Terminal */
  openInTerminal: t.procedure.input(z.object({ path: z.string() })).mutation(async ({ input }) => {
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      exec(`wt -d "${input.path}"`, { windowsHide: true }, (err) => {
        if (err) {
          console.error('[router] Failed to open terminal:', err.message);
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  }),

  /** Open a URL in a new browser window (prevents stealing focus from the current virtual desktop) */
  openExternal: t.procedure.input(z.object({ url: z.string() })).mutation(async ({ input }) => {
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      exec(`start msedge --new-window "${input.url}"`, { windowsHide: true }, (err) => {
        if (err) {
          console.error('[router] Failed to open URL:', err.message);
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  }),

  /** Open multiple URLs in a single Edge browser window as tabs */
  openExternalBatch: t.procedure.input(z.object({ urls: z.array(z.string()).min(1) })).mutation(async ({ input }) => {
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      const quoted = input.urls.map((u) => `"${u}"`).join(' ');
      exec(`start msedge --new-window ${quoted}`, { windowsHide: true }, (err) => {
        if (err) {
          console.error('[router] Failed to open URLs:', err.message);
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  }),

  /** Create a new Windows 11 virtual desktop via PowerShell VirtualDesktop module */
  createVirtualDesktop: t.procedure
    .input(
      z
        .object({
          name: z.string().optional(),
          taskId: z.number().optional(),
          worktreePath: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ input }) => {
      // Resolve desktop name: prefer branch name from worktree, fall back to provided name
      let desktopName = input?.name;
      if (input?.worktreePath) {
        const branch = await getCurrentBranch(input.worktreePath);
        if (branch) desktopName = branch;
      }

      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        let ps1 = 'Import-Module VirtualDesktop; ';
        if (desktopName) {
          const safeName = desktopName.replace(/'/g, "''");
          ps1 += `New-Desktop | Set-DesktopName -Name '${safeName}' -PassThru | Switch-Desktop`;
        } else {
          ps1 += 'New-Desktop | Switch-Desktop';
        }

        exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps1}"`, { windowsHide: true }, async (err) => {
          if (err) {
            console.error('[router] Failed to create virtual desktop:', err.message);
            resolve({ success: false, error: err.message });
          } else {
            // Persist desktop-open state and name in the database
            if (input?.taskId) {
              try {
                const db = getDb();
                const task = await db.task.findUnique({
                  where: { id: input.taskId },
                  select: { desktopOpen: true, state: true },
                });

                // Push Azure "Active" state on first Virtual Desktop open for tasks in TASK_EXECUTION
                if (task && !task.desktopOpen && task.state === GridState.TASK_EXECUTION) {
                  const azureConfig = getAzureConfig();
                  if (azureConfig) {
                    try {
                      await updateWorkItemState(azureConfig, input.taskId, 'Active');
                    } catch (azureErr) {
                      console.error(`[router] Failed to update Azure state for task #${input.taskId}:`, azureErr);
                    }
                  }
                }

                await db.task.update({
                  where: { id: input.taskId },
                  data: { desktopOpen: true, desktopName: desktopName ?? null },
                });
              } catch (e) {
                console.error('[router] Failed to persist desktopOpen:', e);
              }
            }
            setTimeout(() => resolve({ success: true }), 1000);
          }
        });
      });
    }),

  /** Close a Windows 11 virtual desktop by name — closes all windows on it and removes it */
  closeVirtualDesktop: t.procedure
    .input(
      z.object({
        name: z.string().optional(),
        taskId: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Resolve desktop name: prefer DB-stored name, fall back to provided name
      let desktopName = input.name;
      if (input.taskId) {
        try {
          const db = getDb();
          const task = await db.task.findUnique({ where: { id: input.taskId }, select: { desktopName: true } });
          if (task?.desktopName) desktopName = task.desktopName;
        } catch (e) {
          console.error('[router] Failed to look up desktopName:', e);
        }
      }

      if (!desktopName) {
        return { success: false, error: 'No desktop name provided or found' };
      }

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

      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        execFile(
          'powershell',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps1],
          { windowsHide: true, timeout: 15_000 },
          async (err) => {
            if (err) {
              console.error('[router] Failed to close virtual desktop:', err.message);
              resolve({ success: false, error: err.message });
            } else {
              // Persist desktop-closed state in the database
              if (input.taskId) {
                try {
                  const db = getDb();
                  await db.task.update({
                    where: { id: input.taskId },
                    data: { desktopOpen: false, desktopName: null },
                  });
                } catch (e) {
                  console.error('[router] Failed to persist desktopOpen:', e);
                }
              }
              resolve({ success: true });
            }
          },
        );
      });
    }),

  // ─── Window Controls ─────────────────────────────────

  /** Check if the main window is maximized */
  windowIsMaximized: t.procedure.query(() => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return { maximized: win?.isMaximized() ?? false };
  }),

  /** Minimize the main window */
  windowMinimize: t.procedure.mutation(() => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    win?.minimize();
    return { success: true };
  }),

  /** Toggle maximize/restore on the main window */
  windowMaximize: t.procedure.mutation(() => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (win?.isMaximized()) {
      win.restore();
    } else {
      win?.maximize();
    }
    return { success: true };
  }),

  /** Close the main window */
  windowClose: t.procedure.mutation(() => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    win?.close();
    return { success: true };
  }),

  /** Open a copilot session in Windows Terminal */
  openSession: t.procedure
    .input(
      z.object({
        sessionId: z.string(),
        cwd: z.string(),
        taskId: z.number(),
      }),
    )
    .mutation(async ({ input }) => {
      const result = await openSessionInTerminal(input.sessionId, input.cwd);
      if (result.success) {
        // Clear stale signals so the watcher picks up fresh activity
        clearSignals(input.cwd);
        // Re-establish the signal watcher so we detect when the user
        // resumes prompting (postToolUse → session-active signal)
        watchSignals(input.cwd, 'task', input.taskId);
        // Mark as active immediately — the user is interacting
        const db = getDb();
        await db.task.update({
          where: { id: input.taskId },
          data: { disabled: true },
        });
      }
      return result;
    }),

  /** Start a fresh interactive copilot session in Windows Terminal (manual mode) */
  startCopilotSession: t.procedure
    .input(
      z.object({
        cwd: z.string(),
        taskId: z.number(),
      }),
    )
    .mutation(async ({ input }) => {
      const result = await startInteractiveSession(input.cwd);
      if (result.success && result.sessionId) {
        // Save session ID to database and mark as active
        const db = getDb();
        await db.task.update({
          where: { id: input.taskId },
          data: { sessionId: result.sessionId, disabled: true },
        });
        // Set up signal watcher so hooks update the disabled state
        clearSignals(input.cwd);
        watchSignals(input.cwd, 'task', input.taskId);
      }
      return result;
    }),

  /** Start a copilot session to fix PR issues (failing checks, unresolved comments) */
  startFixSession: t.procedure
    .input(
      z.object({
        taskId: z.number(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = await db.task.findUnique({ where: { id: input.taskId } });
      if (!task) throw new Error(`Task #${input.taskId} not found`);
      if (!task.worktreePath) throw new Error(`Task #${input.taskId} has no worktree`);
      if (!task.prUrl) throw new Error(`Task #${input.taskId} has no PR`);

      const worktreePath = task.worktreePath;
      const prUrl = task.prUrl;

      // Fetch PR details to understand what's wrong
      const pr = await getPullRequestByUrl(prUrl, worktreePath);

      // Build context about what needs fixing
      const issues: string[] = [];

      // Check for failing status checks
      if (pr.statusCheckRollup && pr.statusCheckRollup.length > 0) {
        const failing = pr.statusCheckRollup.filter(
          (check) => check.conclusion !== 'SUCCESS' && check.conclusion !== 'NEUTRAL' && check.conclusion !== 'SKIPPED',
        );
        if (failing.length > 0) {
          issues.push(
            `## Failing CI Checks\n\nThe following CI checks are failing:\n${failing.map((c) => `- **${c.conclusion ?? 'PENDING'}**: status=${c.status}`).join('\n')}\n\nPlease investigate the CI failures, fix the underlying issues, and push the changes.`,
          );
        }
      }

      // Check for review decision
      if (pr.reviewDecision === 'CHANGES_REQUESTED') {
        issues.push(`## Changes Requested\n\nReviewers have requested changes on this PR.`);
      }

      // Check for unresolved review comments
      const repoInfo = extractRepoFromPrUrl(prUrl);
      const prNumber = extractPrNumber(prUrl);
      if (repoInfo && prNumber) {
        const comments = await getPrReviewComments(worktreePath, repoInfo.owner, repoInfo.repo, prNumber);
        const unresolved = findUnresolvedThreads(comments, pr.author.login);
        if (unresolved.length > 0) {
          issues.push(formatCommentsForPrompt(unresolved));
        }
      }

      if (issues.length === 0) {
        issues.push(
          'The PR appears to have issues preventing it from being merged. Please review the PR and fix any problems you find.',
        );
      }

      const prompt = `You are fixing issues on an existing pull request.

Task #${task.id}: ${task.title}
PR: ${prUrl}

${issues.join('\n\n')}

After making your fixes:
1. Commit your changes with a clear message referencing Task #${task.id}.
2. Push your changes to update the PR.
3. Do NOT create a new pull request.`;

      // Mark task as disabled (agent working) and clear old session
      await db.task.update({
        where: { id: input.taskId },
        data: { disabled: true },
      });

      // Clear old signals and ensure hooks
      clearSignals(worktreePath);
      ensureGlobalHooks();

      // Spawn the fix session
      const { sessionId } = await spawnSession({
        cwd: worktreePath,
        prompt,
        model: task.model ?? undefined,
      });

      // Save session ID to database
      await db.task.update({
        where: { id: input.taskId },
        data: { sessionId },
      });

      // Start watching for signals
      if (!isWatching(worktreePath)) {
        watchSignals(worktreePath, 'task', input.taskId);
      }

      return { success: true, sessionId };
    }),

  /** List all worktrees for a given profile */
  listWorktrees: t.procedure.input(z.object({ profileKey: z.string() })).query(async ({ input }) => {
    const profiles = loadProfiles();
    const profile = profiles[input.profileKey];
    if (!profile) return [];

    try {
      await pruneWorktrees(profile.repoPath);
      return listWorktrees(profile.repoPath);
    } catch (err) {
      console.error('[router] Failed to list worktrees:', err);
      return [];
    }
  }),

  // ─── Logging ──────────────────────────────────────────

  /** Get recent log entries from the in-memory ring buffer */
  recentLogs: t.procedure
    .input(
      z
        .object({
          level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
          source: z.string().optional(),
          limit: z.number().optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      return getRecentLogs(input?.level as LogLevel | undefined, input?.source, input?.limit);
    }),

  /** List available log file dates */
  logDates: t.procedure.query(() => {
    return listLogFiles();
  }),

  /** Read log entries from a specific date */
  logsByDate: t.procedure.input(z.object({ date: z.string() })).query(({ input }) => {
    return readLogFile(input.date);
  }),

  /** Get the log directory path */
  logDir: t.procedure.query(() => {
    return getLogDir();
  }),

  /** Get copilot session logs for a worktree */
  sessionLogs: t.procedure.input(z.object({ worktreePath: z.string() })).query(({ input }) => {
    return getSessionLogs(input.worktreePath);
  }),

  // ─── Error Management ────────────────────────────────

  /** Clear error state on a task */
  clearTaskError: t.procedure.input(z.object({ taskId: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    return db.task.update({
      where: { id: input.taskId },
      data: {
        errorMessage: null,
        errorAt: null,
      },
    });
  }),

  /** Retry a task in ERROR state — moves it back to its previous state so the pipeline can resume */
  retryTask: t.procedure.input(z.object({ taskId: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const task = await db.task.findUniqueOrThrow({ where: { id: input.taskId } });

    if (task.state !== GridState.ERROR) {
      throw new Error(`Task #${input.taskId} is not in ERROR state (current: ${task.state})`);
    }

    // Restore to the state it was in before the error, defaulting to COPILOT_KICKOFF
    const restoreState = task.previousState ?? GridState.COPILOT_KICKOFF;

    return db.task.update({
      where: { id: input.taskId },
      data: {
        state: restoreState,
        previousState: null,
        errorMessage: null,
        errorAt: null,
      },
    });
  }),

  // ─── Settings ────────────────────────────────────────

  /** Get app settings */
  getSettings: t.procedure.query(() => {
    const settings = loadSettings();
    // Mask the PAT for security (only show last 4 chars)
    return {
      ...settings,
      azure: {
        ...settings.azure,
        pat: settings.azure.pat ? '•'.repeat(Math.max(0, settings.azure.pat.length - 4)) + settings.azure.pat.slice(-4) : '',
      },
    };
  }),

  /** Update app settings */
  saveSettings: t.procedure
    .input(
      z.object({
        azure: z
          .object({
            org: z.string(),
            project: z.string(),
            pat: z.string(),
            team: z.string(),
          })
          .optional(),
        cron: z
          .object({
            intervalSeconds: z.number().min(10).max(3600),
            idleThresholdSeconds: z.number().min(60).max(7200),
          })
          .optional(),
        profiles: z
          .record(
            z.object({
              repoPath: z.string(),
              defaultBranch: z.string(),
              description: z.string().optional(),
              workspace: z.string().optional(),
              setup: z
                .object({
                  cwd: z.string(),
                  command: z.string(),
                })
                .optional(),
            }),
          )
          .optional(),
        notifications: z
          .object({
            enabled: z.boolean(),
            prReviewNeeded: z.boolean(),
            taskCompleted: z.boolean(),
            cronErrors: z.boolean(),
          })
          .optional(),
        terminal: z
          .object({
            shell: z.enum(['pwsh', 'powershell', 'cmd']),
          })
          .optional(),
      }),
    )
    .mutation(({ input }) => {
      // If PAT is masked (starts with dots), don't overwrite the real PAT
      if (input.azure?.pat && input.azure.pat.startsWith('•')) {
        const current = loadSettings();
        input.azure.pat = current.azure.pat;
      }
      return updateSettings(input);
    }),

  // ─── Auto-Update ─────────────────────────────────────

  /** Get auto-update status */
  updateStatus: t.procedure.query(() => {
    return getUpdateStatus();
  }),

  /** Check for updates manually */
  checkForUpdates: t.procedure.mutation(async () => {
    await checkForUpdates();
    return { success: true };
  }),

  /** Install downloaded update (quits and restarts) */
  installUpdate: t.procedure.mutation(() => {
    installUpdate();
    return { success: true };
  }),
});

export type AppRouter = typeof appRouter;
