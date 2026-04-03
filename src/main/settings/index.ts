/**
 * Settings store — persists app settings to a JSON file in userData.
 *
 * Settings that were previously in .env (Azure DevOps config) are now
 * editable via the Settings UI and stored here. On startup, env vars
 * still work as fallback defaults if settings haven't been configured.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { createLogger } from '../logger';

const logger = createLogger('settings');

export interface AppSettings {
  // Azure DevOps
  azure: {
    org: string;
    project: string;
    pat: string;
    team: string;
  };

  // Cron
  cron: {
    intervalSeconds: number;
    idleThresholdSeconds: number;
  };

  // Profiles (mirrors profile.json but editable)
  profiles: Record<
    string,
    {
      repoPath: string;
      defaultBranch: string;
      description?: string;
      workspace?: string;
      /** FE validation config — if present, the repo supports Playwright-based visual validation */
      validation?: {
        /** Path to the Copilot skill file in the repo (e.g. ".github/copilot/skills/validate-fe.md") */
        skillPath: string;
      };
    }
  >;

  // Notifications
  notifications: {
    enabled: boolean;
    prReviewNeeded: boolean;
    taskCompleted: boolean;
    cronErrors: boolean;
  };

  // Terminal
  terminal: {
    shell: 'pwsh' | 'powershell' | 'cmd';
  };
}

const DEFAULTS: AppSettings = {
  azure: {
    org: '',
    project: '',
    pat: '',
    team: '',
  },
  cron: {
    intervalSeconds: 60,
    idleThresholdSeconds: 900,
  },
  profiles: {},
  notifications: {
    enabled: true,
    prReviewNeeded: true,
    taskCompleted: true,
    cronErrors: true,
  },
  terminal: {
    shell: 'pwsh',
  },
};

let cached: AppSettings | null = null;

function getSettingsPath(): string {
  if (!app.isPackaged) {
    return join(__dirname, '../../settings.json');
  }
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'settings.json');
}

/**
 * Loads settings from disk, merging with env var fallbacks and defaults.
 */
export function loadSettings(): AppSettings {
  if (cached) return cached;

  const path = getSettingsPath();
  let stored: Partial<AppSettings> = {};

  if (existsSync(path)) {
    try {
      stored = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      logger.error(`Failed to parse settings.json: ${err}`);
    }
  }

  // Merge with defaults, then env var fallbacks for Azure
  const settings: AppSettings = {
    azure: {
      org: stored.azure?.org || process.env.AZURE_DEVOPS_ORG || '',
      project: stored.azure?.project || process.env.AZURE_DEVOPS_PROJECT || '',
      pat: stored.azure?.pat || process.env.AZURE_DEVOPS_PAT || '',
      team: stored.azure?.team || process.env.AZURE_DEVOPS_TEAM || '',
    },
    cron: {
      intervalSeconds: stored.cron?.intervalSeconds ?? DEFAULTS.cron.intervalSeconds,
      idleThresholdSeconds: stored.cron?.idleThresholdSeconds ?? DEFAULTS.cron.idleThresholdSeconds,
    },
    profiles: stored.profiles ?? DEFAULTS.profiles,
    notifications: {
      enabled: stored.notifications?.enabled ?? DEFAULTS.notifications.enabled,
      prReviewNeeded: stored.notifications?.prReviewNeeded ?? DEFAULTS.notifications.prReviewNeeded,
      taskCompleted: stored.notifications?.taskCompleted ?? DEFAULTS.notifications.taskCompleted,
      cronErrors: stored.notifications?.cronErrors ?? DEFAULTS.notifications.cronErrors,
    },
    terminal: {
      shell: stored.terminal?.shell ?? DEFAULTS.terminal.shell,
    },
  };

  // If profiles are empty, try loading from profile.json
  if (Object.keys(settings.profiles).length === 0) {
    try {
      const profilePath = join(__dirname, '../../profile.json');
      if (existsSync(profilePath)) {
        settings.profiles = JSON.parse(readFileSync(profilePath, 'utf-8'));
      }
    } catch {
      // Ignore — profiles stay empty
    }
  }

  cached = settings;
  return settings;
}

/**
 * Saves settings to disk.
 */
export function saveSettings(settings: AppSettings): void {
  const path = getSettingsPath();
  try {
    writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8');
    cached = settings;
    logger.info('Settings saved');
  } catch (err) {
    logger.error(`Failed to save settings: ${err}`);
    throw err;
  }
}

/**
 * Updates a subset of settings (shallow merge per section).
 */
export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  const updated: AppSettings = {
    azure: { ...current.azure, ...partial.azure },
    cron: { ...current.cron, ...partial.cron },
    profiles: partial.profiles !== undefined ? partial.profiles : current.profiles,
    notifications: { ...current.notifications, ...partial.notifications },
    terminal: { ...current.terminal, ...partial.terminal },
  };
  saveSettings(updated);
  return updated;
}

/**
 * Clears the in-memory cache so next load reads from disk.
 */
export function clearSettingsCache(): void {
  cached = null;
}

/**
 * Convenience: loads the profile map from settings.
 * Falls back to profile.json if no profiles configured in settings.
 * Excludes the 'mock-repo' profile unless HITL_ENABLE_MOCK_REPO is set.
 */
export function loadProfiles(): Record<
  string,
  {
    repoPath: string;
    defaultBranch: string;
    description?: string;
    workspace?: string;
    validation?: { skillPath: string };
  }
> {
  const profiles = { ...loadSettings().profiles };

  if (!process.env.HITL_ENABLE_MOCK_REPO) {
    delete profiles['mock-repo'];
  }

  return profiles;
}
