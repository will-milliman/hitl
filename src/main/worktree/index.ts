/**
 * Git worktree management module.
 *
 * Manages git worktrees for the HITL development workflow:
 * - Lists existing worktrees for a repo
 * - Finds idle worktrees (not assigned to any active story/task)
 * - Creates new worktrees with story/task branches
 * - Removes worktrees when they are no longer needed
 *
 * Worktree naming convention:
 * - Story worktrees: <repoPath>-worktrees/story-<workItemId>
 * - Task worktrees:  <repoPath>-worktrees/task-<workItemId>
 *
 * Branch naming convention:
 * - Story branches: story/<workItemId>
 * - Task branches:  task/<workItemId>
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolve, basename, dirname, join } from 'path'
import { existsSync } from 'fs'

const execFileAsync = promisify(execFile)

/** Options for git command execution */
interface GitOptions {
  cwd: string
  timeout?: number
}

/** Parsed worktree entry from `git worktree list` */
export interface WorktreeEntry {
  path: string
  head: string // commit hash
  branch: string | null // branch name, null if detached
  bare: boolean
}

/**
 * Runs a git command in the given directory.
 */
async function git(
  args: string[],
  options: GitOptions
): Promise<{ stdout: string; stderr: string }> {
  const { cwd, timeout = 30_000 } = options
  try {
    return await execFileAsync('git', args, {
      cwd,
      timeout,
      windowsHide: true,
    })
  } catch (err: unknown) {
    const error = err as Error & { stdout?: string; stderr?: string }
    throw new Error(
      `[worktree] git ${args.join(' ')} failed in ${cwd}: ${error.stderr || error.message}`
    )
  }
}

/**
 * Lists all worktrees for a repository.
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const { stdout } = await git(['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
  })

  const entries: WorktreeEntry[] = []
  let current: Partial<WorktreeEntry> = {}

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current as WorktreeEntry)
      current = { path: line.substring(9).trim(), branch: null, bare: false }
    } else if (line.startsWith('HEAD ')) {
      current.head = line.substring(5).trim()
    } else if (line.startsWith('branch ')) {
      // e.g. "branch refs/heads/story/12345"
      const ref = line.substring(7).trim()
      current.branch = ref.replace('refs/heads/', '')
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'detached') {
      current.branch = null
    }
  }

  if (current.path) entries.push(current as WorktreeEntry)

  return entries
}

/**
 * Returns the worktrees directory for a given repo.
 * Convention: sibling directory named `<repoName>-worktrees`
 */
export function getWorktreesDir(repoPath: string): string {
  const repoName = basename(repoPath)
  return join(dirname(repoPath), `${repoName}-worktrees`)
}

/**
 * Gets the worktree path for a specific work item.
 */
export function getWorktreePath(
  repoPath: string,
  type: 'story' | 'task',
  workItemId: number
): string {
  return join(getWorktreesDir(repoPath), `${type}-${workItemId}`)
}

/**
 * Gets the branch name for a work item.
 */
export function getBranchName(
  type: 'story' | 'task',
  workItemId: number
): string {
  return `${type}/${workItemId}`
}

/**
 * Finds an idle worktree — one that exists but isn't assigned to any
 * active story or task in the database.
 *
 * @param repoPath The main repo path
 * @param assignedPaths Set of worktree paths currently assigned in the DB
 * @returns The path of an idle worktree, or null if none found
 */
export async function findIdleWorktree(
  repoPath: string,
  assignedPaths: Set<string>
): Promise<WorktreeEntry | null> {
  const worktrees = await listWorktrees(repoPath)
  const worktreesDir = getWorktreesDir(repoPath)

  for (const wt of worktrees) {
    // Skip the main worktree (the repo itself)
    if (wt.path === resolve(repoPath)) continue
    // Skip worktrees not in our managed directory
    if (!wt.path.startsWith(worktreesDir)) continue
    // Skip worktrees that are currently assigned
    if (assignedPaths.has(wt.path)) continue

    return wt
  }

  return null
}

/**
 * Creates a new git worktree for a story or task.
 *
 * 1. Fetches the latest from origin
 * 2. Creates a new worktree with a new branch based on the default branch
 *
 * @param repoPath The main repo path
 * @param type 'story' or 'task'
 * @param workItemId The Azure DevOps work item ID
 * @param defaultBranch The default branch to base the new branch on (e.g., 'main')
 * @param baseBranch Optional override for the base branch (e.g., story branch for tasks)
 * @returns The absolute path to the new worktree
 */
export async function createWorktree(
  repoPath: string,
  type: 'story' | 'task',
  workItemId: number,
  defaultBranch: string,
  baseBranch?: string
): Promise<string> {
  const worktreePath = getWorktreePath(repoPath, type, workItemId)
  const branchName = getBranchName(type, workItemId)
  const base = baseBranch ?? `origin/${defaultBranch}`

  // Fetch latest from origin
  console.log(`[worktree] Fetching latest in ${repoPath}...`)
  await git(['fetch', 'origin'], { cwd: repoPath })

  // Check if the branch already exists
  try {
    const { stdout } = await git(
      ['branch', '--list', branchName],
      { cwd: repoPath }
    )
    if (stdout.trim()) {
      // Branch exists — check if worktree already exists at path
      if (existsSync(worktreePath)) {
        console.log(
          `[worktree] Worktree already exists at ${worktreePath}, reusing`
        )
        return worktreePath
      }
      // Branch exists but no worktree — add worktree for existing branch
      console.log(
        `[worktree] Branch ${branchName} exists, adding worktree at ${worktreePath}`
      )
      await git(['worktree', 'add', worktreePath, branchName], {
        cwd: repoPath,
      })
      return worktreePath
    }
  } catch {
    // Branch doesn't exist, which is fine — we'll create it
  }

  // Create new worktree with new branch
  console.log(
    `[worktree] Creating worktree at ${worktreePath} (branch: ${branchName} from ${base})`
  )
  await git(
    ['worktree', 'add', '-b', branchName, worktreePath, base],
    { cwd: repoPath }
  )

  return worktreePath
}

/**
 * Creates a task worktree branched from the story branch.
 *
 * @param repoPath The main repo path
 * @param storyId The parent story's work item ID
 * @param taskId The task's work item ID
 * @param defaultBranch The default branch (fallback if story branch doesn't exist)
 * @returns The absolute path to the new task worktree
 */
export async function createTaskWorktree(
  repoPath: string,
  storyId: number,
  taskId: number,
  defaultBranch: string
): Promise<string> {
  const storyBranch = getBranchName('story', storyId)

  // Check if the story branch exists
  try {
    const { stdout } = await git(
      ['branch', '--list', storyBranch],
      { cwd: repoPath }
    )
    if (stdout.trim()) {
      // Branch from the story branch
      return createWorktree(repoPath, 'task', taskId, defaultBranch, storyBranch)
    }
  } catch {
    // Story branch doesn't exist, fall back to default
  }

  // Fall back to branching from default
  console.warn(
    `[worktree] Story branch ${storyBranch} not found, using ${defaultBranch}`
  )
  return createWorktree(repoPath, 'task', taskId, defaultBranch)
}

/**
 * Removes a git worktree.
 *
 * @param repoPath The main repo path
 * @param worktreePath The path of the worktree to remove
 * @param force Whether to force removal even if there are changes
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false
): Promise<void> {
  const args = ['worktree', 'remove', worktreePath]
  if (force) args.push('--force')

  console.log(`[worktree] Removing worktree at ${worktreePath}`)
  await git(args, { cwd: repoPath })
}

/**
 * Prunes stale worktree entries (worktrees whose directory was deleted manually).
 */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(['worktree', 'prune'], { cwd: repoPath })
}
