/** Grid states that represent the development lifecycle */
export enum GridState {
  PROFILE_ASSIGNMENT = 'PROFILE_ASSIGNMENT',
  PLAN_APPROVAL = 'PLAN_APPROVAL',
  TASK_PR_REVIEW = 'TASK_PR_REVIEW',
  STORY_PR_REVIEW = 'STORY_PR_REVIEW',
  COMPLETED = 'COMPLETED',
  BLOCKED = 'BLOCKED',
}

export const GRID_LABELS: Record<GridState, string> = {
  [GridState.PROFILE_ASSIGNMENT]: 'Profile Assignment',
  [GridState.PLAN_APPROVAL]: 'Plan Approval',
  [GridState.TASK_PR_REVIEW]: 'Task PR Review',
  [GridState.STORY_PR_REVIEW]: 'Story PR Review',
  [GridState.COMPLETED]: 'Completed',
  [GridState.BLOCKED]: 'Blocked',
}

export const IDLE_THRESHOLD_SECONDS = 900 // 15 minutes
export const CRON_INTERVAL = '* * * * *' // every minute
