/** A story from Azure DevOps — lightweight parent reference for context */
export interface Story {
  id: number;
  title: string;
  azureUrl: string;
}

/** A task or bug work item — the primary pipeline entity */
export interface Task {
  id: number;
  title: string;
  workItemType: string; // Azure DevOps type: 'Task' or 'Bug'
  storyId: number | null;
  state: string; // GridState enum value
  profileKey: string | null;
  worktreePath: string | null;
  sessionId: string | null;
  model: string | null;
  prUrl: string | null;
  prMerged: boolean;
  azureUrl: string;
  disabled: boolean;
  skipCopilot: boolean;
  validateFe: boolean;
  prUpdated: boolean;
  completedAt: Date | string | null;
  errorMessage: string | null;
  errorAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  story?: Story | null;
}

/** Profile configuration for a repository */
export interface Profile {
  repoPath: string;
  defaultBranch: string;
  description?: string;
  /** Optional path to a .code-workspace file (relative to repoPath) */
  workspace?: string;
  /** FE validation config — if present, the repo supports Playwright-based visual validation */
  validation?: {
    /** Path to the Copilot skill file in the repo (e.g. ".github/copilot/skills/validate-fe.md") */
    skillPath: string;
  };
  /** Setup command to run in the background after a worktree is created/reused */
  setup?: {
    /** Working directory for the command (relative to worktree root) */
    cwd: string;
    /** Shell command to execute */
    command: string;
  };
}

/** Profile map keyed by profile name */
export type ProfileMap = Record<string, Profile>;
