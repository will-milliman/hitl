/** Grid states that represent the task-centric development lifecycle */
export enum GridState {
  PROFILE_ASSIGNMENT = 'PROFILE_ASSIGNMENT',
  TASK_EXECUTION = 'TASK_EXECUTION',
  PR_REVIEW = 'PR_REVIEW',
  COMPLETED = 'COMPLETED',
  BLOCKED = 'BLOCKED',
  ABANDONED = 'ABANDONED',
}

export const GRID_LABELS: Record<GridState, string> = {
  [GridState.PROFILE_ASSIGNMENT]: 'Profile Assignment',
  [GridState.TASK_EXECUTION]: 'Task Execution',
  [GridState.PR_REVIEW]: 'PR Review',
  [GridState.COMPLETED]: 'Completed',
  [GridState.BLOCKED]: 'Blocked',
  [GridState.ABANDONED]: 'Abandoned',
}

export const IDLE_THRESHOLD_SECONDS = 900 // 15 minutes
export const CRON_INTERVAL = '* * * * *' // every minute
