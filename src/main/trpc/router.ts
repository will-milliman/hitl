import { initTRPC } from '@trpc/server';
import { exec } from 'child_process';
import { BrowserWindow } from 'electron';
import { join } from 'path';
import { z } from 'zod';

import { GRID_LABELS } from '../../shared/constants';
import { updateWorkItemState } from '../azure';
import { getActiveWatcherCount, openSessionInTerminal, startInteractiveSession } from '../copilot';
import { getCronStatus } from '../cron';
import { getAzureConfig } from '../cron/config';
import { getDb } from '../db';
import { isGhAuthenticated } from '../github';
import { getLogDir, getRecentLogs, getSessionLogs, listLogFiles, readLogFile } from '../logger';
import type { LogLevel } from '../logger';
import { loadProfiles, loadSettings, updateSettings } from '../settings';
import { checkForUpdates, getUpdateStatus, installUpdate } from '../updater';
import { listWorktrees, pruneWorktrees } from '../worktree';

const t = initTRPC.create();

export const appRouter = t.router({
  // ─── Queries ──────────────────────────────────────────

  /** Health check */
  health: t.procedure.query(() => {
    return { status: 'ok', timestamp: Date.now() };
  }),

  /** Get all stories (lightweight parent references) */
  stories: t.procedure.query(async () => {
    const db = getDb();
    return db.story.findMany();
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
      const where: Record<string, unknown> = {};
      if (input?.state) where.state = input.state;
      if (input?.storyId) where.storyId = input.storyId;
      return db.task.findMany({
        where,
        include: { story: true },
        orderBy: { updatedAt: 'desc' },
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

  /** Assign a profile to a task and advance it to TASK_EXECUTION */
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

      // Move work item from New to Active in Azure DevOps
      const azureConfig = getAzureConfig();
      if (azureConfig) {
        try {
          await updateWorkItemState(azureConfig, input.taskId, 'Active');
        } catch (err) {
          console.error(`[router] Failed to update Azure DevOps state for task #${input.taskId}:`, err);
          // Non-blocking: continue with local state transition even if Azure update fails
        }
      }

      return db.task.update({
        where: { id: input.taskId },
        data: {
          profileKey: input.profileKey,
          state: 'TASK_EXECUTION',
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

  /** Create a new Windows 11 virtual desktop via PowerShell VirtualDesktop module */
  createVirtualDesktop: t.procedure
    .input(
      z
        .object({
          name: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ input }) => {
      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        const name = input?.name;
        let ps1 = 'Import-Module VirtualDesktop; ';
        if (name) {
          const safeName = name.replace(/'/g, "''");
          ps1 += `New-Desktop | Set-DesktopName -Name '${safeName}' -PassThru | Switch-Desktop`;
        } else {
          ps1 += 'New-Desktop | Switch-Desktop';
        }

        exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps1}"`, { windowsHide: true }, (err) => {
          if (err) {
            console.error('[router] Failed to create virtual desktop:', err.message);
            resolve({ success: false, error: err.message });
          } else {
            setTimeout(() => resolve({ success: true }), 1000);
          }
        });
      });
    }),

  /** Close a Windows 11 virtual desktop by name — closes all windows on it and removes it */
  closeVirtualDesktop: t.procedure
    .input(
      z.object({
        name: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const safeName = input.name.replace(/'/g, "''");
      const ps1 = [
        `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32Close { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, int wParam, int lParam); }'`,
        `Import-Module VirtualDesktop`,
        `$desktop = Get-Desktop | Where-Object { $_.Name -eq '${safeName}' }`,
        `if ($desktop) {`,
        `  $handles = $desktop | Get-DesktopWindow`,
        `  foreach ($h in $handles) {`,
        `    try { [Win32Close]::PostMessage($h, 0x0010, 0, 0) } catch { }`,
        `  }`,
        `  Start-Sleep -Milliseconds 1000`,
        `  $desktop | Remove-Desktop`,
        `}`,
      ].join('; ');

      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps1}"`, { windowsHide: true, timeout: 15_000 }, (err) => {
          if (err) {
            console.error('[router] Failed to close virtual desktop:', err.message);
            resolve({ success: false, error: err.message });
          } else {
            resolve({ success: true });
          }
        });
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
      }),
    )
    .mutation(async ({ input }) => {
      return openSessionInTerminal(input.sessionId, input.cwd);
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
        // Save session ID to database
        const db = getDb();
        await db.task.update({
          where: { id: input.taskId },
          data: { sessionId: result.sessionId },
        });
      }
      return result;
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
