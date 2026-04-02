/**
 * Git worktree management module.
 *
 * Manages git worktrees for the HITL development workflow:
 * - Lists existing worktrees for a repo
 * - Finds idle worktrees (not assigned to any active story/task)
 * - Creates new worktrees with story/task branches
 * - Reuses existing worktrees when possible
 *
 * Worktree naming convention:
 * - Worktrees are named `<repoName>-<number>` (e.g., `rainier-1`, `rainier-2`)
 * - Worktrees are reused rather than removed to avoid expensive repo setup
 *
 * Branch naming convention:
 * - Story branches: story/<workItemId>
 * - Task branches:  task/<workItemId>
 */
import { execFile } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Options for git command execution */
interface GitOptions {
  cwd: string;
  timeout?: number;
}

/** Parsed worktree entry from `git worktree list` */
export interface WorktreeEntry {
  path: string;
  head: string; // commit hash
  branch: string | null; // branch name, null if detached
  bare: boolean;
}

/**
 * Runs a git command in the given directory.
 */
async function git(args: string[], options: GitOptions): Promise<{ stdout: string; stderr: string }> {
  const { cwd, timeout = 30_000 } = options;
  try {
    return await execFileAsync('git', args, {
      cwd,
      timeout,
      windowsHide: true,
    });
  } catch (err: unknown) {
    const error = err as Error & { stdout?: string; stderr?: string };
    throw new Error(`[worktree] git ${args.join(' ')} failed in ${cwd}: ${error.stderr || error.message}`);
  }
}

/**
 * Lists all worktrees for a repository.
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const { stdout } = await git(['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
  });

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current as WorktreeEntry);
      current = { path: line.substring(9).trim(), branch: null, bare: false };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.substring(5).trim();
    } else if (line.startsWith('branch ')) {
      // e.g. "branch refs/heads/story/12345"
      const ref = line.substring(7).trim();
      current.branch = ref.replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.branch = null;
    }
  }

  if (current.path) entries.push(current as WorktreeEntry);

  return entries;
}

/**
 * Returns the worktrees directory for a given repo.
 * Convention: sibling directory named `<repoName>-worktrees`
 */
export function getWorktreesDir(repoPath: string): string {
  const repoName = basename(repoPath);
  return join(dirname(repoPath), `${repoName}-worktrees`);
}

/**
 * Gets the worktree path for the next available numbered worktree.
 *
 * Finds the next sequential number by scanning existing directories.
 * E.g., if `rainier-1` and `rainier-2` exist, returns path for `rainier-3`.
 */
export function getNextWorktreePath(repoPath: string): string {
  const worktreesDir = getWorktreesDir(repoPath);
  const repoName = basename(repoPath);
  const prefix = `${repoName}-`;

  let maxNumber = 0;

  if (existsSync(worktreesDir)) {
    try {
      const entries = readdirSync(worktreesDir);
      for (const entry of entries) {
        if (entry.startsWith(prefix)) {
          const num = parseInt(entry.substring(prefix.length), 10);
          if (!isNaN(num) && num > maxNumber) {
            maxNumber = num;
          }
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }

  return join(worktreesDir, `${prefix}${maxNumber + 1}`);
}

/**
 * Extracts two keywords from a title for use in branch names.
 *
 * Strips common filler words and picks the first two meaningful words,
 * lowercased and joined with a hyphen. Falls back to 'update' if the
 * title doesn't have enough useful words.
 */
export function extractKeywords(title: string): string {
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'for',
    'of',
    'with',
    'by',
    'from',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'has',
    'have',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'can',
    'shall',
    'it',
    'its',
    'this',
    'that',
    'these',
    'those',
    'i',
    'we',
    'you',
    'they',
    'he',
    'she',
    'as',
    'if',
    'not',
    'no',
    'so',
    'up',
    'out',
    'all',
    'into',
    'also',
    'than',
    'then',
    'when',
    'where',
    'how',
    'what',
    'which',
    'who',
    'whom',
    'each',
    'every',
  ]);

  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // strip non-alphanumeric
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));

  if (words.length === 0) return 'update';
  if (words.length === 1) return words[0];
  return `${words[0]}-${words[1]}`;
}

/**
 * Gets the branch name for a work item.
 *
 * Format: `<type>/<workItemId>/<keywords>`
 * e.g., `task/88888/add-feature`
 *
 * If no title is provided, falls back to a simple `<type>/<workItemId>` format.
 */
export function getBranchName(type: 'story' | 'task', workItemId: number, title?: string): string {
  if (!title) return `${type}/${workItemId}`;
  const keywords = extractKeywords(title);
  return `${type}/${workItemId}/${keywords}`;
}

/**
 * Generates a unique branch name by checking if the branch already exists.
 *
 * If the base branch name (with keywords) already exists, appends a
 * numeric suffix (-2, -3, etc.) until a unique name is found.
 *
 * @param repoPath The repo path to check branches against
 * @param type 'story' or 'task'
 * @param workItemId The Azure DevOps work item ID
 * @param title The work item title (used to extract keywords)
 * @returns A unique branch name
 */
export async function getUniqueBranchName(
  repoPath: string,
  type: 'story' | 'task',
  workItemId: number,
  title?: string,
): Promise<string> {
  const baseName = getBranchName(type, workItemId, title);

  // Check if this branch already exists
  try {
    const { stdout } = await git(['branch', '--list', baseName], { cwd: repoPath });
    if (!stdout.trim()) {
      // Also check remote branches
      const { stdout: remoteOut } = await git(['branch', '-r', '--list', `origin/${baseName}`], { cwd: repoPath });
      if (!remoteOut.trim()) return baseName;
    }
  } catch {
    return baseName; // If git fails, just use the base name
  }

  // Branch exists — try with numeric suffixes
  for (let i = 2; i <= 50; i++) {
    const candidate = `${baseName}-${i}`;
    try {
      const { stdout } = await git(['branch', '--list', candidate], { cwd: repoPath });
      if (!stdout.trim()) {
        const { stdout: remoteOut } = await git(['branch', '-r', '--list', `origin/${candidate}`], { cwd: repoPath });
        if (!remoteOut.trim()) return candidate;
      }
    } catch {
      return candidate;
    }
  }

  // Extremely unlikely fallback
  return `${baseName}-${Date.now()}`;
}

/**
 * Finds an idle worktree — one that exists but isn't assigned to any
 * active story or task in the database.
 *
 * @param repoPath The main repo path
 * @param assignedPaths Set of worktree paths currently assigned in the DB
 * @returns The path of an idle worktree, or null if none found
 */
export async function findIdleWorktree(repoPath: string, assignedPaths: Set<string>): Promise<WorktreeEntry | null> {
  const worktrees = await listWorktrees(repoPath);
  const worktreesDir = getWorktreesDir(repoPath);

  const candidates: WorktreeEntry[] = [];

  for (const wt of worktrees) {
    // Skip the main worktree (the repo itself)
    if (wt.path === resolve(repoPath)) continue;
    // Skip worktrees not in our managed directory
    if (!wt.path.startsWith(worktreesDir)) continue;
    // Skip worktrees that are currently assigned
    if (assignedPaths.has(wt.path)) continue;

    candidates.push(wt);
  }

  if (candidates.length === 0) return null;

  // Prefer detached (parked) worktrees — these are ready for reuse
  // without needing to detach an existing branch first
  const detached = candidates.find((wt) => wt.branch === null);
  return detached ?? candidates[0];
}

/**
 * Creates a new git worktree for a story or task.
 *
 * 1. Fetches the latest from origin
 * 2. Creates a new worktree with a sequentially numbered name
 * 3. Creates a new branch based on the default branch
 *
 * Worktrees are named `<repoName>-<N>` and are intended to be reused.
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
  baseBranch?: string,
  title?: string,
): Promise<string> {
  const base = baseBranch ?? `origin/${defaultBranch}`;

  // Fetch latest from origin
  console.log(`[worktree] Fetching latest in ${repoPath}...`);
  await git(['fetch', 'origin'], { cwd: repoPath });

  // Check if a branch for this work item already exists (any keyword variant)
  const branchPrefix = `${type}/${workItemId}`;
  try {
    const { stdout } = await git(['branch', '--list', `${branchPrefix}/*`], { cwd: repoPath });
    // Also check the bare prefix (legacy branches without keywords)
    const { stdout: legacyOut } = await git(['branch', '--list', branchPrefix], { cwd: repoPath });
    const existingBranch = (legacyOut.trim() || stdout.trim().split('\n')[0])?.trim().replace(/^\*\s*/, '');
    if (existingBranch) {
      // Branch exists — check if it already has a worktree
      const worktrees = await listWorktrees(repoPath);
      const existingWt = worktrees.find((wt) => wt.branch === existingBranch);
      if (existingWt) {
        console.log(`[worktree] Worktree already exists for branch ${existingBranch} at ${existingWt.path}, reusing`);
        return existingWt.path;
      }
      // Branch exists but no worktree — create a new numbered worktree for it
      const worktreePath = getNextWorktreePath(repoPath);
      console.log(`[worktree] Branch ${existingBranch} exists, adding worktree at ${worktreePath}`);
      await git(['worktree', 'add', worktreePath, existingBranch], {
        cwd: repoPath,
      });
      return worktreePath;
    }
  } catch {
    // Branch doesn't exist, which is fine — we'll create it
  }

  // Generate a unique branch name with keywords from the title
  const branchName = await getUniqueBranchName(repoPath, type, workItemId, title);

  // Create new worktree with new branch using next sequential number
  const worktreePath = getNextWorktreePath(repoPath);
  console.log(`[worktree] Creating worktree at ${worktreePath} (branch: ${branchName} from ${base})`);
  await git(['worktree', 'add', '-b', branchName, worktreePath, base], { cwd: repoPath });

  return worktreePath;
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
  defaultBranch: string,
  title?: string,
): Promise<string> {
  const storyBranch = getBranchName('story', storyId);

  // Check if the story branch exists
  try {
    const { stdout } = await git(['branch', '--list', storyBranch], { cwd: repoPath });
    if (stdout.trim()) {
      // Branch from the story branch
      return createWorktree(repoPath, 'task', taskId, defaultBranch, storyBranch, title);
    }
  } catch {
    // Story branch doesn't exist, fall back to default
  }

  // Fall back to branching from default
  console.warn(`[worktree] Story branch ${storyBranch} not found, using ${defaultBranch}`);
  return createWorktree(repoPath, 'task', taskId, defaultBranch, undefined, title);
}

/**
 * Repurposes an idle worktree for a new task.
 *
 * The worktree should already be in a detached HEAD state (from cleanup).
 * This function:
 * 1. Fetches the latest from origin
 * 2. Creates a new branch based on the default branch
 * 3. Checks out the new branch in the worktree
 *
 * @param worktreePath The path of the idle worktree to repurpose
 * @param repoPath The main repo path (for fetching)
 * @param type 'story' or 'task'
 * @param workItemId The Azure DevOps work item ID
 * @param defaultBranch The default branch to base the new branch on
 * @returns The worktree path (same as input)
 */
export async function repurposeWorktree(
  worktreePath: string,
  repoPath: string,
  type: 'story' | 'task',
  workItemId: number,
  defaultBranch: string,
  title?: string,
): Promise<string> {
  const base = `origin/${defaultBranch}`;

  // Fetch latest from origin
  await git(['fetch', 'origin'], { cwd: repoPath });

  // Generate a unique branch name with keywords
  const branchName = await getUniqueBranchName(repoPath, type, workItemId, title);

  // Create and check out new branch from origin/defaultBranch
  await git(['checkout', '-b', branchName, base], { cwd: worktreePath });

  return worktreePath;
}

/**
 * Gets the current branch name checked out in a worktree.
 *
 * @param worktreePath The worktree path to check
 * @returns The branch name, or null if HEAD is detached
 */
export async function getCurrentBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });
    const branch = stdout.trim();
    return branch === 'HEAD' ? null : branch; // 'HEAD' means detached
  } catch {
    return null;
  }
}

/**
 * Removes a git worktree.
 *
 * @param repoPath The main repo path
 * @param worktreePath The path of the worktree to remove
 * @param force Whether to force removal even if there are changes
 */
export async function removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<void> {
  const args = ['worktree', 'remove', worktreePath];
  if (force) args.push('--force');

  console.log(`[worktree] Removing worktree at ${worktreePath}`);
  await git(args, { cwd: repoPath });
}

/**
 * Prunes stale worktree entries (worktrees whose directory was deleted manually).
 */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(['worktree', 'prune'], { cwd: repoPath });
}
