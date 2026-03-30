/** A story from Azure DevOps — lightweight parent reference for context */
export interface Story {
  id: number
  title: string
  azureUrl: string
}

/** A task work item — the primary pipeline entity */
export interface Task {
  id: number
  title: string
  storyId: number | null
  state: string // GridState enum value
  profileKey: string | null
  worktreePath: string | null
  sessionId: string | null
  prUrl: string | null
  prMerged: boolean
  azureUrl: string
  disabled: boolean
  prUpdated: boolean
  completedAt: Date | string | null
  errorMessage: string | null
  errorAt: Date | string | null
  createdAt: Date | string
  updatedAt: Date | string
  story?: Story | null
}

/** Profile configuration for a repository */
export interface Profile {
  repoPath: string
  defaultBranch: string
  description?: string
  /** Optional path to a .code-workspace file (relative to repoPath) */
  workspace?: string
}

/** Profile map keyed by profile name */
export type ProfileMap = Record<string, Profile>
