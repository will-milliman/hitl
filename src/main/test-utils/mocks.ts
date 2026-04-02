/**
 * Reusable module mock factories for testing.
 *
 * Each factory returns a mock object matching the module's exports.
 * Use with vi.mock() in test files:
 *
 *   vi.mock('../db', () => mockDbModule())
 *   vi.mock('../github', () => mockGitHubModule())
 *
 * All mocks use vi.fn() so you can set return values and assert calls:
 *
 *   const { isGhAuthenticated } = await import('../github')
 *   vi.mocked(isGhAuthenticated).mockResolvedValue(true)
 */
import { vi } from 'vitest';

// ─── Logger Mock ───────────────────────────────────────────

/** Mock for ../logger — suppresses all log output during tests. */
export function mockLoggerModule() {
  return {
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
}

// ─── Database Mock ─────────────────────────────────────────

/**
 * Creates a mock Prisma client with vi.fn() stubs for all models.
 *
 * For unit tests: use this to control DB responses.
 * For integration tests: use the real test DB from ./db.ts instead.
 */
export function createMockPrismaClient() {
  return {
    story: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    task: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    cronState: {
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  };
}

/**
 * Mock for ../db module.
 * Returns a module with a getDb() that returns a mock Prisma client.
 *
 * Usage:
 *   const mockDb = createMockPrismaClient()
 *   vi.mock('../db', () => mockDbModule(mockDb))
 */
export function mockDbModule(mockClient?: ReturnType<typeof createMockPrismaClient>) {
  const client = mockClient ?? createMockPrismaClient();
  return {
    getDb: vi.fn(() => client),
    initDatabase: vi.fn().mockResolvedValue(client),
    closeDatabase: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── GitHub Module Mock ────────────────────────────────────

/** Mock for ../github module (all gh CLI operations). */
export function mockGitHubModule() {
  return {
    isGhAuthenticated: vi.fn().mockResolvedValue(true),
    getRepoInfo: vi.fn(),
    parseRemoteUrl: vi.fn(),
    createPullRequest: vi.fn(),
    getPullRequest: vi.fn(),
    getPullRequestByUrl: vi.fn(),
    findPullRequest: vi.fn().mockResolvedValue(null),
    isPrMerged: vi.fn().mockResolvedValue(false),
    extractPrNumber: vi.fn(),
    extractRepoFromPrUrl: vi.fn(),
    getPrReviewComments: vi.fn().mockResolvedValue([]),
    getPrIssueComments: vi.fn().mockResolvedValue([]),
    findUnresolvedThreads: vi.fn().mockReturnValue([]),
    formatCommentsForPrompt: vi.fn().mockReturnValue(''),
  };
}

// ─── Azure DevOps Module Mock ──────────────────────────────

/** Mock for ../azure module (all Azure DevOps REST API calls). */
export function mockAzureModule() {
  return {
    queryWiql: vi.fn().mockResolvedValue({ workItems: [] }),
    getWorkItems: vi.fn().mockResolvedValue([]),
    workItemUrl: vi.fn(
      (org: string, project: string, id: number) => `https://dev.azure.com/${org}/${project}/_workitems/edit/${id}`,
    ),
    buildSprintTasksQuery: vi.fn().mockReturnValue('SELECT [System.Id] FROM WorkItems'),
    buildSprintStoriesQuery: vi.fn().mockReturnValue('SELECT [System.Id] FROM WorkItems'),
  };
}

// ─── Copilot Module Mock ───────────────────────────────────

/** Mock for ../copilot module (session spawning, hooks, watcher). */
export function mockCopilotModule() {
  return {
    spawnSession: vi.fn().mockResolvedValue({
      sessionId: 'test-session-id',
      logDir: '/tmp/test-logs',
    }),
    openSessionInTerminal: vi.fn().mockResolvedValue({ success: true }),
    extractSessionId: vi.fn().mockResolvedValue('test-session-id'),
    readLatestSignal: vi.fn().mockReturnValue(null),
    clearSignals: vi.fn(),
    ensureDirs: vi.fn().mockReturnValue({
      logDir: '/tmp/test-logs',
      signalDir: '/tmp/test-signals',
    }),
    getLogDir: vi.fn().mockReturnValue('/tmp/test-logs'),
    SIGNAL_FILES: {
      SESSION_IDLE: 'session-idle.json',
      SESSION_ACTIVE: 'session-active.json',
      SESSION_END: 'session-end.json',
    },
    ensureGlobalHooks: vi.fn(),
    watchSignals: vi.fn(),
    unwatchSignals: vi.fn(),
    unwatchAll: vi.fn(),
    getActiveWatcherCount: vi.fn().mockReturnValue(0),
    isWatching: vi.fn().mockReturnValue(false),
  };
}

// ─── Worktree Module Mock ──────────────────────────────────

/** Mock for ../worktree module (git worktree operations). */
export function mockWorktreeModule() {
  return {
    listWorktrees: vi.fn().mockResolvedValue([]),
    getWorktreesDir: vi.fn((repoPath: string) => `${repoPath}-worktrees`),
    getNextWorktreePath: vi.fn((repoPath: string) => `${repoPath}-worktrees/repo-1`),
    getBranchName: vi.fn((type: string, workItemId: number) => `${type}/${workItemId}`),
    findIdleWorktree: vi.fn().mockResolvedValue(null),
    createWorktree: vi.fn().mockResolvedValue('/tmp/test-worktree'),
    createTaskWorktree: vi.fn().mockResolvedValue('/tmp/test-worktree'),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    pruneWorktrees: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Settings Module Mock ──────────────────────────────────

/** Mock for ../settings module. */
export function mockSettingsModule() {
  return {
    loadSettings: vi.fn().mockReturnValue({
      azure: {},
      cron: {},
      profiles: {
        integrate: {
          repoPath: 'C:/repos/test-repo',
          defaultBranch: 'main',
          description: 'Test profile',
        },
      },
      notifications: {
        enabled: false,
        prReviewNeeded: false,
        taskCompleted: false,
        cronErrors: false,
      },
      terminal: { shell: 'powershell' },
    }),
    saveSettings: vi.fn(),
    updateSettings: vi.fn(),
    clearSettingsCache: vi.fn(),
    loadProfiles: vi.fn().mockReturnValue({
      integrate: {
        repoPath: 'C:/repos/test-repo',
        defaultBranch: 'main',
        description: 'Test profile',
      },
    }),
  };
}

// ─── Notifications Module Mock ─────────────────────────────

/** Mock for ../notifications module. */
export function mockNotificationsModule() {
  return {
    notifyPrReviewNeeded: vi.fn(),
    notifyTaskCompleted: vi.fn(),
    notifyCronError: vi.fn(),
  };
}

// ─── Cron Config Mock ──────────────────────────────────────

/** Mock for ./config (cron config loader). */
export function mockCronConfigModule() {
  return {
    getAzureConfig: vi.fn().mockReturnValue({
      org: 'test-org',
      project: 'test-project',
      pat: 'test-pat',
      teamId: 'test-team',
    }),
    clearConfigCache: vi.fn(),
  };
}

// ─── Electron Module Mock ──────────────────────────────────

/** Mock for 'electron' module. */
export function mockElectronModule() {
  return {
    app: {
      getPath: vi.fn().mockReturnValue('/tmp/test-hitl'),
      isPackaged: false,
      whenReady: vi.fn().mockResolvedValue(undefined),
    },
    powerMonitor: {
      getSystemIdleState: vi.fn().mockReturnValue('active'),
    },
    Notification: vi.fn().mockImplementation(() => ({
      show: vi.fn(),
      on: vi.fn(),
    })),
    BrowserWindow: {
      getAllWindows: vi.fn().mockReturnValue([]),
    },
  };
}

// ─── child_process Mock (for pr-check's execFile) ──────────

/** Mock for 'child_process' module. */
export function mockChildProcessModule() {
  return {
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
      cb(null, { stdout: '', stderr: '' });
    }),
  };
}

// ─── fs Mock (for task-execution's existsSync) ─────────────

/** Mock for 'fs' module — only stubs commonly used functions. */
export function mockFsModule() {
  return {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn().mockReturnValue('/tmp/test'),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    rmSync: vi.fn(),
    watch: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
    appendFileSync: vi.fn(),
  };
}
