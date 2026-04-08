/** Grid states that represent the task-centric development lifecycle */
export enum GridState {
  STORY_PLANNING = 'STORY_PLANNING',
  PROFILE_ASSIGNMENT = 'PROFILE_ASSIGNMENT',
  COPILOT_KICKOFF = 'COPILOT_KICKOFF',
  TASK_EXECUTION = 'TASK_EXECUTION',
  PR_REVIEW = 'PR_REVIEW',
  COMPLETED = 'COMPLETED',
  BLOCKED = 'BLOCKED',
  ABANDONED = 'ABANDONED',
  NON_HITL = 'NON_HITL',
  ERROR = 'ERROR',
}

export const GRID_LABELS: Record<GridState, string> = {
  [GridState.STORY_PLANNING]: 'Story Planning',
  [GridState.PROFILE_ASSIGNMENT]: 'Profile Assignment',
  [GridState.COPILOT_KICKOFF]: 'Copilot Kickoff',
  [GridState.TASK_EXECUTION]: 'Task Execution',
  [GridState.PR_REVIEW]: 'PR Review',
  [GridState.COMPLETED]: 'Completed',
  [GridState.BLOCKED]: 'Blocked',
  [GridState.ABANDONED]: 'Abandoned',
  [GridState.NON_HITL]: 'Non-HITL Tasks',
  [GridState.ERROR]: 'Error',
};

export const IDLE_THRESHOLD_SECONDS = 900; // 15 minutes
export const CRON_INTERVAL = '* * * * *'; // every minute

/** Available Copilot CLI model IDs (passed via --model flag) */
export const COPILOT_MODELS = [
  'claude-opus-4.6',
  'claude-opus-4.6-fast',
  'claude-opus-4.5',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-haiku-4.5',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5.4-mini',
  'gpt-5-mini',
  'gpt-4.1',
] as const;

/** Default model for new copilot sessions */
export const DEFAULT_COPILOT_MODEL: string = 'claude-opus-4.6';
