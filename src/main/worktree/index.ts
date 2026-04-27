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
import { existsSync, readdirSync, rmSync } from 'fs';
import { basename, dirname, join, normalize, resolve } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Options for git command execution */
interface GitOptions {
  cwd: string;
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
  const { cwd } = options;
  try {
    return await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
    });
  } catch (err: unknown) {
    const error = err as Error & { stdout?: string; stderr?: string };
    throw new Error(`[worktree] git ${args.join(' ')} failed in ${cwd}: ${error.stderr || error.message}`);
  }
}

/**
 * Cleans up a partially-created worktree after a failed `git worktree add`.
 *
 * If the timeout kills git mid-checkout, it leaves a broken directory on disk
 * and a stale worktree entry in git's bookkeeping. This removes both so the
 * next attempt starts clean.
 */
function cleanupPartialWorktree(repoPath: string, worktreePath: string): void {
  try {
    if (existsSync(worktreePath)) {
      console.warn(`[worktree] Removing partial worktree directory at ${worktreePath}`);
      rmSync(worktreePath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`[worktree] Failed to remove partial worktree at ${worktreePath}:`, err);
  }

  // Prune stale worktree entries so git doesn't think this path is still in use
  execFileAsync('git', ['worktree', 'prune'], {
    cwd: repoPath,
    windowsHide: true,
  }).catch((err) => {
    console.error(`[worktree] Failed to prune worktrees after cleanup:`, err);
  });
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
      current = { path: normalize(line.substring(9).trim()), branch: null, bare: false };
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
export function extractKeywords(title: string, skip = 0): string {
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

  // Apply the skip offset to select different keyword pairs
  const available = words.slice(skip);

  if (available.length === 0) return skip === 0 ? 'update' : '';
  if (available.length === 1) return available[0];
  return `${available[0]}-${available[1]}`;
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
 * Converts a branch name like `task/88888/key-words` into a desktop-friendly
 * name like `key-words-88888`. This puts the human-readable keywords first so
 * they remain visible when the OS truncates (ellipsizes) long names.
 *
 * Falls back to the raw branch name if the format is unrecognised.
 */
export function toDesktopName(branchName: string): string {
  // Expected format: type/id/keywords  (e.g. "task/12345/add-feature")
  const parts = branchName.split('/');
  if (parts.length >= 3) {
    const id = parts[1];
    const keywords = parts.slice(2).join('-');
    return `${keywords}-${id}`;
  }
  // type/id only (no keywords) — just show the id
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return `${parts[0]}-${parts[1]}`;
  }
  return branchName;
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

  // Branch exists — try alternative keyword pairs from the title first.
  // For a title with words [A, B, C, D], we already tried A-B (skip=0).
  // Now try skip=1 (B-C), skip=2 (C-D), etc.
  if (title) {
    for (let skip = 1; skip <= 10; skip++) {
      const altKeywords = extractKeywords(title, skip);
      if (!altKeywords) break; // No more keyword combinations available
      const candidate = `${type}/${workItemId}/${altKeywords}`;
      if (candidate === baseName) continue; // Same as base, skip
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
  }

  // All keyword combinations exhausted — fall back to numeric suffixes
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

  // Last resort — short numeric suffix (no timestamp)
  return `${baseName}-${Math.floor(Math.random() * 9000) + 1000}`;
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
  const worktreesDir = normalize(getWorktreesDir(repoPath));

  // Normalize assigned paths for reliable comparison (DB may store mixed separators)
  const normalizedAssigned = new Set([...assignedPaths].map((p) => normalize(p)));

  const candidates: WorktreeEntry[] = [];

  for (const wt of worktrees) {
    const wtPath = normalize(wt.path);
    // Skip the main worktree (the repo itself)
    if (wtPath === normalize(resolve(repoPath))) continue;
    // Skip worktrees not in our managed directory
    if (!wtPath.startsWith(worktreesDir)) continue;
    // Skip worktrees that are currently assigned
    if (normalizedAssigned.has(wtPath)) continue;

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
      try {
        await git(['worktree', 'add', worktreePath, existingBranch], {
          cwd: repoPath,
        });
      } catch (err) {
        cleanupPartialWorktree(repoPath, worktreePath);
        throw err;
      }
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
  try {
    await git(['worktree', 'add', '-b', branchName, worktreePath, base], {
      cwd: repoPath,
    });
  } catch (err) {
    cleanupPartialWorktree(repoPath, worktreePath);
    throw err;
  }

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

  // Clean the worktree before repurposing — discard any leftover changes
  // from a previous task so `git checkout -b` doesn't fail on dirty state.
  await git(['reset', '--hard'], { cwd: worktreePath });
  await git(['clean', '-fd'], { cwd: worktreePath });

  // Detach HEAD so the old branch doesn't interfere with the new checkout.
  // Idle worktrees should already be detached (from cleanupCompletedTask),
  // but non-managed or incompletely-cleaned worktrees may still be on a
  // named branch (e.g. one created outside HITL).
  await git(['checkout', '--detach'], { cwd: worktreePath });

  // Generate a unique branch name with keywords
  const branchName = await getUniqueBranchName(repoPath, type, workItemId, title);

  // Create and check out new branch from origin/defaultBranch
  await git(['checkout', '-b', branchName, base], { cwd: worktreePath });

  // Verify the checkout landed on the correct branch
  const { stdout: actualBranch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });
  if (actualBranch.trim() !== branchName) {
    throw new Error(`repurposeWorktree: expected branch "${branchName}" but worktree is on "${actualBranch.trim()}"`);
  }

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
