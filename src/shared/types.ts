/** A story work item from Azure DevOps */
export interface Story {
  id: number
  title: string
  state: string // GridState enum value
  profileKey: string | null
  worktreePath: string | null
  sessionId: string | null
  prUrl: string | null
  azureUrl: string
  disabled: boolean
  prUpdated: boolean
  completedAt: Date | string | null
  errorMessage: string | null
  errorAt: Date | string | null
  createdAt: Date | string
  updatedAt: Date | string
}

/** A task work item associated with a story */
export interface Task {
  id: number
  title: string
  storyId: number
  worktreePath: string | null
  sessionId: string | null
  prUrl: string | null
  prMerged: boolean
  azureUrl: string
  disabled: boolean
  prUpdated: boolean
  errorMessage: string | null
  errorAt: Date | string | null
  createdAt: Date | string
  updatedAt: Date | string
}

/** Profile configuration for a repository */
export interface Profile {
  repoPath: string
  defaultBranch: string
  description?: string
}

/** Profile map keyed by profile name */
export type ProfileMap = Record<string, Profile>
